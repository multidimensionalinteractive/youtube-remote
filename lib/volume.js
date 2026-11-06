'use strict';

const { clamp01 } = require('./bass');

/**
 * Loudness while the bass Web Audio graph is active is owned by a persistent GainNode:
 *   MediaElementSource → lowshelf BiquadFilter → GainNode → destination
 *
 * Heuristics that only filter polluted element/player reads (old lastKnownVolume approach)
 * are not sufficient: a newly inserted <video> can still play at real 100% on the default
 * route before re-wrap. The live architecture clamps new videos immediately, wraps on play
 * + MutationObserver (+ 500ms backup), and reports GainNode.gain as status.volume.
 */

function resolveStatusVolume({ gainNodeValue, playerVolumeRaw, elementVolume, lastKnownVolume }) {
  if (typeof gainNodeValue === 'number' && isFinite(gainNodeValue)) {
    const volume = clamp01(gainNodeValue);
    return { volume, lastKnownVolume: volume, authority: 'gain' };
  }
  if (typeof playerVolumeRaw === 'number' && isFinite(playerVolumeRaw)) {
    const volume = clamp01(playerVolumeRaw / 100);
    return { volume, lastKnownVolume: volume, authority: 'player' };
  }
  if (typeof elementVolume === 'number' && isFinite(elementVolume)) {
    const volume = clamp01(elementVolume);
    return { volume, lastKnownVolume: volume, authority: 'element' };
  }
  const last = clamp01(lastKnownVolume);
  return { volume: last, lastKnownVolume: last, authority: 'lastKnown' };
}

/**
 * Simulate the pre-wrap clamp used when YouTube inserts a new <video> at default 1.0.
 */
function clampNewVideoElementVolume(elementVolume, desiredVolume) {
  const desired = clamp01(desiredVolume);
  const current = Number(elementVolume);
  if (!isFinite(current)) return desired;
  if (Math.abs(current - desired) > 0.01) return desired;
  return current;
}

/**
 * After createMediaElementSource, leave element.volume at 1 and drive loudness via GainNode
 * so element attenuation is not double-applied with the gain node.
 */
function postWrapElementAndGain(desiredVolume) {
  const gain = clamp01(desiredVolume);
  return { elementVolume: 1, gainValue: gain };
}

/**
 * Model swapping to a new media element while a persistent GainNode keeps loudness.
 */
function applyMediaSwap({ previousGain, desiredVolume, newElementDefaultVolume = 1 }) {
  const desired = clamp01(desiredVolume != null ? desiredVolume : previousGain);
  const clampedElement = clampNewVideoElementVolume(newElementDefaultVolume, desired);
  // Wrap attaches source→filter→gain; gain remains the authority.
  const wrapped = postWrapElementAndGain(desired);
  return {
    preWrapElementVolume: clampedElement,
    elementVolume: wrapped.elementVolume,
    gainValue: wrapped.gainValue,
    statusVolume: wrapped.gainValue,
  };
}

module.exports = {
  resolveStatusVolume,
  clampNewVideoElementVolume,
  postWrapElementAndGain,
  applyMediaSwap,
};
