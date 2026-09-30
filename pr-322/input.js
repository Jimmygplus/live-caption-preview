import {
  decryptAudiencePayload,
  encryptAudiencePayload,
  hashAudienceToken,
} from './audience-crypto.js?v=f133add3';
import { AUDIENCE_RELAY_URL } from './relay-config.js?v=f133add3';
import { isNewerCaptionRevision } from './caption-state.js?v=f133add3';

const form = document.querySelector('#messageForm');
const nameInput = document.querySelector('#name');
const languageInput = document.querySelector('#language');
const messageInput = document.querySelector('#message');
const sendBtn = document.querySelector('#sendBtn');
const status = document.querySelector('#status');
const count = document.querySelector('#count');
const lastSent = document.querySelector('#lastSent');
const lastState = document.querySelector('#lastState');
const lastText = document.querySelector('#lastText');
const captionPanel = document.querySelector('#captionPanel');
const captionList = document.querySelector('#captionList');
const roomNotice = document.querySelector('#roomNotice');
const roomNoticeText = document.querySelector('#roomNoticeText');

// iOS keeps the layout viewport at full height when the keyboard opens, so a
// 100dvh grid keeps reserving space that is now behind the keyboard and the
// composer ends up stranded mid-screen. The visual viewport is the only thing
// that reports what is actually visible.
function syncViewportHeight() {
  const view = window.visualViewport;
  const root = document.documentElement;
  root.style.setProperty('--vh', `${Math.round(view ? view.height : window.innerHeight)}px`);
  // Height alone is not enough. iOS still scrolls the page to keep the focused
  // field on screen, and with the app shorter than the layout viewport that
  // leaves it pushed up with a band of nothing underneath. Pinning the body to
  // the visual viewport's own offset takes that scroll out of the picture.
  root.style.setProperty('--vv-top', `${Math.round(view ? view.offsetTop : 0)}px`);
}
window.visualViewport?.addEventListener('resize', syncViewportHeight);
window.visualViewport?.addEventListener('scroll', syncViewportHeight);
window.addEventListener('orientationchange', syncViewportHeight);
syncViewportHeight();
const captionEmpty = document.querySelector('#captionEmpty');
const captionState = document.querySelector('#captionState');
const captionToggle = document.querySelector('#captionToggle');
const hostPresence = document.querySelector('#hostPresence');
const presenceTitle = document.querySelector('#presenceTitle');
const presenceDetail = document.querySelector('#presenceDetail');

const params = new URLSearchParams(location.hash.slice(1));
let savedRelayRoom = {};
try { savedRelayRoom = JSON.parse(sessionStorage.getItem('lc.audience.room') || '{}'); } catch {}
const room = params.get('r') || savedRelayRoom.room || '';
const legacyToken = params.get('t') || '';
const joinSecret = params.get('s') || (!legacyToken ? savedRelayRoom.joinSecret : '') || '';
const relayMode = Boolean(joinSecret);
const makeClientId = () => globalThis.crypto?.randomUUID?.()
  || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const clientId = localStorage.getItem('lc.audience.client') || makeClientId();
localStorage.setItem('lc.audience.client', clientId);
nameInput.value = localStorage.getItem('lc.audience.name') || '';
languageInput.value = localStorage.getItem('lc.audience.language') || 'auto';

let socket = null;
let ready = false;
let reconnectAttempt = 0;
let reconnectTimer = null;
let joinTokenHash = '';
let captionChain = Promise.resolve();
let hostStatus = 'connecting';
let roomClosed = false;
let sending = false;
let expiresAt = Number(savedRelayRoom.expiresAt) || 0;
let expiryTimer = null;
const captions = new Map();

// A room reads a screen, it does not read essays: 200 characters is about as
// much as anyone will take in before the next speaker moves on.
const MESSAGE_LIMIT = 200;

