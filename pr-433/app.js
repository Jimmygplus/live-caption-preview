// Live Caption & Translation — browser client.
//
// Two engines behind one UI:
//   soniox    — mic → AudioWorklet → 16-bit PCM → WebSocket direct to Soniox.
//               Transcript AND translation arrive on the same socket; tokens are
//               tagged `translation_status: "original" | "translation"`.
//   webspeech — browser SpeechRecognition (free, Chrome/Edge, no key). Caption only,
//               unless the server has a Claude key, in which case finalized lines
//               are translated through /api/translate.

import { qrDataUrl } from './qr.js?v=fb68eb0f';
import {
  AUDIO_SIGNAL_MIN_RMS,
  classifyAudioSignal,
  defaultAudioSourceLabel,
  isDefaultAudioSource,
  resolveAudioSourcePreference,
} from './audio-source.js?v=fb68eb0f';
import {
  AUDIO_CHECK_AMBIENT_MS,
  AUDIO_CHECK_SPEECH_MS,
  analyzeAudioCheck,
  formatDbfs,
} from './audio-check.js?v=fb68eb0f';
import { linkedFontSizes } from './font-size.js?v=fb68eb0f';
import {
  CAPTION_STATES,
  applyCaptionPatch,
  createFinalCaption,
  draftView,
} from './caption-state.js?v=fb68eb0f';
import {
  decryptAudiencePayload,
  detectTypedLanguage,
  encryptAudiencePayload,
  hashAudienceToken,
  randomAudienceSecret,
} from './audience-crypto.js?v=fb68eb0f';
import { AUDIENCE_RELAY_URL } from './relay-config.js?v=fb68eb0f';
import { createJoinKeyPair, unwrapJoinSecret, wrapJoinSecret } from './join-crypto.js?v=fb68eb0f';
import { TRIAL_BROKER_URL } from './trial-config.js?v=fb68eb0f';
import { formatTrialCode, redeemTrialCode, startFreeTrial, validTrialCode } from './trial-code.js?v=fb68eb0f';

const SONIOX_WS = 'wss://stt-rt.soniox.com/transcribe-websocket';
const SONIOX_MODEL = 'stt-rt-v5';

const SENTENCE_END = /[.!?。！？…]["'”’)\]]?\s*$/;
// Spoken Chinese often runs comma-to-comma for a long time before a full stop,
// so clause marks have to be cut points too or captions arrive as paragraphs.
const CLAUSE_END = /[,，、;；:：—]["'”’)\]]?\s*$/;
const CLAUSE_BREAK_CHARS = ',，、;；:：—';

// Caption length is measured in CJK-equivalent units: a Han character carries
// roughly as much as two Latin ones, so one budget works for both scripts.
const CJK = /[　-鿿＀-￯]/;
function textWidth(text) {
  let width = 0;
  for (const ch of text) width += CJK.test(ch) ? 1 : 0.45;
  return width;
}

// soft = the length past which a clause mark is allowed to end the caption.
// hard = the length past which we break at the best boundary available.
const LENGTH_PRESETS = {
  short: { soft: 14, hard: 30 },
  medium: { soft: 24, hard: 50 },
  long: { soft: 42, hard: 90 },
};

const lengthPreset = () => LENGTH_PRESETS[el.length.value] || LENGTH_PRESETS.medium;

// Furthest cut point at or before `limit` units, preferring a clause mark, then
// a space, and only slicing mid-word if the text offers nothing better.
function bestBreakPoint(text, limit) {
  let width = 0;
  let lastClause = -1;
  let lastSpace = -1;
  for (let i = 0; i < text.length; i++) {
    width += CJK.test(text[i]) ? 1 : 0.45;
    if (CLAUSE_BREAK_CHARS.includes(text[i])) lastClause = i + 1;
    else if (text[i] === ' ') lastSpace = i;
    if (width >= limit) {
      if (lastClause > 0) return lastClause;
      if (lastSpace > 0) return lastSpace;
      return i + 1;
    }
  }
  return text.length;
}

// Punctuation and whitespace across both scripts, used to keep stray marks from
// becoming captions of their own or being sent off for translation.
const PUNCTUATION = '\\s.,!?;:~—\\-…"\'“”‘’()\\[\\]{}。，、！？；：（）【】《》「」';
const LEADING_PUNCTUATION = new RegExp(`^[${PUNCTUATION}]+`);
const ONLY_PUNCTUATION = new RegExp(`^[${PUNCTUATION}]+$`);

const isPunctuationOnly = (text) => ONLY_PUNCTUATION.test(text);

function absorbTrailingPunctuation(index) {
  const match = stream.finalOrig.slice(index).match(LEADING_PUNCTUATION);
  return match ? index + match[0].length : index;
}

const LANGS = [
  { code: 'en',  speech: 'en-AU',  label: 'English',            name: 'English' },
  { code: 'zh',  speech: 'zh-CN',  label: 'Chinese (Mandarin)',       name: 'Simplified Chinese' },
  { code: 'yue', speech: 'zh-HK',  label: 'Cantonese',                name: 'Cantonese' },
  { code: 'ja',  speech: 'ja-JP',  label: '日本語',              name: 'Japanese' },
  { code: 'ko',  speech: 'ko-KR',  label: '한국어',              name: 'Korean' },
  { code: 'es',  speech: 'es-ES',  label: 'Español',            name: 'Spanish' },
  { code: 'fr',  speech: 'fr-FR',  label: 'Français',           name: 'French' },
  { code: 'de',  speech: 'de-DE',  label: 'Deutsch',            name: 'German' },
  { code: 'pt',  speech: 'pt-BR',  label: 'Português',          name: 'Portuguese' },
  { code: 'it',  speech: 'it-IT',  label: 'Italiano',           name: 'Italian' },
  { code: 'ru',  speech: 'ru-RU',  label: 'Русский',            name: 'Russian' },
  { code: 'nl',  speech: 'nl-NL',  label: 'Nederlands',         name: 'Dutch' },
  { code: 'pl',  speech: 'pl-PL',  label: 'Polski',             name: 'Polish' },
  { code: 'tr',  speech: 'tr-TR',  label: 'Türkçe',             name: 'Turkish' },
  { code: 'hi',  speech: 'hi-IN',  label: 'हिन्दी',               name: 'Hindi' },
  { code: 'ar',  speech: 'ar-SA',  label: 'العربية',             name: 'Arabic' },
  { code: 'id',  speech: 'id-ID',  label: 'Bahasa Indonesia',   name: 'Indonesian' },
  { code: 'ms',  speech: 'ms-MY',  label: 'Bahasa Melayu',      name: 'Malay' },
  { code: 'th',  speech: 'th-TH',  label: 'ไทย',                 name: 'Thai' },
  { code: 'vi',  speech: 'vi-VN',  label: 'Tiếng Việt',         name: 'Vietnamese' },
];

const $ = (id) => document.getElementById(id);

const el = {
  body: document.body,
  engine: $('engine'),
  mode: $('mode'),
  sourceLang: $('sourceLang'),
  targetLang: $('targetLang'),
  sourceLabel: $('sourceLabel'),
  targetLabel: $('targetLabel'),
  device: $('device'),
  audioCheckBtn: $('audioCheckBtn'),
  audioCheckDialog: $('audioCheckDialog'),
  audioCheckDevice: $('audioCheckDevice'),
  audioCheckGate: $('audioCheckGate'),
  audioCheckRun: $('audioCheckRun'),
  audioCheckPhase: $('audioCheckPhase'),
  audioCheckProgress: $('audioCheckProgress'),
  audioCheckMeterFill: $('audioCheckMeterFill'),
  audioCheckLive: $('audioCheckLive'),
  audioCheckResult: $('audioCheckResult'),
  audioCheckSummary: $('audioCheckSummary'),
  audioCheckLevel: $('audioCheckLevel'),
  audioCheckLevelValue: $('audioCheckLevelValue'),
  audioCheckNoise: $('audioCheckNoise'),
  audioCheckNoiseValue: $('audioCheckNoiseValue'),
  audioCheckClipping: $('audioCheckClipping'),
  audioCheckPeakValue: $('audioCheckPeakValue'),
  audioCheckSilence: $('audioCheckSilence'),
  audioCheckGuidance: $('audioCheckGuidance'),
  audioCheckRecommendation: $('audioCheckRecommendation'),
  audioCheckApply: $('audioCheckApply'),
  audioCheckError: $('audioCheckError'),
  audioCheckStart: $('audioCheckStart'),
  translator: $('translator'),
  view: $('view'),
  length: $('length'),
  keysBtn: $('keysBtn'),
  settingsBtn: $('settingsBtn'),
  trialBtn: $('trialBtn'),
  trialStart: $('trialStart'),
  ownKeysSection: $('ownKeysSection'),
  keysDialog: $('keysDialog'),
  keySoniox: $('keySoniox'),
  keyAnthropic: $('keyAnthropic'),
  keysClear: $('keysClear'),
  trialSection: $('trialSection'),
  trialCode: $('trialCode'),
  trialApply: $('trialApply'),
  trialStatus: $('trialStatus'),
  termsBtn: $('termsBtn'),
  termsDialog: $('termsDialog'),
  termsPack: $('termsPack'),
  termsClear: $('termsClear'),
  termsScene: $('termsScene'),
  termsWords: $('termsWords'),
  termsPairs: $('termsPairs'),
  termsCount: $('termsCount'),
  audienceBtn: $('audienceBtn'),
  audienceDialog: $('audienceDialog'),
  audienceLoading: $('audienceLoading'),
  audienceSession: $('audienceSession'),
  audienceQr: $('audienceQr'),
  audienceUrlLabel: $('audienceUrlLabel'),
  audienceUrl: $('audienceUrl'),
  audienceCopy: $('audienceCopy'),
  audienceRoomCode: $('audienceRoomCode'),
  audienceShortHint: $('audienceShortHint'),
  audienceHint: $('audienceHint'),
  audiencePrivacy: $('audiencePrivacy'),
  audienceEnd: $('audienceEnd'),
  captionEditDialog: $('captionEditDialog'),
  captionEditForm: $('captionEditForm'),
  captionEditOriginal: $('captionEditOriginal'),
  captionEditTranslation: $('captionEditTranslation'),
  captionEditHint: $('captionEditHint'),
  jumpBtn: $('jumpBtn'),
  jumpLabel: $('jumpLabel'),
  startBtn: $('startBtn'),
  swapBtn: $('swapBtn'),
  fontSize: $('fontSize'),
  origFontSize: $('origFontSize'),
  fontLinkBtn: $('fontLinkBtn'),
  notice: $('notice'),
  noticeText: $('noticeText'),
  noticeAction: $('noticeAction'),
  noticeDismiss: $('noticeDismiss'),
  pipBtn: $('pipBtn'),
  pairingChip: $('pairingChip'),
  pairingCode: $('pairingCode'),
  typedDock: $('typedDock'),
  typedSoundBtn: $('typedSoundBtn'),
  lockBtn: $('lockBtn'),
  themeBtn: $('themeBtn'),
  themeIcon: $('themeIcon'),
  themeLabel: $('themeLabel'),
  timestampsBtn: $('timestampsBtn'),
  theaterBtn: $('theaterBtn'),
  theaterExit: $('theaterExit'),
  exportMenu: $('exportMenu'),
  controls: $('controls'),
  mobileBar: $('mobileBar'),
  sheetBtn: $('sheetBtn'),
  sheetScrim: $('sheetScrim'),
  stage: $('stage'),
  captions: $('captions'),
  live: $('live'),
  liveMeta: $('liveMeta'),
  liveTimestamp: $('liveTimestamp'),
  liveIdentity: $('liveIdentity'),
  liveTranslation: $('liveTranslation'),
  liveOriginal: $('liveOriginal'),
  liveStableTranslation: $('liveStableTranslation'),
  liveChangingTranslation: $('liveChangingTranslation'),
  liveStableOriginal: $('liveStableOriginal'),
  liveChangingOriginal: $('liveChangingOriginal'),
  placeholder: $('placeholder'),
  placeholderHint: $('placeholderHint'),
  statusDot: $('statusDot'),
  statusText: $('statusText'),
  meterFill: $('meterFill'),
  signalName: $('signalName'),
  audioHint: $('audioHint'),
  gate: $('gate'),
  gateValue: $('gateValue'),
  audioLevelStatus: $('audioLevelStatus'),
  clock: $('clock'),
  translatorStatus: $('translatorStatus'),
  counter: $('counter'),
  errorText: $('errorText'),
};

// ---------------------------------------------------------------- state

const app = {
  config: {
    engines: { soniox: false, webspeech: true },
    translation: { providers: [], default: 'none' },
    audienceInput: { enabled: false, transport: '', publicUrl: '', relayUrl: '' },
  },
  running: false,
  engine: 'soniox',
  segments: [],          // finalized caption records; DOM is a projection, never the source of truth
  nextId: 1,
  startedAt: 0,
  clockTimer: null,
  reconnectAttempt: 0,
  intentionalClose: false,
  msOffset: 0,           // audio-time carried across reconnects, for .srt export
  onSonioxFinished: null, // resolver used by stop() to await the final flush
  detectedLanguage: null, // what Soniox says is actually being spoken
  noticeDismissed: false,
  followBaseline: null,   // segment count when the user scrolled away; null = following
  historyScrollStarted: false, // an upward gesture has actually moved the viewport
  packs: [],              // preset vocabulary packs from glossaries.json
  speakerSlots: new Map(),// Soniox speaker id -> colour slot, in first-heard order
  translateFailures: 0,   // consecutive translation errors
  announcedFallback: null,// vendor switch already surfaced to the user
  activeTranslator: null, // vendor that actually served the last translation
  rawLog: [],             // rolling raw Soniox messages, for after-the-fact diagnosis
  mode: 'server',         // 'server' (local proxy) or 'byok' (static, user's keys)
  pip: null,              // the floating caption window, when open
  touchStartY: 0,         // where a touch drag began, to tell scroll direction
  locked: true,           // pin the view to the newest caption
  audience: null,         // active QR text-input room and host polling state
  editingSegmentId: null, // finalized caption currently open in the correction dialog
  trial: {
    code: '',             // kept in memory only; sent in a POST body when Start is clicked
    requested: false,     // visitor explicitly chose the public one-click trial
    inSession: false,     // a single-use Soniox stream is active
    unlimited: false,     // granted only by a successful broker response
    endReason: '',
    redemptionId: '',
  },
};

// Domain vocabulary, applied to BOTH recognition and translation.
const terms = {
  scene: '',   // free-text description of the meeting
  words: [],   // jargon to recognise correctly
  pairs: [],   // { source, target } — how jargon should be translated
};

// Rolling buffer for the in-flight segment.
const stream = {
  finalOrig: '',
  finalTrans: '',
  interimOrig: '',
  interimTrans: '',
  segStartMs: null,
  displayStartMs: null,
  lastEndMs: null,
  speaker: null,
  previewSpeaker: null,
  language: null,   // language Soniox reports for the segment being built
  cutTimer: null,
  pendingCutAt: -1,
  cutDueAt: 0,
  lastProcMs: 0,
};

// Audio graph + socket handles.
const io = {
  ws: null,
  ctx: null,
  node: null,
  mediaStream: null,
  recognition: null,
  audioStartedAt: 0,
  hasDetectedSignal: false,
  silenceTimer: null,
  audioDeviceLabel: '',
};

const audioCheck = {
  running: false,
  attempt: 0,
  stream: null,
  ctx: null,
  node: null,
  phase: 'idle',
  phaseStartedAt: 0,
  timeout: null,
  progressTimer: null,
  ambientFrames: [],
  speechFrames: [],
};


// ---------------------------------------------------------------- BYOK mode
//
// The same build runs two ways. With the local server present it proxies to
// whatever vendors the server has keys for (Tencent included). Deployed as a
// static site there is no server at all: the browser talks to the vendors
// directly using keys the user supplies, which never leave their machine.
//
// Only vendors reachable from a browser can work that way. Soniox can, because
// a WebSocket handshake is not subject to CORS and its config accepts a
// long-lived key. Anthropic can, because it sends CORS headers and offers an
// explicit browser-access header. Tencent sends no CORS headers at all, so it
// is server-mode only — verified, not assumed.

const KEYS_STORAGE = 'lc.keys';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const TRANSLATE_MODEL = 'claude-haiku-4-5';

const keys = { soniox: '', anthropic: '' };

function loadKeys() {
  try {
    Object.assign(keys, JSON.parse(localStorage.getItem(KEYS_STORAGE) || '{}'));
  } catch {
    /* corrupt entry — keep the empty defaults */
  }
}

function saveKeys() {
  localStorage.setItem(KEYS_STORAGE, JSON.stringify(keys));
}

const isByok = () => app.mode === 'byok';

function localConfig() {
  const providers = [];
  if (keys.anthropic) providers.push({ id: 'claude', label: 'Claude Haiku (your key)' });
  providers.push({ id: 'soniox', label: 'Soniox streaming' });
  providers.push({ id: 'none', label: 'Off — captions only' });
  return {
    engines: { soniox: Boolean(keys.soniox), webspeech: true },
    translation: { providers, default: keys.anthropic ? 'claude' : 'soniox' },
    audienceInput: {
      enabled: Boolean(AUDIENCE_RELAY_URL),
      transport: 'relay',
      publicUrl: '',
      relayUrl: AUDIENCE_RELAY_URL,
    },
  };
}

// Browser-side translation, used only in BYOK mode. Mirrors the server prompt so
// output is identical either way.
async function translateInBrowser({ text, targetName, glossary = [], scene = '', references = [] }) {
  if (!keys.anthropic) throw new Error('Add a Claude API key to use this translator.');

  const glossaryBlock = glossary.length
    ? '\n\nUse these translations for domain terms, adapting grammatically as needed:\n' +
      glossary.map((g) => `- ${g.source} → ${g.target}`).join('\n')
    : '';
  const sceneBlock = scene ? `\n\nSetting: ${scene}` : '';
  const recentBlock = references.length
    ? '\n\nEarlier lines from this same conversation, for tone and terminology continuity:\n' +
      references.map((r) => `- ${r.Text} → ${r.Translation}`).join('\n')
    : '';

  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'x-api-key': keys.anthropic,
      'anthropic-version': '2023-06-01',
      // Required for browser-origin calls; without it the request is refused.
      'anthropic-dangerous-direct-browser-access': 'true',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: TRANSLATE_MODEL,
      max_tokens: 1024,
      system:
        `You translate live speech transcripts into ${targetName}. ` +
        'Output only the translation — no preamble, no quotes, no notes, no explanation. ' +
        'The input is one utterance from ongoing speech and may be informal or clipped; ' +
        'translate it faithfully without completing, censoring, or editorialising it. ' +
        'Keep proper nouns, product names, and acronyms in their original form. ' +
        `If the text is already in ${targetName}, repeat it unchanged.` +
        sceneBlock + glossaryBlock + recentBlock,
      messages: [{ role: 'user', content: text }],
    }),
  });

  const raw = await res.text();
  if (!res.ok) throw new Error(`Claude translation failed (${res.status}): ${raw.slice(0, 160)}`);

  const message = JSON.parse(raw);
  // A safety refusal is HTTP 200 with no text content — check before reading it.
  if (message.stop_reason === 'refusal') return '';
  return (message.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
}

// ---------------------------------------------------------------- setup

function fillLanguageSelects() {
  for (const select of [el.sourceLang, el.targetLang]) {
    select.innerHTML = '';
    for (const lang of LANGS) {
      const option = document.createElement('option');
      option.value = lang.code;
      option.textContent = lang.label;
      select.append(option);
    }
  }
  el.sourceLang.value = 'en';
  el.targetLang.value = 'en';
  el.sourceLang.prepend(new Option('Auto-detect', 'auto'));
}

