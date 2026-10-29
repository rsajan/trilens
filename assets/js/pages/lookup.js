// Ad-hoc lookup for a US company that is not in the curated watchlist.
// Fetched live, straight from the browser, from SEC EDGAR's public data.sec.gov API (no key, CORS-open).
// No price, analyst or sentiment data here: those sources need a server-side fetch, which only runs for
// the watchlist. This page is filings and company profile only, and says so.
import { h, icon, extLink } from '../lib/dom.js';
import { D, getJSONAbsolute } from '../lib/data.js';
import { feedItem, sectionHead } from '../lib/ui.js';

function filingsFromRecent(recent, cik, limit = 60) {
  const out = [];
  const n = (recent.accessionNumber || []).length;
  for (let i = 0; i < n && out.length < limit; i++) {
    const form = recent.form[i];
    if (form === '4' || form === '4/A') continue; // the insider tape is a watchlist-only feature
    const acc = recent.accessionNumber[i];
    const doc = (recent.primaryDocument || [])[i] || '';
    const desc = (recent.primaryDocDescription || [])[i] || '';
    const url = doc ? `https://www.sec.gov/Archives/edgar/data/${cik}/${acc.replace(/-/g, '')}/${doc}` : null;
    out.push({ type: 'filing', date: recent.filingDate[i], url, title: desc && desc !== form ? `${form}: ${desc}` : form });
  }
  return out;
}

export async function renderLookup(ctx, symParam) {
  const root = h('div');
  root.append(h('a', { class: 'back', href: '#/fundamentals' }, icon('back'), 'Fundamentals'));
  const sym = String(symParam || '').toUpperCase();
  if (!sym) { root.append(h('div', { class: 'empty', style: { marginTop: '16px' } }, 'No symbol given.')); return root; }
  ctx.setTitle(`${sym} · SEC lookup`);
  const box = h('div', { style: { marginTop: '16px' } }, h('div', { class: 'empty' }, 'Looking up ', h('b', null, sym), ' on SEC EDGAR…'));
  root.append(box);

  const idx = await D.edgarIndex();
  const row = (idx?.rows || []).find((r) => r.t === sym);
  if (!row) {
    box.replaceChildren(h('div', { class: 'empty' },
      h('b', null, `${sym} is not a US-listed company SEC knows about`),
      'This live lookup only covers companies registered with the SEC. Indian stocks and some foreign issuers are not in its database — add those to your watchlist instead to see prices and sentiment.'));
    return root;
  }
  const cik = String(row.c).padStart(10, '0');
  const sub = await getJSONAbsolute(`https://data.sec.gov/submissions/CIK${cik}.json`);
  if (!sub) {
    box.replaceChildren(h('div', { class: 'empty' },
      h('b', null, 'Could not reach SEC EDGAR'),
      'This happens if SEC is rate-limiting or the connection dropped. Try again in a moment.'));
    return root;
  }
  ctx.setTitle(`${sym} ${sub.name || row.n || ''}`);
  const filings = filingsFromRecent(sub.filings?.recent || {}, parseInt(row.c, 10));
  const wrap = h('div', { style: { marginTop: '4px' } });
  wrap.append(
    h('div', { class: 'co-head' },
      h('div', null,
        h('h1', null, sym),
        h('div', { class: 'soft' }, sub.name || row.n),
        h('div', { class: 'tiny muted', style: { marginTop: '2px' } }, [sub.sicDescription, [...new Set(sub.exchanges || [])].join(', ')].filter(Boolean).join(', '))),
      h('div', { class: 'right' }, extLink('View on sec.gov', `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=&dateb=&owner=include&count=40`, 'btn'))),
    h('div', { class: 'banner', style: { marginTop: '14px' } }, icon('info'), h('div', null,
      h('b', null, 'Live SEC lookup. '),
      `${sym} is not in your curated watchlist, so there is no price, analyst view or sentiment here — only what SEC EDGAR reports, fetched just now. `,
      'Add it to config/watchlist.json for the full view.')),
    h('div', { class: 'section', style: { marginTop: '22px' } }, sectionHead('Recent filings'),
      filings.length ? h('div', { class: 'feed' }, filings.map((f) => feedItem(f))) : h('div', { class: 'empty' }, 'No filings found.')));
  box.replaceChildren(wrap);
  return root;
}
