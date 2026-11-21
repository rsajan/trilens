// Scanner Results / Fundamental Results: which symbols get confirmed by 2+ DIFFERENT
// scanners/signals/frameworks, ranked by how many agree. Computed entirely client-side from
// the already-published bundle (see lib/crosscheck.js), so it updates automatically every time
// a fresh bundle is published -- there is no separate data file to keep in sync.
import { h, badge } from '../lib/dom.js';
import { pageHead, segmented, dataTable } from '../lib/ui.js';
import { loadBundle, notPublished, lockScreen } from '../lib/bundle.js';
import { collectOccurrences, rankBySymbol } from '../lib/crosscheck.js';

const COUNT_KIND = (n) => (n >= 5 ? 'gain' : n >= 3 ? 'accent' : 'outline');

export async function renderResultsPage(ctx, { title, sub, keys, showScore, scoreLabel }) {
  ctx.setTitle(title);
  const root = h('div');
  root.append(pageHead(title, sub));
  const loaded = await loadBundle();
  if (loaded.lock === 'not-published') { root.append(notPublished()); return root; }
  if (loaded.lock === 'locked') { root.append(lockScreen(loaded.env, () => location.reload())); return root; }
  const b = loaded.bundle;
  const occurrences = collectOccurrences(b.signals || {}, keys);
  const allRanked = rankBySymbol(occurrences, 2);
  const sectors = [...new Set(allRanked.map((r) => r.sector).filter(Boolean))].sort();
  // No hardcoded cap -- goes up to however many sources actually agree on one symbol today.
  const maxCount = allRanked.reduce((m, r) => Math.max(m, r.count), 2);
  const countOptions = Array.from({ length: maxCount - 1 }, (_, i) => i + 2);

  let minCount = 2, market = 'all', sector = 'all', sortBy = 'count';
  const box = h('div');

  const paint = () => {
    let rows = allRanked.filter((r) => r.count >= minCount);
    if (market !== 'all') rows = rows.filter((r) => r.market === market);
    if (sector !== 'all') rows = rows.filter((r) => r.sector === sector);
    rows = rows.slice().sort((a, c) => {
      if (sortBy === 'score') return (c.bestScore ?? -Infinity) - (a.bestScore ?? -Infinity);
      if (sortBy === 'symbol') return a.symbol.localeCompare(c.symbol);
      return c.count - a.count || a.symbol.localeCompare(c.symbol);
    });

    const cols = [
      { label: 'symbol', render: (r) => r.symbol },
      { label: 'market', render: (r) => r.market },
      { label: 'sector', render: (r) => r.sector || '—' },
      { label: 'occurrences', align: 'r', render: (r) => badge(`${r.count}`, COUNT_KIND(r.count)) },
      showScore ? { label: scoreLabel || 'best score', align: 'r', render: (r) => r.bestScore != null ? Math.round(r.bestScore * 10) / 10 : '—' } : null,
      { label: 'matching sources', render: (r) => r.sourceNames.join(', ') },
      { label: 'last updated', render: (r) => r.lastUpdated || '—' },
    ].filter(Boolean);

    const shown = rows.slice(0, 150);
    box.replaceChildren(
      h('p', { class: 'soft small', style: { margin: '0 0 14px' } },
        `${rows.length} symbol${rows.length === 1 ? '' : 's'} confirmed by ${minCount}+ different sources` +
        (rows.length > shown.length ? ` -- showing the top ${shown.length}, ranked by occurrence count.` : '.')),
      shown.length
        ? dataTable(cols, shown, { compact: true })
        : h('div', { class: 'empty' }, `No symbol currently appears in ${minCount}+ sources with these filters.`));
  };

  const sectorSelect = h('select', { class: 'field', style: { width: 'auto' }, onChange: (e) => { sector = e.target.value; paint(); } },
    h('option', { value: 'all' }, 'All sectors'),
    ...sectors.map((s) => h('option', { value: s }, s)));
  const sortSelect = h('select', { class: 'field', style: { width: 'auto' }, onChange: (e) => { sortBy = e.target.value; paint(); } },
    h('option', { value: 'count' }, 'Sort: occurrences'),
    h('option', { value: 'symbol' }, 'Sort: symbol'),
    ...(showScore ? [h('option', { value: 'score' }, `Sort: ${scoreLabel || 'best score'}`)] : []));

  root.append(
    h('div', { class: 'row wrap', style: { gap: '10px', marginBottom: '14px', alignItems: 'center' } },
      segmented(countOptions.map((n) => ({ id: String(n), label: `${n}+` })), String(minCount), (v) => { minCount = +v; paint(); }, 'Minimum occurrences'),
      segmented([{ id: 'all', label: 'All markets' }, { id: 'US', label: 'US' }, { id: 'India', label: 'India' }], market, (v) => { market = v; paint(); }),
      sectorSelect, sortSelect),
    box);
  paint();
  return root;
}