async function loadConfig() {
  // No server reachable means this is the static deployment — fall back to keys
  // the user has supplied locally rather than treating it as an error.
  try {
    const res = await fetch('./api/config');
    if (!res.ok) throw new Error(String(res.status));
    app.config = await res.json();
    app.mode = 'server';
  } catch {
    app.mode = 'byok';
    loadKeys();
    app.config = localConfig();
  }

  el.engine.innerHTML = '';
  if (app.config.engines.soniox || isByok()) {
    el.engine.append(new Option('Soniox', 'soniox'));
  }
  el.engine.append(new Option('Browser speech (no key)', 'webspeech'));

  // Translation vendor is chosen independently of the caption engine.
  el.translator.innerHTML = '';
  for (const provider of app.config.translation.providers) {
    el.translator.append(new Option(({soniox: 'Soniox streaming', none: 'Off — captions only', claude: 'Claude Haiku', tencent: 'Tencent', tencent_llm: 'Tencent LLM'})[provider.id] || provider.label, provider.id));
  }
  const savedTranslator = localStorage.getItem('lc.translator');
  el.translator.value =
    savedTranslator && app.config.translation.providers.some((p) => p.id === savedTranslator)
      ? savedTranslator
      : app.config.translation.default;

  const speechSupported = 'SpeechRecognition' in window || 'webkitSpeechRecognition' in window;
  // A new visitor should choose trial access or a key, never silently fall
  // back to a different recognition service after pressing Start captions.
  app.engine = app.config.engines.soniox || isByok() ? 'soniox' : 'webspeech';
  el.engine.value = app.engine;

  if (!speechSupported && app.engine === 'webspeech') {
    setError('Use Chrome or Edge for browser speech, or configure Soniox.');
    el.startBtn.disabled = true;
  }

  // The key button only means anything without a server behind us.
  el.keysBtn.hidden = !isByok();
  if (el.trialBtn) el.trialBtn.hidden = !(isByok() && TRIAL_BROKER_URL);

  if (isByok() && !keys.soniox) {
    const message = TRIAL_BROKER_URL
      ? 'Try live captions free for 30 minutes. No Soniox account, API key or referral code needed.'
      : 'Add your Soniox key to start. It is stored in this browser and sent directly to Soniox.';
    showNotice(message, TRIAL_BROKER_URL ? 'Start free trial' : 'Add API key', () =>
      TRIAL_BROKER_URL ? void beginFreeTrial() : openCaptionSetup());
  }

  onEngineChange();
}

// ---------------------------------------------------------------- audience text input
//
// The QR page and this host page share no vendor credentials. Server mode uses
// a local in-memory room; the static deployment uses an expiring encrypted relay.

const AUDIENCE_HOST_SESSION_KEY = 'lc.audience.host-session.v1';

// The pairing code is on screen for the whole session rather than behind the
// dialog that created it. A latecomer should be able to join without the host
// stopping the meeting to dig it out.


// app.js is shared with the previous layout, which has none of these elements.
// Anything added since has to tolerate their absence or it takes that page down
// at load — as this did.
// The code now lives as long as the meeting does, so there is nothing to tick
// down and nothing to refresh every second. The chip showed a running clock,
// which read as a deadline on the meeting itself and made people anxious about
// a number that did not concern them.
function renderPairingChip() {
  if (!el.pairingChip) return;
  const session = app.audience;
  const code = session?.pairingCode;
  el.pairingChip.hidden = !code || !!session.closed;
  if (el.pairingChip.hidden) return;
  el.pairingCode.textContent = code;
}

// Re-issuing is also the eject button: whoever holds the previous code stops
// matching, while the room and everyone already inside carry on untouched.
async function reissuePairingCode() {
  const session = app.audience;
  if (!el.pairingChip || !session?.id || !session.hostTokenHash) return;
  el.pairingChip.disabled = true;
  try {
    const response = await fetch(
      `${session.relayUrl.replace(/\/$/, '')}/v1/rooms/${encodeURIComponent(session.id)}/pairing`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hostHash: session.hostTokenHash }),
      },
    );
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || 'Could not refresh the join code.');
    session.pairingCode = body.pairingCode;
    session.pairingExpiresAt = body.pairingExpiresAt;
    saveAudienceHostSession(session);
    renderPairingChip();
    if (el.audienceDialog.open) showAudienceSession(session);
    showNotice(`New join code: ${body.pairingCode}. The previous code is no longer active.`);
  } catch (error) {
    setError(error.message || 'Could not refresh the join code.');
  } finally {
    el.pairingChip.disabled = false;
  }
}

el.pairingChip?.addEventListener('click', () => void reissuePairingCode());

// Joining someone else's room from this page. The handshake is the same ECDH
// exchange the QR path performs invisibly, so it ends by handing over to
// input.html through exactly the same contract — the audience page needs no
// idea a pairing code was ever involved.
const joinBar = document.getElementById('joinBar');
const joinHome = document.createComment('Join entry on compact home layouts');
joinBar?.before(joinHome);

function setAudienceSession(session) {
  app.audience = session;
  el.body.classList.toggle('has-room', Boolean(session && !session.closed));
}

const joinCodeInput = document.getElementById('joinCode');
const joinStatus = document.getElementById('joinStatus');

function setJoinStatus(text, state = '') {
  if (!joinStatus) return;
  joinStatus.textContent = text;
  joinStatus.dataset.state = state;
}

async function joinByPairingCode(code) {
  if (!AUDIENCE_RELAY_URL) return setJoinStatus('Conversation sharing is not configured.', 'error');
  setJoinStatus('Finding conversation…', 'busy');

  let roomId;
  try {
    const response = await fetch(`${AUDIENCE_RELAY_URL.replace(/\/$/, '')}/v1/pairing/${code}`);
    if (response.status === 429) return setJoinStatus('Too many attempts. Try again shortly.', 'error');
    if (!response.ok) return setJoinStatus('This join code is invalid or expired. Ask the host for a new code.', 'error');
    ({ roomId } = await response.json());
  } catch {
    return setJoinStatus('Could not connect to conversation sharing.', 'error');
  }

  setJoinStatus('Connecting securely…', 'busy');
  const pair = await createJoinKeyPair();
  const requestId = globalThis.crypto.randomUUID().replaceAll('-', '');
  const url = new URL(`/v1/rooms/${encodeURIComponent(roomId)}/ws`, AUDIENCE_RELAY_URL);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';

  const socket = new WebSocket(url.href);
  let settled = false;
  const finish = (message, state) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    try { socket.close(); } catch { /* already closing */ }
    setJoinStatus(message, state);
  };
  const timer = setTimeout(() => finish('The host did not respond. Check that the conversation is open.', 'error'), 20_000);

  socket.addEventListener('open', () => socket.send(JSON.stringify({
    type: 'join-request', requestId, publicKey: pair.publicKey, pairingCode: code,
  })));

  socket.addEventListener('message', async (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === 'join-approved' && message.requestId === requestId) {
      try {
        const secret = await unwrapJoinSecret(pair.privateKey, message, requestId);
        if (!/^[A-Za-z0-9_-]{20,80}$/.test(secret)) throw new Error('invalid secret');
        settled = true;
        clearTimeout(timer);
        // Same handoff the QR code performs, so input.html needs no new path.
        location.href = `./input.html#r=${encodeURIComponent(roomId)}&s=${encodeURIComponent(secret)}`;
      } catch {
        finish('Secure pairing failed. Enter the join code again.', 'error');
      }
      return;
    }
    if (message.type === 'join-rejected') {
      finish('This code expired. Ask the host for a new code.', 'error');
    } else if (message.type === 'join-unavailable') {
      finish('The host is offline. Try again shortly.', 'error');
    } else if (message.type === 'closed') {
      finish('This conversation has ended.', 'error');
    }
  });

  socket.addEventListener('error', () => finish('Connection interrupted. Please try again.', 'error'));
}

joinBar?.addEventListener('submit', (event) => {
  event.preventDefault();
  const code = joinCodeInput.value.replace(/\D/g, '');
  if (code.length !== 6) return setJoinStatus('Enter a 6-digit join code.', 'error');
  void joinByPairingCode(code);
});

// Opening an invite link joins straight away. The code leaves the address bar
// first, so a refresh or a copied address does not join again.
{
  const shared = new URLSearchParams(location.hash.slice(1)).get('join');
  if (shared !== null && joinCodeInput) {
    history.replaceState(null, '', `${location.pathname}${location.search}`);
    const code = shared.replace(/\D/g, '');
    joinCodeInput.value = code;
    if (code.length === 6) void joinByPairingCode(code);
    else setJoinStatus('Enter a 6-digit join code.', 'error');
  }
}

function makeRelayAudienceSession(data) {
  return {
    ...data,
    transport: 'relay',
    createdAt: Number(data.createdAt) || Date.now(),
    received: Number(data.received) || 0,
    failures: 0,
    reconnectTimer: null,
    heartbeatTimer: null,
    messageChain: Promise.resolve(),
    captionChain: Promise.resolve(),
    captionRevisions: new Map(Array.isArray(data.captionRevisions) ? data.captionRevisions : []),
    pendingCaptions: new Map(),
    pendingDraft: null,
    draftTimer: null,
    lastDraftOrig: '',
    lastDraftTrans: '',
    seen: new Set(Array.isArray(data.seen) ? data.seen : []),
    joinRequests: new Map(),
    socket: null,
    ready: false,
    closed: false,
  };
}

function saveAudienceHostSession(session) {
  if (session.transport !== 'relay' || session.closed) return;
  sessionStorage.setItem(AUDIENCE_HOST_SESSION_KEY, JSON.stringify({
    id: session.id,
    expiresAt: session.expiresAt,
    // Without these a refresh loses the code: the chip vanishes and the dialog
    // falls back to handing out the long access link instead of the home page.
    pairingCode: session.pairingCode,
    pairingExpiresAt: session.pairingExpiresAt,
    hostTokenHash: session.hostTokenHash,
    joinSecret: session.joinSecret,
    relayUrl: session.relayUrl,
    createdAt: session.createdAt,
    received: session.received,
    captionRevisions: [...session.captionRevisions].slice(-200),
    seen: [...session.seen].slice(-200),
  }));
}

function clearAudienceHostSession() {
  renderPairingChip();
  sessionStorage.removeItem(AUDIENCE_HOST_SESSION_KEY);
}

async function restoreAudienceHostSession() {
  if (app.config.audienceInput?.transport !== 'relay') return;
  let saved;
  try { saved = JSON.parse(sessionStorage.getItem(AUDIENCE_HOST_SESSION_KEY) || 'null'); } catch {}
  if (
    !saved
    || !/^[A-Za-z0-9_-]{8,32}$/.test(saved.id || '')
    || !/^[0-9a-f]{64}$/.test(saved.hostTokenHash || '')
    || !/^[A-Za-z0-9_-]{20,80}$/.test(saved.joinSecret || '')
    || !saved.relayUrl
    || Number(saved.expiresAt) <= Date.now()
  ) {
    clearAudienceHostSession();
    return;
  }
  const session = makeRelayAudienceSession(saved);
  setAudienceSession(session);
  renderPairingChip();
  try {
    await connectRelayHost(session, true);
    showAudienceSession(session);
  } catch {
    showAudienceSession(session);
    scheduleRelayReconnect(session);
  }
}

function audienceJoinUrl(session) {
  const configured = session.transport === 'relay' ? '' : app.config.audienceInput?.publicUrl;
  const page = configured
    ? new URL('input.html', `${configured.replace(/\/$/, '')}/`)
    : new URL('./input.html', location.href);
  page.hash = new URLSearchParams(session.transport === 'relay'
    ? { r: session.id, s: session.joinSecret }
    : { r: session.id, t: session.joinToken }).toString();
  return page.href;
}

function localOnlyUrl(url) {
  try {
    const host = new URL(url).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
}

// The short address is now the home page: someone told six digits opens the
// site and types them, rather than being sent to a page that exists only to
// take a code.
// The invite link carries the join code in its fragment, so opening it joins
// without typing. A fragment is never sent to the web server or fetched by
// link previews; replacing the code turns the link off with it.
function audienceInviteUrl(code) {
  const url = new URL('./', location.href);
  url.hash = new URLSearchParams({ join: code }).toString();
  return url.href;
}

function removeAudienceJoinRequest(session, requestId) {
  const request = session.joinRequests.get(requestId);
  if (!request) return;
  clearTimeout(request.timer);
  session.joinRequests.delete(requestId);
}


// The pairing code is the whole gate. Checking it here rather than at the relay
// keeps the relay ignorant of who may join, and makes re-issuing a code an eject
// button: whoever holds the previous one simply stops matching.
//
// There is no approval prompt any more. Everyone who can hear the host read the
// code aloud is already in the room, and a dialog per arrival made joining a
// two-code, two-party ceremony for what should be typing six digits.
async function receiveAudienceJoinRequest(session, message) {
  const requestId = String(message.requestId || '');
  const publicKey = String(message.publicKey || '');
  if (
    app.audience !== session
    || session.closed
    || session.joinRequests.has(requestId)
    || !/^[A-Za-z0-9_-]{16,80}$/.test(requestId)
    || !/^[A-Za-z0-9_-]{80,100}$/.test(publicKey)
  ) return;

  if (!session.pairingCode || String(message.pairingCode || '') !== session.pairingCode) {
    session.socket?.send(JSON.stringify({ type: 'join-response', requestId, approved: false }));
    return;
  }

  session.joinRequests.set(requestId, { id: requestId, publicKey, timer: null });
  await respondToAudienceJoinRequest(session, requestId, true);
}

async function respondToAudienceJoinRequest(session, requestId, approved) {
  const request = session.joinRequests.get(requestId);
  if (!request || session.socket?.readyState !== WebSocket.OPEN) return;
  try {
    if (!approved) {
      session.socket.send(JSON.stringify({ type: 'join-response', requestId, approved: false }));
      removeAudienceJoinRequest(session, requestId);
      return;
    }
    const wrapped = await wrapJoinSecret(request.publicKey, session.joinSecret, requestId);
    session.socket.send(JSON.stringify({
      type: 'join-response',
      requestId,
      approved: true,
      ...wrapped,
    }));
    removeAudienceJoinRequest(session, requestId);
    session.joined = (session.joined || 0) + 1;
    el.audienceHint.textContent = `${session.joined} participants have joined.`;
    el.audienceHint.classList.remove('warn');
  } catch {
    setError('Secure pairing failed. Ask the participant to enter the code again.');
  }
}

function showAudienceSession(session) {
  const joinUrl = audienceJoinUrl(session);
  session.joinUrl = joinUrl;
  el.audienceLoading.hidden = true;
  el.audienceSession.hidden = false;
  el.audienceEnd.hidden = false;
  const pairing = Boolean(session.pairingCode);
  el.audienceUrl.value = pairing ? audienceInviteUrl(session.pairingCode) : joinUrl;
  el.audienceUrlLabel.textContent = pairing ? 'Invite link' : 'Join link';
  el.audienceRoomCode.textContent = session.pairingCode || '';
  el.audienceRoomCode.parentElement.hidden = !pairing;
  el.audienceShortHint.hidden = !pairing;
  try {
    el.audienceQr.src = qrDataUrl(joinUrl);
    el.audienceQr.hidden = false;
    el.audienceHint.textContent = session.transport === 'relay'
      ? 'Scan to join, or send the invite link. Multiple people can join the same conversation.'
      : localOnlyUrl(joinUrl)
      ? 'This local address works on this computer. Use a shared network address for other devices.'
      : 'Scan to join. Multiple people can use the same QR code.';
    el.audienceHint.classList.toggle(
      'warn',
      session.transport !== 'relay' && localOnlyUrl(joinUrl),
    );
    el.audiencePrivacy.textContent = session.transport === 'relay'
      ? 'Shared captions and replies are end-to-end encrypted. This room expires after 6 hours.'
      : 'This room is stored temporarily in the local server and expires after 6 hours. Ending it disables the QR code.';
  } catch (error) {
    el.audienceQr.hidden = true;
    el.audienceHint.textContent = error.message;
    el.audienceHint.classList.add('warn');
  }
  el.audienceBtn.classList.add('active');
}

function audienceMessageTime(message, session) {
  const baseline = app.startedAt || session.createdAt;
  return Math.max(0, message.at - baseline);
}

function audienceCaptionEventId() {
  return `caption-${globalThis.crypto.randomUUID()}`;
}

function sendAudienceCaptionPayload(session, payload, persist) {
  session.captionChain = session.captionChain.then(async () => {
    if (
      app.audience !== session
      || session.closed
      || !session.ready
      || session.socket?.readyState !== WebSocket.OPEN
    ) return;
    const eventId = audienceCaptionEventId();
    const encrypted = await encryptAudiencePayload(session.joinSecret, eventId, payload);
    session.socket.send(JSON.stringify({
      type: 'caption',
      eventId,
      captionId: payload.captionId,
      captionSeq: payload.captionSeq,
      persist,
      ...encrypted,
    }));
    if (persist && session.pendingCaptions.get(payload.captionId)?.revision === payload.revision) {
      session.pendingCaptions.delete(payload.captionId);
    }
  }).catch(() => {
    if (persist) session.pendingCaptions.set(payload.captionId, payload);
  });
}

function publishAudienceCaption(payload, { persist = false } = {}) {
  const session = app.audience;
  if (!session || session.transport !== 'relay' || session.closed) return;
  const revision = (session.captionRevisions.get(payload.captionId) || 0) + 1;
  session.captionRevisions.set(payload.captionId, revision);
  const versioned = { ...payload, revision, updatedAt: Date.now() };
  saveAudienceHostSession(session);
  if (persist) session.pendingCaptions.set(payload.captionId, versioned);
  sendAudienceCaptionPayload(session, versioned, persist);
}

function flushAudienceCaptions(session) {
  for (const payload of session.pendingCaptions.values()) {
    sendAudienceCaptionPayload(session, payload, true);
  }
}

function publishAudienceDraft(orig, trans) {
  const session = app.audience;
  if (!session || session.transport !== 'relay' || session.closed) return;
  session.pendingDraft = { orig, trans };
  if (session.draftTimer) return;
  session.draftTimer = setTimeout(() => {
    session.draftTimer = null;
    const draft = session.pendingDraft;
    session.pendingDraft = null;
    if (!draft || (draft.orig === session.lastDraftOrig && draft.trans === session.lastDraftTrans)) return;
    session.lastDraftOrig = draft.orig;
    session.lastDraftTrans = draft.trans;
    publishAudienceCaption({
      captionId: 'live-draft',
      translationPrimary: translationIsPrimary(),
      captionSeq: 0,
      state: 'draft',
      orig: draft.orig,
      trans: draft.trans,
      source: 'speech',
      author: '',
      speaker: stream.speaker ? speakerName(stream.speaker) : '',
      startMs: (stream.segStartMs ?? 0) + app.msOffset,
      replacesDraft: false,
    });
  }, 180);
}

function publishAudienceSegment(segment, state = 'final', { replacesDraft = false } = {}) {
  const session = app.audience;
  if (session?.draftTimer && replacesDraft) {
    clearTimeout(session.draftTimer);
    session.draftTimer = null;
    session.pendingDraft = null;
  }
  publishAudienceCaption({
    captionId: `segment-${segment.id}`,
    translationPrimary: Boolean(segment.translationPrimary),
    captionSeq: segment.id,
    state,
    orig: segment.orig,
    trans: segment.trans,
    source: segment.source,
    author: segment.author || '',
    speaker: segment.speaker ? speakerName(segment.speaker) : '',
    startMs: segment.startMs,
    replacesDraft,
  }, { persist: true });
}

// A typed contribution scrolls past like any other caption, which is exactly
// wrong for the moment it exists to serve: a room is watching this screen and
// waiting for the person who cannot speak. So it also lands in a fixed strip
// and stays there long enough to be read.
const TYPED_DWELL_MS = 5_000;
const TYPED_MAX_NOTES = 1;
const typedNotes = new Map();

let typedSoundOn = localStorage.getItem('lc.typedSound') === 'on';
let cueContext = null;

// A short, soft two-note chime rather than an alert. Everything visual only
// reaches whoever is already looking at the screen; this is the one thing that
// turns heads toward it, and without it "让大家一起直接看到" does not happen.
function playTypedCue() {
  if (!typedSoundOn) return;
  try {
    cueContext ||= new (window.AudioContext || window.webkitAudioContext)();
    if (cueContext.state === 'suspended') void cueContext.resume();
    const now = cueContext.currentTime;
    for (const [index, hz] of [660, 880].entries()) {
      const osc = cueContext.createOscillator();
      const gain = cueContext.createGain();
      osc.type = 'sine';
      osc.frequency.value = hz;
      const at = now + index * 0.09;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.09, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.22);
      osc.connect(gain).connect(cueContext.destination);
      osc.start(at);
      osc.stop(at + 0.24);
    }
  } catch {
    /* Audio output is a courtesy; never let it break the caption path. */
  }
}