// The host rebuilds a typed caption from its text, so the message id does not
// survive the round trip and a sender cannot match on it. Matching on text I
// personally sent in the last minute is enough, and each entry is consumed on
// the first match so an identical line from someone else cannot also claim it.
const MINE_TTL_MS = 60_000;
const mine = [];
function rememberMine(text) {
  const now = Date.now();
  mine.push({ text, at: now });
  while (mine.length && now - mine[0].at > MINE_TTL_MS) mine.shift();
}
function claimMine(text) {
  const index = mine.findIndex((entry) => entry.text === text);
  if (index === -1) return false;
  mine.splice(index, 1);
  return true;
}

function autoGrowMessage() {
  messageInput.style.height = 'auto';
  messageInput.style.height = `${messageInput.scrollHeight}px`;
}
const pendingKey = `lc.audience.pending.${room}`;
let savedPending = [];
try { savedPending = JSON.parse(sessionStorage.getItem(pendingKey) || '[]'); } catch {}
const pending = new Map(savedPending.map((item) => [item.messageId, item]));

if (params.get('r') && params.get('s')) {
  sessionStorage.setItem('lc.audience.room', JSON.stringify({ room, joinSecret, expiresAt }));
  history.replaceState(null, '', `${location.pathname}${location.search}`);
}

// Scanning a later room can navigate the existing tab to the same page with a
// different fragment. Browsers do not reload for fragment-only navigation, so
// explicitly restart the client before it can remain attached to the old room.
window.addEventListener('hashchange', () => {
  if (location.hash) location.reload();
});

function savePending() {
  sessionStorage.setItem(pendingKey, JSON.stringify([...pending.values()]));
}

function setStatus(text, kind = '') {
  status.textContent = text;
  status.className = kind;
}

function updateSendButton() {
  sendBtn.disabled = sending || roomClosed || (relayMode && !ready);
  sendBtn.textContent = hostStatus === 'away' ? 'Queue reply' : 'Send reply';
}

function setPresence(next) {
  hostStatus = next;
  hostPresence.dataset.state = next;
  const copy = {
    connecting: ['Connecting to the conversation', 'You can send replies once connected'],
    online: ['Host online', 'Your replies appear on the shared screen'],
    away: ['Host away', 'Replies are encrypted and queued until the host returns'],
    closed: ['Conversation ended', 'This QR code is no longer active'],
  }[next] || ['Connecting to the conversation', 'Please wait'];
  [presenceTitle.textContent, presenceDetail.textContent] = copy;
  updateSendButton();
}

function finishRoom(message = 'This conversation has ended.') {
  roomClosed = true;
  ready = false;
  clearTimeout(reconnectTimer);
  clearTimeout(expiryTimer);
  if (socket?.readyState === WebSocket.OPEN) socket.close(1000, 'Room ended');
  sessionStorage.removeItem('lc.audience.room');
  form.hidden = true;
  captionState.textContent = 'Conversation ended';
  setPresence('closed');
  setStatus(message, 'error');
  roomNoticeText.textContent = message;
  roomNotice.hidden = false;
  if (!captions.size) captionEmpty.hidden = true;
}

function armRoomExpiry(value) {
  expiresAt = Number(value) || expiresAt;
  clearTimeout(expiryTimer);
  if (!expiresAt) return;
  sessionStorage.setItem('lc.audience.room', JSON.stringify({ room, joinSecret, expiresAt }));
  const remaining = expiresAt - Date.now();
  if (remaining <= 0) {
    finishRoom('This conversation has expired.');
    return;
  }
  expiryTimer = setTimeout(() => finishRoom('This conversation has expired.'), remaining);
}

// Only shown while a message is still in flight or queued. Once it lands the
// participant sees their own line in the transcript, which says more than any
// wording here could.
function setLast(message, state) {
  lastText.textContent = message.text;
  lastState.textContent = state;
  lastSent.hidden = false;
}

function relayWebSocketUrl() {
  const url = new URL(`/v1/rooms/${encodeURIComponent(room)}/ws`, AUDIENCE_RELAY_URL);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.href;
}

