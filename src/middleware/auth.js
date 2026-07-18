const jwt = require('jsonwebtoken');
const { query } = require('../db/pool');

/**
 * Verifies the Bearer token, then looks up the CURRENT user row from the
 * database and attaches it to req.user.
 *
 * Why look the user up again instead of just trusting the token's payload?
 * A JWT is only proof of *identity* (who you logged in as) — it should not
 * be trusted as the source of truth for *authorization* (what you're
 * currently allowed to do), because that can go stale. Without this
 * lookup, disabling a user or changing their permissions wouldn't take
 * effect until their existing token naturally expired (up to JWT_EXPIRES_IN,
 * e.g. 12 hours) — a real security gap for something like disabling a
 * sub-admin who's leaving on bad terms. Re-checking on every request closes
 * that gap at the cost of one indexed lookup by primary key per request,
 * which is cheap.
 */
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header.' });
  }

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: 'Session expired or invalid. Please log in again.' });
  }

  // A token issued mid-way through a two-factor login (before the code was
  // verified) carries purpose:'mfa_pending' and must NEVER be accepted as a
  // real session — otherwise 2FA would be pure theater: an attacker with
  // just the password could use this token directly against every other
  // route without ever supplying the second factor.
  if (payload.purpose === 'mfa_pending') {
    return res.status(401).json({ error: 'Two-factor verification required.' });
  }

  try {
    const { rows } = await query(
      `SELECT id, name, email, role, permissions, group_scope, status, totp_enabled FROM users WHERE id = $1`,
      [payload.id]
    );
    const user = rows[0];
    if (!user) {
      return res.status(401).json({ error: 'This account no longer exists. Please log in again.' });
    }
    if (user.status === 'disabled') {
      return res.status(401).json({ error: 'This account has been disabled.' });
    }
    // req.user now reflects live DB state, not whatever was true at login time.
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { requireAuth };
