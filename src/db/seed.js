require('dotenv').config();
const bcrypt = require('bcryptjs');
const { getPool } = require('./pool');

async function seed() {
  const pool = getPool();

  console.log('Seeding database...');

  // ---- Main Admin ----
  const passwordHash = await bcrypt.hash('ChangeMe123!', 10);
  const { rows: adminRows } = await pool.query(
    `INSERT INTO users (name, email, password_hash, role, permissions, group_scope)
     VALUES ($1, $2, $3, 'main_admin', '[]', '["all"]')
     ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    ['Kwabena Owusu', 'admin@ardendarpoh.family', passwordHash]
  );
  const mainAdminId = adminRows[0].id;

  // ---- A sample sub-admin ----
  const subPasswordHash = await bcrypt.hash('ChangeMe123!', 10);
  await pool.query(
    `INSERT INTO users (name, email, password_hash, role, permissions, group_scope, created_by)
     VALUES ($1, $2, $3, 'sub_admin', $4, $5, $6)
     ON CONFLICT (email) DO NOTHING`,
    [
      'Sarah Adjei',
      'sarah@ardendarpoh.family',
      subPasswordHash,
      JSON.stringify(['buyers:create', 'payments:record', 'documents:upload']),
      JSON.stringify(['Group A', 'Group B']),
      mainAdminId,
    ]
  );

  // ---- Groups ----
  const groupDefs = [
    ['Group A', 'North Ridge', 84],
    ['Group B', 'Riverside', 96],
    ['Group C', 'Hilltop', 78],
    ['Group D', 'Eastfields', 54],
  ];
  const groupIds = {};
  for (const [name, location, size] of groupDefs) {
    const { rows } = await pool.query(
      `INSERT INTO groups (name, location, total_land_size, created_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (name) DO UPDATE SET location = EXCLUDED.location
       RETURNING id`,
      [name, location, size, mainAdminId]
    );
    groupIds[name] = rows[0].id;
  }

  // ---- Buyers + plots + purchase records + payments ----
  const buyerDefs = [
    {
      name: 'Ama Serwaa', phone: '+233 24 555 0199', group: 'Group A', plot: 'A-014',
      plotSize: 0.5, plotName: 'Riverside Rd, Lot 14', purchaseDate: '2024-03-12',
      totalDue: 3200, paid: 3200, status: 'existing',
    },
    {
      name: 'Kofi Antwi', phone: '+233 20 111 8823', group: 'Group A', plot: 'A-015',
      plotSize: 0.4, plotName: 'Riverside Rd, Lot 15', purchaseDate: '2024-04-28',
      totalDue: 3600, paid: 1800, status: 'existing',
    },
    {
      name: 'Nana Adjoa', phone: '+233 27 888 4410', group: 'Group A', plot: 'A-016',
      plotSize: 0.6, plotName: 'Riverside Rd, Lot 16', purchaseDate: '2024-01-03',
      totalDue: 4200, paid: 0, status: 'existing', nextOfKin: 'Kwesi Adjoa',
    },
    {
      name: 'Efua Owusu', phone: '+233 24 302 7761', group: 'Group A', plot: 'A-017',
      plotSize: 0.5, plotName: 'Riverside Rd, Lot 17', purchaseDate: '2024-06-19',
      totalDue: 2900, paid: 2900, status: 'existing',
    },
    {
      name: 'Yaw Boateng', phone: '+233 55 214 7790', group: 'Group B', plot: 'B-047',
      plotSize: 0.5, plotName: 'Riverside Zone B, Lot 47', purchaseDate: '2023-11-15',
      totalDue: 6500, paid: 0, status: 'existing',
    },
    {
      name: 'Kojo Mensah', phone: '+233 26 470 3312', group: 'Group C', plot: 'C-102',
      plotSize: 0.5, plotName: 'Hilltop Zone C, Lot 102', purchaseDate: '2026-07-04',
      totalDue: 3000, paid: 0, status: 'prospective',
    },
  ];

  for (const b of buyerDefs) {
    const { rows: buyerRows } = await pool.query(
      `INSERT INTO buyers (name, phone, next_of_kin, status, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [b.name, b.phone, b.nextOfKin || null, b.status, mainAdminId]
    );
    const buyerId = buyerRows[0].id;

    const { rows: plotRows } = await pool.query(
      `INSERT INTO plots (group_id, plot_number, plot_name, plot_size, status)
       VALUES ($1, $2, $3, $4, 'sold')
       ON CONFLICT (plot_number) DO UPDATE SET plot_name = EXCLUDED.plot_name
       RETURNING id`,
      [groupIds[b.group], b.plot, b.plotName, b.plotSize]
    );
    const plotId = plotRows[0].id;

    const { rows: prRows } = await pool.query(
      `INSERT INTO purchase_records (buyer_id, plot_id, purchase_date, total_grant_due, fully_paid_flag, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [buyerId, plotId, b.purchaseDate, b.totalDue, b.paid >= b.totalDue, mainAdminId]
    );
    const purchaseRecordId = prRows[0].id;

    if (b.paid > 0) {
      await pool.query(
        `INSERT INTO payments (purchase_record_id, amount, payment_date, method, receipt_number, recorded_by)
         VALUES ($1, $2, $3, 'mobile_money', $4, $5)`,
        [purchaseRecordId, b.paid, b.purchaseDate, `RCT-${plotId}-001`, mainAdminId]
      );
    }

    if (b.paid >= b.totalDue && b.totalDue > 0) {
      await pool.query(
        `UPDATE purchase_records SET acknowledged_by = $1, acknowledgement_date = now() WHERE id = $2`,
        [mainAdminId, purchaseRecordId]
      );
    }
  }

  // A few remaining "available" plots per group, unattached to any buyer.
  const availablePlots = [
    ['Group A', 'A-018', 0.5], ['Group A', 'A-019', 0.4],
    ['Group B', 'B-048', 0.5], ['Group B', 'B-049', 0.6],
    ['Group C', 'C-103', 0.5], ['Group C', 'C-104', 0.5],
    ['Group D', 'D-001', 0.5], ['Group D', 'D-002', 0.5],
  ];
  for (const [group, plotNumber, size] of availablePlots) {
    await pool.query(
      `INSERT INTO plots (group_id, plot_number, plot_size, status)
       VALUES ($1, $2, $3, 'available')
       ON CONFLICT (plot_number) DO NOTHING`,
      [groupIds[group], plotNumber, size]
    );
  }

  console.log('✓ Seed complete.');
  console.log('  Main Admin login → email: admin@ardendarpoh.family  password: ChangeMe123!');
  console.log('  Sub-Admin login  → email: sarah@ardendarpoh.family  password: ChangeMe123!');
  console.log('  ⚠ Change these passwords immediately in a real deployment.');

  await pool.end();
}

seed().catch((err) => {
  console.error('✗ Seed failed:', err);
  process.exit(1);
});
