// Tiny DOM + formatting toolkit. No dependencies.
// Everything that touches the DOM uses textContent, so data from the network
// (headlines, posts, names) can never inject markup.

export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'html') throw new Error('html prop is not allowed');
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
  }
  append(el, kids);
  return el;
}

export function append(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return el;
}

export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---------- icons (24x24 stroke set, constant strings only) ----------
const I = {
  overview: '<rect x="3" y="3" width="7" height="9" rx="1.6"/><rect x="14" y="3" width="7" height="5" rx="1.6"/><rect x="14" y="12" width="7" height="9" rx="1.6"/><rect x="3" y="16" width="7" height="5" rx="1.6"/>',
  fundamentals: '<path d="M3 21h18"/><path d="M5 21V10l7-5.5L19 10v11"/><path d="M9.5 21v-6h5v6"/><path d="M12 10.5h.01"/>',
  technical: '<path d="M6 3.5v3M6 17.5v3M12 2v3M12 15v6M18 6v2M18 18v3"/><rect x="4" y="6.5" width="4" height="11" rx="1.2"/><rect x="10" y="5" width="4" height="10" rx="1.2"/><rect x="16" y="8" width="4" height="10" rx="1.2"/>',
  sentiment: '<path d="M21 11.5a8 8 0 0 1-11.6 7.1L4 20l1.3-4.6A8 8 0 1 1 21 11.5z"/><path d="M8 12h1.6l1.2-2.6 2 5 1.3-2.4H16"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.2M12 19.3v2.2M4.9 4.9l1.6 1.6M17.5 17.5l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.9 19.1l1.6-1.6M17.5 6.5l1.6-1.6"/>',
  moon: '<path d="M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5a8.5 8.5 0 1 0 10.7 10.7z"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
  back: '<path d="m15 5-7 7 7 7"/>',
  next: '<path d="m9 5 7 7-7 7"/>',
  ext: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v4.5A1.5 1.5 0 0 1 16.5 20h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/>',
  lock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2.2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/><path d="M12 15v2"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.2M12 7.8h.01"/>',
  alert: '<path d="M12 3.5 2.8 19.5h18.4z"/><path d="M12 10v4.5M12 17.2h.01"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.5-3.5L4 9"/><path d="M4 4v5h5"/><path d="M4 13a8 8 0 0 0 14.5 3.5L20 15"/><path d="M20 20v-5h-5"/>',
  news: '<path d="M5 4h12a2 2 0 0 1 2 2v14H7a2 2 0 0 1-2-2z"/><path d="M19 9h2v9a2 2 0 0 1-2 2"/><path d="M8.5 8.5h7M8.5 12h7M8.5 15.5h4"/>',
  filing: '<path d="M7 3h7l5 5v11.5A1.5 1.5 0 0 1 17.5 21h-10A1.5 1.5 0 0 1 6 19.5v-15A1.5 1.5 0 0 1 7.5 3"/><path d="M14 3v5h5M9 13h6M9 16.5h6"/>',
  insider: '<circle cx="12" cy="8" r="3.6"/><path d="M4.8 20c.6-3.8 3.4-6 7.2-6s6.6 2.2 7.2 6"/>',
  earnings: '<rect x="3.5" y="5" width="17" height="15" rx="2.2"/><path d="M3.5 10h17M8 3v4M16 3v4"/><path d="m9.5 15 1.8 1.8 3.4-3.6"/>',
  analyst: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1"/>',
  coin: '<circle cx="12" cy="12" r="8.5"/><path d="M14.6 9.2c-.5-.9-1.5-1.3-2.7-1.3-1.5 0-2.5.8-2.5 1.9 0 2.6 5.4 1.2 5.4 4 0 1.1-1.1 1.9-2.7 1.9-1.3 0-2.4-.5-2.9-1.5M12 6.5v1.4M12 16.1v1.4"/>',
  table: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M3.5 9.5h17M3.5 14.5h17M9.5 9.5v10"/>',
  image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.2"/><circle cx="9" cy="10" r="1.6"/><path d="m4 18 5.2-5 3.3 3.2 2.5-2.4L20 17"/>',
  doc: '<path d="M7 3h7l5 5v11.5A1.5 1.5 0 0 1 17.5 21h-10A1.5 1.5 0 0 1 6 19.5v-15A1.5 1.5 0 0 1 7.5 3"/><path d="M14 3v5h5"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  up: '<path d="M12 5v14M6 11l6-6 6 6"/>',
  down: '<path d="M12 19V5M6 13l6 6 6-6"/>',
  tri_up: '<path d="M12 5 21 19H3z" fill="currentColor" stroke="none"/>',
  tri_down: '<path d="M12 19 3 5h18z" fill="currentColor" stroke="none"/>',
  dash: '<path d="M5 12h14" stroke-width="3"/>',
  plug: '<path d="M9 3v5M15 3v5"/><path d="M6 8h12v3.5a6 6 0 0 1-12 0z"/><path d="M12 17.5V21"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4M12 18.8v2.4M4.5 7.4l2 1.2M17.5 15.4l2 1.2M4.5 16.6l2-1.2M17.5 8.6l2-1.2"/>',
};