function dropTypedNote(id) {
  const note = typedNotes.get(id);
  if (!note) return;
  clearTimeout(note.timer);
  note.node.remove();
  typedNotes.delete(id);
  el.typedDock.hidden = typedNotes.size === 0;
}

function showTypedNote(segment, author) {
  if (!el.typedDock) return;
  const node = document.createElement('article');
  node.className = 'typed-note';
  const tag = document.createElement('p');
  tag.className = 'typed-tag';
  tag.textContent = `✍ ${author || 'Participant'}`;
  const text = document.createElement('p');
  text.className = 'typed-text';
  text.textContent = segment.orig;
  const trans = document.createElement('p');
  trans.className = 'typed-trans';
  const view = document.createElement('button');
  view.type = 'button';
  view.className = 'ghost';
  view.textContent = 'Read reply';
  view.addEventListener('click', () => {
    setLocked(false);
    segment.node?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    dropTypedNote(segment.id);
  });
  node.append(tag, text, trans, view);

  el.typedDock.append(node);
  el.typedDock.hidden = false;

  // Oldest first: a burst of two or three should read as a group, not shove the
  // earlier lines off before anyone has finished them.
  while (typedNotes.size >= TYPED_MAX_NOTES) dropTypedNote(typedNotes.keys().next().value);

  el.typedDock.hidden = false;
  typedNotes.set(segment.id, {
    node,
    trans,
    timer: setTimeout(() => dropTypedNote(segment.id), TYPED_DWELL_MS),
  });
  playTypedCue();
}

// The translation arrives after the message, so fill it in if the note is still
// on screen rather than making the reader wait for a second appearance.
function updateTypedNote(segment) {
  const note = typedNotes.get(segment.id);
  if (note) note.trans.textContent = segment.trans || '';
}

el.typedSoundBtn?.addEventListener('click', () => {
  typedSoundOn = !typedSoundOn;
  localStorage.setItem('lc.typedSound', typedSoundOn ? 'on' : 'off');
  el.typedSoundBtn.setAttribute('aria-pressed', String(typedSoundOn));
  if (typedSoundOn) playTypedCue();
});
el.typedSoundBtn?.setAttribute('aria-pressed', String(typedSoundOn));

function receiveAudienceMessage(message, session) {
  const startMs = audienceMessageTime(message, session);
  const segment = pushSegment({
    orig: message.text,
    trans: '',
    startMs,
    endMs: startMs + 1200,
    source: 'typed',
    author: message.name,
  });
  showTypedNote(segment, message.name);
  // Send it back to the room as well. Only the big screen used to see a typed
  // contribution, which leaves a second Deaf participant unable to follow the
  // first — and leaves the sender with no evidence it arrived anywhere.
  publishAudienceSegment(segment);
  const detectedLanguage = message.language === 'auto'
    ? detectTypedLanguage(message.text)
    : message.language || null;
  void queueTranslation(segment, message.text, detectedLanguage);
  session.received += 1;
  saveAudienceHostSession(session);
  el.audienceHint.textContent = `${session.received} replies received. The QR code is still active.`;
  el.audienceHint.classList.remove('warn');
}

function relayWebSocketUrl(session) {
  const url = new URL(`/v1/rooms/${encodeURIComponent(session.id)}/ws`, session.relayUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.href;
}

function scheduleRelayReconnect(session) {
  if (app.audience !== session || session.closed) return;
  if (Number(session.expiresAt) <= Date.now()) {
    session.closed = true;
    setAudienceSession(null);
    clearAudienceHostSession();
    el.audienceBtn.classList.remove('active');
    return;
  }
  session.failures += 1;
  const delay = Math.min(10_000, 500 * 2 ** session.failures);
  if (session.failures === 1) setError('Conversation disconnected. Reconnecting automatically.');
  session.reconnectTimer = setTimeout(() => {
    void connectRelayHost(session, true).catch(() => scheduleRelayReconnect(session));
  }, delay);
}

function startRelayHeartbeat(session) {
  clearInterval(session.heartbeatTimer);
  const send = () => {
    if (session.socket?.readyState === WebSocket.OPEN && session.ready) {
      session.socket.send(JSON.stringify({ type: 'heartbeat' }));
    }
  };
  send();
  session.heartbeatTimer = setInterval(send, 10_000);
}

function connectRelayHost(session, initial = false) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = new WebSocket(relayWebSocketUrl(session));
    session.socket = socket;
    const timeout = setTimeout(() => {
      if (!settled) reject(new Error('Secure connection timed out.'));
      socket.close();
    }, 10_000);

    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ type: 'auth', role: 'host', tokenHash: session.hostTokenHash }));
    });
    socket.addEventListener('message', (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.type === 'ready') {
        clearTimeout(timeout);
        session.failures = 0;
        session.ready = true;
        startRelayHeartbeat(session);
        saveAudienceHostSession(session);
        flushAudienceCaptions(session);
        if (el.errorText.textContent.startsWith('Conversation disconnected')) setError('');
        if (!settled) {
          settled = true;
          resolve();
        }
      } else if (message.type === 'message') {
        session.messageChain = session.messageChain.then(async () => {
          try {
            const payload = await decryptAudiencePayload(
              session.joinSecret,
              message.messageId,
              message,
            );
            if (session.seen.has(message.messageId)) {
              socket.send(JSON.stringify({ type: 'ack', messageId: message.messageId }));
              return;
            }
            const text = typeof payload.text === 'string' ? payload.text.trim().slice(0, 500) : '';
            const name = typeof payload.name === 'string' ? payload.name.trim().slice(0, 30) : '';
            const language = ['auto', 'zh', 'en'].includes(payload.language)
              ? payload.language
              : 'auto';
            if (!text) {
              socket.send(JSON.stringify({ type: 'ack', messageId: message.messageId }));
              return;
            }
            session.seen.add(message.messageId);
            saveAudienceHostSession(session);
            receiveAudienceMessage({ text, name, language, seq: message.seq, at: message.at }, session);
            socket.send(JSON.stringify({ type: 'ack', messageId: message.messageId }));
          } catch {
            setError('A reply could not be decrypted and was skipped.');
          }
        });
      } else if (message.type === 'join-request') {
        void receiveAudienceJoinRequest(session, message);
      } else if (message.type === 'join-cancel' || message.type === 'join-complete') {
        removeAudienceJoinRequest(session, String(message.requestId || ''));
      } else if (message.type === 'closed') {
        session.closed = true;
        if (app.audience === session) setAudienceSession(null);
        clearInterval(session.heartbeatTimer);
        clearAudienceHostSession();
        el.audienceBtn.classList.remove('active');
        el.audienceEnd.hidden = true;
        el.audienceHint.textContent = 'This room has ended. Create a new QR code.';
        el.audienceHint.classList.add('warn');
      }
    });
    socket.addEventListener('close', () => {
      clearTimeout(timeout);
      clearInterval(session.heartbeatTimer);
      session.ready = false;
      if (!settled && initial) {
        settled = true;
        reject(new Error('Could not connect to caption sharing.'));
      } else if (!session.closed && app.audience === session) {
        scheduleRelayReconnect(session);
      }
    });
    socket.addEventListener('error', () => socket.close());
  });
}

