import { h, icon, fmt, badge, extLink, sheet, debounce } from '../lib/dom.js';
import { D } from '../lib/data.js';
import { gauge, meter, sparkline, lineChart, stackBar, legend } from '../lib/charts.js';
import { pageHead, sectionHead, segmented, chipGroup, noDataPanel, dataTable } from '../lib/ui.js';

const SRC_NAME = {
  news: 'News headlines', yahoo: 'Yahoo Finance news', stocktwits: 'StockTwits', reddit: 'Reddit', bluesky: 'Bluesky',
  mastodon: 'Mastodon', hn: 'Hacker News', youtube: 'YouTube', gdelt: 'Global news tone', x: 'X (Twitter)', instagram: 'Instagram', tiktok: 'TikTok',
};
const srcName = (id) => SRC_NAME[id] || id;
const labelClass = (s) => (s >= 20 ? 'gain' : s <= -20 ? 'loss' : '');

export async function render(ctx) {
  const sym = ctx.params[0];
  if (sym) return detail(ctx, sym);
  ctx.setTitle('Sentiment');
  const sent = await D.sentiment();
  const root = h('div');
  root.append(pageHead('Sentiment', 'What news sites, forums and social feeds are saying about your companies, scored from bearish to bullish.',
    sent ? h('button', { class: 'btn', onClick: () => sourcesSheet(sent), 'aria-label': 'Data sources' }, icon('plug'), 'Sources') : null));
  if (!sent || !sent.tickers?.length) { root.append(noDataPanel()); if (sent) root.append(sourcesPanel(sent)); return root; }

  const mk = sent.market || {};
  if (typeof mk.score === 'number') {
    root.append(h('div', { class: 'panel' },
      h('div', { class: 'row wrap', style: { gap: '18px 28px', alignItems: 'center' } },
        gauge(mk.score, { size: 230, label: 'Crowd mood' }),
        h('div', { class: 'grow', style: { minWidth: '220px' } },
          h('h2', null, `Crowd mood: ${mk.label || ''}`),
          h('p', { class: 'soft', style: { margin: '6px 0 12px' } }, `${fmt.int(mk.mentions)} mentions across your watchlist in the last 7 days. The score runs from −100 (all bearish) to +100 (all bullish).`),
          stackBar([{ label: 'Bullish', value: Math.round(mk.bull_pct || 0), color: 'var(--gain)' }, { label: 'Neutral', value: Math.round(mk.neutral_pct || 0), color: 'var(--flat)' }, { label: 'Bearish', value: Math.round(mk.bear_pct || 0), color: 'var(--loss)' }])))));
  }

  // leaderboard
  let sort = 'bull';
  const list = h('div', { class: 'ledger' });
  const sorters = {
    bull: (a, b) => b.score - a.score,
    bear: (a, b) => a.score - b.score,
    talk: (a, b) => (b.mentions || 0) - (a.mentions || 0),
    shift: (a, b) => Math.abs(b.score_change || 0) - Math.abs(a.score_change || 0),
  };
  const paint = () => {
    list.replaceChildren(...sent.tickers.slice().sort(sorters[sort]).map((t) => h('a', { class: 'lrow', href: `#/sentiment/${encodeURIComponent(t.symbol)}`, style: { alignItems: 'center' } },
      h('div', { class: 'who' }, h('div', { class: 'sym' }, t.symbol.replace(/\.NS$/, '')), h('div', { class: 'name ell' }, `${fmt.int(t.mentions)} mentions${t.mentions_change ? `, ${t.mentions_change > 0 ? 'up' : 'down'} ${Math.abs(Math.round(t.mentions_change))}%` : ''}`)),
      t.trend?.length > 2 ? sparkline(t.trend, { color: 'var(--s1)' }) : null,
      h('div', { class: 'px', style: { minWidth: '96px' } },
        h('div', { class: 'p ' + fmt.dir(t.score) }, fmt.signed(t.score, 0)),
        h('div', { style: { margin: '6px 0 0', width: '96px', marginLeft: 'auto' } }, meter(t.score)),
        h('div', { class: 'tiny muted', style: { marginTop: '5px' } }, t.label)))));
  };
  root.append(h('section', { class: 'section' }, sectionHead('Company by company'),
    segmented([{ id: 'bull', label: 'Most bullish' }, { id: 'bear', label: 'Most bearish' }, { id: 'talk', label: 'Most talked about' }, { id: 'shift', label: 'Biggest shift' }], sort, (v) => { sort = v; paint(); }, 'Sort sentiment'),
    h('div', { style: { height: '8px' } }), list));
  paint();
  root.append(h('section', { class: 'section' }, sectionHead('Where the data comes from'), sourcesPanel(sent)));
  return root;
}

function sourcesPanel(sent) {
  const grid = h('div', { class: 'srcs' });
  for (const s of sent.sources || []) {
    grid.append(h('div', { class: 'src' }, h('span', { class: 'dot ' + (s.status === 'ok' ? 'ok' : s.status === 'error' ? 'error' : 'off') }),
      h('div', null, h('div', { class: 'nm' }, s.name || srcName(s.id)), h('div', { class: 'nt' }, s.note || (s.status === 'ok' ? `${fmt.int(s.items)} items this run` : '')))));
  }
  return grid;
}
function sourcesSheet(sent) { sheet('Sentiment sources', sourcesPanel(sent), h('p', { class: 'muted small', style: { marginTop: '14px' } }, 'Scores come from a finance-tuned word list plus the bullish/bearish tags users add themselves on StockTwits. They are a mood gauge, not a forecast.')); }

