// Client-side alerts, checked while the chart page is open (there is no server, so nothing fires
// while the page or app is closed).
//
//  - Price alerts: checked against live telemetry, about once a second per symbol.
//  - Script alerts: an indicator's alertcondition(). Each one runs its own copy of the script in
//    the Pine worker, on its own bars for its contract and timeframe, so it keeps working whatever
//    the charts are showing. It fires once per bar close: when a bar closes with the condition
//    true (the forming bar is ignored, so a condition that flickers inside a bar does not fire).
//
// A firing shows a toast, a browser notification if you allowed them, and a short tone.
// "Once" alerts then switch off; "every bar close" alerts stay armed.

import { h, sheet, clear } from '../../lib/dom.js';
import { alerts, addAlert, patchAlert, deleteAlert, alertHit, fillMessage } from '../store/library.js';
import { BarBuffer } from '../data/bar-buffer.js';
import { TF } from '../data/timeframes.js';
import { sourceFor } from './chart-cell.js';

const COND = { crosses: 'crosses', above: 'goes at or above', below: 'goes at or below' };
const HISTORY = 600; // bars each script alert keeps: enough warm-up for long averages

export function describeAlert(a, fmt) {
  if (a.kind === 'script') {
    const src = sourceFor(a.ref);
    return `${a.symbol} ${TF[a.tf] ? TF[a.tf].label : a.tf} · ${src ? src.name : 'deleted script'}: ${a.condTitle}`;
  }
  return `${a.symbol} ${COND[a.cond]} ${fmt(a.symbol, a.price)}`;
}

export class AlertEngine {
  /**
   * @param {{ getAdapter: () => any, pine: import('../pine/client.js').PineEngine, toast: (title: string, body: string) => void,
   *   fmt: (symbol: string, p: number) => string }} o
   */
  constructor(o) {
    this.o = o;
    this.subs = new Map(); // price alerts: symbol -> unsubscribe
    this.prev = new Map(); // price alerts: symbol -> previous last price
    this.runners = new Map(); // script alerts: id -> runner
    this.unsub = alerts.subscribe((a) => a, () => this.sync());
    this.sync();
  }

  sync() {
    const adapter = this.o.getAdapter();
    const feedChanged = this.adapter && this.adapter !== adapter;
    this.adapter = adapter;
    const list = alerts.get();

    const want = new Set(list.filter((a) => a.active && a.kind !== 'script').map((a) => a.symbol));
    for (const [sym, u] of this.subs) if (!want.has(sym) || feedChanged) { u(); this.subs.delete(sym); this.prev.delete(sym); }
    for (const sym of want) if (!this.subs.has(sym)) this.subs.set(sym, adapter.subscribeTelemetry(sym, (t) => this.checkPrice(sym, t.last)));

    const scriptIds = new Set(list.filter((a) => a.active && a.kind === 'script').map((a) => a.id));
    for (const [id, r] of this.runners) if (!scriptIds.has(id) || feedChanged) { r.stop(); this.runners.delete(id); }
    for (const a of list) if (a.active && a.kind === 'script' && !this.runners.has(a.id)) this.runners.set(a.id, this.startRunner(a));
  }

  checkPrice(symbol, last) {
    const prev = this.prev.get(symbol);
    this.prev.set(symbol, last);
    for (const a of alerts.get()) {
      if (!a.active || a.kind === 'script' || a.symbol !== symbol) continue;
      if (!alertHit(a.cond, a.price, prev, last)) continue;
      patchAlert(a.id, { active: false, firedAt: Date.now(), firedPrice: last });
      this.fire(`${a.symbol} ${COND[a.cond]} ${this.o.fmt(a.symbol, a.price)}`, `Last ${this.o.fmt(a.symbol, last)}${a.note ? ' · ' + a.note : ''}`, a.id);
    }
  }

