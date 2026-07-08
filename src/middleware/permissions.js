/**
 * Role-based access control.
 *
 * Roles:
 *  - main_admin : full, unrestricted access to everything. Always passes.
 *  - sub_admin  : access limited to req.user.permissions (array of strings)
 *                 and req.user.group_scope (array of group names, or ["all"]).
 *  - read_only  : can view anything but never passes a permission check.
 */

/** Blocks everyone except the Main Admin. */
function requireMainAdmin(req, res, next) {
  if (req.user?.role !== 'main_admin') {
    return res.status(403).json({ error: 'Only the Main Admin can perform this action.' });
  }
  next();
}

/** Requires a specific permission string, unless the user is the Main Admin. */
function requirePermission(permission) {
  return (req, res, next) => {
    if (req.user?.role === 'main_admin') return next();
    const perms = Array.isArray(req.user?.permissions) ? req.user.permissions : [];
    if (perms.includes(permission)) return next();
    return res.status(403).json({
      error: `You don't have permission to do this (requires "${permission}").`,
    });
  };
}

/**
 * Requires the user's group_scope to include the resource's group name (or "all").
 * groupNameResolver(req) -> group name string, or a Promise resolving to one.
 * Returning null/undefined lets the request through (e.g. resource not found —
 * let the route handler itself return the 404 rather than masking it as a 403).
 */
function requireGroupAccess(groupNameResolver) {
  return async (req, res, next) => {
    try {
      if (req.user?.role === 'main_admin') return next();
      const scope = Array.isArray(req.user?.group_scope) ? req.user.group_scope : [];
      if (scope.includes('all')) return next();

      const targetGroup = await groupNameResolver(req);
      if (!targetGroup) return next(); // let the route report "not found" itself
      if (scope.includes(targetGroup)) return next();

      return res.status(403).json({ error: 'You do not have access to this group.' });
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { requireMainAdmin, requirePermission, requireGroupAccess };
