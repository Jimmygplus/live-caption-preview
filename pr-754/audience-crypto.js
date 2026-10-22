const encoder = new TextEncoder();
const decoder = new TextDecoder();

function base64UrlEncode(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function randomAudienceSecret(bytes = 18) {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function hashAudienceToken(token) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function base64UrlDecode(value) {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/')
    + '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export async function deriveAudienceKey(secret) {
  const context = encoder.encode(`live-caption-audience-v1\0${secret}`);
  const digest = await crypto.subtle.digest('SHA-256', context);
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptAudiencePayload(secret, messageId, payload) {
  const key = await deriveAudienceKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(messageId) },
    key,
    encoder.encode(JSON.stringify(payload)),
  );
  return {
    iv: base64UrlEncode(iv),
    ciphertext: base64UrlEncode(new Uint8Array(ciphertext)),
  };
}

export async function decryptAudiencePayload(secret, messageId, envelope) {
  const key = await deriveAudienceKey(secret);
  const plaintext = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: base64UrlDecode(envelope.iv),
      additionalData: encoder.encode(messageId),
    },
    key,
    base64UrlDecode(envelope.ciphertext),
  );
  return JSON.parse(decoder.decode(plaintext));
}

export function detectTypedLanguage(text) {
  const cjk = (text.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length;
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  if (cjk >= 2 && cjk >= latin * 0.2) return 'zh';
  if (latin >= 3 && latin > cjk * 2) return 'en';
  return null;
}
