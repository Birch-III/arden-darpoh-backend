const express = require('express');
const { query } = require('../db/pool');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth } = require('../middleware/auth');
const { requirePermission, requireGroupAccess } = require('../middleware/permissions');
const { logAction } = require('../middleware/auditLog');

const router = express.Router();
router.use(requireAuth);

/** Resolves the group name for a purchase record, given either :id in the URL or purchase_record_id in the body. */
async function groupOfPurchaseRecord(req) {
  const purchaseRecordId = req.params.id || req.body.purchase_record_id;
  if (!purchaseRecordId) return null;
  const { rows } = await query(
    `SELECT g.name FROM purchase_records pr
     JOIN plots p ON p.id = pr.plot_id
     JOIN groups g ON g.id = p.group_id
     WHERE pr.id = $1`,
    [purchaseRecordId]
  );
  return rows[0]?.name || null;
}

/** Resolves the group name for an existing payment (used before deleting it). */
async function groupOfPayment(req) {
  const { rows } = await query(
    `SELECT g.name FROM payments pay
     JOIN purchase_records pr ON pr.id = pay.purchase_record_id
     JOIN plots p ON p.id = pr.plot_id
     JOIN groups g ON g.id = p.group_id
     WHERE pay.id = $1`,
    [req.params.id]
  );
  return rows[0]?.name || null;
}

// GET /api/payments — town-wide list for the Grant Payments screen
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { rows } = await query(`
      SELECT
        b.id AS buyer_id, b.name AS buyer_name,
        p.plot_number, g.name AS group_name,
        pr.id AS purchase_record_id, pr.total_grant_due, pr.acknowledgement_date,
        COALESCE(SUM(pay.amount), 0) AS amount_paid,
        (pr.total_grant_due - COALESCE(SUM(pay.amount), 0)) AS balance,
        MAX(pay.payment_date) AS last_payment_date,
        CASE
          WHEN COALESCE(SUM(pay.amount), 0) >= pr.total_grant_due AND pr.total_grant_due > 0 THEN 'paid'
          WHEN COALESCE(SUM(pay.amount), 0) > 0 THEN 'partial'
          ELSE 'unpaid'
        END AS payment_status
      FROM purchase_records pr
      JOIN buyers b ON b.id = pr.buyer_id
      JOIN plots p ON p.id = pr.plot_id
      JOIN groups g ON g.id = p.group_id
      LEFT JOIN payments pay ON pay.purchase_record_id = pr.id
      WHERE pr.deleted_at IS NULL AND b.deleted_at IS NULL
      GROUP BY b.id, b.name, p.plot_number, g.name, pr.id, pr.total_grant_due, pr.acknowledgement_date
      ORDER BY balance DESC
    `);
    res.json(rows);
  })
);

// POST /api/payments — record a new grant payment
router.post(
  '/',
  requirePermission('payments:record'),
  requireGroupAccess(groupOfPurchaseRecord),
  asyncHandler(async (req, res) => {
    const { purchase_record_id, amount, payment_date, method, receipt_number } = req.body;
    if (!purchase_record_id || !amount) {
      return res.status(400).json({ error: 'purchase_record_id and amount are required.' });
    }
    if (Number(amount) <= 0) {
      return res.status(400).json({ error: 'Amount must be greater than zero.' });
    }

    const { rows: prRows } = await query('SELECT * FROM purchase_records WHERE id = $1 AND deleted_at IS NULL', [purchase_record_id]);
    if (!prRows[0]) return res.status(404).json({ error: 'Purchase record not found.' });

    const { rows } = await query(
      `INSERT INTO payments (purchase_record_id, amount, payment_date, method, receipt_number, recorded_by)
       VALUES ($1, $2, COALESCE($3, CURRENT_DATE), COALESCE($4, 'cash'), $5, $6) RETURNING *`,
      [purchase_record_id, amount, payment_date || null, method || null, receipt_number || null, req.user.id]
    );

    // Auto-flag fully_paid_flag once total paid reaches the amount due (does NOT auto-acknowledge).
    const { rows: totals } = await query(
      `SELECT COALESCE(SUM(amount),0) AS total_paid FROM payments WHERE purchase_record_id = $1`,
      [purchase_record_id]
    );
    const fullyPaid = Number(totals[0].total_paid) >= Number(prRows[0].total_grant_due) && Number(prRows[0].total_grant_due) > 0;
    await query('UPDATE purchase_records SET fully_paid_flag = $1 WHERE id = $2', [fullyPaid, purchase_record_id]);

    await logAction(req.user.id, 'payment.record', 'payments', rows[0].id, {
      purchase_record_id, amount,
    });

    res.status(201).json({ ...rows[0], fully_paid_flag: fullyPaid });
  })
);

// POST /api/payments/purchase-records/:id/acknowledge — manual "fully paid" certification
router.post(
  '/purchase-records/:id/acknowledge',
  requirePermission('payments:record'),
  requireGroupAccess(groupOfPurchaseRecord),
  asyncHandler(async (req, res) => {
    const { rows: prRows } = await query('SELECT * FROM purchase_records WHERE id = $1 AND deleted_at IS NULL', [req.params.id]);
    if (!prRows[0]) return res.status(404).json({ error: 'Purchase record not found.' });
    if (!prRows[0].fully_paid_flag) {
      return res.status(400).json({ error: 'This plot is not yet fully paid — cannot acknowledge.' });
    }

    const { rows } = await query(
      `UPDATE purchase_records SET acknowledged_by = $1, acknowledgement_date = now() WHERE id = $2 RETURNING *`,
      [req.user.id, req.params.id]
    );

    await logAction(req.user.id, 'payment.acknowledge', 'purchase_records', rows[0].id, {});
    res.json(rows[0]);
  })
);

// DELETE /api/payments/:id — correct a mis-entered payment (Main Admin only via permission)
router.delete(
  '/:id',
  requirePermission('payments:delete'),
  requireGroupAccess(groupOfPayment),
  asyncHandler(async (req, res) => {
    const { rows } = await query('DELETE FROM payments WHERE id = $1 RETURNING *', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Payment not found.' });

    const { rows: totals } = await query(
      `SELECT COALESCE(SUM(amount),0) AS total_paid FROM payments WHERE purchase_record_id = $1`,
      [rows[0].purchase_record_id]
    );
    const { rows: prRows } = await query('SELECT total_grant_due FROM purchase_records WHERE id = $1', [rows[0].purchase_record_id]);
    const fullyPaid = Number(totals[0].total_paid) >= Number(prRows[0].total_grant_due) && Number(prRows[0].total_grant_due) > 0;
    await query('UPDATE purchase_records SET fully_paid_flag = $1 WHERE id = $2', [fullyPaid, rows[0].purchase_record_id]);

    await logAction(req.user.id, 'payment.delete', 'payments', rows[0].id, {});
    res.json({ success: true });
  })
);

module.exports = router;
