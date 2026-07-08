const { query } = require('../db/pool');

/**
 * Records an entry in audit_log. Never throws — a logging failure should
 * never break the actual request.
 */
async function logAction(userId, action, targetTable, targetId, details = {}) {
  try {
    await query(
      `INSERT INTO audit_log (user_id, action, target_table, target_id, details)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId ?? null, action, targetTable ?? null, targetId ?? null, JSON.stringify(details)]
    );
  } catch (err) {
    console.error('Failed to write audit log:', err.message);
  }
}

module.exports = { logAction };
