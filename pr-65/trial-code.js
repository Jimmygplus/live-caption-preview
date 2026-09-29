// Kept in sync with CODE_PATTERN in trial/src/index.js, which verifies the code.
export const TRIAL_CODE_MIN = 6;
export const TRIAL_CODE_MAX = 32;

// Deliberately wider than the generator's alphabet. Generated codes avoid
// 0/O/1/I because a human transcribing an arbitrary string cannot tell them
// apart; a campaign's own word ("LAUNCH2026") carries that context itself, so
// restricting it would rule out most memorable codes. The minimum length is
// what keeps a guessable code out of reach of the rate limiter.
const TRIAL_CODE_PATTERN = new RegExp(`^[A-Z0-9]{${TRIAL_CODE_MIN},${TRIAL_CODE_MAX}}$`);

export function normalizeTrialCode(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// Deliberately no grouping: a memorable code must not have hyphens injected
// mid-word as it is typed. Hyphens in a pasted code are stripped above.
export function formatTrialCode(value) {
  return normalizeTrialCode(value).slice(0, TRIAL_CODE_MAX);
}

export function validTrialCode(value) {
  return TRIAL_CODE_PATTERN.test(normalizeTrialCode(value));
}

export async function redeemTrialCode({ brokerUrl, code, fetchImpl = fetch }) {
  if (!validTrialCode(code)) throw new Error('Enter a trial code with at least 6 letters or numbers.');
  return requestTrial(brokerUrl, 'redeem', { code: normalizeTrialCode(code) }, fetchImpl);
}

export async function startFreeTrial({ brokerUrl, fetchImpl = fetch }) {
  return requestTrial(brokerUrl, 'start', {}, fetchImpl);
}

async function requestTrial(brokerUrl, action, payload, fetchImpl) {
  if (!brokerUrl) throw new Error('The free trial is not configured. You can use your own Soniox API key.');
  let response;
  try {
    response = await fetchImpl(`${brokerUrl.replace(/\/$/, '')}/v1/trials/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new Error('Could not reach the trial service. Check your connection and try again. No API key is needed for a trial.');
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Trial redemption failed (${response.status})`);
  if (!/^(?:temp:|snx_temp_)[^\s]{10,}$/.test(body.api_key || '')) {
    throw new Error('The trial service did not return a valid temporary key.');
  }
  return body;
}
