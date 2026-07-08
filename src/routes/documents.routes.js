const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { query } = require('../db/pool');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth } = require('../middleware/auth');
const { requirePermission, requireGroupAccess } = require('../middleware/permissions');
const { logAction } = require('../middleware/auditLog');

const router = express.Router();
router.use(requireAuth);

/** Resolves the group name for the buyer a document is being uploaded to. */
async function groupOfBuyerParam(req) {
  const { rows } = await query(
    `SELECT g.name FROM purchase_records pr
     JOIN plots p ON p.id = pr.plot_id
     JOIN groups g ON g.id = p.group_id
     WHERE pr.buyer_id = $1 LIMIT 1`,
    [req.params.buyerId]
  );
  return rows[0]?.name || null;
}

/** Resolves the group name for an existing document (used before deleting it). */
async function groupOfDocument(req) {
  const { rows } = await query(
    `SELECT g.name FROM documents d
     JOIN purchase_records pr ON pr.buyer_id = d.buyer_id
     JOIN plots p ON p.id = pr.plot_id
     JOIN groups g ON g.id = p.group_id
     WHERE d.id = $1 LIMIT 1`,
    [req.params.id]
  );
  return rows[0]?.name || null;
}

const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const safeName = `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_')}`;
    cb(null, safeName);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB per document
  fileFilter: (req, file, cb) => {
    const allowed = /pdf|jpe?g|png|doc|docx/i;
    cb(null, allowed.test(path.extname(file.originalname)));
  },
});

// POST /api/documents/:buyerId — upload a document to a buyer's folder
router.post(
  '/:buyerId',
  requirePermission('documents:upload'),
  requireGroupAccess(groupOfBuyerParam),
  upload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded, or file type not allowed.' });

    const { document_type, purchase_record_id } = req.body;
    const { rows } = await query(
      `INSERT INTO documents (buyer_id, purchase_record_id, document_type, file_name, file_path, file_size_bytes, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, document_type, file_name, uploaded_at`,
      [
        req.params.buyerId,
        purchase_record_id || null,
        document_type || 'other',
        req.file.originalname,
        req.file.filename,
        req.file.size,
        req.user.id,
      ]
    );

    await logAction(req.user.id, 'document.upload', 'documents', rows[0].id, {
      buyer_id: req.params.buyerId,
      file_name: req.file.originalname,
    });

    res.status(201).json(rows[0]);
  })
);

// GET /api/documents/:id/download
router.get(
  '/:id/download',
  asyncHandler(async (req, res) => {
    const { rows } = await query('SELECT * FROM documents WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Document not found.' });

    const filePath = path.join(UPLOAD_DIR, rows[0].file_path);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File missing from storage.' });

    res.download(filePath, rows[0].file_name);
  })
);

// DELETE /api/documents/:id
router.delete(
  '/:id',
  requirePermission('documents:delete'),
  requireGroupAccess(groupOfDocument),
  asyncHandler(async (req, res) => {
    const { rows } = await query('DELETE FROM documents WHERE id = $1 RETURNING *', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Document not found.' });

    const filePath = path.join(UPLOAD_DIR, rows[0].file_path);
    fs.unlink(filePath, () => {}); // best-effort; ignore if already gone

    await logAction(req.user.id, 'document.delete', 'documents', rows[0].id, {});
    res.json({ success: true });
  })
);

module.exports = router;
