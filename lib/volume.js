'use strict';

const { clamp01 } = require('./bass');

/**
 * createMediaElementSource() often snaps the media element / player volume to 100%.
 * While the bass Web Audio graph is attached, trust lastKnownVolume instead of live reads.
 * Also ignore one-off anomalous 100% player readings that would poison state.
 */

function isAnomalousFullVolume(value, lastKnownVolume, { asPercent = false } = {}) {
  const last = Number(lastKnownVolume);
  if (!isFinite(last) || last >= 0.995) return false;
  const n = Number(value);
  if (!isFinite(n)) return false;
  if (asPercent) return Math.round(n) === 100;
  return n >= 0.995;
}

function snapshotVolumeBeforeWrap({ lastKnownVolume, playerVolumeRaw, alreadyWrapped }) {
  let snap = clamp01(lastKnownVolume);
  const raw = Number(playerVolumeRaw);
  if (isFinite(raw) && raw > 0 && raw <= 100) {
    if (!(alreadyWrapped && isAnomalousFullVolume(raw, lastKnownVolume, { asPercent: true }))) {
      snap = clamp01(raw / 100);
    }
  }
  return snap;
}

function resolveStatusVolume({
  graphActive,
  lastKnownVolume,
  elementVolume,
  playerVolumeRaw,
}) {
  const last = clamp01(lastKnownVolume);
  if (graphActive) {
    // Web Audio path: element/player volume reads are unreliable (often snap to 100%).
    return { volume: last, lastKnownVolume: last };
  }

  if (typeof playerVolumeRaw === 'number' && isFinite(playerVolumeRaw)) {
    const volume = clamp01(playerVolumeRaw / 100);
    if (isAnomalousFullVolume(playerVolumeRaw, last, { asPercent: true })) {
      return { volume: last, lastKnownVolume: last };
    }
    return { volume, lastKnownVolume: volume };
  }

  if (typeof elementVolume === 'number' && isFinite(elementVolume)) {
    const volume = clamp01(elementVolume);
    if (isAnomalousFullVolume(volume, last, { asPercent: false })) {
      return { volume: last, lastKnownVolume: last };
    }
    return { volume, lastKnownVolume: volume };
  }

  return { volume: last, lastKnownVolume: last };
}

module.exports = {
  isAnomalousFullVolume,
  snapshotVolumeBeforeWrap,
  resolveStatusVolume,
};
