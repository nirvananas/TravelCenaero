// "How much have I spent so far": totals of a mission's expenses. Pure, no DOM.
import { categoryOfTitle, NUMBERED } from './receipt.js';

const amountOf = (e) => (e.amount !== '' && e.amount != null && Number.isFinite(Number(e.amount)) ? Number(e.amount) : 0);

/** Group used in the summary: meals together, unknown titles under "Autre". */
export function groupOf(e) {
  const c = e.category || categoryOfTitle(e.title);
  if (NUMBERED.includes(c)) return 'Repas';
  return c || 'Autre';
}

/**
 * expenses: [{title, category, date, amount, photos}]; today: YYYY-MM-DD.
 * Returns {total, today, count, withoutProof, withoutAmount,
 *          byGroup: [[group, sum]] largest first, byDay: [[date, sum]] by date}.
 * Sums are rounded to the cent to avoid 0.1 + 0.2 artefacts.
 */
export function spendingSummary(expenses, today) {
  const cents = (x) => Math.round(x * 100) / 100;
  const groups = new Map();
  const days = new Map();
  let total = 0;
  let todayTotal = 0;
  for (const e of expenses) {
    const a = amountOf(e);
    total += a;
    if (e.date === today) todayTotal += a;
    if (a) groups.set(groupOf(e), (groups.get(groupOf(e)) || 0) + a);
    if (a && e.date) days.set(e.date, (days.get(e.date) || 0) + a);
  }
  return {
    total: cents(total),
    today: cents(todayTotal),
    count: expenses.length,
    withoutProof: expenses.filter((e) => !e.photos?.length).length,
    withoutAmount: expenses.filter((e) => !amountOf(e)).length,
    byGroup: [...groups].map(([g, s]) => [g, cents(s)]).sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])),
    byDay: [...days].map(([d, s]) => [d, cents(s)]).sort((x, y) => x[0].localeCompare(y[0])),
  };
}
