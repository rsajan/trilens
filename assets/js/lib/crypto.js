// Decrypts the Technical bundle in the browser (WebCrypto, AES-256-GCM + PBKDF2).
// The encrypted file is safe to keep in a public repository: without the
// password it is just random bytes.

const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export function cryptoAvailable() { return !!(globalThis.crypto && crypto.subtle); }

// Derived keys are kept for the page's lifetime, so files sharing a salt (the stock price
// pieces) cost one PBKDF2 run in all.
const KEYS = new Map();
function keyFor(env, pass) {
  const id = pass + '\u0000' + env.salt + '\u0000' + env.iter;
  if (!KEYS.has(id)) {
    const p = (async () => {
      const keyMat = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
      return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: b64(env.salt), iterations: env.iter, hash: 'SHA-256' },
        keyMat, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    })();
    p.catch(() => KEYS.delete(id));
    KEYS.set(id, p);
  }
  return KEYS.get(id);
}

export async function decryptEnvelope(env, pass) {
  if (!cryptoAvailable()) throw new Error('secure-context');
  const key = await keyFor(env, pass);
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

/** The reverse of decryptEnvelope (same format as the pipeline's encrypt()), for settings sync. */
export async function encryptEnvelope(obj, pass, iter = 250000) {
  if (!cryptoAvailable()) throw new Error('secure-context');
  const b64e = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const keyMat = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, keyMat, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const gz = new Uint8Array(await new Response(new Blob([JSON.stringify(obj)]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, gz));
  return { v: 1, enc: true, alg: 'AES-256-GCM', kdf: 'PBKDF2-SHA256', iter, comp: 'gzip', salt: b64e(salt), iv: b64e(iv), data: b64e(data) };
}