function captionTime(ms) {
  const seconds = Math.max(0, Math.floor(Number(ms) / 1000) || 0);
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function nearCaptionBottom() {
  return captionPanel.scrollHeight - captionPanel.scrollTop - captionPanel.clientHeight < 160;
}

function removeCaption(captionId) {
  const current = captions.get(captionId);
  current?.node.remove();
  captions.delete(captionId);
}

let followingCaptions = true;
function updateCaptionToggle() {
  captionToggle.hidden = followingCaptions || !captions.size;
  captionToggle.textContent = 'Back to latest ↓';
}
captionPanel.addEventListener('wheel', (event) => {
  if (event.deltaY < 0) { followingCaptions = false; updateCaptionToggle(); }
}, { passive: true });
captionPanel.addEventListener('keydown', (event) => {
  if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) { followingCaptions = false; updateCaptionToggle(); }
});
captionPanel.addEventListener('scroll', () => {
  if (!nearCaptionBottom()) followingCaptions = false;
  updateCaptionToggle();
}, { passive: true });

function renderCaption(payload) {
  const current = captions.get(payload.captionId);
  if (current && !isNewerCaptionRevision(current.revision, payload.revision)) return;
  const shouldFollow = followingCaptions;
  if (payload.replacesDraft && payload.captionId !== 'live-draft') removeCaption('live-draft');

  let node = current?.node;
  if (!node) {
    node = document.createElement('li');
    node.className = 'caption';
    const meta = document.createElement('p');
    meta.className = 'caption-meta';
    const original = document.createElement('p');
    original.className = 'caption-original';
    const translation = document.createElement('p');
    translation.className = 'caption-translation';
    node.append(meta, ...(payload.translationPrimary === true ? [translation, original] : [original, translation]));
    const draft = captions.get('live-draft')?.node;
    captionList.insertBefore(node, payload.captionId !== 'live-draft' ? draft || null : null);
  }

  const identity = payload.source === 'typed'
    ? `⌨ ${payload.author || 'Participant'}`
    : payload.speaker ? `🎙 ${payload.speaker}` : '🎙 Speech';
  if (payload.captionId === 'live-draft') captionList.append(node);
  node.dataset.state = payload.state;
  node.dataset.translationPrimary = String(payload.translationPrimary === true);
  node.dataset.source = payload.source;
  if (payload.source === 'typed' && !node.dataset.mine && claimMine(payload.orig)) {
    node.dataset.mine = 'true';
  }
  node.querySelector('.caption-meta').textContent = `${captionTime(payload.startMs)} · ${identity}${payload.state === 'draft' ? ' · Speaking' : ''}`;
  node.querySelector('.caption-original').textContent = payload.orig;
  node.querySelector('.caption-translation').textContent = payload.trans;
  node.classList.toggle('no-translation', !payload.trans);
  captions.set(payload.captionId, { revision: payload.revision, node });
  captionEmpty.hidden = true;
  captionState.textContent = payload.state === 'draft' ? 'Live' : 'Up to date';

  while (captionList.children.length > 100) {
    const oldest = captionList.firstElementChild;
    const id = [...captions].find(([, item]) => item.node === oldest)?.[0];
    if (id) captions.delete(id);
    oldest.remove();
  }
  updateCaptionToggle();
  if (shouldFollow) captionPanel.scrollTop = captionPanel.scrollHeight;
}

function validCaptionPayload(payload, envelope) {
  return payload
    && payload.captionId === envelope.captionId
    && payload.captionSeq === envelope.captionSeq
    && Number.isSafeInteger(payload.revision)
    && payload.revision > 0
    && ['draft', 'final', 'corrected'].includes(payload.state)
    && ['speech', 'typed'].includes(payload.source)
    && typeof payload.orig === 'string'
    && typeof payload.trans === 'string'
    && payload.orig.length <= 3000
    && payload.trans.length <= 3000
    && typeof payload.author === 'string'
    && payload.author.length <= 30
    && typeof payload.speaker === 'string'
    && payload.speaker.length <= 80;
}

