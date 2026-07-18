const rateLimit = require('express-rate-limit');

/**
 * Limits login attempts per IP. This is the single most important gap this
 * system had — without it, nothing stops a scripted brute-force attempt
 * against the login endpoint. 8 attempts per 15 minutes is generous enough
 * for a real person who fat-fingered their password a few times, but slows
 * an automated attacker to a crawl (a handful of guesses every 15 minutes
 * is not a workable brute-force rate).
 */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please wait 15 minutes and try again.' },
});

/**
 * Same idea for the "change my password" endpoint — it also checks a
 * password (the current one), so it deserves the same protection, just
 * slightly less strict since the requester is already authenticated.
 */
const passwordChangeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait 15 minutes and try again.' },
});

/**
 * A TOTP code is only 6 digits — without limiting attempts, brute-forcing
 * one within its ~90 second validity window would be feasible for an
 * automated attacker. Same strictness as login.
 */
const mfaVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many verification attempts. Please wait 15 minutes and try again.' },
});

module.exports = { loginLimiter, passwordChangeLimiter, mfaVerifyLimiter };
