// Settings sync across browsers and devices (PC, phone, both website addresses) through the same
// private GitHub Gist as the Watch Lists sync. Everything the Backup button saves (chart layouts,
// drawings, Pine scripts, watchlists, alerts, templates, chart settings) is encrypted with your
// Technical password before it leaves this browser; the gist only ever holds scrambled data.
// Needs: the gist token (same as Watch Lists sync) and the password remembered on this device.
//
// Rules: each browser notes when a synced setting really changed (lib/store.js). On start and when
// the tab comes back, a newer copy in the gist is applied; local changes are sent within ~20 s.
// If both changed, the newer one wins.

import { store } from './store.js';
import * as sync from './sync.js';
import { collect, restore } from './backup.js';
import { encryptEnvelope, decryptEnvelope, cryptoAvailable } from './crypto.js';

const FILE = 'trilens-settings.json';
const NOT_SYNCED = /^(techpass|gh_token|gist_id|watchlists|sync:)/;
const num = (k) => { try { return +localStorage.getItem('trilens:' + k) || 0; } catch { return 0; } };
const setNum = (k, v) => { try { localStorage.setItem('trilens:' + k, String(v)); } catch { /* ignore */ } };

export const state = { msg: '', at: 0, busy: false, listeners: new Set() };
const say = (msg) => { state.msg = msg; state.at = Date.now(); for (const f of state.listeners) { try { f(state); } catch { /* ignore */ } } };

export const password = () => store.get('techpass', '');
export const isOn = () => sync.isConnected() && store.get('sync:off', false) !== true;
export const ready = () => isOn() && !!password() && cryptoAvailable();

function items() {
  const all = collect().items;
  for (const k of Object.keys(all)) if (NOT_SYNCED.test(k)) delete all[k];
  return all;
}

/** Send this browser's settings. */
export async function pushNow() {
  if (!ready()) return false;
  const updated = num('sync:changedAt') || Date.now();
  const env = await encryptEnvelope({ items: items() }, password());
  await sync.pushFile(FILE, { format: 'trilens-settings-sync', updated_at: updated, env });
  setNum('sync:syncedAt', updated);
  say('Synced ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
  return true;
}

/**
 * Compare with the gist and apply or send. Returns 'applied' when this browser's storage was
 * replaced by a newer copy (the caller reloads, or has not loaded any page yet).
 */
export async function syncOnce() {
  if (!ready() || state.busy) return 'off';
  state.busy = true;
  try {
    const remote = await sync.pullFile(FILE);
    const changed = num('sync:changedAt'), synced = num('sync:syncedAt');
    if (!remote || !remote.env) { await pushNow(); return 'pushed'; }
    const remoteNewer = remote.updated_at > synced, localNewer = changed > synced;
    if (remoteNewer && (!localNewer || remote.updated_at >= changed)) {
      let data;
      try { data = await decryptEnvelope(remote.env, password()); }
      catch { say('Sync: the copy in GitHub uses a different Technical password. Use the same password on every device.'); return 'error'; }
      restore({ format: 'trilens-backup', items: data.items || {} });
      setNum('sync:changedAt', remote.updated_at);
      setNum('sync:syncedAt', remote.updated_at);
      say('Updated from your other devices ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
      return 'applied';
    }
    if (localNewer) { await pushNow(); return 'pushed'; }
    say('In sync ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    return 'same';
  } catch (e) {
    say('Sync failed: ' + e.message);
    return 'error';
  } finally {
    state.busy = false;
  }
}

/** Run before the first page is drawn, so a newer copy is used straight away (no reload). */
export async function atStart() {
  if (!ready()) return;
  await Promise.race([syncOnce(), new Promise((r) => setTimeout(r, 4000))]);
  // keep going while the page is open
  setInterval(() => { if (ready() && num('sync:changedAt') > num('sync:syncedAt') && !state.busy) pushNow().catch((e) => say('Sync failed: ' + e.message)); }, 20000);
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'hidden') { if (ready() && num('sync:changedAt') > num('sync:syncedAt')) pushNow().catch(() => {}); return; }
    if (await syncOnce() === 'applied') { const { freezeWrites } = await import('./store.js'); freezeWrites(); location.reload(); }
  });
}