async function receiveCaption(envelope) {
  try {
    const payload = await decryptAudiencePayload(joinSecret, envelope.eventId, envelope);
    if (validCaptionPayload(payload, envelope)) renderCaption(payload);
  } catch {
    setStatus('A caption update could not be decrypted and was skipped.', 'error');
  }
}

async function connectRelay() {
  if (!relayMode || !AUDIENCE_RELAY_URL || roomClosed || socket?.readyState === WebSocket.OPEN) return;
  if (expiresAt && expiresAt <= Date.now()) return finishRoom('This conversation has expired.');
  clearTimeout(reconnectTimer);
  ready = false;
  setPresence('connecting');
  setStatus(reconnectAttempt ? 'Reconnecting securely…' : 'Connecting securely…');
  if (!joinTokenHash) joinTokenHash = await hashAudienceToken(joinSecret);
  socket = new WebSocket(relayWebSocketUrl());
  socket.addEventListener('open', () => {
    socket.send(JSON.stringify({ type: 'auth', role: 'participant', tokenHash: joinTokenHash, clientId }));
  });
  socket.addEventListener('message', (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === 'ready') {
      ready = true;
      reconnectAttempt = 0;
      armRoomExpiry(message.expiresAt);
      if (roomClosed) return;
      setPresence(message.hostStatus === 'online' ? 'online' : 'away');
      captionState.textContent = captions.size ? 'Up to date' : 'Waiting for captions';
      setStatus(
        hostStatus === 'online'
          ? 'Ready. Your reply will appear with the captions.'
          : 'The host is away. Replies will queue until they return.',
        hostStatus === 'online' ? 'ok' : '',
      );
      for (const item of pending.values()) socket.send(JSON.stringify(item.envelope));
    } else if (message.type === 'caption') {
      captionChain = captionChain.then(() => receiveCaption(message));
    } else if (message.type === 'host-status') {
      setPresence(message.status === 'online' ? 'online' : 'away');
      if (hostStatus === 'online') {
        setStatus(pending.size ? 'The host is back. Queued replies are being delivered.' : 'The host is online. You can reply.', 'ok');
      } else {
        setStatus('The host is away. Replies will queue until they return.');
      }
    } else if (message.type === 'queued') {
      const item = pending.get(message.messageId);
      if (message.hostStatus) setPresence(message.hostStatus === 'online' ? 'online' : 'away');
      const queuedState = hostStatus === 'online'
        ? 'Delivered; waiting to appear on the shared screen'
        : 'Queued until the host returns';
      if (item) setLast(item, queuedState);
      setStatus(`${queuedState}。`, hostStatus === 'online' ? 'ok' : '');
    } else if (message.type === 'displayed') {
      const item = pending.get(message.messageId);
      if (!item) return;
      // The bubble in the timeline is the confirmation now, so the little
      // status box goes away rather than saying the same thing twice.
      lastSent.hidden = true;
      pending.delete(message.messageId);
      savePending();
      setStatus('Received and displayed on the shared screen.', 'ok');
    } else if (message.type === 'closed') {
      finishRoom();
    } else if (message.type === 'error') {
      if (message.code === 'invalid_message') {
        pending.delete(message.messageId);
        savePending();
      }
      setStatus(message.code === 'rate_limited' ? 'Please wait a few seconds before sending again.' : 'Could not send your reply. Please try again.', 'error');
    }
  });
  socket.addEventListener('close', () => {
    ready = false;
    if (roomClosed || form.hidden) return;
    if (expiresAt && expiresAt <= Date.now()) return finishRoom('This conversation has expired.');
    reconnectAttempt += 1;
    const delay = Math.min(10_000, 500 * 2 ** reconnectAttempt);
    reconnectTimer = setTimeout(() => {
      void connectRelay().catch(() => setStatus('Could not reconnect. Please try again shortly.', 'error'));
    }, delay);
    setPresence('connecting');
    setStatus('Disconnected. Pending replies will resume after reconnection.', 'error');
  });
  socket.addEventListener('error', () => socket.close());
}

