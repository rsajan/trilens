import { renderResultsPage } from './results.js';
import { FUNDAMENTAL_KEYS } from './scanner.js';

export async function render(ctx) {
  return renderResultsPage(ctx, {
    title: 'Fundamental Results',
    sub: 'Symbols confirmed by 2 or more different fundamentals-scoring frameworks on the Fundamental Analysis page, ranked by how many agree.',
    keys: FUNDAMENTAL_KEYS,
    showScore: true,
    scoreLabel: 'best score',
  });
}
