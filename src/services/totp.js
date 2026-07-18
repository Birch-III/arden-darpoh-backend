const { generateSecret, generate, verify, generateURI } = require('otplib');
const QRCode = require('qrcode');

const ISSUER = 'Arden Darpoh Family Land';

/** Generates a new random TOTP secret for a user (not yet confirmed/enabled). */
function makeSecret() {
  return generateSecret();
}

/** Builds the otpauth:// URL an authenticator app needs, and renders it as a scannable QR code (data URL). */
async function buildSetupPayload(email, secret) {
  const otpauthUrl = generateURI({ issuer: ISSUER, label: email, secret });
  const qrDataUrl = await QRCode.toDataURL(otpauthUrl);
  return { otpauthUrl, qrDataUrl, secret };
}

/** Verifies a 6-digit code against a stored secret. Returns a plain boolean (otplib itself returns a result object). */
async function verifyCode(code, secret) {
  if (!code || !secret) return false;
  try {
    const result = await verify({ secret, token: String(code).trim() });
    return !!result.valid;
  } catch (err) {
    return false;
  }
}

/** Generates the current valid code for a secret — only used by tests, to simulate an authenticator app. */
async function currentCodeForTesting(secret) {
  return generate({ secret });
}

module.exports = { makeSecret, buildSetupPayload, verifyCode, currentCodeForTesting };