export function icon(name, cls) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  if (cls) svg.setAttribute('class', cls);
  // constant strings from the table above only
  svg.innerHTML = I[name] || '';
  return svg;
}

// ---------- formatting ----------
const dash = '—';
const nf = (min, max) => new Intl.NumberFormat('en-US', { minimumFractionDigits: min, maximumFractionDigits: max });
const nfCache = {};
function _nf(min, max) { const k = min + ':' + max; return nfCache[k] || (nfCache[k] = nf(min, max)); }
const isNum = (n) => typeof n === 'number' && Number.isFinite(n);

export const fmt = {
  dash,
  isNum,
  num(n, d = 2) { return isNum(n) ? _nf(d, d).format(n) : dash; },
  int(n) { return isNum(n) ? _nf(0, 0).format(n) : dash; },
  compact(n, d = 1) {
    if (!isNum(n)) return dash;
    const a = Math.abs(n);
    const u = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
    for (const [v, s] of u) if (a >= v) return _nf(0, d).format(n / v) + s;
    return _nf(0, a < 10 ? 2 : 0).format(n);
  },
  money(n, ccy = 'USD', d = 2) {
    if (!isNum(n)) return dash;
    const sym = ccy === 'INR' ? '₹' : ccy === 'USD' ? '$' : ccy === 'EUR' ? '€' : ccy === 'GBP' ? '£' : ccy === 'JPY' ? '¥' : '';
    const digits = Math.abs(n) >= 100000 && ccy === 'INR' ? 0 : d;
    return (n < 0 ? '−' : '') + sym + _nf(digits, digits).format(Math.abs(n)) + (sym ? '' : ' ' + ccy);
  },
  moneyC(n, ccy = 'USD') {
    if (!isNum(n)) return dash;
    const sym = ccy === 'INR' ? '₹' : ccy === 'USD' ? '$' : '';
    return (n < 0 ? '−' : '') + sym + fmt.compact(Math.abs(n));
  },
  pct(n, d = 2, sign = true) {
    if (!isNum(n)) return dash;
    const s = _nf(d, d).format(Math.abs(n));
    return (n < 0 ? '−' : sign && n > 0 ? '+' : '') + s + '%';
  },
  signed(n, d = 2) {
    if (!isNum(n)) return dash;
    return (n < 0 ? '−' : n > 0 ? '+' : '') + _nf(d, d).format(Math.abs(n));
  },
  dir(n) { return !isNum(n) || n === 0 ? 'flat' : n > 0 ? 'up' : 'down'; },
  arrow(n) { return !isNum(n) || n === 0 ? '' : n > 0 ? '▲' : '▼'; },
  date(s) {
    const d = toDate(s); if (!d) return dash;
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  },
  shortDate(s) {
    const d = toDate(s); if (!d) return dash;
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  },
  monthYear(s) {
    const d = toDate(s); if (!d) return dash;
    return d.toLocaleDateString('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' });
  },
  weekday(s) {
    const d = toDate(s); if (!d) return dash;
    return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  },
  rel(ts) {
    const d = toDate(ts); if (!d) return dash;
    const s = (Date.now() - d.getTime()) / 1000;
    if (s < -3600) { const days = Math.round(-s / 86400); return days <= 0 ? 'soon' : 'in ' + days + 'd'; }
    if (s < 90) return 'just now';
    if (s < 3600) return Math.round(s / 60) + 'm ago';
    if (s < 86400) return Math.round(s / 3600) + 'h ago';
    if (s < 86400 * 14) return Math.round(s / 86400) + 'd ago';
    return fmt.shortDate(d.toISOString());
  },
  daysUntil(s) {
    const d = toDate(s); if (!d) return null;
    const t = new Date(); const today = Date.UTC(t.getFullYear(), t.getMonth(), t.getDate());
    return Math.round((d.getTime() - today) / 86400000);
  },
};

