const express = require('express');
const { query, getClient } = require('../db/pool');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth } = require('../middleware/auth');
const { requirePermission, requireGroupAccess } = require('../middleware/permissions');
const { logAction } = require('../middleware/auditLog');

const router = express.Router();
router.use(requireAuth);

/** Resolves the group name for a buyer's existing purchase record (used for edit/delete scope checks). */
async function groupOfBuyer(req) {
  const { rows } = await query(
    `SELECT g.name FROM purchase_records pr
     JOIN plots p ON p.id = pr.plot_id
     JOIN groups g ON g.id = p.group_id
     WHERE pr.buyer_id = $1 LIMIT 1`,
    [req.params.id]
  );
  return rows[0]?.name || null;
}

/** Resolves the target group name straight from the request body (used on buyer creation). */
async function groupFromRequestBody(req) {
  if (!req.body.group_id) return null;
  const { rows } = await query('SELECT name FROM groups WHERE id = $1', [req.body.group_id]);
  return rows[0]?.name || null;
}

// Shared SELECT that computes paid/balance/payment-status per buyer.
const BUYER_LIST_SELECT = `
  SELECT
    b.id, b.name, b.phone, b.email, b.status AS buyer_status, b.created_at,
    g.name AS group_name,
    p.plot_number, p.id AS plot_id,
    pr.id AS purchase_record_id, pr.purchase_date, pr.total_grant_due, pr.fully_paid_flag,
    pr.acknowledgement_date,
    COALESCE(SUM(pay.amount), 0) AS amount_paid,
    (pr.total_grant_due - COALESCE(SUM(pay.amount), 0)) AS balance,
    CASE
      WHEN pr.total_grant_due IS NULL THEN NULL
      WHEN COALESCE(SUM(pay.amount), 0) >= pr.total_grant_due AND pr.total_grant_due > 0 THEN 'paid'
      WHEN COALESCE(SUM(pay.amount), 0) > 0 THEN 'partial'
      ELSE 'unpaid'
    END AS payment_status
  FROM buyers b
  LEFT JOIN purchase_records pr ON pr.buyer_id = b.id
  LEFT JOIN plots p ON p.id = pr.plot_id
  LEFT JOIN groups g ON g.id = p.group_id
  LEFT JOIN payments pay ON pay.purchase_record_id = pr.id
`;
const BUYER_LIST_GROUP_BY = `
  GROUP BY
    b.id, b.name, b.phone, b.email, b.status, b.created_at,
    g.name, p.plot_number, p.id,
    pr.id, pr.purchase_date, pr.total_grant_due, pr.fully_paid_flag, pr.acknowledgement_date
`;

// GET /api/buyers?status=&group=&payment_status=&search=
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { status, group, payment_status, search } = req.query;
    const having = [];
    const where = [];
    const params = [];

    if (status) {
      params.push(status);
      where.push(`b.status = $${params.length}`);
    }
    if (group) {
      params.push(group);
      where.push(`g.name = $${params.length}`);
    }
    if (search) {
      params.push(`%${search.toLowerCase()}%`);
      where.push(`(LOWER(b.name) LIKE $${params.length} OR LOWER(p.plot_number) LIKE $${params.length})`);
    }
    if (payment_status) {
      params.push(payment_status);
      having.push(`
        CASE
          WHEN pr.total_grant_due IS NULL THEN NULL
          WHEN COALESCE(SUM(pay.amount), 0) >= pr.total_grant_due AND pr.total_grant_due > 0 THEN 'paid'
          WHEN COALESCE(SUM(pay.amount), 0) > 0 THEN 'partial'
          ELSE 'unpaid'
        END = $${params.length}
      `);
    }

    const sql =
      BUYER_LIST_SELECT +
      (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
      BUYER_LIST_GROUP_BY +
      (having.length ? ` HAVING ${having.join(' AND ')}` : '') +
      ' ORDER BY b.created_at DESC';

    const { rows } = await query(sql, params);
    res.json(rows);
  })
);

