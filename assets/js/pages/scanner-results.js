import { renderResultsPage } from './results.js';
import { SCANNER_KEYS } from './scanner.js';

export async function render(ctx) {
  return renderResultsPage(ctx, {
    title: 'Scanner Results',
    sub: 'Symbols confirmed by 2 or more different price-action scanners, signals, or frameworks on the Scanner page -- high-conviction setups that keep showing up across independent methods.',
    keys: SCANNER_KEYS,
    showScore: false,
  });
}