async function pollAudienceMessages(session) {
  if (app.audience !== session || session.closed) return;
  try {
    const response = await fetch(
      `./api/audience/sessions/${encodeURIComponent(session.id)}/messages?after=${session.lastSeq}`,
      { headers: { authorization: `Bearer ${session.hostToken}` } },
    );
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Could not retrieve replies (${response.status})`);
    for (const message of body.messages || []) {
      if (message.seq <= session.lastSeq) continue;
      session.lastSeq = message.seq;
      receiveAudienceMessage(message, session);
    }
    if (session.failures && el.errorText.textContent.startsWith('Reply sharing disconnected')) {
      setError('');
    }
    session.failures = 0;
  } catch (error) {
    session.failures += 1;
    if (session.failures === 1) setError(`Reply sharing disconnected：${error.message}`);
    if (/不存在|结束|401|404/.test(error.message)) {
      session.closed = true;
      if (app.audience === session) setAudienceSession(null);
      el.audienceBtn.classList.remove('active');
      el.audienceHint.textContent = 'This room has ended. Create a new QR code.';
      el.audienceHint.classList.add('warn');
      el.audienceEnd.hidden = true;
      return;
    }
  }
  const delay = session.failures ? Math.min(8000, 800 * 2 ** session.failures) : 750;
  session.pollTimer = setTimeout(() => void pollAudienceMessages(session), delay);
}

async function createAudienceSession() {
  el.audienceLoading.hidden = false;
  el.audienceLoading.textContent = 'Creating a secure room…';
  el.audienceSession.hidden = true;
  el.audienceEnd.hidden = true;

  if (!app.config.audienceInput?.enabled) {
    el.audienceLoading.textContent = 'Conversation sharing has not been configured for this deployment.';
    return;
  }

  try {
    if (app.config.audienceInput.transport === 'relay') {
      const relayUrl = app.config.audienceInput.relayUrl;
      const hostToken = randomAudienceSecret();
      const joinSecret = randomAudienceSecret();
      const hostTokenHash = await hashAudienceToken(hostToken);
      const response = await fetch(`${relayUrl.replace(/\/$/, '')}/v1/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          hostHash: hostTokenHash,
          joinHash: await hashAudienceToken(joinSecret),
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `Could not create room (${response.status})`);
      const session = makeRelayAudienceSession({
        ...body,
        hostTokenHash,
        joinSecret,
        relayUrl,
        createdAt: Date.now(),
      });
      setAudienceSession(session);
      renderPairingChip();
      await connectRelayHost(session, true);
      saveAudienceHostSession(session);
      showAudienceSession(session);
      return;
    }

    const response = await fetch('./api/audience/sessions', {
      method: 'POST',
      headers: { 'x-live-caption-client': 'host' },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Could not create room (${response.status})`);
    const session = {
      ...body,
      transport: 'polling',
      createdAt: Date.now(),
      lastSeq: 0,
      received: 0,
      failures: 0,
      pollTimer: null,
      closed: false,
    };
    setAudienceSession(session);
    showAudienceSession(session);
    void pollAudienceMessages(session);
  } catch (error) {
    if (app.audience?.transport === 'relay') {
      app.audience.closed = true;
      app.audience.socket?.close();
      setAudienceSession(null);
    }
    el.audienceLoading.textContent = `Could not create room: ${error.message}`;
  }
}

async function endAudienceSession() {
  const session = app.audience;
  if (!session) return;
  session.closed = true;
  clearTimeout(session.pollTimer);
  clearTimeout(session.reconnectTimer);
  clearTimeout(session.draftTimer);
  clearInterval(session.heartbeatTimer);
  for (const request of session.joinRequests?.values?.() || []) clearTimeout(request.timer);
  session.joinRequests?.clear?.();
  clearAudienceHostSession();
  setAudienceSession(null);
  el.audienceBtn.classList.remove('active');
  el.audienceSession.hidden = true;
  el.audienceEnd.hidden = true;
  el.audienceLoading.hidden = false;
  el.audienceLoading.textContent = 'This room has ended. The previous QR code is no longer active.';
  if (session.transport === 'relay') {
    if (session.socket?.readyState === WebSocket.OPEN) {
      session.socket.send(JSON.stringify({ type: 'close-room' }));
      session.socket.close();
    } else {
      try {
        await fetch(`${session.relayUrl.replace(/\/$/, '')}/v1/rooms/${encodeURIComponent(session.id)}/close`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ hostHash: session.hostTokenHash, code: session.pairingCode }),
        });
      } catch {
        // The room still expires server-side; ending locally must remain instant.
      }
    }
    return;
  }
  try {
    await fetch(`./api/audience/sessions/${encodeURIComponent(session.id)}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${session.hostToken}` },
    });
  } catch {
    // The room still expires server-side; ending locally must remain instant.
  }
}

async function refreshDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  let devices = [];
  try {
    devices = await navigator.mediaDevices.enumerateDevices();
  } catch {
    return;
  }
  const inputs = devices.filter((d) => d.kind === 'audioinput');
  const previous = el.device.value;
  const wasDefault = isDefaultAudioSource(previous)
    || el.device.selectedOptions[0]?.dataset.defaultSource === 'true';
  // enumerateDevices() orders the system default capture device first. Chrome
  // also commonly labels it "Default - …" or gives it the literal id
  // "default". Select that concrete pseudo-device instead of relying on an
  // unconstrained getUserMedia call, which is unreliable on older macOS.
  const defaultInput = inputs.find((device) => device.deviceId === 'default')
    || inputs.find((device) => /^default\b/i.test(device.label))
    || inputs[0];
  const defaultValue = defaultInput?.deviceId || '';

  el.device.innerHTML = '';
  const defaultOption = new Option(defaultAudioSourceLabel(defaultInput?.label), defaultValue);
  defaultOption.dataset.defaultSource = 'true';
  el.device.append(defaultOption);
  el.device.append(new Option('Tab / system audio', 'display'));
  inputs.filter((device) => device !== defaultInput).forEach((d, i) => {
    el.device.append(new Option(d.label || `Input device ${i + 1}`, d.deviceId));
  });
  // Browser capture is a stable pseudo-device. The system-default option is
  // rebuilt from the current enumeration; physical ids are restored only while
  // the corresponding device remains available.
  if (previous === 'display') el.device.value = previous;
  else if (wasDefault) el.device.value = defaultValue;
  else if (previous && inputs.some((d) => d.deviceId === previous)) el.device.value = previous;
}

// ---------------------------------------------------------------- UI wiring

// Captured before anything rewrites it, so switching back to Soniox restores
// the real text rather than a copy that has to be kept in sync by hand.
const SONIOX_AUDIO_HINT = el.audioHint.innerHTML;

// Keep Start actionable when credentials are missing: it opens the setup
// choice. Browser speech remains available only when explicitly selected.
function refreshStartAvailability() {
  el.startBtn.disabled = app.engine === 'webspeech'
    && !('SpeechRecognition' in window || 'webkitSpeechRecognition' in window);
}

function needsCaptionAccess() {
  return app.engine === 'soniox' && isByok() && !keys.soniox
    && !app.trial.code && !app.trial.requested;
}

function onEngineChange() {
  app.engine = el.engine.value;
  const isSoniox = app.engine === 'soniox';
  if (!isSoniox && el.mode.querySelector('[value="captions"]')
      && ![...el.translator.options].some(o => !['soniox', 'none'].includes(o.value))) {
    el.mode.value = 'captions';
  }

  // The browser engine opens the microphone itself, and it always opens the
  // system default one: it never sees the device picked here and cannot capture
  // tab audio at all. Leaving that whole group live meant a choice that silently
  // did nothing. There is also no gate to set, because no audio passes through
  // this page on the way to the recogniser — but the level meter still earns its
  // place, and gets its own read-only stream, because "is the microphone even
  // hearing me" is the first question when nothing appears.
  el.body.dataset.audio = isSoniox ? 'gate' : 'monitor';
  el.signalName.textContent = isSoniox ? 'Noise gate' : 'Microphone';
  el.device.disabled = !isSoniox;
  el.audioCheckBtn.disabled = !isSoniox;
  refreshStartAvailability();
  el.audioHint.innerHTML = isSoniox
    ? SONIOX_AUDIO_HINT
    : 'Browser speech uses your <strong>default microphone</strong>. Choose Soniox for a different device or tab / system audio.';

  const twoWay = el.mode.querySelector('[value="two_way"]');
  if (twoWay) twoWay.disabled = !isSoniox;
  if (!isSoniox && el.mode.value === 'two_way') el.mode.value = 'one_way';
  applyModeLabels();
}

// Everything except Soniox's own inline translation runs on finalized sentences
// through /api/translate, which is why those providers read better.
function usesExternalTranslator() {
  return el.translator.value !== 'soniox' && el.translator.value !== 'none';
}

// Soniox streams translation tokens behind the originals, so segmentation has to
// wait for them. External providers translate after the cut, so it can be tight.
// Soniox streams the translation behind the original and gives no way to tell
// which original a translation token belongs to — the only thing keeping them
// together is that they land inside the same segment. Cutting on clause marks
// makes segments shorter than that lag, so a translation ends up attached to the
// caption before its own. Inline translation therefore only cuts where a real
// pause makes the lag likely to have cleared.
const usesInlineTranslation = () => el.translator.value === 'soniox';

function cutGraceMs() {
  return usesInlineTranslation() ? 700 : 150;
}

// In two-way mode the target is whichever of the two configured languages was
// *not* spoken; in one-way it is always the configured target.
function pickTarget(detected) {
  const a = el.sourceLang.value;
  const b = el.targetLang.value;
  if (el.mode.value === 'two_way' && detected) return detected === b ? a : b;
  return b;
}

// The task stays stable when a provider changes. English is the reading
// language on arrival; the existing other-language paths remain available.
let previousCaptionMode = '';
function applyModeLabels() {
  const mode = el.mode.value;
  const captionOnly = mode === 'captions';
  const english = mode === 'english';
  const changed = mode !== previousCaptionMode;
  const soniox = app.engine === 'soniox';
  const canTranslate = soniox || [...el.translator.options].some(o => !['soniox', 'none'].includes(o.value));
  for (const value of ['english', 'one_way']) {
    const option = el.mode.querySelector(`[value="${value}"]`);
    if (option) option.disabled = !canTranslate;
  }
  const autoOption = el.sourceLang.querySelector('[value="auto"]');
  if (autoOption) autoOption.disabled = !soniox || mode === 'two_way';
  if (captionOnly) {
    el.sourceLang.value = 'en';
    el.targetLang.value = 'en';
    el.translator.value = 'none';
  } else {
    if (english) {
      el.targetLang.value = 'en';
      if (changed && soniox) el.sourceLang.value = 'auto';
    }
    if (changed && mode === 'two_way') {
      el.sourceLang.value = 'en';
      if (el.targetLang.value === 'en') el.targetLang.value = 'zh';
    }
    if ((changed || english) && el.translator.value === 'none') {
      const saved = localStorage.getItem('lc.translator');
      const options = [...el.translator.options];
      el.translator.value = options.find(o => o.value === saved && o.value !== 'none' && (soniox || o.value !== 'soniox'))?.value
        || options.find(o => o.value !== 'none' && (soniox || o.value !== 'soniox'))?.value || 'none';
    }
  }
  if ((!soniox || mode === 'two_way') && el.sourceLang.value === 'auto') el.sourceLang.value = 'en';
  const inlineOption = el.translator.querySelector('[value="soniox"]');
  if (inlineOption) inlineOption.disabled = !soniox;
  if (!soniox && el.translator.value === 'soniox') {
    el.translator.value = [...el.translator.options].find(o => !['soniox', 'none'].includes(o.value))?.value || 'none';
  }
  const noTranslationOption = el.translator.querySelector('[value="none"]');
  if (noTranslationOption) noTranslationOption.disabled = english;
  el.translator.disabled = captionOnly;
  el.sourceLang.closest('.field').hidden = captionOnly;
  el.targetLang.closest('.field').hidden = captionOnly || english;
  el.swapBtn.hidden = captionOnly || english;
  el.sourceLabel.textContent = mode === 'two_way' ? 'Language A' : 'Spoken language';
  el.targetLabel.textContent = mode === 'two_way' ? 'Language B' : 'Read in';
  el.body.dataset.captionMode = mode;
  el.placeholderHint.textContent = captionOnly
    ? 'Read spoken English as live captions. Choose your audio, then start.'
    : english ? 'Follow speech in English. The original stays available underneath.'
    : 'Choose the languages for your conversation, then start.';
  previousCaptionMode = mode;
}

const translationIsPrimary = () => el.mode.value === 'english';

// Audio and caption mode stay visible. Settings reveals only the additional
// engine and display options; the phone sheet shows the full form.
const settingsPanel = document.getElementById('settingsPanel');

function setConsoleCollapsed(collapsed) {
  el.body.classList.toggle('console-collapsed', collapsed);
  const phone = el.body.classList.contains('phone');
  if (settingsPanel) {
    if (!phone && collapsed && settingsPanel.contains(document.activeElement)) el.settingsBtn?.focus();
    settingsPanel.hidden = !phone && collapsed;
  }
  el.settingsBtn?.setAttribute('aria-expanded', String(phone
    ? el.body.classList.contains('sheet-open') : !collapsed));
}

function setStatus(state, text) {
  const previous = el.body.dataset.state;
  el.body.dataset.state = state;
  if (state === 'connecting' || state === 'running') el.body.classList.add('session-started');
  el.statusText.textContent = text;

  // Starting makes room for captions. Stopping or an error should not reopen
  // a settings panel the user has already closed.
  if (state !== previous && (state === 'running' || state === 'connecting')) {
    setConsoleCollapsed(true);
  }
}

function setError(message) {
  el.errorText.textContent = message || '';
  if (message) console.warn('[live-caption]', message);
}

// ---------------------------------------------------------------- persistence
//
// Captions were memory-only, so a refresh or a crash lost the whole meeting.
// Every committed segment is now written to localStorage, debounced, and offered
// back on the next load. Storage is capped and prunes oldest-first so a long
// meeting can never blow the quota and silently stop saving.

const STORE_KEY = 'lc.transcript';
const STORE_MAX_SEGMENTS = 4000;
let saveTimer = null;

function persistSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    persistNow();
  }, 1200);
}

function persistNow() {
  if (!app.segments.length) return;
  const payload = {
    savedAt: Date.now(),
    startedAt: app.startedAt,
    segments: app.segments.slice(-STORE_MAX_SEGMENTS).map((s) => ({
      o: s.orig, t: s.trans, s: s.startMs, e: s.endMs, k: s.speaker, a: +s.at,
      x: s.source, n: s.author, r: s.revision, q: s.state, p: s.translationPrimary,
    })),
  };
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(payload));
    app.saveFailed = false;
  } catch {
    // Quota exceeded — drop the oldest half and try once more rather than
    // failing silently for the rest of the meeting.
    try {
      payload.segments = payload.segments.slice(-Math.floor(payload.segments.length / 2));
      localStorage.setItem(STORE_KEY, JSON.stringify(payload));
    } catch {
      if (!app.saveFailed) {
        app.saveFailed = true;
        setError('Could not save the transcript locally. Please export it.');
      }
    }
  }
}

function readSavedTranscript() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    return data?.segments?.length ? data : null;
  } catch {
    return null;
  }
}

function restoreTranscript(data) {
  for (const s of data.segments) {
    const segment = createFinalCaption({
      id: app.nextId++,
      orig: s.o || '',
      trans: s.t || '',
      startMs: s.s ?? 0,
      endMs: s.e ?? 0,
      at: new Date(s.a || data.savedAt),
      speaker: s.k || null,
      source: s.x || 'speech',
      author: s.n || '',
      translationPrimary: Boolean(s.p),
      node: null,
    });
    segment.revision = Number.isSafeInteger(s.r) && s.r > 0 ? s.r : 1;
    segment.state = s.q === CAPTION_STATES.CORRECTED
      ? CAPTION_STATES.CORRECTED
      : CAPTION_STATES.FINAL;
    app.segments.push(segment);
    renderSegment(segment);
  }
  updateCounter();
  el.placeholder.hidden = true;
  setLocked(true, { scroll: true });
}

// Offered on boot so an accidental refresh mid-meeting is recoverable.
function offerRestore() {
  const data = readSavedTranscript();
  if (!data) return;
  const when = new Date(data.savedAt).toLocaleString();
  showNotice(
    `Saved transcript: ${data.segments.length} captions (${when}).`,
    'Restore',
    () => {
      restoreTranscript(data);
      // Restoring puts a transcript on screen without passing through
      // setStatus, so the console would otherwise stay expanded and squeeze
      // the very thing the user just asked to see.
      setConsoleCollapsed(true);
    },
  );
}

// ---------------------------------------------------------------- phone layout
//
// A phone cannot show ten controls and the captions at once. Below the
// breakpoint the toolbar becomes a bottom sheet and the captions take the whole
// screen; the start button moves down to the thumb bar rather than being
// duplicated, so there is never a second copy to keep in sync.

const phoneQuery = matchMedia('(max-width: 820px)');
const sidebarQuery = matchMedia('(min-width: 1200px)');
sidebarQuery.addEventListener('change', applyLayout);

function applyLayout() {
  const phone = phoneQuery.matches;
  el.body.classList.toggle('phone', phone);
  el.mobileBar.hidden = !phone;
  const sidebarAction = document.querySelector('.console > .console-action');
  if (joinBar) {
    if (sidebarQuery.matches && sidebarAction) sidebarAction.prepend(joinBar);
    else joinHome.after(joinBar);
  }

  // A layout can name where the button belongs on desktop; without such a slot
  // it falls back to sitting beside the terms button, as the original bar does.
  const home = document.getElementById('startHome');
  if (phone) el.mobileBar.append(el.startBtn);
  else if (home) home.append(el.startBtn);
  else el.termsBtn.after(el.startBtn);

  if (!phone) closeSheet();
  else setConsoleCollapsed(el.body.classList.contains('console-collapsed'));
}

function openSheet() {
  el.body.classList.add('sheet-open');
  el.sheetScrim.hidden = false;
  setConsoleCollapsed(el.body.classList.contains('console-collapsed'));
}

function closeSheet() {
  el.body.classList.remove('sheet-open');
  el.sheetScrim.hidden = true;
  setConsoleCollapsed(el.body.classList.contains('console-collapsed'));
}

const toggleSheet = () =>
  (el.body.classList.contains('sheet-open') ? closeSheet() : openSheet());

// Escape closes the settings sheet. A native <dialog> already does this, so a
// panel that ignores it reads as broken — and on a phone the sheet covers the
// button that opened it, leaving only a thin strip of scrim to tap.
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (el.body.classList.contains('sheet-open')) {
    event.preventDefault();
    closeSheet();
    el.sheetBtn.focus();
  } else if (!el.body.classList.contains('phone') && !el.body.classList.contains('console-collapsed')
    && !document.querySelector('dialog[open]')) {
    event.preventDefault();
    setConsoleCollapsed(true);
    el.settingsBtn?.focus();
  }
});

// A layout may offer an explicit close control inside the sheet itself.
document.getElementById('sheetClose')?.addEventListener('click', closeSheet);

// Tapping the backdrop dismisses a modal, matching Escape and what every other
// sheet on a phone does. The target is the <dialog> only when the pointer
// misses its contents, so this never fires from inside the form.
for (const dialog of document.querySelectorAll('dialog')) {
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
}

// ---------------------------------------------------------------- floating window
//
// Document Picture-in-Picture gives a real always-on-top window that holds
// arbitrary DOM, so the caption stage is *moved* into it rather than mirrored.
// Every render path keeps writing to the same nodes and needs no changes; the
// only work is carrying the styles across and putting it back on close.

const pipSupported = () => 'documentPictureInPicture' in window;

function copyStylesInto(target) {
  for (const sheet of document.styleSheets) {
    try {
      const css = [...sheet.cssRules].map((r) => r.cssText).join('\n');
      const style = document.createElement('style');
      style.textContent = css;
      target.head.append(style);
    } catch {
      // Cross-origin sheet — re-link it instead of reading the rules.
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = sheet.href;
      target.head.append(link);
    }
  }
}

async function openPip() {
  if (!pipSupported()) return;

  const pip = await documentPictureInPicture.requestWindow({
    width: 640,
    height: 240,
    disallowReturnToOpener: false,
  });
  app.pip = pip;

  copyStylesInto(pip.document);
  pip.document.documentElement.dataset.theme = document.documentElement.dataset.theme;
  pip.document.documentElement.style.cssText = document.documentElement.style.cssText;
  syncPipFontSizes();
  pip.document.body.dataset.view = el.body.dataset.view;
  pip.document.body.classList.add('pip');

  // #live is a child of #stage, so moving the stage carries the whole caption
  // area — committed segments, the in-progress line, and the jump button.
  //
  // Remember the neighbour rather than looking up a landmark by id on the way
  // back. An id is markup a layout is free to rename, and when it does,
  // getElementById returns null — which insertBefore reads as "append", so the
  // caption area silently reappears below the footer instead of above it.
  const stageAnchor = el.stage.nextElementSibling;
  pip.document.body.append(el.stage);

  pip.addEventListener('pagehide', () => {
    document.body.insertBefore(el.stage, stageAnchor);
    app.pip = null;
    el.pipBtn.setAttribute('aria-pressed', 'false');
    scrollToBottom();
  });

  el.pipBtn.setAttribute('aria-pressed', 'true');
  scrollToBottom();
}

// ---------------------------------------------------------------- terms

function loadTerms() {
  try {
    Object.assign(terms, JSON.parse(localStorage.getItem('lc.terms') || '{}'));
  } catch {
    /* corrupt entry — fall back to the empty defaults */
  }
  terms.words ||= [];
  terms.pairs ||= [];
  terms.scene ||= '';

  el.termsScene.value = terms.scene;
  el.termsWords.value = terms.words.join('\n');
  el.termsPairs.value = terms.pairs.map((p) => `${p.source}=${p.target}`).join('\n');
  updateTermsCount();
}

function saveTermsFromForm() {
  terms.scene = el.termsScene.value.trim();
  terms.words = el.termsWords.value
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  terms.pairs = el.termsPairs.value
    .split('\n')
    .map((line) => {
      // Accept =, ：, : and full-width variants so pasting from a doc just works.
      const m = line.split(/\s*[=＝:：]\s*/);
      if (m.length < 2) return null;
      const source = m[0].trim();
      const target = m.slice(1).join(':').trim();
      return source && target ? { source, target } : null;
    })
    .filter(Boolean);

  localStorage.setItem('lc.terms', JSON.stringify(terms));
  updateTermsCount();
}

// Preset vocabulary packs, merged into whatever is already in the form so
// several industries can be stacked (e.g. 研发 + 金融).
async function loadGlossaryPacks() {
  try {
    const res = await fetch('./glossaries.json?v=fb68eb0f');
    const data = await res.json();
    app.packs = data.packs || [];
  } catch {
    app.packs = [];
    return;
  }
  for (const pack of app.packs) {
    el.termsPack.append(new Option(pack.label, pack.id));
  }
}

function applyGlossaryPack(id) {
  const pack = (app.packs || []).find((p) => p.id === id);
  if (!pack) return;

  const scene = el.termsScene.value.trim();
  if (!scene) el.termsScene.value = pack.scene;
  else if (!scene.includes(pack.scene)) el.termsScene.value = `${scene} ${pack.scene}`;

  const existingWords = new Set(
    el.termsWords.value.split('\n').map((s) => s.trim()).filter(Boolean),
  );
  for (const w of pack.words) existingWords.add(w);
  el.termsWords.value = [...existingWords].join('\n');

  // Keyed by source term so re-selecting a pack never duplicates a row.
  const pairs = new Map();
  for (const line of el.termsPairs.value.split('\n')) {
    const [s, ...rest] = line.split(/\s*[=＝:：]\s*/);
    if (s?.trim() && rest.length) pairs.set(s.trim(), rest.join(':').trim());
  }
  for (const [s, t] of pack.pairs) pairs.set(s, t);
  el.termsPairs.value = [...pairs].map(([s, t]) => `${s}=${t}`).join('\n');

  el.termsPack.value = '';
  saveTermsFromForm();
}

function updateTermsCount() {
  const parts = [];
  if (terms.words.length) parts.push(`${terms.words.length} recognition terms`);
  if (terms.pairs.length) parts.push(`${terms.pairs.length} translation pairs`);
  if (terms.scene) parts.push('Context added');
  const summary = parts.length ? parts.join(' · ') : 'Not set';
  el.termsCount.textContent = summary;
  el.termsBtn.title = `Vocabulary and context (${summary})`;
  el.termsBtn.classList.toggle('active', parts.length > 0);
}

// Soniox accepts domain context directly in the session config.
function buildSonioxContext() {
  const context = {};
  if (terms.scene) context.text = terms.scene;
  if (terms.words.length) context.terms = terms.words;
  // Only meaningful when Soniox is also doing the translating.
  if (terms.pairs.length && el.translator.value === 'soniox') {
    context.translation_terms = terms.pairs.map((p) => ({
      source: p.source,
      target: p.target,
    }));
  }
  return Object.keys(context).length ? context : null;
}

// ---------------------------------------------------------------- notices

function showNotice(text, actionLabel, action) {
  el.noticeText.textContent = text;
  if (actionLabel) {
    el.noticeAction.textContent = actionLabel;
    el.noticeAction.hidden = false;
    el.noticeAction.onclick = () => { hideNotice(); action?.(); };
  } else {
    el.noticeAction.hidden = true;
  }
  el.notice.hidden = false;
}

function hideNotice() {
  el.notice.hidden = true;
}

function swapLanguages() {
  app.noticeDismissed = false;
  return restartWith(() => {
    const previousSource = el.sourceLang.value;
    el.sourceLang.value = el.targetLang.value;
    el.targetLang.value = previousSource;
  });
}

function langLabel(code) {
  return LANGS.find((l) => l.code === code)?.label || code;
}

// Language config is fixed for the life of a Soniox session, so any correction
// means restarting the stream. Captions already on screen are kept.
async function restartWith(mutate) {
  const wasRunning = app.running;
  if (wasRunning) await stop();
  mutate();
  hideNotice();
  app.detectedLanguage = null;
  if (wasRunning) await start();
}

// Soniox reports the language it actually hears. Under one-way translation,
// speaking the target language yields zero translation tokens — which reads as a
// broken app rather than a misconfiguration, so say so instead of showing blanks.
function checkLanguageMismatch() {
  if (app.noticeDismissed || !app.detectedLanguage || ['captions', 'english'].includes(el.mode.value)) return;

  const detected = app.detectedLanguage;
  const detectedName = langLabel(detected);
  const source = el.sourceLang.value;
  const target = el.targetLang.value;
  if (source === 'auto') return;

  // Auto two-way already covers both configured languages; only a third is a problem.
  if (el.mode.value === 'two_way') {
    if (detected === source || detected === target) return hideNotice();
    return showNotice(
      `Detected ${detectedName}. Two-way translation is set to ${langLabel(source)} and ` +
        `${langLabel(target)}.`,
      `Use ${detectedName} and restart`,
      () => void restartWith(() => { el.sourceLang.value = detected; }),
    );
  }

  if (detected === target) {
    return showNotice(
      `Speech is already in ${detectedName}. ` +
        `The source caption is the text to read.`,
      'Use two-way translation',
      () => void restartWith(() => { el.mode.value = 'two_way'; applyModeLabels(); }),
    );
  }

  if (detected !== source) {
    return showNotice(
      `Detected ${detectedName}. Your spoken language is set to ${langLabel(source)}.`,
      `Use ${detectedName} and restart`,
      () => void restartWith(() => { el.sourceLang.value = detected; }),
    );
  }

  hideNotice();
}

// A session is exactly when you discover the microphone or the language is
// wrong, so changing these mid-session restarts the stream instead of being
// forbidden. The one case that still has to be locked is a trial: the Soniox
// key is single-use, so restarting would spend a second 30-minute redemption
// and another slot of the daily allowance — silently, on a stray click.
function setControlsDisabled(running) {
  const locked = running && (app.trial.inSession || app.trial.requested || Boolean(app.trial.code));
  for (const button of [el.trialBtn, el.trialStart, el.trialApply, el.keysBtn]) {
    if (button) button.disabled = running;
  }
  for (const control of [el.engine, el.sourceLang, el.targetLang, el.device]) {
    control.disabled = locked;
    control.title = locked
      ? 'During a trial, settings stay fixed. Restarting requires another trial connection.'
      : '';
  }
  // The check grabs the microphone for itself, so it cannot run against a live
  // stream whatever the engine is.
  el.audioCheckBtn.disabled = running || app.engine !== 'soniox';
  el.mode.disabled = locked;
  el.translator.disabled = locked || el.mode.value === 'captions';
  el.device.disabled = locked || app.engine !== 'soniox';
}

// Changing a setting mid-session means reconnecting. Guarded because stop() and
// start() are both async: a second change arriving mid-restart would interleave
// two teardowns over one stream.
async function restartForSettingChange() {
  if (!app.running || app.restarting) return;
  app.restarting = true;
  try {
    await restartWith(() => {});
  } catch (error) {
    setError(error?.message || 'Could not reconnect. Press Start captions to try again.');
  } finally {
    app.restarting = false;
  }
}

function tickClock() {
  const total = Math.floor((Date.now() - app.startedAt) / 1000);
  const mm = String(Math.floor(total / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  el.clock.textContent = `${mm}:${ss}`;
}

function updateCounter() {
  const chars = app.segments.reduce((sum, s) => sum + s.orig.length, 0);
  el.counter.textContent = app.segments.length
    ? `${app.segments.length} captions · ${chars} characters`
    : '';
}

// ---------------------------------------------------------------- rendering

function langName(code) {
  return LANGS.find((l) => l.code === code)?.name || code;
}

function stamp(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor(total / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

// Soniox hands back opaque speaker ids ("1", "2", …). Map them to a small,
// stable set of colour slots in first-heard order.
function speakerSlot(id) {
  if (!app.speakerSlots.has(id)) app.speakerSlots.set(id, app.speakerSlots.size % 6);
  return app.speakerSlots.get(id);
}

function speakerName(id) {
  return `Speaker ${String.fromCharCode(65 + speakerSlot(id))}`; // A, B, C…
}

function renderSegment(segment) {
  const li = document.createElement('li');
  li.className = 'segment';
  li.dataset.id = String(segment.id);
  li.dataset.state = segment.state;
  li.dataset.translationPrimary = String(Boolean(segment.translationPrimary));
  el.body.classList.add('has-captions');

  // Colour-code speakers so a busy meeting reads as a conversation, not a wall.
  if (segment.speaker) li.dataset.speaker = speakerSlot(segment.speaker);
  if (segment.source === 'typed') li.dataset.source = 'typed';

  const meta = document.createElement('p');
  meta.className = 'meta';
  const identity = segment.source === 'typed'
    ? `⌨ ${segment.author || 'Participant'}`
    : segment.speaker ? speakerName(segment.speaker) : '';

  const timestamp = document.createElement('span');
  timestamp.className = 'timestamp mono';
  timestamp.textContent = stamp(segment.startMs);

  const identityNode = document.createElement('span');
  identityNode.className = 'identity';
  identityNode.textContent = identity;
  meta.append(timestamp, identityNode);

  const orig = document.createElement('p');
  orig.className = 'original';
  orig.textContent = segment.orig;

  const trans = document.createElement('p');
  trans.className = 'translation';
  trans.textContent = segment.trans;

  const edit = document.createElement('button');
  edit.className = 'segment-edit ghost';
  edit.type = 'button';
  edit.textContent = 'Edit';
  edit.setAttribute('aria-label', `Edit caption at ${stamp(segment.startMs)}`);
  edit.addEventListener('click', () => openCaptionEditor(segment));

  // Match reading order for both the visual layout and assistive technology.
  li.append(meta, ...(segment.translationPrimary ? [trans, orig] : [orig, trans]), edit);
  if (!segment.trans) li.classList.add('no-translation');

  segment.node = li;
  el.captions.append(li);
  scrollToBottom();
}

function renderSegmentContent(segment) {
  if (!segment.node) return;
  segment.node.dataset.state = segment.state;
  segment.node.querySelector('.original').textContent = segment.orig;
  segment.node.querySelector('.translation').textContent = segment.trans;
  segment.node.classList.toggle('no-translation', !segment.trans);
}

function patchFinalCaption(segment, patch, { expectedRevision = segment.revision, state = segment.state } = {}) {
  const result = applyCaptionPatch(segment, patch, { expectedRevision, state });
  if (!result.applied) return false;
  Object.assign(segment, result.caption);
  persistSoon(); // the translation is part of the record, not just the view
  publishAudienceSegment(segment, segment.state);
  renderSegmentContent(segment);
  updateTypedNote(segment);
  scrollToBottom();
  return true;
}

// On a touch screen there is no hover to reveal the per-caption edit button
// with, and showing one under every line turns the transcript into a column of
// buttons — the captions are the product, corrections are rare. Long-press the
// caption instead: no persistent chrome, and the same editor either way.
function bindLongPressToCorrect(list) {
  const HOLD_MS = 500;
  const SLOP = 10;
  let timer = null;
  let origin = null;

  const cancel = () => { clearTimeout(timer); timer = null; origin = null; };

  list.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse') return;
    const li = event.target.closest('li.segment');
    if (!li) return;
    origin = { x: event.clientX, y: event.clientY };
    timer = setTimeout(() => {
      const segment = app.segments.find((s) => String(s.id) === li.dataset.id);
      if (segment) openCaptionEditor(segment);
      cancel();
    }, HOLD_MS);
  });

  // A drag is a scroll, and a lift before the hold elapses is a plain tap.
  list.addEventListener('pointermove', (event) => {
    if (!origin) return;
    if (Math.abs(event.clientX - origin.x) > SLOP || Math.abs(event.clientY - origin.y) > SLOP) cancel();
  });
  for (const type of ['pointerup', 'pointercancel', 'pointerleave']) {
    list.addEventListener(type, cancel);
  }
}

bindLongPressToCorrect(el.captions);

function openCaptionEditor(segment) {
  app.editingSegmentId = segment.id;
  el.captionEditOriginal.value = segment.orig;
  el.captionEditTranslation.value = segment.trans;
  el.captionEditHint.textContent = `Editing caption ${segment.id} at ${stamp(segment.startMs)}. Changes sync to connected screens and exports.`;
  el.captionEditDialog.showModal();
  el.captionEditOriginal.focus();
}

function saveCaptionCorrection() {
  const segment = app.segments.find((item) => item.id === app.editingSegmentId);
  if (!segment) return;
  const orig = el.captionEditOriginal.value.trim();
  const trans = el.captionEditTranslation.value.trim();
  if (!orig) {
    el.captionEditOriginal.setCustomValidity('Source text cannot be empty.');
    el.captionEditOriginal.reportValidity();
    return;
  }
  el.captionEditOriginal.setCustomValidity('');
  patchFinalCaption(segment, { orig, trans }, {
    expectedRevision: segment.revision,
    state: CAPTION_STATES.CORRECTED,
  });
  el.captionEditDialog.close('save');
  segment.node?.querySelector('.segment-edit')?.focus();
}

// Allow for fractional scroll positions, without treating history near the
// bottom as the latest line.
const FOLLOW_THRESHOLD_PX = 2;

function distanceFromBottom() {
  return el.stage.scrollHeight - el.stage.scrollTop - el.stage.clientHeight;
}

function isFollowing() {
  return distanceFromBottom() <= FOLLOW_THRESHOLD_PX;
}

function scrollToBottom() {
  // Following is explicit intent. Being near the bottom does not cancel a
  // deliberate history review.
  if (app.locked) el.stage.scrollTop = el.stage.scrollHeight;
  updateJumpButton();
}

function setLocked(locked, { scroll = false } = {}) {
  if (locked) {
    app.followBaseline = null;
    app.historyScrollStarted = false;
  } else if (app.locked) {
    app.followBaseline = app.segments.length;
    app.historyScrollStarted = !isFollowing();
  }
  app.locked = locked;
  el.lockBtn.setAttribute('aria-pressed', String(locked));
  el.lockBtn.title = locked ? 'Following latest. Scroll up to read earlier captions.' : 'Reading earlier captions. Click to follow latest.';

  if (locked && scroll) {
    el.stage.scrollTo({ top: el.stage.scrollHeight, behavior: 'auto' });
  }
  updateJumpButton();
}

function resetCaptionFollowing() {
  // Reading position belongs to this session, not to a saved preference.
  localStorage.removeItem('lc.locked');
  setLocked(true, { scroll: true });
}

function pauseFollowingForHistory() {
  // An upward gesture on an empty or non-scrollable stage is not a history
  // review. Do not let it disable following before the first caption arrives.
  if (app.locked && (app.segments.length > 0 || !el.live.hidden)
    && el.view.value === 'list' && el.stage.scrollTop > 0
    && el.stage.scrollHeight > el.stage.clientHeight + FOLLOW_THRESHOLD_PX) {
    setLocked(false);
  }
}

function handleStageScroll() {
  // Caption rendering and layout changes also emit scroll events. They must
  // never pause following; only an explicit reading gesture can do that.
  if (!app.locked) {
    if (!isFollowing()) app.historyScrollStarted = true;
    // A pending render scroll can fire after PageUp/wheel but before the
    // browser moves the viewport. It must not cancel that reading gesture.
    else if (app.historyScrollStarted) setLocked(true);
  }
  updateJumpButton();
}

function jumpToLatest() {
  // Returning to the bottom is also a statement of intent — re-arm the lock.
  setLocked(true, { scroll: true });
}

// The missed count is DERIVED from the segment count at the moment the user
// scrolled away — never accumulated. An earlier version incremented a counter
// inside scrollToBottom(), which runs on every interim token update, so it
// counted redraws (many per second) rather than captions.
function updateJumpButton() {
  const following = app.locked;

  if (following) {
    app.followBaseline = null;
  }

  const missed = app.followBaseline === null ? 0 : Math.max(0, app.segments.length - app.followBaseline);

  // Cinema and ticker views don't scroll, so there is nothing to jump back to.
  const show =
    el.view.value === 'list' && !following && !isFollowing() && app.segments.length > 0;
  el.jumpBtn.hidden = !show;
  el.jumpLabel.textContent = missed > 0 ? `${missed} new caption${missed === 1 ? '' : 's'}` : 'Back to latest';
}

function renderLive() {
  const draft = draftView(stream);
  const orig = (draft.original.stable + draft.original.changing).trim();
  const trans = (draft.translation.stable + draft.translation.changing).trim();

  if (!orig && !trans) {
    el.live.hidden = true;
    el.live.setAttribute('aria-busy', 'false');
    el.live.removeAttribute('data-speaker');
    return;
  }

  if (stream.displayStartMs === null) {
    stream.displayStartMs = stream.segStartMs ?? Math.max(0, Date.now() - app.startedAt);
  }
  const liveSpeaker = stream.speaker || stream.previewSpeaker;
  el.live.hidden = false;
  el.live.dataset.state = draft.state;
  el.live.dataset.translationPrimary = String(translationIsPrimary());
  if (translationIsPrimary() && el.liveOriginal.nextElementSibling === el.liveTranslation) {
    el.liveOriginal.before(el.liveTranslation);
  } else if (!translationIsPrimary() && el.liveTranslation.nextElementSibling === el.liveOriginal) {
    el.liveTranslation.before(el.liveOriginal);
  }
  el.body.classList.add('has-captions');
  el.placeholder.hidden = true;
  el.live.setAttribute('aria-busy', 'true');
  if (liveSpeaker) el.live.dataset.speaker = speakerSlot(liveSpeaker);
  else el.live.removeAttribute('data-speaker');
  el.live.classList.toggle('no-translation', !trans);
  el.liveTimestamp.textContent = stamp(stream.displayStartMs + app.msOffset);
  el.liveIdentity.textContent = liveSpeaker ? speakerName(liveSpeaker) : '';
  el.liveStableTranslation.textContent = draft.translation.stable;
  el.liveChangingTranslation.textContent = draft.translation.changing;
  el.liveStableOriginal.textContent = draft.original.stable;
  el.liveChangingOriginal.textContent = draft.original.changing;
  publishAudienceDraft(orig, trans);
  scrollToBottom();
}

function pushSegment({ orig, trans, startMs, endMs, speaker, source = 'speech', author = '' }) {
  const segment = createFinalCaption({
    id: app.nextId++,
    translationPrimary: translationIsPrimary(),
    orig,
    trans,
    startMs: startMs ?? Date.now() - app.startedAt,
    endMs: endMs ?? Date.now() - app.startedAt,
    at: new Date(),
    speaker: speaker || null,
    source,
    author,
    node: null,
  });
  app.segments.push(segment);
  renderSegment(segment);
  publishAudienceSegment(segment, segment.state, { replacesDraft: source === 'speech' });
  updateCounter();
  persistSoon();
  el.placeholder.hidden = true;
  return segment;
}

// ---------------------------------------------------------------- segmentation

function clearCutTimer() {
  if (stream.cutTimer) {
    clearTimeout(stream.cutTimer);
    stream.cutTimer = null;
  }
  stream.pendingCutAt = -1;
}

// Translation tokens lag their originals by design, so a boundary is never acted
// on immediately — we mark the spot and give the translation a moment to catch up.
// If a second boundary shows up first, the earlier one still wins.
function schedulePendingCut(cutAt) {
  if (stream.cutTimer) return;
  stream.pendingCutAt = cutAt;
  stream.cutDueAt = Date.now() + cutGraceMs();
  stream.cutTimer = setTimeout(() => {
    stream.cutTimer = null;
    const at = Math.min(stream.pendingCutAt, stream.finalOrig.length);
    stream.pendingCutAt = -1;
    commitSegment(at);
    maybeCut(); // the remainder may already hold the next boundary
    renderLive();
  }, cutGraceMs());
}

function commitSegment(cutIndex) {
  clearCutTimer();

  // A cut point is recorded when the endpoint arrives, but Soniox often sends the
  // sentence-final punctuation in a LATER message — so the recorded index can sit
  // just before it. Pull the cut forward over any punctuation that has since
  // landed, otherwise the mark is orphaned onto the front of the next segment.
  cutIndex = absorbTrailingPunctuation(cutIndex);

  const head = stream.finalOrig.slice(0, cutIndex);
  const tail = stream.finalOrig.slice(cutIndex);
  const orig = head.trim();
  const trans = stream.finalTrans.trim();

  // Punctuation with no words is not an utterance. Give it back to the segment it
  // was split from rather than letting it stand as its own caption.
  if (orig && isPunctuationOnly(orig) && !trans) {
    const previous = app.segments.at(-1);
    if (previous) {
      previous.orig += orig;
      previous.node?.querySelector('.original')?.replaceChildren(previous.orig);
      persistSoon();
    }
    stream.finalOrig = tail;
    stream.segStartMs = tail.trim() ? stream.lastEndMs : null;
    stream.displayStartMs = stream.segStartMs;
    return;
  }

  if (orig || trans) {
    const segment = pushSegment({
      orig,
      trans,
      startMs: (stream.segStartMs ?? 0) + app.msOffset,
      endMs: (stream.lastEndMs ?? stream.segStartMs ?? 0) + app.msOffset,
      speaker: stream.speaker,
    });
    // Translate the finished sentence, not a streaming fragment.
    void queueTranslation(segment, orig, stream.language);
  }

  stream.finalOrig = tail;
  stream.finalTrans = '';
  stream.segStartMs = tail.trim() ? stream.lastEndMs : null;
  stream.displayStartMs = stream.segStartMs;
}

// Decide whether the buffered final text is ready to become a segment.
function maybeCut({ force = false } = {}) {
  if (force) {
    if (stream.finalOrig.trim() || stream.finalTrans.trim()) {
      commitSegment(stream.finalOrig.length);
    }
    return;
  }

  const text = stream.finalOrig;
  const { soft, hard } = lengthPreset();
  const width = textWidth(text);

  const inline = usesInlineTranslation();
  // Inline translation needs room for the lag, so its ceiling is far higher and
  // exists only to stop an unbroken monologue from growing without limit.
  const ceiling = inline ? Math.max(hard * 3, 120) : hard;

  // Over the ceiling: break immediately at the best boundary available. No grace
  // window — the caption is already too long to keep buffering.
  if (width >= ceiling) {
    commitSegment(bestBreakPoint(text, ceiling));
    return;
  }

  // A full stop always ends the caption, however short.
  if (SENTENCE_END.test(text)) {
    schedulePendingCut(text.length);
    return;
  }

  // Clause marks are cut points only when something else does the translating.
  if (!inline && width >= soft && CLAUSE_END.test(text)) {
    schedulePendingCut(text.length);
  }
}

// Browsers clamp setTimeout to >= 1s in hidden or occluded tabs, which would stall
// segment commits exactly when the caption window is parked beside a meeting.
// WebSocket messages keep arriving regardless, so let them drive an overdue cut.
function flushPendingCutIfDue() {
  if (!stream.cutTimer || Date.now() < stream.cutDueAt) return;
  clearCutTimer();
  const at = Math.min(stream.pendingCutAt, stream.finalOrig.length);
  stream.pendingCutAt = -1;
  commitSegment(at);
  maybeCut();
}

function resetStream() {
  clearCutTimer();
  stream.finalOrig = '';
  stream.finalTrans = '';
  stream.interimOrig = '';
  stream.interimTrans = '';
  stream.segStartMs = null;
  stream.displayStartMs = null;
  stream.lastEndMs = null;
  stream.speaker = null;
  stream.previewSpeaker = null;
}

// ---------------------------------------------------------------- audio capture

// Capture the tab's or the system's own sound instead of a microphone. Chrome
// on macOS 14.2+ can hand over system audio directly, so a virtual audio device
// (BlackHole, Loopback) is no longer needed for the common case.
async function startDisplayAudio() {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new Error('Use Chrome or Edge to capture tab / system audio.');
  }

  // Video has to be requested for the picker to appear; we never read it.
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: {
      // Ask for the whole machine's output; Chrome falls back to tab audio.
      systemAudio: 'include',
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });

  if (!stream.getAudioTracks().length) {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error('No audio was shared. Enable Share audio in the browser prompt and try again.');
  }

  // Ending the share from the browser's own banner must stop the session too.
  stream.getVideoTracks()[0]?.addEventListener('ended', () => {
    if (app.running) void stop();
  });

  return stream;
}

function setAudioSignalState(state, message = '') {
  const monitor = el.body.dataset.audio === 'monitor';
  const copy = {
    idle: 'Not started',
    waiting: 'Speak to check the input',
    active: 'Audio detected',
    gated: 'Below noise gate',
    // Changing the input is not on offer when the engine ignores the setting.
    silent: monitor ? 'No microphone signal. Check input volume and browser permissions.' : 'No audio detected. Check your input.',
  };
  const device = io.audioDeviceLabel || el.device.selectedOptions[0]?.textContent || 'Input';

  // "External Microphone" is what macOS calls the 3.5mm jack, and it switches to
  // it the moment anything is plugged in — including headphones with no
  // microphone in them, which then hand every listener a perfectly silent
  // stream while the built-in array sits bypassed. The device name was on
  // screen the whole time and said exactly this; nobody could be expected to
  // read it that way, so when there is no sound, spell it out.
  const onJack = /external mic|外接麦克风|line[- ]?in/i.test(device);
  const silentJack = state === 'silent' && onJack;
  el.audioLevelStatus.dataset.state = state;
  el.audioLevelStatus.textContent = silentJack
    ? 'No signal from the headset input. Disconnect the cable or choose the built-in microphone.'
    : message || copy[state] || copy.waiting;
  el.audioLevelStatus.title = silentJack
    ? `Input: ${device}. A headset input is selected; check that it has a microphone.`
    : `Input: ${device}`;
  el.device.classList.toggle('no-signal', !monitor && state === 'silent');
  el.device.title = state === 'silent'
    ? `Input: ${device}. No signal detected. Check input volume or choose another microphone.`
    : `Input: ${device}`;
}

// Called when the recogniser returns tokens. Latches the same flag the level
// meter would have set, so a meter that never reports cannot leave a false
// "no sound" warning standing for the rest of the session.
function noteRecognizerActivity() {
  if (io.hasDetectedSignal) return;
  io.hasDetectedSignal = true;
  clearTimeout(io.silenceTimer);
  // Words coming back are the strongest evidence there is that the microphone
  // works — stronger than any meter — so this states it outright instead of
  // leaving whatever the meter last guessed standing.
  setAudioSignalState('active');
}

function beginAudioSignalCheck(track) {
  clearTimeout(io.silenceTimer);
  io.audioStartedAt = performance.now();
  io.hasDetectedSignal = false;
  io.audioDeviceLabel = track?.label || el.device.selectedOptions[0]?.textContent || '';
  setAudioSignalState('waiting');
  io.silenceTimer = setTimeout(() => {
    if (!io.hasDetectedSignal) setAudioSignalState('silent');
  }, 4_100);
  track?.addEventListener('mute', () => setAudioSignalState('silent', 'Input muted. Check your microphone.'));
  track?.addEventListener('unmute', () => setAudioSignalState('waiting'));
}

function showAudioLevel(data) {
  el.meterFill.style.width = `${Math.min(100, Math.round(data.peak * 140))}%`;
  el.meterFill.classList.toggle('gated', Boolean(data.gated));
  if (data.rms >= AUDIO_SIGNAL_MIN_RMS) {
    io.hasDetectedSignal = true;
    clearTimeout(io.silenceTimer);
  }
  const state = classifyAudioSignal({
    rms: data.rms,
    gated: Boolean(data.gated),
    elapsedMs: performance.now() - io.audioStartedAt,
    hasDetectedSignal: io.hasDetectedSignal,
  });
  setAudioSignalState(state);
}

async function startAudio() {
  const deviceId = el.device.value;
  // Raw audio: browser AGC / noise suppression / echo cancellation are tuned for
  // voice calls and can clip speech or mangle virtual-device input. Streaming ASR
  // models do better with the unprocessed signal.
  const constraints = {
    audio: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  };

  if (deviceId === 'display') {
    io.mediaStream = await startDisplayAudio();
  } else {
    io.mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
    await refreshDevices(); // device labels only populate after permission is granted
  }
  const audioTrack = io.mediaStream.getAudioTracks()[0];
  beginAudioSignalCheck(audioTrack);

  // Ask for 16 kHz, but read back what we actually got — Safari ignores the hint.
  io.ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
  if (io.ctx.state === 'suspended') await io.ctx.resume();

  await io.ctx.audioWorklet.addModule('./pcm-worklet.js?v=fb68eb0f');

  const source = io.ctx.createMediaStreamSource(io.mediaStream);
  io.node = new AudioWorkletNode(io.ctx, 'pcm-processor', {
    numberOfInputs: 1,
    numberOfOutputs: 0,
    channelCount: 1,
    channelCountMode: 'explicit',
  });

  io.node.port.onmessage = (event) => {
    const data = event.data;
    if (data.type === 'level') {
      // The worklet reports the pre-gate signal, so a quiet microphone and
      // audio intentionally held below the threshold remain distinguishable.
      showAudioLevel(data);
      return;
    }
    if (data.type === 'audio' && io.ws?.readyState === WebSocket.OPEN) {
      io.ws.send(data.frame);
    }
  };

  io.node.port.postMessage({ type: 'threshold', value: gateThreshold() });

  source.connect(io.node);
  return io.ctx.sampleRate;
}

function stopAudio() {
  clearTimeout(io.silenceTimer);
  try { io.node?.port.postMessage('stop'); } catch {}
  try { io.node?.disconnect(); } catch {}
  try { io.mediaStream?.getTracks().forEach((t) => t.stop()); } catch {}
  try { io.ctx?.close(); } catch {}
  io.node = null;
  io.mediaStream = null;
  io.ctx = null;
  io.audioStartedAt = 0;
  io.hasDetectedSignal = false;
  io.audioDeviceLabel = '';
  el.meterFill.style.width = '0%';
  el.meterFill.classList.remove('gated');
  setAudioSignalState('idle');
}

// The slider is 0–60 for feel; the underlying RMS threshold is small because
// speech RMS typically sits between 0.02 and 0.20. 0 disables the gate.
const gateThreshold = () => Number(el.gate.value) / 1000;

function applyGate() {
  const value = Number(el.gate.value);
  el.gateValue.textContent = value === 0 ? 'Off' : String(value);
  localStorage.setItem('lc.gate', String(value));

  el.gate.setAttribute('aria-valuetext', value === 0 ? 'Close' : String(value));

  io.node?.port.postMessage({ type: 'threshold', value: gateThreshold() });
}

function updateAudioCheckSettings(deviceLabel = '') {
  el.audioCheckDevice.textContent = deviceLabel
    || el.device.selectedOptions[0]?.textContent
    || 'Default microphone';
  const gate = Number(el.gate.value);
  el.audioCheckGate.textContent = gate === 0 ? 'Off (manual)' : `${gate} (manual)`;
}

function resetAudioCheckView() {
  el.audioCheckRun.hidden = true;
  el.audioCheckResult.hidden = true;
  el.audioCheckResult.removeAttribute('data-outcome');
  el.audioCheckError.textContent = '';
  el.audioCheckProgress.value = 0;
  el.audioCheckMeterFill.style.width = '0%';
  el.audioCheckStart.textContent = 'Start check';
  el.audioCheckApply.disabled = true;
  delete el.audioCheckApply.dataset.gate;
  updateAudioCheckSettings();
}

function stopAudioCheck({ resetView = false } = {}) {
  audioCheck.running = false;
  audioCheck.attempt += 1;
  clearTimeout(audioCheck.timeout);
  clearInterval(audioCheck.progressTimer);
  try { audioCheck.node?.port.postMessage('stop'); } catch {}
  try { audioCheck.node?.disconnect(); } catch {}
  try { audioCheck.stream?.getTracks().forEach((track) => track.stop()); } catch {}
  try { audioCheck.ctx?.close(); } catch {}
  audioCheck.stream = null;
  audioCheck.ctx = null;
  audioCheck.node = null;
  audioCheck.phase = 'idle';
  audioCheck.timeout = null;
  audioCheck.progressTimer = null;
  // Do not retain a voice-level timeline after the aggregate result is built.
  audioCheck.ambientFrames = [];
  audioCheck.speechFrames = [];
  if (resetView) resetAudioCheckView();
}

function renderAudioCheckResult(result) {
  el.audioCheckRun.hidden = true;
  el.audioCheckResult.hidden = false;
  el.audioCheckResult.dataset.outcome = result.outcome;
  el.audioCheckSummary.textContent = result.summary;
  el.audioCheckLevel.textContent = result.reports.level;
  el.audioCheckLevelValue.textContent = `Speech ${formatDbfs(result.metrics.speechRms)}`;
  el.audioCheckNoise.textContent = result.reports.noise;
  el.audioCheckNoiseValue.textContent = `Background ${formatDbfs(result.metrics.ambientRms)}`;
  el.audioCheckClipping.textContent = result.reports.clipping;
  el.audioCheckPeakValue.textContent = `Peak ${Math.round(result.metrics.speechPeak * 100)}%`;
  el.audioCheckSilence.textContent = result.reports.silence;
  el.audioCheckGuidance.textContent = result.guidance;
  el.audioCheckStart.textContent = 'Check again';

  if (result.recommendedGate === null) {
    el.audioCheckRecommendation.textContent = 'Unavailable';
    el.audioCheckApply.disabled = true;
    delete el.audioCheckApply.dataset.gate;
  } else {
    el.audioCheckRecommendation.textContent = String(result.recommendedGate);
    el.audioCheckApply.disabled = false;
    el.audioCheckApply.textContent = 'Apply suggestion';
    el.audioCheckApply.dataset.gate = String(result.recommendedGate);
  }
}

function finishAudioCheck() {
  const result = analyzeAudioCheck({
    ambientFrames: audioCheck.ambientFrames,
    speechFrames: audioCheck.speechFrames,
  });
  stopAudioCheck();
  renderAudioCheckResult(result);
}

function updateAudioCheckProgress() {
  const elapsed = performance.now() - audioCheck.phaseStartedAt;
  const value = audioCheck.phase === 'ambient'
    ? Math.min(AUDIO_CHECK_AMBIENT_MS, elapsed)
    : AUDIO_CHECK_AMBIENT_MS + Math.min(AUDIO_CHECK_SPEECH_MS, elapsed);
  el.audioCheckProgress.value = value;
}

function beginAudioCheckSpeechPhase() {
  audioCheck.phase = 'speech';
  audioCheck.phaseStartedAt = performance.now();
  el.audioCheckPhase.textContent = 'Now say a sentence at your normal speaking volume';
  el.audioCheckLive.textContent = 'For example: Hello everyone, let us start the meeting.';
  el.audioCheckProgress.value = AUDIO_CHECK_AMBIENT_MS;
  audioCheck.timeout = setTimeout(finishAudioCheck, AUDIO_CHECK_SPEECH_MS);
}

function onAudioCheckLevel(data) {
  if (!audioCheck.running) return;
  const frame = { rms: Number(data.rms) || 0, peak: Number(data.peak) || 0 };
  if (audioCheck.phase === 'ambient') audioCheck.ambientFrames.push(frame);
  if (audioCheck.phase === 'speech') audioCheck.speechFrames.push(frame);
  el.audioCheckMeterFill.style.width = `${Math.min(100, Math.round(frame.peak * 140))}%`;
}

async function startAudioCheck() {
  stopAudioCheck();
  const attempt = audioCheck.attempt;
  el.audioCheckResult.hidden = true;
  el.audioCheckError.textContent = '';
  el.audioCheckRun.hidden = false;
  el.audioCheckPhase.textContent = 'Connecting to your input…';
  el.audioCheckLive.textContent = 'Your browser may ask for microphone or screen sharing permission.';
  el.audioCheckStart.textContent = 'Stop check';
  audioCheck.running = true;

  try {
    const deviceId = el.device.value;
    const constraints = {
      audio: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    };
    const capturedStream = deviceId === 'display'
      ? await startDisplayAudio()
      : await navigator.mediaDevices.getUserMedia(constraints);
    if (!audioCheck.running || audioCheck.attempt !== attempt) {
      capturedStream.getTracks().forEach((track) => track.stop());
      return;
    }
    audioCheck.stream = capturedStream;
    const track = capturedStream.getAudioTracks()[0];
    if (!track) throw new Error('This input has no audio track. Choose another device.');
    track.addEventListener('ended', () => {
      if (audioCheck.running) {
        stopAudioCheck({ resetView: true });
        el.audioCheckError.textContent = 'The input stopped. Choose a device and try again.';
      }
    });
    updateAudioCheckSettings(track.label);

    const checkContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    audioCheck.ctx = checkContext;
    if (checkContext.state === 'suspended') await checkContext.resume();
    await checkContext.audioWorklet.addModule('./pcm-worklet.js?v=fb68eb0f');
    if (!audioCheck.running || audioCheck.attempt !== attempt) {
      capturedStream.getTracks().forEach((captureTrack) => captureTrack.stop());
      void checkContext.close();
      return;
    }
    const source = checkContext.createMediaStreamSource(capturedStream);
    audioCheck.node = new AudioWorkletNode(checkContext, 'pcm-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
      channelCountMode: 'explicit',
      processorOptions: { levelsOnly: true },
    });
    audioCheck.node.port.onmessage = (event) => {
      if (event.data?.type === 'level') onAudioCheckLevel(event.data);
    };
    source.connect(audioCheck.node);

    audioCheck.phase = 'ambient';
    audioCheck.phaseStartedAt = performance.now();
    el.audioCheckPhase.textContent = 'Stay quiet while background noise is measured';
    el.audioCheckLive.textContent = 'Please stay quiet for a moment.';
    audioCheck.progressTimer = setInterval(updateAudioCheckProgress, 100);
    audioCheck.timeout = setTimeout(beginAudioCheckSpeechPhase, AUDIO_CHECK_AMBIENT_MS);
  } catch (error) {
    if (audioCheck.attempt !== attempt) return;
    stopAudioCheck();
    el.audioCheckRun.hidden = true;
    el.audioCheckStart.textContent = 'Retry';
    el.audioCheckError.textContent = `| error}|Could not start the check: ${error.message || error}|| error}`;
  }
}

function openAudioCheckDialog() {
  if (app.running) return;
  stopAudioCheck();
  resetAudioCheckView();
  el.audioCheckDialog.showModal();
}

// ---------------------------------------------------------------- Soniox engine

function buildSonioxConfig(apiKey, sampleRate) {
  const source = el.sourceLang.value;
  const target = el.targetLang.value;
  const twoWay = el.mode.value === 'two_way';

  const config = {
    api_key: apiKey,
    model: SONIOX_MODEL,
    audio_format: 'pcm_s16le',
    sample_rate: sampleRate,
    num_channels: 1,
    enable_speaker_diarization: true,
    enable_language_identification: true,
    enable_endpoint_detection: true,
    language_hints: (twoWay ? [source, target] : [source]).filter(language => language !== 'auto'),
  };
  if (!config.language_hints.length) delete config.language_hints;
  // Trial keys already carry an immutable server-generated reference id. BYOK
  // and the Node-server key keep the existing product identifier.
  if (!app.trial.inSession) config.client_reference_id = 'live-caption-web';

  // Domain vocabulary makes the model spell jargon, product and people names
  // correctly instead of guessing at a phonetic match.
  const context = buildSonioxContext();
  if (context) config.context = context;

  // Soniox only translates when it is also the chosen translation provider.
  // Otherwise this is a caption-only stream and translation happens per finished
  // sentence through /api/translate, which produces noticeably better output.
  if (el.translator.value === 'soniox' && source !== target) {
    config.translation = twoWay
      ? { type: 'two_way', language_a: source, language_b: target }
      : { type: 'one_way', target_language: target };
  }

  return config;
}

async function fetchTemporaryKey(isCurrent = () => true) {
  // Verified: Soniox accepts a long-lived key in the WebSocket config, so BYOK
  // needs no token-minting round trip and therefore no server.
  if (isByok()) {
    if (app.trial.code || app.trial.requested) {
      const result = app.trial.code
        ? await redeemTrialCode({ brokerUrl: TRIAL_BROKER_URL, code: app.trial.code })
        : await startFreeTrial({ brokerUrl: TRIAL_BROKER_URL });
      if (!isCurrent()) throw new DOMException('Caption start was cancelled.', 'AbortError');
      app.trial.unlimited = result.unlimited === true && Boolean(app.trial.code);
      if (!app.trial.unlimited) app.trial.code = '';
      app.trial.requested = false;
      app.trial.inSession = true;
      app.trial.endReason = '';
      app.trial.redemptionId = result.redemption_id || '';
      el.trialCode.value = app.trial.code;
      syncTrialAccessLabels();
      setControlsDisabled(true);
      showNotice(app.trial.unlimited
        ? 'Unrestricted referral access active. No session time limit or limit on starts. Stop and start again whenever you need.'
        : 'Starting your free trial: up to 30 minutes. Stopping, refreshing or disconnecting ends this connection.');
      return result.api_key;
    }
    if (!keys.soniox) throw new Error('Choose the free trial or add a Soniox API key to start captions.');
    return keys.soniox;
  }
  const res = await fetch('./api/token', { method: 'POST' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Token request failed (${res.status})`);
  if (!body.api_key) throw new Error('The server did not return a Soniox temporary key.');
  return body.api_key;
}

