// =============================================================================
// Smoke test suite — runs the real Express app + real schema.sql against
// pg-mem, a pure-JS in-memory PostgreSQL emulator. This lets you verify auth,
// permissions, and the core buyer/payment/grant workflow without needing a
// real Postgres server installed.
//
// Run with: npm test
//
// Note: pg-mem is a WIP shim and has a few known quirks (e.g. it can
// occasionally mis-resolve two joined tables that both have a column with
// the exact same name, even when explicitly qualified). Real PostgreSQL does
// not have this issue. Always do a final check against a real Postgres
// database (npm run db:init && npm run db:seed) before going live.
// =============================================================================

process.env.JWT_SECRET = 'test-secret';
process.env.CORS_ORIGIN = '*';

const fs = require('fs');
const path = require('path');
const { newDb } = require('pg-mem');
const bcrypt = require('bcryptjs');

async function main() {
  const db = newDb({ autoCreateForeignKeyIndices: true });
  db.public.registerFunction({
    name: 'now',
    returns: 'timestamp' ,
    implementation: () => new Date(),
  });
  // pg-mem's pg adapter
  const { Pool } = db.adapters.createPg();
  const pool = new Pool();

  const poolModule = require('../src/db/pool');
  poolModule.setPool(pool);

  // ---- run schema ----
  const schema = fs.readFileSync(path.join(__dirname, '..', 'src/db/schema.sql'), 'utf8');
  try {
    await pool.query(schema);
    console.log('✓ schema.sql applied successfully against pg-mem');
  } catch (err) {
    console.error('✗ schema.sql FAILED:', err.message);
    process.exit(1);
  }

  // ---- seed minimal data directly (bypassing seed.js's own pool creation) ----
  const passwordHash = await bcrypt.hash('ChangeMe123!', 10);
  await pool.query(
    `INSERT INTO users (name, email, password_hash, role, permissions, group_scope)
     VALUES ($1, $2, $3, 'main_admin', '[]', '["all"]')`,
    ['Kwabena Owusu', 'admin@ardendarpoh.family', passwordHash]
  );
  const subHash = await bcrypt.hash('ChangeMe123!', 10);
  await pool.query(
    `INSERT INTO users (name, email, password_hash, role, permissions, group_scope)
     VALUES ($1, $2, $3, 'sub_admin', $4, $5)`,
    ['Sarah Adjei', 'sarah@ardendarpoh.family', subHash, JSON.stringify(['buyers:create','payments:record']), JSON.stringify(['Group A'])]
  );
  console.log('✓ seed users inserted');

  // ---- boot the express app on an ephemeral port ----
  const { createApp } = require('../src/app');
  const app = createApp();
  const server = app.listen(0);
  const port = server.address().port;
  const base = `http://localhost:${port}`;

  const results = [];
  function check(name, cond, extra) {
    results.push({ name, pass: !!cond, extra });
    console.log((cond ? '✓' : '✗') + ' ' + name + (extra ? ' — ' + extra : ''));
  }

  // health
  let r = await fetch(base + '/api/health');
  check('GET /api/health returns ok', r.status === 200);

  // login main admin
  r = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@ardendarpoh.family', password: 'ChangeMe123!' }),
  });
  let body = await r.json();
  check('main admin login succeeds', r.status === 200 && body.token, JSON.stringify(body).slice(0,200));
  const adminToken = body.token;

  // login sub admin
  r = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'sarah@ardendarpoh.family', password: 'ChangeMe123!' }),
  });
  body = await r.json();
  check('sub admin login succeeds', r.status === 200 && body.token);
  const subToken = body.token;

  // wrong password
  r = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@ardendarpoh.family', password: 'wrong' }),
  });
  check('wrong password rejected with 401', r.status === 401);

  // create group as main admin
  r = await fetch(base + '/api/groups', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ name: 'Group A', location: 'North Ridge', total_land_size: 84 }),
  });
  body = await r.json();
  check('create Group A as main admin', r.status === 201, JSON.stringify(body).slice(0,200));
  const groupAId = body.id;

  r = await fetch(base + '/api/groups', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ name: 'Group B', location: 'Riverside', total_land_size: 96 }),
  });
  body = await r.json();
  const groupBId = body.id;
  check('create Group B as main admin', r.status === 201);

  // sub-admin tries to create a group -> should be denied (no groups:manage permission)
  r = await fetch(base + '/api/groups', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${subToken}` },
    body: JSON.stringify({ name: 'Group X' }),
  });
  check('sub-admin CANNOT create group (permission denied)', r.status === 403);

  // list groups
  r = await fetch(base + '/api/groups', { headers: { Authorization: `Bearer ${adminToken}` } });
  body = await r.json();
  check('list groups returns 2 groups with rollup stats', Array.isArray(body) && body.length === 2 && 'total_plots' in body[0], JSON.stringify(body));

  // sub-admin creates a buyer in Group A (has permission + scope) -> should succeed
  r = await fetch(base + '/api/buyers', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${subToken}` },
    body: JSON.stringify({
      name: 'Nana Adjoa', phone: '+233 27 888 4410', group_id: groupAId,
      plot_number: 'A-016', plot_size: 0.6, total_grant_due: 4200, status: 'existing',
    }),
  });
  body = await r.json();
  check('sub-admin creates buyer in Group A', r.status === 201, JSON.stringify(body).slice(0,200));
  const buyerId = body.buyer_id;
  const purchaseRecordId = body.purchase_record_id;

  // fetch buyer folder
  r = await fetch(base + '/api/buyers/' + buyerId, { headers: { Authorization: `Bearer ${adminToken}` } });
  body = await r.json();
  check('buyer folder shows correct balance before payment', Number(body.balance) === 4200, JSON.stringify(body));
  check('buyer folder payment_status is unpaid', body.payment_status === 'unpaid');

  // record a partial payment
  r = await fetch(base + '/api/payments', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${subToken}` },
    body: JSON.stringify({ purchase_record_id: purchaseRecordId, amount: 1800, method: 'mobile_money', receipt_number: 'RCT-001' }),
  });
  body = await r.json();
  check('record partial payment succeeds', r.status === 201, JSON.stringify(body));
  check('partial payment does not set fully_paid_flag', body.fully_paid_flag === false);

  // record remaining payment to fully pay it off
  r = await fetch(base + '/api/payments', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${subToken}` },
    body: JSON.stringify({ purchase_record_id: purchaseRecordId, amount: 2400, method: 'cash', receipt_number: 'RCT-002' }),
  });
  body = await r.json();
  check('final payment marks fully_paid_flag true (auto-flag)', body.fully_paid_flag === true, JSON.stringify(body));

  // re-fetch buyer folder -> balance should be 0, status paid
  r = await fetch(base + '/api/buyers/' + buyerId, { headers: { Authorization: `Bearer ${adminToken}` } });
  body = await r.json();
  check('buyer folder balance is 0 after full payment', Number(body.balance) === 0);
  check('buyer folder payment_status is paid', body.payment_status === 'paid');
  check('payment history has 2 entries', body.payments.length === 2, JSON.stringify(body.payments));

  // acknowledge full payment
  r = await fetch(base + `/api/payments/purchase-records/${purchaseRecordId}/acknowledge`, {
    method: 'POST', headers: { Authorization: `Bearer ${subToken}` },
  });
  body = await r.json();
  check('acknowledge fully-paid plot succeeds', r.status === 200 && body.acknowledged_by, JSON.stringify(body));

  // dashboard KPIs
  r = await fetch(base + '/api/dashboard', { headers: { Authorization: `Bearer ${adminToken}` } });
  body = await r.json();
  check('dashboard total_buyers = 1', body.total_buyers === 1, JSON.stringify(body));
  check('dashboard grant totals correct', Number(body.grant.total_due) === 4200 && Number(body.grant.total_collected) === 4200, JSON.stringify(body.grant));

  // sub-admin tries to create an admin user -> denied
  r = await fetch(base + '/api/admin/users', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${subToken}` },
    body: JSON.stringify({ name: 'X', email: 'x@x.com', password: 'pw123456', role: 'sub_admin' }),
  });
  check('sub-admin CANNOT create admin user', r.status === 403);

  // main admin creates an admin user -> succeeds
  r = await fetch(base + '/api/admin/users', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ name: 'Comfort Asante', email: 'comfort@ardendarpoh.family', password: 'pw123456', role: 'read_only', permissions: [], group_scope: ['all'] }),
  });
  body = await r.json();
  check('main admin creates read_only user', r.status === 201, JSON.stringify(body));

  // reports
  r = await fetch(base + '/api/reports/land-availability', { headers: { Authorization: `Bearer ${adminToken}` } });
  check('land-availability report accessible to main admin', r.status === 200);

  r = await fetch(base + '/api/reports/grant-payments', { headers: { Authorization: `Bearer ${subToken}` } });
  check('grant-payments report DENIED to sub-admin without reports:view', r.status === 403);

  // no-auth request rejected
  r = await fetch(base + '/api/buyers');
  check('unauthenticated request rejected with 401', r.status === 401);

  // group-scope enforcement: Sarah is scoped to Group A only
  r = await fetch(base + '/api/buyers', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${subToken}` },
    body: JSON.stringify({
      name: 'Yaw Boateng', group_id: groupBId, // Group B — outside Sarah's scope
      plot_number: 'B-047', total_grant_due: 6500, status: 'existing',
    }),
  });
  check('sub-admin CANNOT create buyer OUTSIDE their group scope (Group B)', r.status === 403, JSON.stringify(await r.clone().json?.() ?? {}));

  server.close();

  const failed = results.filter((x) => !x.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) {
    console.log('FAILED:', failed.map((f) => f.name));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Smoke test crashed:', err);
  process.exit(1);
});
