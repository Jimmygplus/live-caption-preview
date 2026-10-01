export const AUDIO_CHECK_AMBIENT_MS = 2_500;
export const AUDIO_CHECK_SPEECH_MS = 4_000;

const SILENCE_RMS = 0.0015;
const QUIET_SPEECH_RMS = 0.015;
const NOISY_AMBIENT_RMS = 0.012;
const CLIPPING_PEAK = 0.98;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function percentile(values, position) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * position));
  return sorted[index];
}

function finiteLevels(frames, key) {
  return frames
    .map((frame) => Number(frame?.[key]))
    .filter((value) => Number.isFinite(value) && value >= 0);
}

export function formatDbfs(value) {
  if (!Number.isFinite(value) || value <= 0) return '−∞ dBFS';
  return `${Math.round(20 * Math.log10(value))} dBFS`;
}

export function analyzeAudioCheck({ ambientFrames = [], speechFrames = [] } = {}) {
  const ambientLevels = finiteLevels(ambientFrames, 'rms');
  const speechLevels = finiteLevels(speechFrames, 'rms');
  const speechPeaks = finiteLevels(speechFrames, 'peak');
  const ambientRms = percentile(ambientLevels, 0.8);
  const speechRms = percentile(speechLevels, 0.75);
  const speechPeak = speechPeaks.length ? Math.max(...speechPeaks) : 0;
  const clippingFrames = speechPeaks.filter((peak) => peak >= CLIPPING_PEAK).length;
  const clippingRatio = clippingFrames / Math.max(1, speechPeaks.length);
  const snrRatio = ambientRms > 0 ? speechRms / ambientRms : Infinity;

  const silent = speechRms < SILENCE_RMS;
  const clipped = !silent && (speechPeak >= 0.995 || clippingRatio >= 0.05);
  const noisy = !silent && (ambientRms >= NOISY_AMBIENT_RMS || snrRatio < 4);
  const quiet = !silent && speechRms < QUIET_SPEECH_RMS;

  let outcome = 'good';
  if (silent) outcome = 'silent';
  else if (clipped) outcome = 'clipped';
  else if (noisy) outcome = 'noisy';
  else if (quiet) outcome = 'quiet';

  // Keep the gate above ordinary room tone, but never so high that it is likely
  // to trim the tested voice. The recommendation is opt-in; the user's manual
  // setting remains untouched until they apply it.
  const recommendedGate = silent
    ? null
    : clamp(Math.round(Math.min(Math.max(0.002, ambientRms * 1.7), speechRms * 0.45) * 1000), 1, 60);

  const copy = {
    good: {
      summary: 'Your audio is ready',
      guidance: 'Apply the suggested gate if needed, then start captions. You can adjust it later.',
    },
    quiet: {
      summary: 'Speech is quiet',
      guidance: 'Move closer to the microphone or try a headset, then check again.',
    },
    noisy: {
      summary: 'Background noise is high',
      guidance: 'Move closer to the microphone or try a quieter input or headset.',
    },
    clipped: {
      summary: 'Input is too loud',
      guidance: 'Lower the input volume, move back from the microphone or try another input.',
    },
    silent: {
      summary: 'No speech detected',
      guidance: 'Check that the correct microphone is selected and unmuted, then speak and try again.',
    },
  }[outcome];

  return {
    outcome,
    ...copy,
    recommendedGate,
    metrics: {
      ambientRms,
      speechRms,
      speechPeak,
      clippingRatio,
      snrRatio,
    },
    reports: {
      level: silent ? 'No signal' : quiet ? 'Quiet' : clipped ? 'Too loud' : 'Good',
      noise: noisy ? 'High' : 'Normal',
      clipping: clipped ? 'Clipping detected' : 'None detected',
      silence: silent ? 'Silence detected' : 'None detected',
    },
  };
}
