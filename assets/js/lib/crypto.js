// Decrypts the Technical bundle in the browser (WebCrypto, AES-256-GCM + PBKDF2).
// The encrypted file is safe to keep in a public repository: without the
// password it is just random bytes.

const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export function cryptoAvailable() { return !!(globalThis.crypto && crypto.subtle); }

export async function decryptEnvelope(env, pass) {
  if (!cryptoAvailable()) throw new Error('secure-context');
  const enc = new TextEncoder();
  const keyMat = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: b64(env.salt), iterations: env.iter, hash: 'SHA-256' },
    keyMat, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  let plain;
  try {
    plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(env.iv) }, key, b64(env.data));
  } catch {
    throw new Error('bad-password');
  }
  let text;
  if (env.comp === 'gzip') {
    const ds = new DecompressionStream('gzip');
    text = await new Response(new Blob([plain]).stream().pipeThrough(ds)).text();
  } else {
    text = new TextDecoder().decode(plain);
  }
  return JSON.parse(text);
}
