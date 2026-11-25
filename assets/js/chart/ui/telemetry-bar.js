// Futures telemetry strip: contract, last, 24h change, mark, index, funding (or basis + expiry for a
// dated contract), 24h high/low/volume/turnover and open interest. Cells are created once and only
// their text changes on each update.

import { h } from '../../lib/dom.js';
import { fmtNum, fmtVol } from '../engine/chart-engine.js';

const two = (n) => String(n).padStart(2, '0');
function countdown(sec) {
  if (!Number.isFinite(sec)) return '—';
  sec = Math.max(0, Math.floor(sec));
  const d = Math.floor(sec / 86400), hh = Math.floor((sec % 86400) / 3600), mm = Math.floor((sec % 3600) / 60), ss = sec % 60;
  return (d ? d + 'd ' : '') + two(hh) + ':' + two(mm) + ':' + two(ss);
}

/**
 * @param {{ onPickSymbol: () => void }} hooks
 */
export function createTelemetryBar(hooks) {
  const cell = (label, title) => {
    const v = h('span', { class: 'tv num' }, '—');
    const el = h('div', { class: 'tcell', title: title || label }, h('span', { class: 'tl' }, label), v);
    return { el, v, l: el.firstChild };
  };
  const symName = h('span', { class: 'tsym' }, '—');
  const symKind = h('span', { class: 'tkind' }, '');
  const symSub = h('span', { class: 'tsub' }, '');
  const symBtn = h('button', { type: 'button', class: 'tpick', onClick: hooks.onPickSymbol, title: 'Change contract' }, h('span', { class: 'row', style: { gap: '6px' } }, symName, symKind), symSub);
  const last = h('span', { class: 'tlast num' }, '—');
  const chg = h('span', { class: 'tchg num' }, '');

  const mark = cell('Mark', 'Mark price: the fair price used for funding and liquidations');
  const index = cell('Index', 'Index price: the spot reference the contract tracks');
  const fund = cell('Funding / 8h', 'Funding rate for the current 8-hour interval and time until it is charged');
  const fundCd = h('span', { class: 'tcd num' }, '');
  fund.el.append(fundCd);
  const high = cell('24h high');
  const low = cell('24h low');
  const vol = cell('24h vol');
  const turn = cell('24h turnover');
  const oi = cell('Open interest', 'Contracts open right now, and their value at the mark price');

  const el = h('div', { class: 'tbar', role: 'group', 'aria-label': 'Contract telemetry' },
    symBtn, h('div', { class: 'tpx' }, last, chg),
    h('div', { class: 'tcells' }, mark.el, index.el, fund.el, high.el, low.el, vol.el, turn.el, oi.el));

  let lastPrice = NaN, nextT = NaN, dec = 2, base = '', quote = '';
  const timer = setInterval(() => { if (Number.isFinite(nextT)) fundCd.textContent = countdown(nextT - Date.now() / 1000); }, 1000);

  return {
    el,
    /** @param {{ symbol: string, name: string, kind: string, tick: number, base: string, quote: string }} c @param {string} feedLabel */
    setContract(c, feedLabel) {
      symName.textContent = c.symbol;
      symKind.textContent = c.kind === 'perp' ? 'Perpetual' : 'Quarterly';
      symSub.textContent = c.name + ' · ' + feedLabel;
      const s = String(c.tick); dec = s.includes('e-') ? +s.split('e-')[1] : (s.split('.')[1] || '').length;
      base = c.base; quote = c.quote;
      lastPrice = NaN; nextT = NaN;
      for (const x of [mark, index, fund, high, low, vol, turn, oi]) x.v.textContent = '—';
      last.textContent = '—'; chg.textContent = ''; fundCd.textContent = '';
      fund.l.textContent = c.kind === 'perp' ? 'Funding / 8h' : 'Basis (annual)';
      fund.el.title = c.kind === 'perp' ? 'Funding rate for the current 8-hour interval and time until it is charged' : 'Premium of the quarterly contract over the index, annualised, and time to expiry';
    },
    /** @param {import('../data/adapters.js').Telemetry} t */
    update(t) {
      if (Number.isFinite(t.last)) {
        last.textContent = fmtNum(t.last, dec);
        if (Number.isFinite(lastPrice) && t.last !== lastPrice) {
          last.classList.remove('flash-up', 'flash-down');
          void last.offsetWidth; // restart the flash animation
          last.classList.add(t.last > lastPrice ? 'flash-up' : 'flash-down');
        }
        lastPrice = t.last;
      }
      if (Number.isFinite(t.change24h)) {
        chg.textContent = (t.change24h >= 0 ? '+' : '') + fmtNum(t.change24h, dec) + ' (' + (t.changePct24h >= 0 ? '+' : '') + t.changePct24h.toFixed(2) + '%)';
        chg.className = 'tchg num ' + (t.change24h >= 0 ? 'up' : 'down');
        last.classList.toggle('up', t.change24h >= 0); last.classList.toggle('down', t.change24h < 0);
      }
      mark.v.textContent = fmtNum(t.mark, dec);
      index.v.textContent = fmtNum(t.index, dec);
      if (t.kind === 'perp') {
        fund.v.textContent = Number.isFinite(t.fundingRate) ? (t.fundingRate * 100).toFixed(4) + '%' : '—';
        fund.v.className = 'tv num ' + (t.fundingRate > 0 ? 'up' : t.fundingRate < 0 ? 'down' : '');
        nextT = t.nextFundingTime;
      } else {
        fund.v.textContent = Number.isFinite(t.basisAnnualPct) ? t.basisAnnualPct.toFixed(2) + '%' : '—';
        fund.v.className = 'tv num ' + (t.basisAnnualPct >= 0 ? 'up' : 'down');
        nextT = t.expiryTime;
      }
      fundCd.textContent = countdown(nextT - Date.now() / 1000);
      high.v.textContent = fmtNum(t.high24h, dec);
      low.v.textContent = fmtNum(t.low24h, dec);
      vol.v.textContent = fmtVol(t.volume24h) + ' ' + base;
      turn.v.textContent = fmtVol(t.turnover24h) + ' ' + quote;
      oi.v.textContent = Number.isFinite(t.openInterest) ? fmtVol(t.openInterest) + ' ' + base + ' · ' + fmtVol(t.openInterestValue) + ' ' + quote : '—';
    },
    dispose() { clearInterval(timer); },
  };
}
