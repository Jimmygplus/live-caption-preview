export const AUDIO_SIGNAL_MIN_RMS = 0.0015;
export const AUDIO_SIGNAL_WARN_AFTER_MS = 4_000;

export function defaultAudioSourceValue(availableDeviceIds = []) {
  return availableDeviceIds.includes('default') ? 'default' : availableDeviceIds[0] || '';
}

export function isDefaultAudioSource(value) {
  return value === '' || value === 'default';
}

export function resolveAudioSourcePreference(savedSource, availableDeviceIds = []) {
  const fallback = defaultAudioSourceValue(availableDeviceIds);
  if (savedSource === null) return { value: fallback, remove: false };
  if (!savedSource || savedSource === 'display') return { value: fallback, remove: true };
  if (availableDeviceIds.includes(savedSource)) return { value: savedSource, remove: false };
  return { value: fallback, remove: true };
}

export function defaultAudioSourceLabel(label = '') {
  const routed = label
    .replace(/^default\s*-\s*/i, '')
    .replace(/^default\s*\((.*)\)$/i, '$1')
    .trim();
  return routed ? `Default · ${routed}` : 'Default microphone';
}

export function classifyAudioSignal({ rms = 0, gated = false, elapsedMs = 0, hasDetectedSignal = false }) {
  if (rms >= AUDIO_SIGNAL_MIN_RMS) return gated ? 'gated' : 'active';
  if (gated && rms >= AUDIO_SIGNAL_MIN_RMS / 8) return 'gated';
  if (!hasDetectedSignal && elapsedMs >= AUDIO_SIGNAL_WARN_AFTER_MS) return 'silent';
  return 'waiting';
}
