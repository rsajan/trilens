// The 20 automatic watchlists: one per Scanner signal (17), Crypto, US top 500 and India top 500.
// Built in the browser from your unlocked data; nothing is written to the repository.
// Used by the chart's watchlist panel (⚡ and on open) and by the Watch Lists page.

import { loadBundle } from '../../lib/bundle.js';
import { store } from '../../lib/store.js';
import { stockData } from '../data/stocks.js';
import { buildSignalLists, installLists, SIGNAL_LISTS } from './library.js';

/** Names of the automatic lists, in display order. */
export const AUTO_LIST_NAMES = [...SIGNAL_LISTS.map(([, name]) => name), 'Crypto', 'US top 500', 'India top 500'];

/**
 * Build or refresh the automatic lists.
 * auto: only with a remembered password, and only when the published data changed since last time.
 * @returns {Promise<{ state: 'built'|'skipped'|'locked'|'not-published', env?: any, lists?: { name: string, symbols: string[] }[], stocks?: boolean }>}
 */
export async function refreshAutoLists(auto = false) {
  const res = await loadBundle().catch(() => ({ lock: 'not-published' }));
  if (res.lock) return { state: res.lock, env: res.env };
  await stockData.load(true).catch(() => {});
  const stamp = res.bundle.built_at + '|' + (stockData.data ? stockData.data.built_at : '');
  if (auto && store.get('signalListsAt') === stamp) return { state: 'skipped' };
  const tops = stockData.status === 'ready' ? stockData.topLists() : [];
  const lists = [...buildSignalLists(res.bundle), ...tops];
  installLists(lists);
  store.set('signalListsAt', stamp);
  return { state: 'built', lists, stocks: tops.length > 0 };
}