  /** Run the alert's script on its own bars; check the newest closed bar each time a bar closes. */
  startRunner(a) {
    const adapter = this.adapter, pine = this.o.pine;
    const ds = 'al:' + a.id;
    const tf = TF[a.tf] || TF['1h'];
    let stopped = false, unsubBars = null, baseline = -Infinity, running = false, again = false;
    const buf = new BarBuffer();
    const stop = () => { stopped = true; if (unsubBars) unsubBars(); pine.drop(ds); };
    const fail = (why) => { patchAlert(a.id, { active: false }); this.o.toast(`Alert switched off: ${describeAlert(a, this.o.fmt)}`, why); };

    const evaluate = async (initial) => {
      if (stopped) return;
      if (running) { again = true; return; }
      running = true;
      try {
        const src = sourceFor(a.ref);
        if (!src) { fail('Its script was deleted.'); stop(); return; }
        const res = await pine.run(ds, ds, src.source, a.inputs || {});
        if (!res || stopped) return;
        if (!res.ok) { fail(res.diagnostics[0] ? `Script error on line ${res.diagnostics[0].line}: ${res.diagnostics[0].message}` : 'The script failed to run.'); stop(); return; }
        const ac = (res.alertconds || []).find((x) => x.title === a.condTitle);
        if (!ac) { fail(`The script no longer has an alertcondition() titled "${a.condTitle}".`); stop(); return; }
        const k = res.bars - 2; // newest closed bar; the last bar is still forming
        if (k < 0) return;
        const t = buf.cols.time[k];
        if (initial) { baseline = t; return; } // never fire for history that was already there
        if (t <= baseline) return;
        baseline = t;
        if (!ac.at[k]) return;
        const bar = buf.bar(k);
        const fmt = (v, isVol) => (isVol ? String(Math.round(v)) : this.o.fmt(a.symbol, v));
        const msg = ac.message ? fillMessage(ac.message, { ticker: a.symbol, interval: tf.label, ...bar, fmt }) : `Bar closed at ${this.o.fmt(a.symbol, bar.close)}`;
        const cur = alerts.get().find((x) => x.id === a.id);
        if (!cur || !cur.active) return;
        patchAlert(a.id, { firedAt: Date.now(), firedPrice: bar.close, active: cur.freq === 'every' });
        this.fire(describeAlert(a, this.o.fmt), msg + (a.note ? ' · ' + a.note : ''), a.id + ':' + t);
      } catch (err) { console.warn('alert', err); }
      finally {
        running = false;
        if (again && !stopped) { again = false; evaluate(false); }
      }
    };

    (async () => {
      try {
        const contracts = await adapter.contracts();
        const c = contracts.find((x) => x.symbol === a.symbol);
        if (!c) { fail('Its contract is not offered by the current feed.'); return; }
        const bars = await adapter.bars(a.symbol, tf.id, { limit: HISTORY });
        if (stopped) return;
        buf.replace(bars);
        pine.setData(ds, buf.copy(), { ticker: c.symbol, mintick: c.tick }, { period: tf.pine, seconds: tf.sec });
        await evaluate(true);
        unsubBars = adapter.subscribeBars(a.symbol, tf.id, (bar) => {
          if (stopped) return;
          const kind = buf.apply(bar);
          if (kind === 'stale') return;
          pine.pushBar(ds, bar);
          if (kind === 'append') evaluate(false); // a new bar means the previous one closed
        });
      } catch (err) { if (!stopped) fail(String(err.message || err)); }
    })();
    return { stop };
  }

  fire(title, body, tag) {
    this.o.toast(title, body);
    try { if ('Notification' in window && Notification.permission === 'granted') new Notification('Trilens alert: ' + title, { body, tag, icon: 'assets/icons/icon-192.png' }); } catch { /* notifications unavailable */ }
    beep();
  }

