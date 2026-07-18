const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const totp = require('../services/totp');
const { query } = require('../db/pool');
const asyncHandler = require('../utils/asyncHandler');
const { logAction } = require('../middleware/auditLog');
const { requireAuth } = require('../middleware/auth');
const { loginLimiter, passwordChangeLimiter, mfaVerifyLimiter } = require('../middleware/rateLimiters');
const { validatePassword } = require('../utils/passwordPolicy');

const router = express.Router();

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    permissions: user.permissions,
    group_scope: user.group_scope,
    totp_enabled: user.totp_enabled,
  };
}

function issueSessionToken(userId) {
  return jwt.sign({ id: userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '12h',
  });
}

// POST /api/auth/login
router.post(
  '/login',
  loginLimiter,
  asyncHandler(async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const { rows } = await query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
    const user = rows[0];

    if (!user || user.status === 'disabled') {
      return res.status(401).json({ error: 'Incorrect email or password.' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Incorrect email or password.' });
    }

    if (user.totp_enabled) {
      // Password is correct, but two-factor isn't done yet. Issue a short-lived,
      // clearly-marked "pending" token — NOT a real session — that only proves
      // "this person knew the password." See auth.js's rejection of
      // purpose:'mfa_pending' for why this can't be used as a real session on
      // its own.
      const mfaToken = jwt.sign({ id: user.id, purpose: 'mfa_pending' }, process.env.JWT_SECRET, {
        expiresIn: '5m',
      });
      return res.json({ mfa_required: true, mfa_token: mfaToken });
    }

    const token = issueSessionToken(user.id);
    await logAction(user.id, 'auth.login', 'users', user.id, {});
    res.json({ token, user: publicUser(user) });
  })
);

// POST /api/auth/2fa/verify — second step of login when 2FA is enabled
router.post(
  '/2fa/verify',
  mfaVerifyLimiter,
  asyncHandler(async (req, res) => {
    const { mfa_token, code } = req.body;
    if (!mfa_token || !code) {
      return res.status(400).json({ error: 'A verification code is required.' });
    }

    let payload;
    try {
      payload = jwt.verify(mfa_token, process.env.JWT_SECRET);
    } catch (err) {
      return res.status(401).json({ error: 'Your verification session expired. Please log in again.' });
    }
    if (payload.purpose !== 'mfa_pending') {
      return res.status(401).json({ error: 'Invalid verification request.' });
    }

    const { rows } = await query('SELECT * FROM users WHERE id = $1', [payload.id]);
    const user = rows[0];
    if (!user || user.status === 'disabled' || !user.totp_enabled || !user.totp_secret) {
      return res.status(401).json({ error: 'Two-factor authentication is not available for this account.' });
    }

    const valid = await totp.verifyCode(code, user.totp_secret);
    if (!valid) {
      return res.status(401).json({ error: 'Incorrect code. Please try again.' });
    }

    const token = issueSessionToken(user.id);
    await logAction(user.id, 'auth.login', 'users', user.id, { via: '2fa' });
    res.json({ token, user: publicUser(user) });
  })
);

// GET /api/auth/me  (used by the frontend to restore a session on page load)
router.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({ user: req.user });
  })
);

// PATCH /api/auth/me/password — change your own password
router.patch(
  '/me/password',
  requireAuth,
  passwordChangeLimiter,
  asyncHandler(async (req, res) => {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password) {
      return res.status(400).json({ error: 'Current password and new password are required.' });
    }
    const policyError = validatePassword(new_password);
    if (policyError) return res.status(400).json({ error: policyError });

    const { rows } = await query('SELECT * FROM users WHERE id = $1', [req.user.id]);
    const user = rows[0];
    if (!user) return res.status(404).json({ error: 'Account not found.' });

    const valid = await bcrypt.compare(current_password, user.password_hash);
    if (!valid) {
      // 400, not 401: this is a validation failure on input ("you typed the
      // wrong current password"), not a session problem. The frontend's
      // api() helper treats any 401 from an authenticated request as "your
      // session is invalid, log out" — using 401 here would incorrectly
      // force-logout someone who just fat-fingered their current password.
      return res.status(400).json({ error: 'Current password is incorrect.' });
    }

    const newHash = await bcrypt.hash(new_password, 10);
    await query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, user.id]);

    await logAction(user.id, 'auth.change_password', 'users', user.id, {});

    res.json({ success: true });
  })
);

// GET /api/auth/2fa/setup — generates a new secret + QR code, NOT yet enabled
// until confirmed via /2fa/enable. Calling this again before confirming just
// replaces the pending secret (harmless — nothing was enabled yet). Calling
// it while 2FA is already ON will require re-confirmation to stay enabled,
// so the frontend should steer people to /2fa/disable first if they already
// have it on and just want to reconfigure.
router.get(
  '/2fa/setup',
  requireAuth,
  asyncHandler(async (req, res) => {
    const secret = totp.makeSecret();
    await query('UPDATE users SET totp_secret = $1, totp_enabled = false WHERE id = $2', [secret, req.user.id]);

    const { qrDataUrl, otpauthUrl } = await totp.buildSetupPayload(req.user.email, secret);
    res.json({ secret, otpauth_url: otpauthUrl, qr_code: qrDataUrl });
  })
);

// POST /api/auth/2fa/enable — confirms setup with a real code from the app
router.post(
  '/2fa/enable',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'Enter the 6-digit code from your authenticator app.' });

    const { rows } = await query('SELECT totp_secret FROM users WHERE id = $1', [req.user.id]);
    const secret = rows[0]?.totp_secret;
    if (!secret) return res.status(400).json({ error: 'Start setup first.' });

    const valid = await totp.verifyCode(code, secret);
    if (!valid) return res.status(400).json({ error: 'Incorrect code. Please try again.' });

    await query('UPDATE users SET totp_enabled = true WHERE id = $1', [req.user.id]);
    await logAction(req.user.id, 'auth.2fa_enabled', 'users', req.user.id, {});
    res.json({ success: true });
  })
);

// POST /api/auth/2fa/disable — requires current password, not just being logged in
router.post(
  '/2fa/disable',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'Enter your password to disable two-factor authentication.' });

    const { rows } = await query('SELECT * FROM users WHERE id = $1', [req.user.id]);
    const user = rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    // Same reasoning as the password-change route above: this is a wrong-input
    // validation failure, not a session problem — must not be 401, or the
    // frontend's blanket "401 = force logout" handling would wrongly nuke
    // an active session over a mistyped password.
    if (!valid) return res.status(400).json({ error: 'Incorrect password.' });

    await query('UPDATE users SET totp_enabled = false, totp_secret = NULL WHERE id = $1', [req.user.id]);
    await logAction(req.user.id, 'auth.2fa_disabled', 'users', req.user.id, {});
    res.json({ success: true });
  })
);

module.exports = router;
