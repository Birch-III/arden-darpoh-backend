const express = require('express');
const { query } = require('../db/pool');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { logAction } = require('../middleware/auditLog');

const router = express.Router();
router.use(requireAuth);

// GET /api/plots?group_id=&status=available — used when registering a new buyer
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const conditions = [];
    const params = [];

    if (req.query.group_id) {
      params.push(req.query.group_id);
      conditions.push(`group_id = $${params.length}`);
    }
    if (req.query.status) {
      params.push(req.query.status);
      conditions.push(`status = $${params.length}`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const { rows } = await query(`SELECT * FROM plots ${where} ORDER BY plot_number`, params);
    res.json(rows);
  })
);

// POST /api/plots — pre-register an available plot (no buyer yet)
router.post(
  '/',
  requirePermission('groups:manage'),
  asyncHandler(async (req, res) => {
    const { group_id, plot_number, plot_name, plot_size, plot_size_unit, latitude, longitude } = req.body;
    if (!group_id || !plot_number) {
      return res.status(400).json({ error: 'group_id and plot_number are required.' });
    }
    const { rows } = await query(
      `INSERT INTO plots (group_id, plot_number, plot_name, plot_size, plot_size_unit, latitude, longitude, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'available') RETURNING *`,
      [group_id, plot_number, plot_name || null, plot_size || null, plot_size_unit || 'acres', latitude || null, longitude || null]
    );
    await logAction(req.user.id, 'plot.create', 'plots', rows[0].id, { plot_number });
    res.status(201).json(rows[0]);
  })
);

// PATCH /api/plots/:id
router.patch(
  '/:id',
  requirePermission('groups:manage'),
  asyncHandler(async (req, res) => {
    const { plot_name, plot_size, plot_size_unit, status, latitude, longitude } = req.body;
    const { rows } = await query(
      `UPDATE plots SET
         plot_name = COALESCE($1, plot_name),
         plot_size = COALESCE($2, plot_size),
         plot_size_unit = COALESCE($3, plot_size_unit),
         status = COALESCE($4, status),
         latitude = COALESCE($5, latitude),
         longitude = COALESCE($6, longitude)
       WHERE id = $7 RETURNING *`,
      [plot_name, plot_size, plot_size_unit, status, latitude, longitude, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Plot not found.' });
    await logAction(req.user.id, 'plot.update', 'plots', rows[0].id, req.body);
    res.json(rows[0]);
  })
);

module.exports = router;
