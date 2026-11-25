// Client-side price alerts. Checked against live telemetry (about once a second per symbol) while
// the chart page is open: there is no server, so nothing can fire while the page or app is closed.
// A fired alert shows a toast, a browser notification if you allowed them, and a short tone; it
// then switches off (re-arm it from the alerts list).

import { h, sheet, clear } from '../../lib/dom.js';
import { alerts, addAlert, patchAlert, deleteAlert, alertHit } from '../store/library.js';

const COND = { crosses: 'crosses', above: 'goes at or above', below: 'goes at or below' };

export class AlertEngine {
  /** @param {{ getAdapter: () => any, toast: (title: string, body: string) => void, fmt: (symbol: string, p: number) => string }} o */
  constructor(o) {
    this.o = o;
    this.subs = new Map(); // symbol -> unsubscribe
    this.prev = new Map(); // symbol -> previous last price
    this.unsub = alerts.subscribe((a) => a, () => this.sync());
    this.sync();
  }

  /** Subscribe to exactly the symbols that have an armed alert. */
  sync() {
    const adapter = this.o.getAdapter();
    const want = new Set(alerts.get().filter((a) => a.active).map((a) => a.symbol));
    for (const [sym, u] of this.subs) if (!want.has(sym) || this.adapter !== adapter) { u(); this.subs.delete(sym); this.prev.delete(sym); }
    this.adapter = adapter;
    for (const sym of want) {
      if (this.subs.has(sym)) continue;
      this.subs.set(sym, adapter.subscribeTelemetry(sym, (t) => this.check(sym, t.last)));
    }
  }

  check(symbol, last) {
    const prev = this.prev.get(symbol);
    this.prev.set(symbol, last);
    for (const a of alerts.get()) {
      if (!a.active || a.symbol !== symbol) continue;
      if (!alertHit(a.cond, a.price, prev, last)) continue;
      patchAlert(a.id, { active: false, firedAt: Date.now(), firedPrice: last });
      this.fire(a, last);
    }
  }

  fire(a, last) {
    const title = `${a.symbol} ${COND[a.cond]} ${this.o.fmt(a.symbol, a.price)}`;
    const body = `Last ${this.o.fmt(a.symbol, last)}${a.note ? ' · ' + a.note : ''}`;
    this.o.toast(title, body);
    try { if ('Notification' in window && Notification.permission === 'granted') new Notification('Trilens alert: ' + title, { body, tag: a.id, icon: 'assets/icons/icon-192.png' }); } catch { /* notifications unavailable */ }
    beep();
  }

  dispose() { this.unsub(); for (const u of this.subs.values()) u(); this.subs.clear(); }
}

function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.value = 880; o.type = 'sine';
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.45);
    o.connect(g).connect(ctx.destination);
    o.start(); o.stop(ctx.currentTime + 0.5);
    o.onended = () => ctx.close();
  } catch { /* audio blocked until the user interacts with the page */ }
}

/** @param {{ symbol: string, price: number, last: number, fmt: (p: number) => string }} o */
export function alertDialog(o) {
  const cond = h('select', { class: 'ipt' }, Object.entries(COND).map(([k, v]) => h('option', { value: k }, v)));
  const price = h('input', { class: 'ipt', type: 'number', step: 'any', inputmode: 'decimal', 'aria-label': 'Price' });
  price.value = String(o.price);
  const note = h('input', { class: 'ipt', type: 'text', placeholder: 'Optional note', 'aria-label': 'Note' });
  const msg = h('p', { class: 'muted small' }, `Last price ${o.fmt(o.last)}. Alerts are checked while this page is open in a tab or the installed app; nothing fires while it is closed.`);
  const create = h('button', { type: 'button', class: 'btn primary', onClick: async () => {
    const p = parseFloat(price.value);
    if (!Number.isFinite(p)) { price.focus(); return; }
    addAlert({ symbol: o.symbol, cond: cond.value, price: p, note: note.value.trim() });
    if ('Notification' in window && Notification.permission === 'default') { try { await Notification.requestPermission(); } catch { /* ignored */ } }
    bg.remove();
  } }, 'Create alert');
  const bg = sheet('New alert · ' + o.symbol,
    h('div', { class: 'cx-form' },
      h('label', { class: 'cx-field' }, h('span', null, 'When the last price'), cond),
      h('label', { class: 'cx-field' }, h('span', null, 'Price'), price),
      h('label', { class: 'cx-field' }, h('span', null, 'Note'), note)),
    msg, h('div', { class: 'row', style: { marginTop: '12px' } }, create));
  setTimeout(() => price.focus(), 30);
  return bg;
}

/** @param {{ fmt: (symbol: string, p: number) => string }} o */
export function alertsListDialog(o) {
  const box = h('div', { class: 'ledger' });
  const paint = () => {
    clear(box);
    const list = [...alerts.get()].sort((a, b) => (b.active - a.active) || b.created - a.created);
    if (!list.length) { box.append(h('p', { class: 'muted', style: { padding: '12px 2px' } }, 'No alerts yet. Use "Alert" in the toolbar, or select a horizontal level and press the bell.')); return; }
    for (const a of list) {
      const state = a.active ? 'Armed' : a.firedAt ? `Fired ${new Date(a.firedAt).toLocaleString()} at ${o.fmt(a.symbol, a.firedPrice)}` : 'Off';
      box.append(h('div', { class: 'lrow', style: { minHeight: '56px' } },
        h('div', { class: 'who' }, h('b', null, `${a.symbol} ${COND[a.cond]} ${o.fmt(a.symbol, a.price)}`), h('div', { class: 'name' }, state + (a.note ? ' · ' + a.note : ''))),
        h('div', { class: 'row' },
          h('button', { type: 'button', class: 'btn', style: { minHeight: '36px' }, onClick: () => patchAlert(a.id, { active: !a.active, firedAt: a.active ? a.firedAt : null }) }, a.active ? 'Turn off' : 'Re-arm'),
          h('button', { type: 'button', class: 'btn', style: { minHeight: '36px' }, onClick: () => deleteAlert(a.id) }, 'Delete'))));
    }
  };
  const unsub = alerts.subscribe((x) => x, paint);
  paint();
  const bg = sheet('Alerts', box, h('p', { class: 'muted small', style: { marginTop: '12px' } }, 'Checked about once a second against the chart feed while this page is open.'));
  new MutationObserver((_, obs) => { if (!bg.isConnected) { obs.disconnect(); unsub(); } }).observe(document.body, { childList: true });
  return bg;
}
