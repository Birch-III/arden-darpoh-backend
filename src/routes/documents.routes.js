const express = require('express');
const multer = require('multer');
const path = require('path');
const { query } = require('../db/pool');
const storage = require('../services/documentStorage');
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

// Files are held in memory only long enough to stream to Cloudinary — never written to local disk.
const upload = multer({
  storage: multer.memoryStorage(),
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
    const uploaded = await storage.upload(req.file.buffer, { filename: req.file.originalname });

    const { rows } = await query(
      `INSERT INTO documents (buyer_id, purchase_record_id, document_type, file_name, file_path, resource_type, file_size_bytes, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, document_type, file_name, uploaded_at`,
      [
        req.params.buyerId,
        purchase_record_id || null,
        document_type || 'other',
        req.file.originalname,
        uploaded.storageKey,
        uploaded.resourceType || 'auto',
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

// GET /api/documents/:id/download — streams the file back from cloud storage
router.get(
  '/:id/download',
  asyncHandler(async (req, res) => {
    const { rows } = await query('SELECT * FROM documents WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Document not found.' });

    const buffer = await storage.fetchBuffer(rows[0].file_path, rows[0].resource_type);
    res.setHeader('Content-Disposition', `attachment; filename="${rows[0].file_name.replace(/"/g, '')}"`);
    res.send(buffer);
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

    try {
      await storage.remove(rows[0].file_path, rows[0].resource_type);
    } catch (err) {
      console.error('Failed to remove file from cloud storage (DB record already deleted):', err.message);
    }

    await logAction(req.user.id, 'document.delete', 'documents', rows[0].id, {});
    res.json({ success: true });
  })
);

module.exports = router;
