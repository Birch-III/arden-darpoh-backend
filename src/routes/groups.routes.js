const express = require('express');
const { query } = require('../db/pool');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { logAction } = require('../middleware/auditLog');

const router = express.Router();
router.use(requireAuth);

// GET /api/groups — list all groups with rollup stats.
// total_plots is the group's declared capacity (total_land_size) — NOT a
// count of individual plot rows, since most "available" plots never get an
// explicit row created for them (only sold/reserved/pre-registered ones do).
// available_plots = capacity minus whatever's actually sold or reserved.
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { rows } = await query(`
      SELECT
        g.id, g.name, g.location, g.total_land_size, g.archived,
        g.total_land_size AS total_plots,
        COUNT(p.id) FILTER (WHERE p.status = 'sold') AS sold_plots,
        COUNT(p.id) FILTER (WHERE p.status = 'reserved') AS reserved_plots,
        GREATEST(
          g.total_land_size - COUNT(p.id) FILTER (WHERE p.status IN ('sold', 'reserved')),
          0
        ) AS available_plots,
        COUNT(DISTINCT pr.buyer_id) FILTER (WHERE pr.deleted_at IS NULL) AS buyer_count
      FROM groups g
      LEFT JOIN plots p ON p.group_id = g.id
      LEFT JOIN purchase_records pr ON pr.plot_id = p.id
      WHERE g.archived = false
      GROUP BY g.id, g.name, g.location, g.total_land_size, g.archived
      ORDER BY g.name
    `);
    res.json(rows);
  })
);

// GET /api/groups/:id — one group + its plots/buyers table
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const { rows: groupRows } = await query(`
      SELECT
        g.*,
        g.total_land_size AS total_plots,
        COUNT(p.id) FILTER (WHERE p.status = 'sold') AS sold_plots,
        COUNT(p.id) FILTER (WHERE p.status = 'reserved') AS reserved_plots,
        GREATEST(
          g.total_land_size - COUNT(p.id) FILTER (WHERE p.status IN ('sold', 'reserved')),
          0
        ) AS available_plots
      FROM groups g
      LEFT JOIN plots p ON p.group_id = g.id
      WHERE g.id = $1
      GROUP BY g.id
    `, [req.params.id]);
    if (!groupRows[0]) return res.status(404).json({ error: 'Group not found.' });

    const { rows: plots } = await query(
      `
      SELECT
        p.id AS plot_id, p.plot_number, p.plot_name, p.plot_size, p.plot_size_unit, p.status,
        b.id AS buyer_id, b.name AS buyer_name, b.phone AS buyer_phone,
        pr.id AS purchase_record_id, pr.purchase_date, pr.total_grant_due, pr.fully_paid_flag,
        COALESCE(SUM(pay.amount), 0) AS amount_paid
      FROM plots p
      LEFT JOIN purchase_records pr ON pr.plot_id = p.id AND pr.deleted_at IS NULL
      LEFT JOIN buyers b ON b.id = pr.buyer_id
      LEFT JOIN payments pay ON pay.purchase_record_id = pr.id
      WHERE p.group_id = $1
      GROUP BY p.id, p.plot_number, p.plot_name, p.plot_size, p.plot_size_unit, p.status,
               b.id, b.name, b.phone,
               pr.id, pr.purchase_date, pr.total_grant_due, pr.fully_paid_flag
      ORDER BY p.plot_number
      `,
      [req.params.id]
    );

    res.json({ ...groupRows[0], plots });
  })
);

// POST /api/groups — create a new group (Main Admin or users with groups:manage)
router.post(
  '/',
  requirePermission('groups:manage'),
  asyncHandler(async (req, res) => {
    const { name, location, total_land_size, description } = req.body;
    if (!name) return res.status(400).json({ error: 'Group name is required.' });
    if (total_land_size !== undefined && Number(total_land_size) < 0) {
      return res.status(400).json({ error: 'Total plots cannot be negative.' });
    }

    const { rows } = await query(
      `INSERT INTO groups (name, location, total_land_size, description, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [name, location || null, total_land_size || 0, description || null, req.user.id]
    );
    await logAction(req.user.id, 'group.create', 'groups', rows[0].id, { name });
    res.status(201).json(rows[0]);
  })
);

// PATCH /api/groups/:id — rename / resize a group
router.patch(
  '/:id',
  requirePermission('groups:manage'),
  asyncHandler(async (req, res) => {
    const { name, location, total_land_size, description } = req.body;

    if (total_land_size !== undefined) {
      const { rows: soldCount } = await query(
        `SELECT COUNT(*) AS n FROM plots WHERE group_id = $1 AND status IN ('sold', 'reserved')`,
        [req.params.id]
      );
      if (Number(total_land_size) < Number(soldCount[0].n)) {
        return res.status(400).json({
          error: `Total plots can't be set below ${soldCount[0].n} — that many are already sold or reserved in this group.`,
        });
      }
    }

    const { rows } = await query(
      `UPDATE groups SET
         name = COALESCE($1, name),
         location = COALESCE($2, location),
         total_land_size = COALESCE($3, total_land_size),
         description = COALESCE($4, description)
       WHERE id = $5 RETURNING *`,
      [name, location, total_land_size, description, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Group not found.' });
    await logAction(req.user.id, 'group.update', 'groups', rows[0].id, req.body);
    res.json(rows[0]);
  })
);

// DELETE /api/groups/:id — archive (soft delete) a group
router.delete(
  '/:id',
  requirePermission('groups:manage'),
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      'UPDATE groups SET archived = true WHERE id = $1 RETURNING id',
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Group not found.' });
    await logAction(req.user.id, 'group.archive', 'groups', rows[0].id, {});
    res.json({ success: true });
  })
);

module.exports = router;
