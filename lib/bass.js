'use strict';

/**
 * Shared bass-cut math used by the extension content script (mirrored there for
 * browser isolation — no bundler). Keep these defaults in sync with
 * extension/content.js BASS_CONFIG.
 */
const BASS_DEFAULTS = Object.freeze({
  // Low-shelf corner frequency (Hz). Verified working range ~150–250.
  frequencyHz: 200,
  // Slider 0 = neutral (0 dB); slider 1 = max attenuation (negative dB).
  maxCutDb: 30,
  defaultAmount: 0,
  q: 0.7,
});

function clamp01(n) {
  n = Number(n);
  if (!isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function amountToDb(amount, maxCutDb = BASS_DEFAULTS.maxCutDb) {
  const maxCut = Number(maxCutDb);
  const cut = Number.isFinite(maxCut) && maxCut > 0 ? maxCut : BASS_DEFAULTS.maxCutDb;
  const db = -cut * clamp01(amount);
  return Object.is(db, -0) ? 0 : db;
}

function dbToAmount(db, maxCutDb = BASS_DEFAULTS.maxCutDb) {
  const maxCut = Number(maxCutDb);
  const cut = Number.isFinite(maxCut) && maxCut > 0 ? maxCut : BASS_DEFAULTS.maxCutDb;
  const n = Number(db);
  if (!isFinite(n) || n >= 0) return 0;
  return clamp01((-n) / cut);
}

module.exports = {
  BASS_DEFAULTS,
  clamp01,
  amountToDb,
  dbToAmount,
};
