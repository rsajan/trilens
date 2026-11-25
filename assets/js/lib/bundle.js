// Shared Technical-bundle loading/unlock state, used by every page that reads it (Scanner,
// Fundamental Analysis) so unlocking once on either page unlocks the other too.
import { h, icon } from './dom.js';
import { getJSON } from './data.js';
import { store } from './store.js';
import { decryptEnvelope, cryptoAvailable } from './crypto.js';

let BUNDLE = null;

async function fetchEnvelope() {
  for (const p of ['data/technical/bundle.json', 'data/technical/bundle.local.json']) {
    const o = await getJSON(p, { fresh: true });
    if (o) return o;
  }
  return null;
}

async function unlock(env, pass) {
  const b = await decryptEnvelope(env, pass);
  BUNDLE = b;
  return b;
}

export function notPublished() {
  return h('div', { class: 'lock' }, icon('lock', 'big'), h('h2', null, 'Technical data is not published yet'),
    h('p', { class: 'soft', style: { margin: '10px 0 0' } }, 'This page is built from the scanner files on your computer. Run PUBLISH.bat in your project folder once, and it will appear here. The README explains the one-time setup.'));
}

/** opts.open(env, pass) replaces the bundle unlock (the stock prices use the same password). */
export function lockScreen(env, onUnlocked, opts = {}) {
  const err = h('div', { class: 'err', role: 'alert' });
  const pass = h('input', { class: 'field', type: 'password', placeholder: 'Technical page password', autocomplete: 'current-password', 'aria-label': 'Password', required: true });
  const remember = h('input', { type: 'checkbox', checked: true, id: 'rem' });
  const form = h('form', { onSubmit: async (e) => {
    e.preventDefault(); err.textContent = '';
    if (!cryptoAvailable()) { err.textContent = 'Your browser only unlocks on a secure address. Open the site by its https:// link.'; return; }
    try {
      await (opts.open || unlock)(env, pass.value);
      if (remember.checked) store.set('techpass', pass.value);
      onUnlocked();
    } catch (x) { err.textContent = x.message === 'bad-password' ? 'That password did not open it. Check it and try again.' : 'Could not unlock: ' + x.message; }
  } }, pass, h('label', { class: 'check', for: 'rem' }, remember, 'Remember on this device'), h('button', { class: 'btn primary', type: 'submit' }, 'Unlock'), err);
  return h('div', { class: 'lock' }, icon('lock', 'big'), h('h2', null, opts.title || 'Your strategies are locked'),
    h('p', { class: 'soft', style: { margin: '10px 0 0' } }, opts.text || 'Everything on this page is encrypted in your repository. Enter the password you chose during setup to read it. It is checked on your device only.'), form);
}

// Returns { bundle } once unlocked, or { lock: 'not-published' | 'locked', env } otherwise.
// On first visit with a remembered password this tries it once, silently.
export async function loadBundle() {
  if (BUNDLE) return { bundle: BUNDLE };
  const env = await fetchEnvelope();
  if (!env) return { lock: 'not-published' };
  if (!env.enc) { BUNDLE = env; return { bundle: BUNDLE }; }
  const saved = store.get('techpass');
  if (saved) {
    try { await unlock(env, saved); return { bundle: BUNDLE }; }
    catch { store.del('techpass'); }
  }
  return { lock: 'locked', env };
}
