require('dotenv').config();
const bcrypt = require('bcryptjs');
const { getPool } = require('./pool');

async function run() {
  const [,, email, newPassword] = process.argv;
  if (!email || !newPassword) {
    console.error('Usage: node src/db/set-password.js <email> <new-password>');
    process.exit(1);
  }
  const pool = getPool();
  const hash = await bcrypt.hash(newPassword, 10);
  const { rows } = await pool.query(
    `UPDATE users SET password_hash = $1 WHERE email = $2 RETURNING id, name, email`,
    [hash, email.toLowerCase()]
  );
  if (!rows[0]) {
    console.error('No user found with that email.');
    process.exit(1);
  }
  console.log(`Password updated for ${rows[0].name} (${rows[0].email})`);
  await pool.end();
}

run().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});