// ---------------- one company ----------------
async function detail(ctx, sym) {
  const [d, sent] = await Promise.all([D.sentimentFor(sym), D.sentiment()]);
  const root = h('div');
  root.append(h('a', { class: 'back', href: '#/sentiment' }, icon('back'), 'Sentiment'));
  if (!d) { root.append(h('div', { class: 'empty', style: { marginTop: '16px' } }, h('b', null, `No sentiment for ${sym} yet`), 'It appears after the next sentiment run.')); return root; }
  ctx.setTitle(`${d.symbol} sentiment`);
  root.append(h('div', { class: 'co-head' },
    h('div', null, h('h1', null, d.symbol.replace(/\.NS$/, '')), h('div', { class: 'soft' }, d.name || '')),
    h('a', { class: 'btn', href: `#/fundamentals/${encodeURIComponent(d.symbol)}` }, 'Fundamentals')));
  root.append(h('div', { class: 'panel' }, h('div', { class: 'row wrap', style: { gap: '14px 28px' } },
    gauge(d.score, { size: 220, label: d.symbol }),
    h('div', { class: 'grow', style: { minWidth: '220px' } },
      h('h2', null, d.label),
      h('p', { class: 'soft', style: { margin: '6px 0 12px' } }, `${fmt.int(d.mentions)} mentions in the last 7 days.`),
      stackBar([{ label: 'Bullish', value: Math.round(d.bull_pct), color: 'var(--gain)' }, { label: 'Neutral', value: Math.round(d.neutral_pct), color: 'var(--flat)' }, { label: 'Bearish', value: Math.round(d.bear_pct), color: 'var(--loss)' }])))));

  if (d.history?.length > 2) {
    const hs = d.history.slice(-120);
    root.append(h('section', { class: 'section' }, sectionHead('Score over time', `${hs.length} readings`),
      lineChart({ series: [{ name: 'Score', values: hs.map((x) => x.s), color: 'var(--s1)' }], x: hs.map((x) => x.t), height: 200, area: true, yFmt: (v) => fmt.signed(v, 0), xFmt: (t, tip) => (tip ? new Date(t).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : fmt.shortDate(t)), label: 'Sentiment score history' })));
  }
  const bs = Object.entries(d.by_source || {});
  if (bs.length) {
    root.append(h('section', { class: 'section' }, sectionHead('By source'), dataTable([
      { label: 'Source', render: ([id]) => srcName(id) },
      { label: 'Mentions', align: 'r', render: ([, v]) => fmt.int(v.n) },
      { label: 'Split', render: ([, v]) => stackBar([{ label: 'Bullish', value: v.bull || 0, color: 'var(--gain)' }, { label: 'Neutral', value: v.neutral || 0, color: 'var(--flat)' }, { label: 'Bearish', value: v.bear || 0, color: 'var(--loss)' }], { showLegend: false }) },
      { label: 'Score', align: 'r', render: ([, v]) => h('span', { class: fmt.dir(v.score) }, fmt.signed(v.score, 0)) },
    ], bs.sort((a, b) => b[1].n - a[1].n))));
  }
  if (d.keywords?.length) root.append(h('section', { class: 'section' }, sectionHead('Words people use'), h('div', { class: 'row wrap', style: { gap: '8px' } }, d.keywords.slice(0, 18).map((k) => h('span', { class: 'badge outline', title: `${k.n} mentions` }, k.w)))));

  // feed
  let src = 'all', lab = 'all';
  const items = d.items || [];
  const box = h('div');
  const paint = () => {
    const f = items.filter((i) => (src === 'all' || i.source === src) && (lab === 'all' || i.label === lab));
    box.replaceChildren(...f.slice(0, 60).map(post));
    if (!f.length) box.append(h('div', { class: 'empty' }, 'Nothing matches.'));
  };
  const srcs = [...new Set(items.map((i) => i.source))];
  root.append(h('section', { class: 'section' }, sectionHead('Latest posts and headlines', `${items.length} kept`),
    chipGroup([{ id: 'all', label: 'All sources' }, ...srcs.map((s) => ({ id: s, label: srcName(s) }))], src, (v) => { src = v; paint(); }),
    chipGroup([{ id: 'all', label: 'Any mood' }, { id: 'bull', label: 'Bullish' }, { id: 'neutral', label: 'Neutral' }, { id: 'bear', label: 'Bearish' }], lab, (v) => { lab = v; paint(); }),
    box));
  paint();
  return root;
}

function post(i) {
  const tone = i.label === 'bull' ? 'gain' : i.label === 'bear' ? 'loss' : '';
  const text = i.title && i.text && i.text !== i.title ? i.title + '. ' + i.text : (i.title || i.text || '');
  return h('div', { class: 'post' },
    h('div', { class: 'tx' }, text.length > 320 ? text.slice(0, 317) + '…' : text),
    h('div', { class: 'm' },
      badge(i.label === 'bull' ? 'Bullish' : i.label === 'bear' ? 'Bearish' : 'Neutral', tone),
      h('span', null, srcName(i.source)), i.author ? h('span', null, i.author) : null,
      i.ts ? h('span', null, fmt.rel(i.ts)) : null,
      i.likes ? h('span', null, `${fmt.compact(i.likes)} likes`) : null,
      i.url ? extLink('Open', i.url, 'muted') : null));
}
