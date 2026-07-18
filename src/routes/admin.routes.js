const express = require('express');
const bcrypt = require('bcryptjs');
const { query } = require('../db/pool');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth } = require('../middleware/auth');
const { requireMainAdmin } = require('../middleware/permissions');
const { logAction } = require('../middleware/auditLog');
const { validatePassword } = require('../utils/passwordPolicy');

const router = express.Router();
router.use(requireAuth);

// GET /api/admin/users — list all admin/sub-admin accounts (Main Admin only)
router.get(
  '/users',
  requireMainAdmin,
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT id, name, email, role, permissions, group_scope, status, created_at
       FROM users ORDER BY created_at ASC`
    );
    res.json(rows);
  })
);

// POST /api/admin/users — create a new Sub-Admin or Read-only user (Main Admin only)
router.post(
  '/users',
  requireMainAdmin,
  asyncHandler(async (req, res) => {
    const { name, email, password, role, permissions, group_scope } = req.body;
    if (!name || !email || !password || !role) {
      return res.status(400).json({ error: 'name, email, password and role are required.' });
    }
    if (!['sub_admin', 'read_only'].includes(role)) {
      return res.status(400).json({ error: 'role must be sub_admin or read_only (Main Admin is set at setup only).' });
    }
    const policyError = validatePassword(password);
    if (policyError) return res.status(400).json({ error: policyError });

    const passwordHash = await bcrypt.hash(password, 10);
    const { rows } = await query(
      `INSERT INTO users (name, email, password_hash, role, permissions, group_scope, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, name, email, role, permissions, group_scope, status, created_at`,
      [
        name,
        email.toLowerCase(),
        passwordHash,
        role,
        JSON.stringify(permissions || []),
        JSON.stringify(group_scope || ['all']),
        req.user.id,
      ]
    );

    await logAction(req.user.id, 'admin.create_user', 'users', rows[0].id, { email, role });
    res.status(201).json(rows[0]);
  })
);

// PATCH /api/admin/users/:id — update a user's permissions, group scope, or status
router.patch(
  '/users/:id',
  requireMainAdmin,
  asyncHandler(async (req, res) => {
    if (Number(req.params.id) === req.user.id) {
      return res.status(400).json({ error: "You can't edit your own permissions." });
    }
    const { name, permissions, group_scope, status } = req.body;
    const { rows } = await query(
      `UPDATE users SET
         name = COALESCE($1, name),
         permissions = COALESCE($2, permissions),
         group_scope = COALESCE($3, group_scope),
         status = COALESCE($4, status)
       WHERE id = $5 AND role != 'main_admin'
       RETURNING id, name, email, role, permissions, group_scope, status`,
      [
        name || null,
        permissions ? JSON.stringify(permissions) : null,
        group_scope ? JSON.stringify(group_scope) : null,
        status || null,
        req.params.id,
      ]
    );
    if (!rows[0]) return res.status(404).json({ error: 'User not found (or cannot modify the Main Admin).' });

    await logAction(req.user.id, 'admin.update_user', 'users', rows[0].id, req.body);
    res.json(rows[0]);
  })
);

// GET /api/admin/audit-log — recent activity across the system (Main Admin only)
router.get(
  '/audit-log',
  requireMainAdmin,
  asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const { rows } = await query(
      `SELECT a.*, u.name AS user_name
       FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
       ORDER BY a.created_at DESC LIMIT $1`,
      [limit]
    );
    res.json(rows);
  })
);

module.exports = router;
