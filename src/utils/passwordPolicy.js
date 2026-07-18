/**
 * Returns null if the password is acceptable, or a user-facing error string if not.
 * Deliberately not overly strict (no special-character requirement) — this is a
 * small family system, not a bank, and overly strict rules just push people
 * toward writing passwords down. Length + a mix of letters and numbers is a
 * reasonable floor.
 */
function validatePassword(password) {
  if (!password || password.length < 8) {
    return 'Password must be at least 8 characters.';
  }
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    return 'Password must include at least one letter and one number.';
  }
  return null;
}

module.exports = { validatePassword };