// GET /api/buyers/:id — full "folder": buyer + plot + payments + documents
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const { rows: buyerRows } = await query(
      `${BUYER_LIST_SELECT} WHERE b.id = $1 ${BUYER_LIST_GROUP_BY}`,
      [req.params.id]
    );
    if (!buyerRows[0]) return res.status(404).json({ error: 'Buyer not found.' });
    const buyer = buyerRows[0];

    const { rows: payments } = await query(
      `SELECT pay.*, u.name AS recorded_by_name
       FROM payments pay
       LEFT JOIN users u ON u.id = pay.recorded_by
       WHERE pay.purchase_record_id = $1
       ORDER BY pay.payment_date DESC, pay.id DESC`,
      [buyer.purchase_record_id]
    );

    const { rows: documents } = await query(
      `SELECT id, document_type, file_name, file_size_bytes, uploaded_at
       FROM documents WHERE buyer_id = $1 ORDER BY uploaded_at DESC`,
      [req.params.id]
    );

    res.json({ ...buyer, payments, documents });
  })
);

// POST /api/buyers — register a new buyer + plot + purchase record (one transaction)
router.post(
  '/',
  requirePermission('buyers:create'),
  requireGroupAccess(groupFromRequestBody),
  asyncHandler(async (req, res) => {
    const {
      name, phone, email, address, next_of_kin, status,
      group_id, plot_number, plot_name, plot_size, plot_size_unit,
      purchase_date, total_grant_due,
    } = req.body;

    if (!name || !group_id || !plot_number) {
      return res.status(400).json({ error: 'name, group_id and plot_number are required.' });
    }

    const client = await getClient();
    try {
      await client.query('BEGIN');

      const { rows: buyerRows } = await client.query(
        `INSERT INTO buyers (name, phone, email, address, next_of_kin, status, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [name, phone || null, email || null, address || null, next_of_kin || null, status || 'existing', req.user.id]
      );
      const buyerId = buyerRows[0].id;

      // Re-use the plot row if it already exists (pre-registered as "available"), else create it.
      const { rows: existingPlot } = await client.query(
        'SELECT id FROM plots WHERE plot_number = $1',
        [plot_number]
      );
      let plotId;
      if (existingPlot[0]) {
        plotId = existingPlot[0].id;
        await client.query(`UPDATE plots SET status = 'sold' WHERE id = $1`, [plotId]);
      } else {
        const { rows: newPlot } = await client.query(
          `INSERT INTO plots (group_id, plot_number, plot_name, plot_size, plot_size_unit, status)
           VALUES ($1, $2, $3, $4, $5, 'sold') RETURNING id`,
          [group_id, plot_number, plot_name || null, plot_size || null, plot_size_unit || 'acres']
        );
        plotId = newPlot[0].id;
      }

      const { rows: prRows } = await client.query(
        `INSERT INTO purchase_records (buyer_id, plot_id, purchase_date, total_grant_due, created_by)
         VALUES ($1, $2, COALESCE($3, CURRENT_DATE), $4, $5) RETURNING id`,
        [buyerId, plotId, purchase_date || null, total_grant_due || 0, req.user.id]
      );

      await client.query('COMMIT');

      await logAction(req.user.id, 'buyer.create', 'buyers', buyerId, { name, plot_number });
      res.status(201).json({ buyer_id: buyerId, plot_id: plotId, purchase_record_id: prRows[0].id });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  })
);

// PATCH /api/buyers/:id — edit buyer contact info / status
router.patch(
  '/:id',
  requirePermission('buyers:edit'),
  requireGroupAccess(groupOfBuyer),
  asyncHandler(async (req, res) => {
    const { name, phone, email, address, next_of_kin, status } = req.body;
    const { rows } = await query(
      `UPDATE buyers SET
         name = COALESCE($1, name),
         phone = COALESCE($2, phone),
         email = COALESCE($3, email),
         address = COALESCE($4, address),
         next_of_kin = COALESCE($5, next_of_kin),
         status = COALESCE($6, status)
       WHERE id = $7 RETURNING *`,
      [name, phone, email, address, next_of_kin, status, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Buyer not found.' });
    await logAction(req.user.id, 'buyer.update', 'buyers', rows[0].id, req.body);
    res.json(rows[0]);
  })
);

// DELETE /api/buyers/:id — Main Admin only, hard delete (cascades to purchase records/payments/docs)
router.delete(
  '/:id',
  requirePermission('buyers:delete'),
  requireGroupAccess(groupOfBuyer),
  asyncHandler(async (req, res) => {
    const { rows } = await query('DELETE FROM buyers WHERE id = $1 RETURNING id', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Buyer not found.' });
    await logAction(req.user.id, 'buyer.delete', 'buyers', rows[0].id, {});
    res.json({ success: true });
  })
);

module.exports = router;
