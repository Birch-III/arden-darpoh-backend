const express = require('express');
const { query } = require('../db/pool');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');

const router = express.Router();
router.use(requireAuth);
router.use(requirePermission('reports:view'));

// GET /api/reports/land-availability — sold/reserved/available per group + town-wide
router.get(
  '/land-availability',
  asyncHandler(async (req, res) => {
    const { rows } = await query(`
      SELECT
        g.name AS group_name, g.location,
        COUNT(p.id) AS total_plots,
        COUNT(p.id) FILTER (WHERE p.status = 'sold') AS sold_plots,
        COUNT(p.id) FILTER (WHERE p.status = 'reserved') AS reserved_plots,
        COUNT(p.id) FILTER (WHERE p.status = 'available') AS available_plots
      FROM groups g
      LEFT JOIN plots p ON p.group_id = g.id
      WHERE g.archived = false
      GROUP BY g.name, g.location
      ORDER BY g.name
    `);
    res.json(rows);
  })
);

// GET /api/reports/grant-payments — every buyer's grant status with aging
router.get(
  '/grant-payments',
  asyncHandler(async (req, res) => {
    const { rows } = await query(`
      SELECT
        b.name AS buyer_name, g.name AS group_name, p.plot_number,
        pr.total_grant_due,
        COALESCE(SUM(pay.amount), 0) AS amount_paid,
        (pr.total_grant_due - COALESCE(SUM(pay.amount), 0)) AS balance,
        MAX(pay.payment_date) AS last_payment_date,
        CASE
          WHEN COALESCE(SUM(pay.amount), 0) >= pr.total_grant_due AND pr.total_grant_due > 0 THEN 'paid'
          WHEN COALESCE(SUM(pay.amount), 0) > 0 THEN 'partial'
          ELSE 'unpaid'
        END AS payment_status,
        CASE WHEN MAX(pay.payment_date) IS NOT NULL
          THEN (CURRENT_DATE - MAX(pay.payment_date))
          ELSE (CURRENT_DATE - pr.purchase_date)
        END AS days_since_last_payment
      FROM purchase_records pr
      JOIN buyers b ON b.id = pr.buyer_id
      JOIN plots p ON p.id = pr.plot_id
      JOIN groups g ON g.id = p.group_id
      LEFT JOIN payments pay ON pay.purchase_record_id = pr.id
      GROUP BY b.name, g.name, p.plot_number, pr.id, pr.total_grant_due, pr.purchase_date
      ORDER BY balance DESC
    `);
    res.json(rows);
  })
);

// GET /api/reports/buyer-directory — full contact + plot list
router.get(
  '/buyer-directory',
  asyncHandler(async (req, res) => {
    const { rows } = await query(`
      SELECT
        b.name, b.phone, b.email, b.status AS buyer_status,
        g.name AS group_name, p.plot_number, p.plot_size, p.plot_size_unit,
        pr.purchase_date
      FROM buyers b
      LEFT JOIN purchase_records pr ON pr.buyer_id = b.id
      LEFT JOIN plots p ON p.id = pr.plot_id
      LEFT JOIN groups g ON g.id = p.group_id
      ORDER BY b.name
    `);
    res.json(rows);
  })
);

module.exports = router;