async function connectSoniox(sampleRate) {
  const startedAt = app.startedAt;
  const isCurrent = () => app.running && !app.intentionalClose && app.startedAt === startedAt;
  const apiKey = await fetchTemporaryKey(isCurrent);
  if (!isCurrent()) throw new DOMException('Caption start was cancelled.', 'AbortError');

  await new Promise((resolve, reject) => {
    const ws = new WebSocket(SONIOX_WS);
    ws.binaryType = 'arraybuffer';
    io.ws = ws;

    const failFast = () => reject(new Error('Could not connect to Soniox.'));

    ws.onopen = () => {
      ws.send(JSON.stringify(buildSonioxConfig(apiKey, sampleRate)));
      app.reconnectAttempt = 0;
      setStatus('running', 'Listening · Soniox');
      setError('');
      ws.onerror = (e) => console.warn('[soniox] socket error', e);
      resolve();
    };

    ws.onerror = failFast;
    ws.onmessage = (event) => handleSonioxMessage(event.data);
    ws.onclose = () => handleSonioxClose(sampleRate);
  });
}

function handleSonioxMessage(raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }

  // Rolling record of the raw stream. Costs nothing and is the only way to settle
  // "the caption and the translation don't match" after the fact — dump it with
  // __lc.dump() from the console.
  app.rawLog.push({ t: Date.now() - app.startedAt, m: message });
  if (app.rawLog.length > 400) app.rawLog.shift();

  // Text coming back is proof the audio arrived, whatever the level meter
  // believes. Telling someone to change their input while their words are
  // appearing on screen is worse than saying nothing: the advice is wrong and
  // it points them away from whatever the real problem is.
  if (message.tokens?.length) noteRecognizerActivity();

  if (message.error_code) {
    const error = sonioxErrorMessage(message, app.trial.inSession);
    // Reconnecting with the same rejected key can never fix authorization.
    void stop().then(() => {
      setError(error);
      setStatus('error', 'Soniox could not continue');
      showNotice(error, 'Trial / API keys', () => openCaptionSetup());
    });
    return;
  }

  // Keep audio-time monotonic across reconnects so .srt timestamps stay sane.
  if (typeof message.total_audio_proc_ms === 'number') {
    stream.lastProcMs = message.total_audio_proc_ms;
  }

  flushPendingCutIfDue();

  let sawEndpoint = false;
  let interimOrig = '';
  let interimTrans = '';
  let languageChanged = false;

  for (const token of message.tokens || []) {
    // Endpoint detection marks an utterance boundary with a literal <end> token.
    if (token.text === '<end>') {
      sawEndpoint = true;
      continue;
    }

    const isTranslation = token.translation_status === 'translation';

    if (token.is_final) {
      if (isTranslation) {
        stream.finalTrans += token.text;
      } else {
        // A change of speaker always ends the segment. Letting two people run
        // together in one line is what makes the translation incoherent — the
        // model reads a reply as a continuation of the previous sentence.
        if (
          token.speaker &&
          stream.speaker &&
          token.speaker !== stream.speaker &&
          stream.finalOrig.trim()
        ) {
          commitSegment(stream.finalOrig.length);
        }
        if (token.speaker) stream.speaker = token.speaker;

        stream.finalOrig += token.text;
        if (stream.segStartMs === null && typeof token.start_ms === 'number') {
          stream.segStartMs = token.start_ms;
        }
        if (stream.displayStartMs === null) stream.displayStartMs = stream.segStartMs;
        if (typeof token.end_ms === 'number') stream.lastEndMs = token.end_ms;
        if (token.language) {
          stream.language = token.language;
          if (token.language !== app.detectedLanguage) {
            app.detectedLanguage = token.language;
            languageChanged = true;
          }
        }
      }
    } else if (isTranslation) {
      interimTrans += token.text;
    } else {
      interimOrig += token.text;
      if (stream.displayStartMs === null && typeof token.start_ms === 'number') {
        stream.displayStartMs = token.start_ms;
      }
      if (token.speaker) stream.previewSpeaker = token.speaker;
    }
  }

  stream.interimOrig = interimOrig;
  stream.interimTrans = interimTrans;

  if (languageChanged) checkLanguageMismatch();

  // Endpoint detection is the most reliable boundary signal, but it still goes
  // through the grace window so this utterance's translation lands in this segment.
  if (sawEndpoint) schedulePendingCut(stream.finalOrig.length);
  maybeCut();

  renderLive();

  // Soniox flushes the tail of the last utterance after end-of-stream, then
  // sends `finished`. stop() waits for this so the final sentence isn't lost.
  if (message.finished) app.onSonioxFinished?.();
}