export function toDate(s) {
  if (!s) return null;
  if (s instanceof Date) return s;
  const d = new Date(typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s + 'T00:00:00Z' : s);
  return isNaN(d.getTime()) ? null : d;
}

export const fileKey = (sym) => String(sym).replace(/[^A-Za-z0-9]+/g, '_');
export const debounce = (fn, ms = 160) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
export const sum = (a) => a.reduce((x, y) => x + (Number(y) || 0), 0);
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export function safeUrl(u) { try { const x = new URL(u, location.href); return /^(https?:|mailto:)/.test(x.protocol) ? x.href : null; } catch { return null; } }

export function extLink(text, url, cls) {
  const u = safeUrl(url);
  if (!u) return h('span', { class: cls }, text);
  return h('a', { href: u, target: '_blank', rel: 'noopener noreferrer', class: cls }, text);
}

// ---------- lens badge (the signature element) ----------
export const LENS_NAMES = { F: 'Fundamentals', T: 'Technical', S: 'Sentiment' };
export function lensBadge(letter, state, why) {
  const st = state === 1 || state === 'bull' ? 'bull' : state === -1 || state === 'bear' ? 'bear' : state === 0 || state === 'neutral' ? 'neutral' : 'none';
  const word = { bull: 'leans bullish', bear: 'leans bearish', neutral: 'neutral', none: 'no read' }[st];
  const el = h('span', { class: 'lens ' + st, title: `${LENS_NAMES[letter]} ${word}${why ? ' — ' + why : ''}`, 'aria-label': `${LENS_NAMES[letter]} ${word}` }, letter);
  if (st === 'bull') el.append(icon('tri_up'));
  else if (st === 'bear') el.append(icon('tri_down'));
  else if (st === 'neutral') el.append(icon('dash'));
  return el;
}
export function lensRow(lens = {}) {
  return h('span', { class: 'lenses' }, lensBadge('F', lens.F, lens.F_why), lensBadge('T', lens.T, lens.T_why), lensBadge('S', lens.S, lens.S_why));
}

export function badge(text, kind = '') { return h('span', { class: 'badge ' + kind }, text); }
export function empty(title, body, action) {
  return h('div', { class: 'empty' }, h('b', null, title), body, action ? h('div', { style: { marginTop: '12px' } }, action) : null);
}
export function sheet(title, ...content) {
  const bg = h('div', { class: 'sheet-bg', onClick: (e) => { if (e.target === bg) bg.remove(); } },
    h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div', { class: 'row between', style: { marginBottom: '6px' } }, h('h3', null, title),
        h('button', { class: 'btn', onClick: () => bg.remove(), style: { minHeight: '36px', padding: '0 14px' } }, 'Close')),
      ...content));
  document.body.append(bg);
  const onKey = (e) => { if (e.key === 'Escape') { bg.remove(); removeEventListener('keydown', onKey); } };
  addEventListener('keydown', onKey);
  return bg;
}
