const express = require('express');
const { query } = require('../db/pool');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/dashboard — town-wide KPIs for the overview screen
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const [buyers, plots, grant, byGroup, overdue] = await Promise.all([
      query(`SELECT COUNT(*) AS total_buyers FROM buyers`),
      query(`
        SELECT
          COUNT(*) AS total_plots,
          COUNT(*) FILTER (WHERE status = 'sold') AS sold_plots,
          COUNT(*) FILTER (WHERE status = 'available') AS available_plots,
          COUNT(*) FILTER (WHERE status = 'reserved') AS reserved_plots
        FROM plots
      `),
      query(`
        SELECT
          COALESCE(SUM(pr.total_grant_due), 0) AS total_due,
          COALESCE(SUM(paid.amount_paid), 0) AS total_collected
        FROM purchase_records pr
        LEFT JOIN (
          SELECT purchase_record_id, SUM(amount) AS amount_paid
          FROM payments GROUP BY purchase_record_id
        ) paid ON paid.purchase_record_id = pr.id
      `),
      query(`
        SELECT
          g.name,
          COUNT(p.id) AS total_plots,
          COUNT(p.id) FILTER (WHERE p.status = 'sold') AS sold_plots,
          COUNT(p.id) FILTER (WHERE p.status = 'reserved') AS reserved_plots,
          COUNT(p.id) FILTER (WHERE p.status = 'available') AS available_plots
        FROM groups g
        LEFT JOIN plots p ON p.group_id = g.id
        WHERE g.archived = false
        GROUP BY g.name ORDER BY g.name
      `),
      query(`
        SELECT * FROM (
          SELECT b.id, b.name, p.plot_number,
                 (pr.total_grant_due - COALESCE(SUM(pay.amount), 0)) AS balance,
                 MAX(pay.payment_date) AS last_payment_date
          FROM purchase_records pr
          JOIN buyers b ON b.id = pr.buyer_id
          JOIN plots p ON p.id = pr.plot_id
          LEFT JOIN payments pay ON pay.purchase_record_id = pr.id
          GROUP BY b.id, b.name, p.plot_number, pr.id, pr.total_grant_due
        ) sub
        WHERE balance > 0
          AND (last_payment_date IS NULL OR last_payment_date < CURRENT_DATE - INTERVAL '90 days')
        ORDER BY balance DESC
        LIMIT 10
      `),
    ]);

    res.json({
      total_buyers: Number(buyers.rows[0].total_buyers),
      plots: plots.rows[0],
      grant: {
        total_due: Number(grant.rows[0].total_due),
        total_collected: Number(grant.rows[0].total_collected),
        total_outstanding: Number(grant.rows[0].total_due) - Number(grant.rows[0].total_collected),
      },
      by_group: byGroup.rows,
      overdue_buyers: overdue.rows,
    });
  })
);

module.exports = router;