  dispose() {
    this.unsub();
    for (const u of this.subs.values()) u();
    for (const r of this.runners.values()) r.stop();
    this.subs.clear(); this.runners.clear();
  }
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

async function askNotify() {
  if ('Notification' in window && Notification.permission === 'default') { try { await Notification.requestPermission(); } catch { /* ignored */ } }
}

/**
 * @param {{ symbol: string, tf: string, price: number, last: number, fmt: (p: number) => string,
 *   conds: { label: string, ref: string, inputs: object, title: string, message: string }[] }} o
 */
export function alertDialog(o) {
  const source = h('select', { class: 'ipt', 'aria-label': 'Condition' },
    h('option', { value: 'price' }, 'Price'),
    o.conds.map((c, i) => h('option', { value: String(i) }, c.label)));
  // price fields
  const cond = h('select', { class: 'ipt' }, Object.entries(COND).map(([k, v]) => h('option', { value: k }, v)));
  const price = h('input', { class: 'ipt', type: 'number', step: 'any', inputmode: 'decimal', 'aria-label': 'Price' });
  price.value = String(o.price);
  const priceBox = h('div', { class: 'cx-form' },
    h('label', { class: 'cx-field' }, h('span', null, 'When the last price'), cond),
    h('label', { class: 'cx-field' }, h('span', null, 'Price'), price));
  // script fields
  const freq = h('select', { class: 'ipt' }, h('option', { value: 'once' }, 'Once, then switch off'), h('option', { value: 'every' }, 'Every bar close that meets it'));
  const msgPreview = h('p', { class: 'muted small' });
  const scriptBox = h('div', { class: 'cx-form hide' },
    h('label', { class: 'cx-field' }, h('span', null, 'Fire'), freq), msgPreview);
  const note = h('input', { class: 'ipt', type: 'text', placeholder: 'Optional note', 'aria-label': 'Note' });
  const paint = () => {
    const isPrice = source.value === 'price';
    priceBox.classList.toggle('hide', !isPrice);
    scriptBox.classList.toggle('hide', isPrice);
    if (!isPrice) {
      const c = o.conds[+source.value];
      msgPreview.textContent = `Runs the indicator on ${o.symbol} ${TF[o.tf] ? TF[o.tf].label : o.tf} with its current inputs, and fires when a bar closes with "${c.title}" true.` + (c.message ? ` Message: ${c.message}` : '');
    }
  };
  source.addEventListener('change', paint);
  const hint = o.conds.length ? null : h('p', { class: 'muted small' }, 'To alert on a script condition, add an indicator that calls alertcondition() to this chart.');
  const create = h('button', { type: 'button', class: 'btn primary', onClick: async () => {
    if (source.value === 'price') {
      const p = parseFloat(price.value);
      if (!Number.isFinite(p)) { price.focus(); return; }
      addAlert({ kind: 'price', symbol: o.symbol, cond: cond.value, price: p, note: note.value.trim() });
    } else {
      const c = o.conds[+source.value];
      addAlert({ kind: 'script', symbol: o.symbol, tf: o.tf, ref: c.ref, inputs: structuredClone(c.inputs || {}), condTitle: c.title, freq: freq.value, note: note.value.trim() });
    }
    await askNotify();
    bg.remove();
  } }, 'Create alert');
  const bg = sheet('New alert · ' + o.symbol,
    h('label', { class: 'cx-field', style: { marginBottom: '12px' } }, h('span', null, 'Condition'), source),
    hint, priceBox, scriptBox,
    h('label', { class: 'cx-field', style: { marginTop: '12px' } }, h('span', null, 'Note'), note),
    h('p', { class: 'muted small', style: { marginTop: '10px' } }, `Last price ${o.fmt(o.last)}. Alerts are checked while this page is open in a tab or the installed app; nothing fires while it is closed.`),
    h('div', { class: 'row', style: { marginTop: '12px' } }, create));
  paint();
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
      const fired = a.firedAt ? `last fired ${new Date(a.firedAt).toLocaleString()} at ${o.fmt(a.symbol, a.firedPrice)}` : '';
      const state = a.active ? (a.kind === 'script' ? (a.freq === 'every' ? 'Armed, every bar close' : 'Armed, once') : 'Armed') + (fired ? ' · ' + fired : '') : fired ? 'Fired · ' + fired : 'Off';
      box.append(h('div', { class: 'lrow', style: { minHeight: '56px' } },
        h('div', { class: 'who' }, h('b', null, describeAlert(a, o.fmt)), h('div', { class: 'name' }, state + (a.note ? ' · ' + a.note : ''))),
        h('div', { class: 'row' },
          h('button', { type: 'button', class: 'btn', style: { minHeight: '36px' }, onClick: () => patchAlert(a.id, { active: !a.active }) }, a.active ? 'Turn off' : 'Re-arm'),
          h('button', { type: 'button', class: 'btn', style: { minHeight: '36px' }, onClick: () => deleteAlert(a.id) }, 'Delete'))));
    }
  };
  const unsub = alerts.subscribe((x) => x, paint);
  paint();
  const bg = sheet('Alerts', box, h('p', { class: 'muted small', style: { marginTop: '12px' } }, 'Price alerts check the feed about once a second; script alerts check each bar as it closes. Both only while this page is open.'));
  new MutationObserver((_, obs) => { if (!bg.isConnected) { obs.disconnect(); unsub(); } }).observe(document.body, { childList: true });
  return bg;
}
