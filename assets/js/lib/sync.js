// Cross-device sync for Watch Lists via a private GitHub Gist - the only external call this
// file ever makes is to api.github.com, using a token the user pastes in themselves (never
// typed anywhere else, never sent anywhere else). The token should be a GitHub "classic"
// Personal Access Token scoped ONLY to "gist" - it cannot read or change repos, issues, or
// anything else on the account.
import { store } from './store.js';

const SENTINEL = 'Trilens watch lists (auto-sync - do not rename or delete)';
const FILENAME = 'trilens-watchlists.json';
const API = 'https://api.github.com';

export function getToken() { return store.get('gh_token', ''); }
export function setToken(t) {
  store.set('gh_token', t ? t.trim() : '');
  if (!t) store.del('gist_id');
}
export function isConnected() { return !!getToken(); }

async function gh(path, opts = {}) {
  const token = getToken();
  if (!token) throw new Error('not connected');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  let res;
  try {
    res = await fetch(API + path, {
      ...opts,
      signal: ctrl.signal,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', ...(opts.headers || {}) },
    });
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'GitHub did not respond in time.' : 'Could not reach GitHub (are you offline?).');
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    if (res.status === 401) throw new Error('That token was rejected - check you pasted it correctly and it has not expired.');
    if (res.status === 403) throw new Error('GitHub rate-limited or blocked this request. Try again shortly.');
    throw new Error(`GitHub error ${res.status}`);
  }
  return res.status === 204 ? null : res.json();
}

async function findGistId() {
  const cached = store.get('gist_id', null);
  if (cached) {
    try { await gh(`/gists/${cached}`); return cached; } catch { store.del('gist_id'); }
  }
  for (let page = 1; page <= 5; page++) {
    const list = await gh(`/gists?per_page=100&page=${page}`);
    const hit = (list || []).find((g) => g.description === SENTINEL);
    if (hit) { store.set('gist_id', hit.id); return hit.id; }
    if (!list || list.length < 100) break;
  }
  return null;
}

async function createGist(payload, file = FILENAME) {
  const g = await gh('/gists', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ description: SENTINEL, public: false, files: { [file]: { content: JSON.stringify(payload) } } }),
  });
  store.set('gist_id', g.id);
  return g.id;
}

// Returns {updated_at, lists} from the gist, or null if there is no gist yet.
export async function pull() {
  const id = await findGistId();
  if (!id) return null;
  const g = await gh(`/gists/${id}`);
  const file = g.files && g.files[FILENAME];
  if (!file || !file.content) return null;
  try { return JSON.parse(file.content); } catch { return null; }
}

export async function push(payload) {
  const id = (await findGistId()) || (await createGist(payload));
  await gh(`/gists/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ files: { [FILENAME]: { content: JSON.stringify(payload) } } }),
  });
}

// ---- any file in the same private gist (used by settings sync); null when there is none yet
export async function pullFile(name) {
  const id = await findGistId();
  if (!id) return null;
  const g = await gh(`/gists/${id}`);
  const file = g.files && g.files[name];
  if (!file) return null;
  let text = file.content;
  if (file.truncated && file.raw_url) {
    const r = await fetch(file.raw_url, { headers: { Authorization: `Bearer ${getToken()}` } });
    text = r.ok ? await r.text() : null;
  }
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

export async function pushFile(name, payload) {
  const id = await findGistId();
  if (!id) { await createGist(payload, name); return; }
  await gh(`/gists/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ files: { [name]: { content: JSON.stringify(payload) } } }),
  });
}