if (!room || (!legacyToken && !joinSecret)) {
  finishRoom('This QR code is invalid. Scan the current code on the shared screen.');
  presenceTitle.textContent = 'Invalid conversation link';
  presenceDetail.textContent = 'Ask the host for a current invitation';
  captionState.textContent = '';
} else if (relayMode && !AUDIENCE_RELAY_URL) {
  finishRoom('Reply sharing is unavailable. Please contact the host.');
  presenceTitle.textContent = 'Conversation unavailable';
  captionState.textContent = '';
} else if (relayMode) {
  if (expiresAt && expiresAt <= Date.now()) finishRoom('This conversation has expired.');
  else void connectRelay().catch(() => setStatus('Could not connect. Please scan the QR code again.', 'error'));
} else {
  captionPanel.hidden = true;
  ready = true;
  setPresence('online');
  setStatus('Connected. You can reply.', 'ok');
}

captionToggle.addEventListener('click', () => {
  followingCaptions = true;
  captionPanel.scrollTop = captionPanel.scrollHeight;
  updateCaptionToggle();
});

messageInput.addEventListener('input', () => {
  count.textContent = `${messageInput.value.length} / ${MESSAGE_LIMIT}`;
  autoGrowMessage();
});

nameInput.addEventListener('change', () => {
  localStorage.setItem('lc.audience.name', nameInput.value.trim());
});

languageInput.addEventListener('change', () => {
  localStorage.setItem('lc.audience.language', languageInput.value);
});

messageInput.addEventListener('keydown', (event) => {
  // Enter sends. A room is not waiting while someone composes a paragraph, and
  // every extra keystroke is one more thing to explain to a first-time user.
  if (event.key !== 'Enter' || event.isComposing) return;
  if (event.shiftKey) return;           // deliberate newline
  event.preventDefault();
  form.requestSubmit();
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = messageInput.value.trim();
  if (!text || sending || roomClosed || (relayMode && !ready)) return;

  sending = true;
  updateSendButton();
  setStatus('Sending…');
  const messageId = makeClientId();
  const item = {
    messageId,
    text,
    name: nameInput.value.trim(),
    language: languageInput.value,
    sentAt: Date.now(),
  };
  try {
    if (relayMode) {
      if (!ready) throw new Error('Reconnecting. Please try again shortly.');
      const encrypted = await encryptAudiencePayload(joinSecret, messageId, item);
      item.envelope = { type: 'message', messageId, ...encrypted };
      pending.set(messageId, item);
      savePending();
      socket.send(JSON.stringify(item.envelope));
      setLast(item, 'Delivering…');
      setStatus(hostStatus === 'away' ? 'Encrypting and queuing…' : 'Waiting for the host to receive your reply…');
    } else {
      const response = await fetch(`./api/audience/sessions/${encodeURIComponent(room)}/messages`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${legacyToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ text, name: item.name, clientId, language: item.language, messageId }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `Send failed (${response.status})`);
      setLast(item, 'Delivered; waiting to appear on the shared screen');
      setStatus('Delivered; waiting to appear on the shared screen.', 'ok');
    }

    localStorage.setItem('lc.audience.name', item.name);
    localStorage.setItem('lc.audience.language', item.language);
    // Remembered before the round trip, so the copy the host broadcasts back
    // can be recognised as this person's own line and mirrored to the right.
    rememberMine(item.text);
    messageInput.value = '';
    count.textContent = `0 / ${MESSAGE_LIMIT}`;
    autoGrowMessage();
    messageInput.focus();
  } catch (error) {
    setStatus(error.message, 'error');
  } finally {
    sending = false;
    updateSendButton();
  }
});

const layoutObserver = new ResizeObserver(() => {
  if (followingCaptions) captionPanel.scrollTop = captionPanel.scrollHeight;
});
layoutObserver.observe(captionPanel);
