// The Fundamental Analysis page: same Technical bundle, same Strategies/Results/Automation/
// Library tabs, but the Signals tab shows only the fundamentals-scoring frameworks - split out
// from Scanner (the pure price-action scanners) by the owner's own request.
import { renderPage, FUNDAMENTAL_KEYS } from './scanner.js';

export async function render(ctx) {
  return renderPage(ctx, { title: 'Fundamental Analysis', sub: 'The multi-factor scoring frameworks that blend fundamentals with technicals, and the automation that runs them.', allow: FUNDAMENTAL_KEYS });
}
