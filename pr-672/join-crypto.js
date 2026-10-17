const encoder = new TextEncoder();
const decoder = new TextDecoder();
const JOIN_INFO = encoder.encode('live-caption-short-join-v1');

function base64UrlEncode(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function base64UrlDecode(value) {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/')
    + '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function importPublicKey(value) {
  return crypto.subtle.importKey(
    'raw',
    base64UrlDecode(value),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
}

async function deriveWrappingKey(privateKey, publicKey, requestId) {
  const sharedBits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: publicKey },
    privateKey,
    256,
  );
  const material = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encoder.encode(requestId),
      info: JOIN_INFO,
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function createJoinKeyPair() {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveBits'],
  );
  const publicKey = base64UrlEncode(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
  return { privateKey: pair.privateKey, publicKey };
}

export async function joinVerificationCode(publicKey) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(publicKey)));
  const value = ((digest[0] << 16) | (digest[1] << 8) | digest[2]) % 1_000_000;
  const digits = String(value).padStart(6, '0');
  return `${digits.slice(0, 3)}-${digits.slice(3)}`;
}

export async function wrapJoinSecret(participantPublicKey, joinSecret, requestId) {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveBits'],
  );
  const wrappingKey = await deriveWrappingKey(
    pair.privateKey,
    await importPublicKey(participantPublicKey),
    requestId,
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(requestId) },
    wrappingKey,
    encoder.encode(joinSecret),
  );
  const hostPublicKey = base64UrlEncode(
    new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)),
  );
  return {
    hostPublicKey,
    iv: base64UrlEncode(iv),
    ciphertext: base64UrlEncode(new Uint8Array(ciphertext)),
  };
}

export async function unwrapJoinSecret(privateKey, envelope, requestId) {
  const wrappingKey = await deriveWrappingKey(
    privateKey,
    await importPublicKey(envelope.hostPublicKey),
    requestId,
  );
  const plaintext = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: base64UrlDecode(envelope.iv),
      additionalData: encoder.encode(requestId),
    },
    wrappingKey,
    base64UrlDecode(envelope.ciphertext),
  );
  return decoder.decode(plaintext);
}

// Kept in sync with ROOM_CODE_LENGTH in relay/src/index.js, which mints the code.
export const ROOM_CODE_LENGTH = 6;

export function normalizeRoomCode(value = '') {
  return String(value).toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, ROOM_CODE_LENGTH);
}

export function formatRoomCode(value = '') {
  const code = normalizeRoomCode(value);
  return code.length > 3 ? `${code.slice(0, 3)}-${code.slice(3)}` : code;
}

// Tests the raw value on purpose: normalizeRoomCode() strips and truncates, so
// unrelated ids (a UUID, say) can survive it at the right length and look valid.
const ROOM_CODE_PATTERN = new RegExp(`^[A-HJ-NP-Z2-9]{${ROOM_CODE_LENGTH}}$`);

export function isRoomCode(value = '') {
  return ROOM_CODE_PATTERN.test(String(value));
}