function handleSonioxClose(sampleRate) {
  if (io.ws) io.ws.onmessage = null;
  io.ws = null;

  if (!app.running || app.intentionalClose) return;

  if (app.trial.inSession) {
    const expired = app.trial.endReason === 'expired';
    app.trial.inSession = false;
    void stop().then(() => {
      const message = app.trial.unlimited
        ? 'The connection ended. Your unrestricted code is still ready. Press Start captions to reconnect.'
        : expired
        ? 'The 30-minute trial has ended. Start another trial if your daily allowance permits, or use your own API key.'
        : 'The trial connection has ended. Unused time cannot be resumed after disconnection.';
      setError(message);
      setStatus('error', expired ? 'Trial ended' : 'Trial disconnected');
      showNotice(message, app.trial.unlimited ? 'Start captions' : 'Trial / API keys', () =>
        app.trial.unlimited ? void start() : openCaptionSetup());
    });
    return;
  }

  // Carry the audio clock forward, then reconnect with a fresh temporary key.
  app.msOffset += stream.lastProcMs || 0;
  stream.lastProcMs = 0;

  app.reconnectAttempt += 1;
  if (app.reconnectAttempt > 8) {
    setError('Stopped after repeated connection failures. Your transcript is still available.');
    void stop();
    return;
  }

  const delay = Math.min(8000, 400 * 2 ** (app.reconnectAttempt - 1));
  setStatus('connecting', `Disconnected. Reconnecting in ${Math.round(delay / 1000)} seconds…`);

  setTimeout(async () => {
    if (!app.running) return;
    try {
      await connectSoniox(sampleRate);
    } catch (err) {
      setError(err.message);
      handleSonioxClose(sampleRate);
    }
  }, delay);
}

// ---------------------------------------------------------------- Web Speech engine

function startWebSpeech() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) throw new Error('Use Chrome or Edge for browser speech recognition.');

  const lang = LANGS.find((l) => l.code === el.sourceLang.value)?.speech || 'en-AU';
  const recognition = new Recognition();
  recognition.lang = lang;
  recognition.continuous = true;
  recognition.interimResults = true;
  io.recognition = recognition;

  recognition.onresult = (event) => {
    io.hasRecognized = true;
    noteRecognizerActivity();
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      const text = result[0].transcript;
      if (result.isFinal) {
        const line = text.trim();
        if (line) {
          const nowMs = Math.max(0, Date.now() - app.startedAt);
          const segment = pushSegment({
            orig: line,
            trans: '',
            startMs: stream.displayStartMs ?? nowMs,
            endMs: nowMs,
          });
          // A following interim result belongs to the next utterance and must
          // establish its own visual timestamp.
          stream.displayStartMs = null;
          void queueTranslation(segment, line, el.sourceLang.value);
        }
      } else {
        interim += text;
      }
    }
    stream.interimOrig = interim;
    renderLive();
  };

  recognition.onerror = (event) => {
    if (event.error === 'aborted') return;
    if (event.error === 'no-speech') {
      // Raised after every pause, so it is only news when nothing has been
      // recognised all session. The likeliest cause by far is the language:
      // this engine listens for exactly one and is deaf to every other. Saying
      // "改用 Soniox" first, as this used to, answered a question nobody asked.
      if (!io.hasRecognized) {
        const lang = el.sourceLang.selectedOptions[0]?.textContent || 'selected language';
        setAudioSignalState('silent',
          `No speech recognized. Browser speech is listening for ${lang}. Check the language and microphone permission.`);
      }
      return;
    }
    const message = browserSpeechErrorMessage(event.error);
    void stop().then(() => {
      setError(message);
      setStatus('error', 'Browser speech unavailable');
      showNotice(message, TRIAL_BROKER_URL ? 'Try free · 30 min' : 'Set up Soniox', () =>
        openCaptionSetup());
    });
  };

  // SpeechRecognition stops itself periodically; restart while we're still running.
  recognition.onend = () => {
    if (!app.running) return;
    try {
      recognition.start();
    } catch {
      /* already restarting */
    }
  };

  recognition.start();
  io.hasDetectedSignal = false;
  io.hasRecognized = false;
  setAudioSignalState('waiting', 'Waiting for speech');
  setStatus('running', 'Listening · Browser speech');
  void startWebSpeechMeter();
}

