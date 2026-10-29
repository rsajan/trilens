// Ad-hoc lookup for a US company that is not in the curated watchlist.
// Fetched live, straight from the browser, from SEC EDGAR's public data.sec.gov API (no key, CORS-open).
// No price, analyst or sentiment data here: those sources need a server-side fetch, which only runs for
// the watchlist. This page is filings and company profile only, and says so.
import { h, icon, extLink, sheet } from '../lib/dom.js';
import { D, getJSONAbsolute } from '../lib/data.js';
import { feedItem, sectionHead } from '../lib/ui.js';

// Manual "add to watchlist" - this static site has no backend to write config/watchlist.json
// itself, so this opens a sheet with a copyable line plus a direct link to edit that file on
// GitHub (works from a phone: GitHub's own editor commits straight to main, which republishes
// the site). It only happens if the owner chooses to, by tapping this button.
function addToWatchlistButton(entry) {
  const line = JSON.stringify(entry);
  return h('button', { class: 'btn primary', type: 'button', style: { minHeight: '38px', padding: '0 16px' }, onClick: () => {
    const copyBtn = h('button', { class: 'btn', type: 'button', style: { minHeight: '34px', padding: '0 14px', flex: 'none' } }, 'Copy');
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(line);
        copyBtn.textContent = 'Copied';
        setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
      } catch {
        copyBtn.textContent = 'Select the text and copy it';
      }
    });
    sheet('Add to watchlist',
      h('p', { class: 'soft small' }, 'This only happens if you choose to: paste the line below into the "tickers" list in config/watchlist.json, then push. Quickest from a phone is GitHub’s own editor, which commits straight to the live site. It then gets the full price, earnings, analyst and sentiment view.'),
      h('div', { class: 'row', style: { gap: '10px', alignItems: 'center', flexWrap: 'wrap', marginTop: '10px' } },
        h('pre', { class: 'txt', style: { flex: '1 1 auto' } }, line),
        copyBtn),
      h('div', { style: { marginTop: '14px' } }, extLink('Open config/watchlist.json on GitHub', 'https://github.com/rsajan/trilens/edit/main/config/watchlist.json', 'btn primary')));
  } }, 'Add to watchlist');
}

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
      h('div', { class: 'right', style: { display: 'flex', gap: '8px', flexWrap: 'wrap', justifyContent: 'flex-end' } },
        addToWatchlistButton({ symbol: sym, name: sub.name || row.n }),
        extLink('View on sec.gov', `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=&dateb=&owner=include&count=40`, 'btn'))),
    h('div', { class: 'banner', style: { marginTop: '14px' } }, icon('info'), h('div', null,
      h('b', null, 'Live SEC lookup. '),
      `${sym} is not in your curated watchlist, so there is no price, analyst view or sentiment here — only what SEC EDGAR reports, fetched just now.`)),
    h('div', { class: 'section', style: { marginTop: '22px' } }, sectionHead('Recent filings'),
      filings.length ? h('div', { class: 'feed' }, filings.map((f) => feedItem(f))) : h('div', { class: 'empty' }, 'No filings found.')));
  box.replaceChildren(wrap);
  return root;
}

// Ad-hoc lookup for an India company that is not in the curated watchlist.
// Unlike the US page above, this has no live data to show: NSE's own quote and shareholding
// APIs block scripted/cross-origin requests, so there is no free, ToS-respecting way to fetch
// price, ratios or filings for an arbitrary Indian stock from the browser. This page is the
// static company profile (from the Nifty Total Market list the pipeline publishes)
// plus links out to where that live data actually lives, and says so plainly.
export async function renderIndiaLookup(ctx, symParam) {
  const root = h('div');
  root.append(h('a', { class: 'back', href: '#/fundamentals' }, icon('back'), 'Fundamentals'));
  const sym = String(symParam || '').toUpperCase();
  if (!sym) { root.append(h('div', { class: 'empty', style: { marginTop: '16px' } }, 'No symbol given.')); return root; }
  ctx.setTitle(`${sym} · NSE lookup`);

  const idx = await D.indiaIndex();
  const row = (idx?.rows || []).find((r) => r.s === sym);
  if (!row) {
    root.append(h('div', { class: 'empty', style: { marginTop: '16px' } },
      h('b', null, `${sym} is not in NSE’s Nifty Total Market index`),
      'This list covers India’s roughly 750 largest companies by NSE index membership. Smaller or newer listings are not included — add it to your watchlist instead if you follow it closely.'));
    return root;
  }
  ctx.setTitle(`${sym} ${row.n || ''}`);
  const wrap = h('div', { style: { marginTop: '16px' } });
  wrap.append(
    h('div', { class: 'co-head' },
      h('div', null,
        h('h1', null, sym),
        h('div', { class: 'soft' }, row.n),
        h('div', { class: 'tiny muted', style: { marginTop: '2px' } }, [row.ind, row.fv ? `Face value ₹${row.fv}` : null].filter(Boolean).join(', '))),
      h('div', { class: 'right' }, addToWatchlistButton({ symbol: `${sym}.NS`, name: row.n }))),
    h('div', { class: 'banner', style: { marginTop: '14px' } }, icon('info'), h('div', null,
      h('b', null, 'NSE list lookup. '),
      `${sym} is not in your curated watchlist. NSE’s live price and shareholding data blocks automated browser requests, so there is nothing more to fetch here — only what Trilens’s free static company list already has.`)),
    h('div', { class: 'section', style: { marginTop: '22px' } }, sectionHead('Open elsewhere'),
      h('div', { class: 'ledger' },
        extRow('NSE quote page', `https://www.nseindia.com/get-quotes/equity?symbol=${encodeURIComponent(sym)}`),
        extRow('Screener.in (ratios, financials)', `https://www.screener.in/company/${encodeURIComponent(sym)}/`))));
  root.append(wrap);
  return root;
}

function extRow(label, url) {
  const a = extLink('', url, 'lrow');
  a.append(h('div', { class: 'who' }, h('div', { class: 'sym' }, label)), icon('ext'));
  return a;
}
