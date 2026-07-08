require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { getPool } = require('./pool');

async function init() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  const pool = getPool();
  console.log('Running schema.sql against', process.env.DATABASE_URL.replace(/:[^:@]+@/, ':****@'));
  await pool.query(schema);
  console.log('✓ Database schema is up to date.');
  await pool.end();
}

init().catch((err) => {
  console.error('✗ Failed to initialize database:', err.message);
  process.exit(1);
});