// A read-only tap on the default microphone, purely so the level meter can
// answer "is it hearing me". Opened after the recogniser is already running,
// and every failure swallowed: a meter is a nicety, recognition is the job.
//
// The tap is not trusted until it has actually heard something. On a test rig
// it returned a permanently silent stream while the recogniser held the device,
// and a bar pinned to zero is worse than no bar — it reads as "your microphone
// is dead" when the truth is "this page cannot hear what the recogniser hears".
// So the meter only appears once it has real sound to show, and it never drives
// the status text: in this mode the recogniser is the only witness worth
// quoting about whether anything is being heard.
async function startWebSpeechMeter() {
  try {
    const media = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    ctx.createMediaStreamSource(media).connect(analyser);

    const buffer = new Float32Array(analyser.fftSize);
    io.monitor = { media, ctx, raf: 0 };
    io.audioStartedAt = performance.now();

    const tick = () => {
      if (!io.monitor) return;
      analyser.getFloatTimeDomainData(buffer);
      let sum = 0;
      let peak = 0;
      for (const value of buffer) {
        sum += value * value;
        peak = Math.max(peak, Math.abs(value));
      }
      if (Math.sqrt(sum / buffer.length) >= AUDIO_SIGNAL_MIN_RMS) {
        el.body.classList.add('mic-metered');
      }
      el.meterFill.style.width = `${Math.min(100, Math.round(peak * 140))}%`;
      io.monitor.raf = requestAnimationFrame(tick);
    };
    tick();
  } catch {
    /* No meter, then. The recogniser is unaffected. */
  }
}

function stopWebSpeechMeter() {
  if (!io.monitor) return;
  cancelAnimationFrame(io.monitor.raf);
  io.monitor.media.getTracks().forEach((track) => track.stop());
  void io.monitor.ctx.close().catch(() => {});
  io.monitor = null;
  el.body.classList.remove('mic-metered');
  el.meterFill.style.width = '0%';
}

function stopWebSpeech() {
  stopWebSpeechMeter();
  if (!io.recognition) return;
  io.recognition.onend = null;
  try { io.recognition.stop(); } catch {}
  io.recognition = null;
}

function matchingTerms(text) {
  if (!terms.pairs.length) return [];
  const haystack = text.toLowerCase();
  return terms.pairs.filter((p) => haystack.includes(p.source.toLowerCase()));
}

// The last few already-translated sentences before this one, as context.
function recentReferences(segment, limit = 3) {
  const index = app.segments.indexOf(segment);
  const before = index === -1 ? app.segments : app.segments.slice(0, index);
  return before
    .filter((s) => s.orig && s.trans)
    .slice(-limit)
    .map((s) => ({ Type: 'sentence', Text: s.orig, Translation: s.trans }));
}

// Fired per finalized segment. Each request patches its own segment node, so they
// can run concurrently without any ordering risk.
async function queueTranslation(segment, text, detectedLang) {
  if (!usesExternalTranslator() || !text) return;

  // An LLM handed a lone "。" plus conversational context will continue the
  // conversation rather than translate — it invents a plausible next sentence.
  // Nothing without an actual word in it is worth a request.
  if (isPunctuationOnly(text.trim())) return;

  const target = pickTarget(detectedLang);
  // Nothing to do when the utterance is already in the target language.
  if (detectedLang && detectedLang === target) return;

  const expectedRevision = segment.revision;
  try {
    if (isByok()) {
      const translation = await translateInBrowser({
        text,
        targetName: langName(target),
        glossary: matchingTerms(text),
        scene: terms.scene,
        references: recentReferences(segment),
      });
      if (translation) {
        patchFinalCaption(segment, { trans: translation }, { expectedRevision });
        app.translateFailures = 0;
        setTranslatorStatus('claude');
      }
      return;
    }

    const res = await fetch('./api/translate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text,
        source: detectedLang || '',
        target,
        targetName: langName(target),
        provider: el.translator.value,
        // Recent sentence pairs so the model keeps terminology and tone
        // consistent across a long meeting instead of translating in isolation.
        references: recentReferences(segment),
        // Only the terms this sentence actually contains. Sending the whole
        // glossary every time tripled the token cost for no benefit — a term
        // can only influence a translation if the word is present.
        glossary: matchingTerms(text),
        scene: terms.scene,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Translation failed (${res.status})`);

    if (body.translation) {
      patchFinalCaption(segment, { trans: body.translation }, { expectedRevision });
      app.translateFailures = 0;
      setTranslatorStatus(body.provider);
      // Announce a silent vendor switch once, rather than letting the meeting
      // run on a different engine without anyone noticing.
      if (body.fellBackFrom && body.provider !== app.announcedFallback) {
        app.announcedFallback = body.provider;
        const from = providerLabel(body.fellBackFrom);
        const to = providerLabel(body.provider);
        showNotice(
          `${from} is unavailable. Translation switched to ${to}. ${(body.reason || '').slice(0, 90)}`,
        );
      }
    }
  } catch (err) {
    setError(err.message);
    // Missing translations used to be completely silent — surface a run of them.
    if (++app.translateFailures === 3) {
      showNotice(`Translation failed ${app.translateFailures} times. Captions are still available.`, 'Retry', () => {
        app.translateFailures = 0;
        setError('');
      });
    }
  }
}

function providerLabel(id) {
  return app.config.translation.providers.find((p) => p.id === id)?.label || id;
}

// Keeps the serving vendor visible in the status bar at all times.
function setTranslatorStatus(id) {
  app.activeTranslator = id;
  el.translatorStatus.textContent = id ? `Translation ${providerLabel(id)}` : '';
  el.translatorStatus.classList.toggle('warn', Boolean(id) && id !== el.translator.value);
}

// ---------------------------------------------------------------- start / stop

async function start() {
  if (app.running) return false;
  if (needsCaptionAccess()) {
    const message = TRIAL_BROKER_URL
      ? 'Choose the free 30-minute trial or add a Soniox API key to start captions.'
      : 'Add a Soniox API key to start captions.';
    setError(message);
    openCaptionSetup({ message });
    return false;
  }
  setError('');
  // The restore offer belongs to the previous session's transcript. Left up, it
  // sits over a session that has already started, still offering to bring back
  // something else.
  hideNotice();
  resetCaptionFollowing();
  resetStream();
  app.intentionalClose = false;
  app.reconnectAttempt = 0;
  app.msOffset = 0;
  stream.lastProcMs = 0;
  // Re-detect on every session, so a restart re-checks the language config.
  app.detectedLanguage = null;
  app.translateFailures = 0;
  app.announcedFallback = null;
  setTranslatorStatus(usesExternalTranslator() ? el.translator.value : null);
  app.running = true;
  app.startedAt = Date.now();
  const startedAt = app.startedAt;

  el.startBtn.textContent = 'Stop captions';
  el.startBtn.dataset.running = 'true';
  setControlsDisabled(true);
  setStatus('connecting', 'Starting…');

  app.clockTimer = setInterval(tickClock, 1000);
  tickClock();

  try {
    if (app.engine === 'soniox') {
      const sampleRate = await startAudio();
      if (!app.running || app.startedAt !== startedAt) {
        if (!app.running) stopAudio();
        return false;
      }
      await connectSoniox(sampleRate);
    } else {
      startWebSpeech();
    }
    el.placeholder.hidden = app.segments.length > 0;
    // Until the first line lands this is the only thing on screen, so it should
    // say what is happening now rather than describe the settings that got here.
    if (!el.placeholder.hidden) el.placeholderHint.textContent = 'Listening… Your first words will appear here.';
    return true;
  } catch (err) {
    if (!app.running || app.startedAt !== startedAt) return false;
    await stop();
    const message = err.name === 'NotAllowedError'
      ? 'Microphone access was not allowed. Allow microphone access in your browser, then try again.'
      : err.name === 'NotFoundError'
        ? 'No microphone was found. Connect a microphone or choose another audio source.'
        : err.message || String(err);
    setError(message);
    setStatus('error', 'Could not start');
    return false;
  }
}

// End the Soniox stream and wait for the tail.
//
// The end-of-stream signal must be an empty TEXT frame. An empty ArrayBuffer is
// silently ignored by the service, which then sits waiting for more audio until
// it times out (error 408) — and closing the socket immediately after the signal
// throws away the final flush, losing the last spoken sentence every time.
function finishSonioxStream(timeoutMs = 2000) {
  const ws = io.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.resolve();

  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      app.onSonioxFinished = null;
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    app.onSonioxFinished = done;
    try {
      ws.send('');
    } catch {
      done();
    }
  });
}

async function stop() {
  const endedTrial = app.trial.inSession;
  app.trial.inSession = false;
  app.running = false;
  app.intentionalClose = true;

  clearInterval(app.clockTimer);
  app.clockTimer = null;

  // Cut the audio off first, so nothing is still being sent after end-of-stream.
  stopWebSpeech();
  stopAudio();

  if (io.ws) {
    await finishSonioxStream();
    try { io.ws.close(); } catch {}
    io.ws = null;
  }

  // Flush whatever is still buffered so nothing is lost.
  stream.interimOrig = '';
  stream.interimTrans = '';
  maybeCut({ force: true });
  renderLive();
  resetStream();

  el.startBtn.textContent = 'Start captions';
  el.startBtn.dataset.running = 'false';
  setControlsDisabled(false);
  persistNow();
  setStatus('idle', 'Stopped · transcript available');
  if (endedTrial) {
    if (app.trial.unlimited) {
      showNotice('Stopped. Your unrestricted code is ready to use again.', 'Start captions', () => void start());
    } else {
      showNotice('This trial connection has ended. Start another trial if your daily allowance permits, or use your own API key.', 'Trial / API keys', () =>
        el.keysBtn.click());
    }
  }
}

// ---------------------------------------------------------------- export

function srtTime(ms) {
  const total = Math.max(0, Math.floor(ms));
  const h = String(Math.floor(total / 3600000)).padStart(2, '0');
  const m = String(Math.floor((total % 3600000) / 60000)).padStart(2, '0');
  const s = String(Math.floor((total % 60000) / 1000)).padStart(2, '0');
  const msPart = String(total % 1000).padStart(3, '0');
  return `${h}:${m}:${s},${msPart}`;
}

function buildText() {
  return app.segments
    .map((s) => (s.trans ? `${s.orig}\n${s.trans}` : s.orig))
    .join('\n\n');
}

function buildMarkdown() {
  const header = `# Live Caption transcript\n\n- Time: ${new Date().toLocaleString()}\n- Captions: ${app.segments.length}\n\n---\n\n`;
  const body = app.segments
    .map((s) => {
      // Same label as on screen — the raw Soniox id would not match what was shown.
      const identity = s.source === 'typed'
        ? `⌨ ${s.author || 'Participant'}`
        : s.speaker ? speakerName(s.speaker) : '';
      const meta = `**${stamp(s.startMs)}**${identity ? ` · ${identity}` : ''}`;
      return s.trans ? `${meta}\n\n> ${s.orig}\n\n${s.trans}` : `${meta}\n\n${s.orig}`;
    })
    .join('\n\n---\n\n');
  return header + body + '\n';
}

function buildSrt() {
  return app.segments
    .map((s, i) => {
      const end = Math.max(s.endMs, s.startMs + 1200);
      const text = s.trans ? `${s.trans}\n${s.orig}` : s.orig;
      return `${i + 1}\n${srtTime(s.startMs)} --> ${srtTime(end)}\n${text}\n`;
    })
    .join('\n');
}

function download(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function fileStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

// Runs the server-side probe of every configured vendor and reports it inline.
async function runSelfTest() {
  showNotice('Checking services…');
  try {
    if (isByok()) return void runSelfTestInBrowser();
    const res = await fetch('./api/selftest', { method: 'POST' });
    const { results } = await res.json();
    const line = results
      .map((r) => `${r.ok ? '✅' : '❌'} ${r.name} ${r.ms}ms${r.ok ? '' : ` — ${r.detail}`}`)
      .join('　');
    const allOk = results.every((r) => r.ok);
    showNotice(allOk ? `All services ready · ${line}` : `Some services need attention · ${line}`);
  } catch (err) {
    showNotice(`Service check failed: ${err.message}`);
  }
}

// BYOK self-test: exercises the user's own keys against both vendors directly.
async function runSelfTestInBrowser() {
  const results = [];
  const timed = async (name, fn) => {
    const t0 = Date.now();
    try {
      await fn();
      results.push({ name, ok: true, ms: Date.now() - t0 });
    } catch (err) {
      results.push({ name, ok: false, ms: Date.now() - t0, detail: err.message });
    }
  };

  await timed('Soniox captions', () => {
    if (!keys.soniox) throw new Error('Add an API key first');
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(SONIOX_WS);
      const fail = (m) => { try { ws.close(); } catch {} reject(new Error(m)); };
      const timer = setTimeout(() => fail('Connection timed out'), 10000);
      ws.onopen = () => {
        ws.send(JSON.stringify({
          api_key: keys.soniox, model: SONIOX_MODEL, audio_format: 'pcm_s16le',
          sample_rate: 16000, num_channels: 1, language_hints: ['en'],
        }));
        ws.send(new Int16Array(1600).buffer);
        ws.send('');
      };
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.error_code) { clearTimeout(timer); fail(`${m.error_code} ${m.error_message}`); }
        if (m.finished) { clearTimeout(timer); ws.close(); resolve(); }
      };
      ws.onerror = () => { clearTimeout(timer); fail('Connection failed'); };
    });
  });

  if (keys.anthropic) {
    await timed('Claude Translation', async () => {
      const out = await translateInBrowser({ text: 'Connectivity check.', targetName: 'Simplified Chinese' });
      if (!out) throw new Error('No translation returned');
    });
  }

  const line = results
    .map((r) => `${r.ok ? '✅' : '❌'} ${r.name} ${r.ms}ms${r.ok ? '' : ` — ${r.detail}`}`)
    .join('　');
  showNotice(results.every((r) => r.ok) ? `All services ready · ${line}` : `Some services need attention · ${line}`);
}

async function handleExport(kind) {
  el.exportMenu.open = false;

  if (kind === 'selftest') return void runSelfTest();

  if (kind === 'clear') {
    if (app.segments.length && !confirm('Clear the entire transcript?')) return;
    app.segments = [];
    if (!app.running && !app.audience) el.body.classList.remove('session-started');
    el.body.classList.toggle('has-captions', !el.live.hidden);
    localStorage.removeItem(STORE_KEY);
    el.captions.innerHTML = '';
    el.placeholder.hidden = false;
    resetCaptionFollowing();
    updateCounter();
    return;
  }

  if (!app.segments.length) {
    setError('There are no captions to export yet.');
    return;
  }

  if (kind === 'copy') {
    try {
      await navigator.clipboard.writeText(buildText());
      setError('');
      const previous = el.statusText.textContent;
      el.statusText.textContent = 'Copied to clipboard';
      setTimeout(() => { el.statusText.textContent = previous; }, 1600);
    } catch {
      setError('Could not copy. Download the transcript instead.');
    }
    return;
  }

  const base = `live-caption-${fileStamp()}`;
  if (kind === 'txt') download(`${base}.txt`, buildText(), 'text/plain;charset=utf-8');
  if (kind === 'md') download(`${base}.md`, buildMarkdown(), 'text/markdown;charset=utf-8');
  if (kind === 'srt') download(`${base}.srt`, buildSrt(), 'application/x-subrip;charset=utf-8');
}

// ---------------------------------------------------------------- events

el.startBtn.addEventListener('click', () => {
  if (app.running) void stop();
  else void start();
});

el.view.addEventListener('change', () => {
  el.body.dataset.view = el.view.value;
  if (app.pip) app.pip.document.body.dataset.view = el.view.value;
  localStorage.setItem('lc.view', el.view.value);
  if (el.view.value !== 'list') el.stage.scrollTop = el.stage.scrollHeight;
  updateJumpButton();
});

el.length.addEventListener('change', () => {
  localStorage.setItem('lc.length', el.length.value);
});

// Browser/system capture is intentionally session-only. Persisting it made a
// returning user silently start from tab capture instead of the safe mic default.
el.device.addEventListener('change', () => {
  const selectedDefault = el.device.selectedOptions[0]?.dataset.defaultSource === 'true';
  if (el.device.value === 'display' || selectedDefault || isDefaultAudioSource(el.device.value)) {
    localStorage.removeItem('lc.source');
  }
  else localStorage.setItem('lc.source', el.device.value);
  if (!app.running) setAudioSignalState('idle');
  void restartForSettingChange();
});

el.gate.addEventListener('input', applyGate);
el.audioCheckBtn.addEventListener('click', openAudioCheckDialog);
el.audioCheckStart.addEventListener('click', () => {
  if (audioCheck.running) stopAudioCheck({ resetView: true });
  else void startAudioCheck();
});
el.audioCheckApply.addEventListener('click', () => {
  const gate = Number(el.audioCheckApply.dataset.gate);
  if (!Number.isFinite(gate)) return;
  el.gate.value = String(gate);
  applyGate();
  updateAudioCheckSettings();
  el.audioCheckApply.textContent = 'Applied';
});
el.audioCheckDialog.addEventListener('close', () => stopAudioCheck());
el.audioCheckDialog.addEventListener('cancel', () => stopAudioCheck());

el.stage.addEventListener('scroll', handleStageScroll, { passive: true });
// Keep the newest line visible after fullscreen, window or console resizing.
new ResizeObserver(() => scrollToBottom()).observe(el.stage);
el.jumpBtn.addEventListener('click', jumpToLatest);

el.sheetBtn.addEventListener('click', toggleSheet);
el.settingsBtn?.addEventListener('click', () => {
  if (el.body.classList.contains('phone')) toggleSheet();
  else {
    const opening = el.body.classList.contains('console-collapsed');
    setConsoleCollapsed(!opening);
    if (opening) el.engine.focus();
  }
});
el.sheetScrim.addEventListener('click', closeSheet);
phoneQuery.addEventListener('change', applyLayout);

// Starting or stopping is the one action worth closing the sheet for.
el.startBtn.addEventListener('click', () => {
  if (el.body.classList.contains('phone')) closeSheet();
});

el.pipBtn.hidden = !pipSupported();
el.pipBtn.addEventListener('click', () => {
  if (app.pip) app.pip.close();
  else void openPip().catch((err) => setError(`Could not open floating captions: ${err.message}`));
});

el.lockBtn.addEventListener('click', () => setLocked(!app.locked, { scroll: true }));

// Release the lock only on a real gesture. Listening for plain scroll events
// would also catch our own programmatic snap-to-bottom and unlock immediately.
// Any deliberate scroll up releases the lock immediately. The previous version
// waited until the view was already far from the bottom — impossible to reach,
// because each incoming caption snapped it back before the gesture could move it.
el.stage.addEventListener(
  'wheel',
  (event) => {
    if (event.deltaY < 0) pauseFollowingForHistory();
  },
  { passive: true },
);

el.stage.addEventListener(
  'touchstart',
  (event) => { app.touchStartY = event.touches[0]?.clientY ?? 0; },
  { passive: true },
);

el.stage.addEventListener(
  'touchmove',
  (event) => {
    const y = event.touches[0]?.clientY ?? 0;
    if (y > app.touchStartY + 8) pauseFollowingForHistory(); // dragging down = scrolling up
  },
  { passive: true },
);

