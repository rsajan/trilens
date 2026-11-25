// Chart page (#/chart): futures charting, telemetry and the Pine Script editor.
// Everything runs in this browser: prices come from a synthetic market generated in a Web Worker
// (or, if you pick it, Binance's public futures feed), and Pine scripts run in a second worker.
import { h } from '../lib/dom.js';

export const wide = true; // full-bleed layout: the router drops the page max-width
let unmount = null;

export async function render(ctx) {
  ctx.setTitle('Chart');
  return h('div', { class: 'cx-mount', id: 'cx-mount' });
}

export async function afterRender(view) {
  const { mountChartPage } = await import('../chart/ui/chart-page.js');
  const el = view.querySelector('#cx-mount');
  if (el) unmount = mountChartPage(el);
}

export function cleanup() {
  if (unmount) { unmount(); unmount = null; }
}