// Keyboard scrolling counts as intent too.
el.stage.addEventListener('keydown', (event) => {
  if (['PageUp', 'Home', 'ArrowUp'].includes(event.key)) pauseFollowingForHistory();
});

// Dragging or clicking the scrollbar is also an explicit reading gesture.
el.stage.addEventListener('pointerdown', (event) => {
  if (event.target !== el.stage || event.button !== 0) return;
  const right = el.stage.getBoundingClientRect().right;
  const scrollbarWidth = Math.max(16, el.stage.offsetWidth - el.stage.clientWidth);
  if (event.clientX >= right - scrollbarWidth) pauseFollowingForHistory();
}, { passive: true });

function openCaptionSetup({ message = '', ownKeys = false } = {}) {
  el.keySoniox.value = keys.soniox;
  el.keyAnthropic.value = keys.anthropic;
  el.trialSection.hidden = !(isByok() && TRIAL_BROKER_URL);
  el.trialCode.value = formatTrialCode(app.trial.code);
  el.trialStatus.textContent = message || (app.trial.code
    ? 'Trial code ready. Press Start captions to connect to Soniox.'
    : '');
  el.trialStatus.dataset.state = message ? 'error' : app.trial.code ? 'ready' : '';
  if (el.ownKeysSection) el.ownKeysSection.open = ownKeys || Boolean(keys.soniox) || !TRIAL_BROKER_URL;
  if (!el.keysDialog.open) el.keysDialog.showModal();
}

el.keysBtn.addEventListener('click', () => openCaptionSetup({ ownKeys: true }));

function browserSpeechErrorMessage(error) {
  const messages = {
    network: 'Browser speech could not reach its recognition service. Check your connection, or choose the free Soniox trial. Browser speech does not use an API key.',
    'not-allowed': 'Microphone access was denied. Allow microphone access in your browser and try again.',
    'service-not-allowed': 'This browser does not allow its speech recognition service. Choose the Soniox trial or use your own API key.',
    'audio-capture': 'No microphone audio is available. Check that your microphone is connected and is not in use by another app.',
    'language-not-supported': 'Browser speech does not support the selected language. Choose another language or use Soniox.',
  };
  return messages[error] || 'Browser speech stopped unexpectedly. Try again or choose Soniox in Settings.';
}

function sonioxErrorMessage(message, trial) {
  if (message.error_type === 'temp_api_key_session_expired') {
    return 'Your 30-minute trial has ended. Start another trial if your daily allowance permits, or use your own API key.';
  }
  if ([401, 403].includes(Number(message.error_code))) {
    return trial
      ? 'Soniox could not authorize this trial. Please try a new trial; you do not need your own API key.'
      : 'Soniox did not accept this API key. Check it in API keys, or choose the free 30-minute trial.';
  }
  return `Soniox could not continue (${message.error_code}). ${message.error_message || 'Please try again.'}`;
}

function syncTrialAccessLabels() {
  if (el.trialBtn) {
    const label = el.trialBtn.querySelector('.lbl') || el.trialBtn;
    label.textContent = app.trial.unlimited ? 'Start captions · unlimited' : 'Try free · 30 min';
  }
  el.trialStart.textContent = app.trial.unlimited ? 'Start with unrestricted code' : 'Start free 30-minute trial';
  const title = document.getElementById('trialTitle');
  if (title) title.textContent = app.trial.unlimited ? 'Unrestricted referral access' : 'Try free for 30 minutes';
  const limits = document.getElementById('trialLimits');
  if (limits) limits.hidden = app.trial.unlimited;
}

async function beginFreeTrial() {
  if (app.running) return;
  app.trial.requested = true;
  if (!app.trial.unlimited) app.trial.code = '';
  el.engine.value = 'soniox';
  onEngineChange();
  if (el.keysDialog.open) el.keysDialog.close('trial');
  if (!await start()) openCaptionSetup({ message: el.errorText.textContent });
}

el.trialBtn?.addEventListener('click', () => void beginFreeTrial());
el.trialStart?.addEventListener('click', () => void beginFreeTrial());

el.trialCode.addEventListener('input', () => {
  const selection = el.trialCode.selectionStart;
  el.trialCode.value = formatTrialCode(el.trialCode.value);
  el.trialCode.setSelectionRange(selection, selection);
  el.trialStatus.textContent = '';
  el.trialStatus.dataset.state = '';
});

function applyTrialCode(value, { silent = false } = {}) {
  if (!validTrialCode(value)) return false;
  app.trial.code = formatTrialCode(value);
  app.trial.unlimited = false;
  syncTrialAccessLabels();
  app.trial.requested = false;
  app.config.engines.soniox = true;
  if (![...el.engine.options].some((option) => option.value === 'soniox')) {
    el.engine.prepend(new Option('Soniox (referral access)', 'soniox'));
  }
  el.engine.value = 'soniox';
  onEngineChange();
  el.startBtn.disabled = false;
  el.trialStatus.textContent = 'Trial code ready. Press Start captions to connect to Soniox.';
  el.trialStatus.dataset.state = 'ready';
  if (!silent) {
    showNotice('Referral code ready. Press Start captions to verify your access.');
  }
  return true;
}

el.trialApply.addEventListener('click', async () => {
  if (app.running) return;
  if (!applyTrialCode(el.trialCode.value)) {
    el.trialStatus.textContent = 'Enter the trial code you were given.';
    el.trialStatus.dataset.state = 'error';
    el.trialCode.focus();
    return;
  }
  el.keysDialog.close('trial');
  if (!await start()) openCaptionSetup({ message: el.errorText.textContent });
});

// A shared link can carry the code: ?k=LAUNCH2026 saves the recipient from
// typing it. Stripped from the URL afterwards so it does not linger in the
// address bar, in a screenshot, or in whatever they paste onward.
{
  const url = new URL(location.href);
  const shared = url.searchParams.get('k');
  if (shared) {
    url.searchParams.delete('k');
    history.replaceState(null, '', url.href);
    // The provider configuration is loaded later. Do not access it here.
    if (validTrialCode(shared)) app.trial.code = formatTrialCode(shared);
  }
}

el.keysClear.addEventListener('click', () => {
  keys.soniox = '';
  keys.anthropic = '';
  saveKeys();
  el.keysDialog.close('cleared');
  location.reload();
});

el.keysDialog.addEventListener('close', () => {
  if (el.keysDialog.returnValue !== 'save') return;
  keys.soniox = el.keySoniox.value.trim();
  keys.anthropic = el.keyAnthropic.value.trim();
  saveKeys();
  // The provider list and engine availability are derived from the keys, so the
  // simplest correct refresh is a reload.
  location.reload();
});

el.termsBtn.addEventListener('click', () => {
  loadTerms();
  el.termsDialog.showModal();
});

el.termsPack.addEventListener('change', () => applyGlossaryPack(el.termsPack.value));

el.termsClear.addEventListener('click', () => {
  el.termsScene.value = '';
  el.termsWords.value = '';
  el.termsPairs.value = '';
  saveTermsFromForm();
});

el.termsDialog.addEventListener('close', () => {
  if (el.termsDialog.returnValue !== 'save') return;
  saveTermsFromForm();
  if (app.running && app.engine === 'soniox') {
    // Context is fixed for the life of a Soniox session.
    showNotice('Vocabulary saved. Restart captions to apply it.', 'Restart now', () =>
      void restartWith(() => {}));
  }
});

el.audienceBtn.addEventListener('click', () => {
  el.audienceDialog.showModal();
  if (app.audience && !app.audience.closed) showAudienceSession(app.audience);
  else void createAudienceSession();
});

el.audienceCopy.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(el.audienceUrl.value);
    const previous = el.audienceCopy.textContent;
    el.audienceCopy.textContent = 'Copied';
    setTimeout(() => { el.audienceCopy.textContent = previous; }, 1400);
  } catch {
    el.audienceUrl.select();
    setError('Could not copy. Select and copy the link manually.');
  }
});



el.audienceEnd.addEventListener('click', () => {
  if (confirm('End this room? The current QR code will stop working.')) {
    void endAudienceSession();
  }
});

el.engine.addEventListener('change', () => { onEngineChange(); void restartForSettingChange(); });
el.mode.addEventListener('change', () => { applyModeLabels(); void restartForSettingChange(); });
for (const select of [el.sourceLang, el.targetLang]) {
  select.addEventListener('change', () => void restartForSettingChange());
}

el.translator.addEventListener('change', () => {
  localStorage.setItem('lc.translator', el.translator.value);
  onEngineChange(); // refresh the hint text
  if (app.running && app.engine === 'soniox') {
    // Whether Soniox translates inline is part of the session config.
    showNotice('Restart captions to apply the new translation provider.', 'Restart now', () =>
      void restartWith(() => {}));
  }
});

el.swapBtn.addEventListener('click', () => void swapLanguages());

el.noticeDismiss.addEventListener('click', () => {
  app.noticeDismissed = true;
  hideNotice();
});

// Translation and original are sized independently — set them equal if you want
// both lines to read with the same weight.
// The floating window is a separate document with its own root, so anything set
// as a custom property has to be written to both or the two drift apart.
// Theme is identical in both windows; only the size has to be recomputed.
function styleRoots() {
  return [document.documentElement, app.pip?.document.documentElement].filter(Boolean);
}

// Same size as the main window — popping a caption out does not change how far
// away the reader is sitting. Written inline on the floating document's root
// because that is what outranks the narrow-viewport rule, which would otherwise
// treat a 640px window as a phone and shrink text the reader had just enlarged.
function syncPipFontSizes() {
  const root = app.pip?.document.documentElement;
  if (!root) return;
  root.style.setProperty('--original-size', `${el.origFontSize.value}px`);
  root.style.setProperty('--translation-size', `${el.fontSize.value}px`);
}

function applyFontSize(input, cssVar, storageKey) {
  document.documentElement.style.setProperty(cssVar, `${input.value}px`);
  localStorage.setItem(storageKey, input.value);
  syncPipFontSizes();
}

let fontSizesLinked = false;
let fontSizeRatio = Number(localStorage.getItem('lc.fontRatio')) || 42 / 34;

function setFontSizesLinked(enabled, captureRatio = enabled) {
  fontSizesLinked = enabled;
  if (enabled && captureRatio) {
    fontSizeRatio = Number(el.origFontSize.value) / Number(el.fontSize.value);
    localStorage.setItem('lc.fontRatio', String(fontSizeRatio));
  }
  el.fontLinkBtn.setAttribute('aria-pressed', String(enabled));
  el.fontLinkBtn.setAttribute(
    'aria-label',
    enabled ? 'Unlink source and translation text sizes' : 'Link source and translation text sizes',
  );
  el.fontLinkBtn.title = enabled
    ? 'Text sizes are linked. Both adjust together within their limits.'
    : 'Keep both text sizes in proportion';
  localStorage.setItem('lc.fontLinked', enabled ? '1' : '0');
}

function applyLinkedFontSize(changed) {
  const source = changed === 'original' ? el.origFontSize : el.fontSize;
  const sizes = linkedFontSizes({
    changed,
    value: Number(source.value),
    ratio: fontSizeRatio,
    min: Number(source.min),
    max: Number(source.max),
    step: Number(source.step),
  });
  el.origFontSize.value = String(sizes.original);
  el.fontSize.value = String(sizes.translation);
  applyFontSize(el.origFontSize, '--original-size', 'lc.origSize2');
  applyFontSize(el.fontSize, '--translation-size', 'lc.transSize2');
}

el.origFontSize.addEventListener('input', () => {
  if (fontSizesLinked) applyLinkedFontSize('original');
  else applyFontSize(el.origFontSize, '--original-size', 'lc.origSize2');
});

el.fontSize.addEventListener('input', () => {
  if (fontSizesLinked) applyLinkedFontSize('translation');
  else applyFontSize(el.fontSize, '--translation-size', 'lc.transSize2');
});

el.fontLinkBtn.addEventListener('click', () => setFontSizesLinked(!fontSizesLinked));

// System → Light → Dark → System
const THEMES = [
  { id: 'system', icon: '🖥', label: 'System', short: 'System' },
  { id: 'light', icon: '☀️', label: 'Light', short: 'Light' },
  { id: 'dark', icon: '🌙', label: 'Dark', short: 'Dark' },
];
const systemPrefersDark = matchMedia('(prefers-color-scheme: dark)');

function applyTheme(id) {
  const dark = id === 'system' ? systemPrefersDark.matches : id === 'dark';
  for (const root of styleRoots()) root.dataset.theme = dark ? 'dark' : 'light';

  const theme = THEMES.find((t) => t.id === id) || THEMES[0];
  // Writing to the button's textContent would erase the label beside the icon.
  el.themeIcon.textContent = theme.icon;
  el.themeLabel.textContent = `Theme: ${theme.short}`;
  el.themeBtn.title = `Theme: ${theme.label} (click to change)`;
  localStorage.setItem('lc.theme', id);
}

el.themeBtn.addEventListener('click', () => {
  const current = localStorage.getItem('lc.theme') || 'system';
  const next = THEMES[(THEMES.findIndex((t) => t.id === current) + 1) % THEMES.length];
  applyTheme(next.id);
});

// Only meaningful while following the system, but harmless to leave attached.
systemPrefersDark.addEventListener('change', () => {
  if ((localStorage.getItem('lc.theme') || 'system') === 'system') applyTheme('system');
});

function setTimestamps(on) {
  el.body.classList.toggle('show-timestamps', on);
  el.timestampsBtn.setAttribute('aria-pressed', String(on));
  el.timestampsBtn.title = on ? 'Hide timestamps' : 'Show timestamps';
  localStorage.setItem('lc.timestamps', on ? '1' : '0');
}

el.timestampsBtn.addEventListener('click', () => {
  setTimestamps(!el.body.classList.contains('show-timestamps'));
});

// Real fullscreen, not just hiding our own chrome — the browser UI goes away too.
function isFullscreen() {
  return Boolean(document.fullscreenElement || document.webkitFullscreenElement);
}

async function enterFullscreen() {
  const root = document.documentElement;
  if (!root.requestFullscreen && !root.webkitRequestFullscreen) return false;
  try {
    // WebKit's prefixed implementation does not accept the standard options
    // object; passing it can make an otherwise supported fullscreen call fail.
    if (root.requestFullscreen) await root.requestFullscreen({ navigationUI: 'hide' });
    else await root.webkitRequestFullscreen();
    return true;
  } catch {
    return false; // denied or unsupported — fall back to chrome-hiding only
  }
}

async function exitFullscreen() {
  const exit = document.exitFullscreen || document.webkitExitFullscreen;
  if (exit && isFullscreen()) {
    try { await exit.call(document); } catch {}
  }
}

function setTheater(on) {
  el.body.classList.toggle('theater', on);
  el.body.classList.remove('peek');
  el.theaterBtn.setAttribute('aria-pressed', String(on));
  // Theater hides the toolbar, and the exit button lives in it. Without a
  // separate way out, anything that stops fullscreenchange from firing leaves
  // the page with no visible escape at all.
  el.theaterExit.hidden = !on;
}

el.theaterBtn.addEventListener('click', async () => {
  if (el.body.classList.contains('theater')) {
    await exitFullscreen();
    setTheater(false);
  } else {
    setTheater(true);
    await enterFullscreen(); // must run inside the click gesture
  }
});

// Esc leaves native fullscreen without firing our click handler, so mirror the
// browser's state back into the theater class rather than tracking it ourselves.
for (const event of ['fullscreenchange', 'webkitfullscreenchange']) {
  document.addEventListener(event, () => {
    if (!isFullscreen()) setTheater(false);
  });
}

// Unconditional: the previous version only acted when already out of fullscreen,
// so if the fullscreen state and the theater class ever disagreed, Esc did nothing.
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !el.body.classList.contains('theater')) return;
  void exitFullscreen();
  setTheater(false);
});

el.theaterExit.addEventListener('click', () => {
  void exitFullscreen();
  setTheater(false);
});

// Pointer near the top edge slides the toolbar back in — the video-player
// convention, and it depends on no event other than mouse movement.
document.addEventListener('mousemove', (event) => {
  if (!el.body.classList.contains('theater')) return;
  el.body.classList.toggle('peek', event.clientY < 64);
});

el.exportMenu.addEventListener('click', (event) => {
  const kind = event.target.closest('[data-export]')?.dataset.export;
  if (kind) void handleExport(kind);
});

el.captionEditForm.addEventListener('submit', (event) => {
  const submitter = event.submitter?.value;
  if (submitter !== 'save') return;
  event.preventDefault();
  saveCaptionCorrection();
});

el.captionEditDialog.addEventListener('close', () => {
  app.editingSegmentId = null;
  el.captionEditOriginal.setCustomValidity('');
});

document.addEventListener('click', (event) => {
  if (el.exportMenu.open && !el.exportMenu.contains(event.target)) el.exportMenu.open = false;
});

navigator.mediaDevices?.addEventListener?.('devicechange', () => void refreshDevices());

window.addEventListener('beforeunload', (event) => {
  if (app.running || app.segments.length) {
    event.preventDefault();
    event.returnValue = '';
  }
});

// ---------------------------------------------------------------- boot

// Storage keys are versioned: the two sliders swapped roles when the original
// became the primary caption, so old saved values must not carry over.
for (const [input, cssVar, key] of [
  [el.origFontSize, '--original-size', 'lc.origSize2'],
  [el.fontSize, '--translation-size', 'lc.transSize2'],
]) {
  const saved = localStorage.getItem(key);
  if (saved) input.value = saved;
  document.documentElement.style.setProperty(cssVar, `${input.value}px`);
}
const savedFontLink = localStorage.getItem('lc.fontLinked') === '1';
setFontSizesLinked(savedFontLink, savedFontLink && !localStorage.getItem('lc.fontRatio'));

applyTheme(localStorage.getItem('lc.theme') || 'system');
setTimestamps(localStorage.getItem('lc.timestamps') === '1');

applyLayout();
resetCaptionFollowing();
el.length.value = localStorage.getItem('lc.length') || 'short';
el.gate.value = localStorage.getItem('lc.gate') || '0';
applyGate();
el.view.value = localStorage.getItem('lc.view') || 'list';
el.body.dataset.view = el.view.value;
loadTerms();
await loadGlossaryPacks();

fillLanguageSelects();
await loadConfig();
if (app.trial.code) {
  applyTrialCode(app.trial.code, { silent: true });
  showNotice('Referral code loaded. Press Start captions to verify your access.');
}
await restoreAudienceHostSession();
await refreshDevices();
const savedSource = localStorage.getItem('lc.source');
const sourcePreference = resolveAudioSourcePreference(
  savedSource,
  [...el.device.options].map((option) => option.value).filter((value) => value && value !== 'display'),
);
el.device.value = sourcePreference.value;
if (sourcePreference.remove) localStorage.removeItem('lc.source');
setAudioSignalState('idle');
setStatus('idle', 'Ready');
offerRestore();

// Debug hook — replay synthetic Soniox payloads with no mic and no API key:
//   __lc.feed({ tokens: [{ text: 'Hello', is_final: true, translation_status: 'original' }] })
window.__lc = {
  feed: (message) => handleSonioxMessage(JSON.stringify(message)),
  // Replay the worklet's pre-gate level report when diagnosing meter/status UI.
  level: (data) => showAudioLevel(data),
  // Render a complete check from deterministic level fixtures without asking
  // for microphone permission; used by browser regression tests and demos.
  audioCheck: (samples) => {
    openAudioCheckDialog();
    const result = analyzeAudioCheck(samples);
    renderAudioCheckResult(result);
    return result;
  },
  // Copy the raw stream + committed segments to the clipboard for diagnosis.
  dump: () => {
    const text = JSON.stringify(
      { raw: app.rawLog, segments: app.segments.map((s) => ({ o: s.orig, t: s.trans, k: s.speaker })) },
      null, 2,
    );
    navigator.clipboard?.writeText(text);
    console.log(text);
    return `${app.rawLog.length} raw messages / ${app.segments.length} captions copied to clipboard`;
  },
  push: pushSegment,
  state: { app, stream },
};
