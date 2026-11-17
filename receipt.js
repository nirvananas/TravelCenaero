// Reading a receipt's text (OCR of a photo, or the text layer of a PDF): amount,
// date, time and expense category. Pure functions, no DOM. Results are suggestions
// that the app only uses to fill empty fields, so a wrong guess costs one edit.

// Expense categories (the quick buttons of the app) and their Replicon expense type.
// Replicon types seen on a real expense sheet: "Avions, trains, métros" and "Avance".
export const CATEGORIES = ['Train', 'Avion', 'Métro', 'Bus', 'Taxi', 'Repas midi', 'Repas soir',
  'Petit-déjeuner', 'Hôtel', 'Taxe de séjour', 'Parking', 'Carburant', 'Péage', 'Inscription'];
export const NUMBERED = ['Repas midi', 'Repas soir', 'Petit-déjeuner'];
const TRANSPORT = ['Train', 'Avion', 'Métro', 'Bus'];
export const REPLICON_TYPES = ['Avions, trains, métros', 'Avance'];

export function repliconType(category) {
  return TRANSPORT.includes(category) ? 'Avions, trains, métros' : 'Avance';
}

/** Category from an expense title, e.g. "Repas midi 2" -> "Repas midi". */
export function categoryOfTitle(title) {
  const t = (title || '').toLowerCase();
  return CATEGORIES.find((c) => t.startsWith(c.toLowerCase())) || '';
}

const fold = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// ---------------------------------------------------------------------------
// Amount
// ---------------------------------------------------------------------------

// 1 234,56 | 1.234,56 | 1,234.56 | 28.45 | 2,10 — always two decimals.
const AMOUNT_RE = /(?<![\d.,])(\d{1,3}(?:[ .,  ]\d{3})+|\d+)[.,](\d{2})(?![\d])/g;
const TOTAL_KW = /\b(total|totaal|montant|a payer|te betalen|amount due|amount paid|grand total|prix|price|paye|paid|debit)\b/;
const NOT_TOTAL = /\b(sous[- ]?total|subtotal|sub total|ht|hors taxe|tva|vat|btw|mwst|net total|rendu|change|monnaie|especes|cash|given|recu|pourboire|tip)\b/;

function amountsIn(line) {
  const out = [];
  for (const m of line.matchAll(AMOUNT_RE)) {
    const units = m[1].replace(/[ .,  ]/g, '');
    const v = Number(`${units}.${m[2]}`);
    if (v > 0 && v < 100000) out.push(v);
  }
  return out;
}

/** Most likely amount paid, as a string with two decimals ("28.45"), or ''. */
export function findAmount(text) {
  const lines = String(text).split(/\r?\n/).map(fold);
  const keyed = [];
  lines.forEach((l, i) => {
    if (!TOTAL_KW.test(l) || NOT_TOTAL.test(l)) return;
    let a = amountsIn(l);
    if (!a.length && i + 1 < lines.length && !NOT_TOTAL.test(lines[i + 1])) a = amountsIn(lines[i + 1]);
    keyed.push(...a);
  });
  const pool = keyed.length ? keyed
    : lines.filter((l) => !NOT_TOTAL.test(l)).flatMap(amountsIn);
  return pool.length ? Math.max(...pool).toFixed(2) : '';
}

// ---------------------------------------------------------------------------
// Date and time
// ---------------------------------------------------------------------------

const MONTHS = {
  jan: 1, janv: 1, janvier: 1, january: 1, januari: 1,
  feb: 2, fev: 2, fevr: 2, fevrier: 2, february: 2, februari: 2,
  mar: 3, mars: 3, march: 3, maart: 3, mrt: 3,
  apr: 4, avr: 4, avril: 4, april: 4,
  may: 5, mai: 5, mei: 5,
  jun: 6, juin: 6, june: 6, juni: 6,
  jul: 7, juil: 7, juillet: 7, july: 7, juli: 7,
  aug: 8, aou: 8, aout: 8, august: 8, augustus: 8,
  sep: 9, sept: 9, septembre: 9, september: 9,
  oct: 10, octobre: 10, october: 10, okt: 10, oktober: 10,
  nov: 11, novembre: 11, november: 11,
  dec: 12, decembre: 12, december: 12,
};

const iso = (y, m, d) => {
  if (y < 100) y += 2000;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
};

/** All dates found, in order of appearance, as YYYY-MM-DD. */
export function findDates(text) {
  const t = fold(String(text));
  const found = [];
  const push = (pos, v) => { if (v) found.push({ pos, v }); };
  for (const m of t.matchAll(/\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/g)) push(m.index, iso(+m[1], +m[2], +m[3]));
  for (const m of t.matchAll(/(?<![\d/.-])(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})(?![\d/.-])/g)) {
    let [a, b] = [+m[1], +m[2]];
    if (a <= 12 && b > 12) [a, b] = [b, a]; // US order, e.g. 05/19/26
    push(m.index, iso(+m[3], b, a));
  }
  for (const m of t.matchAll(/\b(\d{1,2})(?:er)?[ .-]*([a-z]{3,9})\.?[ .'-]*(\d{4}|'?\d{2})\b/g)) {
    const mo = MONTHS[m[2]];
    if (mo) push(m.index, iso(+m[3].replace("'", ''), mo, +m[1]));
  }
  return found.sort((x, y) => x.pos - y.pos).map((f) => f.v);
}

/**
 * Best date: the first one within the mission dates (with a week of margin),
 * else the first one found. range = {start, end} as YYYY-MM-DD, optional.
 */
export function findDate(text, range = {}) {
  const dates = findDates(text);
  if (!dates.length) return '';
  if (range.start) {
    const lo = shift(range.start, -7);
    const hi = shift(range.end || range.start, 7);
    const inside = dates.find((d) => d >= lo && d <= hi);
    if (inside) return inside;
  }
  return dates[0];
}

function shift(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** First clock time (HH:MM) found, or ''. Accepts 13:27, 13h27, 08H49. */
export function findTime(text) {
  const m = String(text).match(/(?<!\d)([01]?\d|2[0-3])\s?[:hH]\s?([0-5]\d)(?!\d)/);
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : '';
}

// ---------------------------------------------------------------------------
// Category
// ---------------------------------------------------------------------------

const RULES = [
  ['Taxe de séjour', /taxe de sejour|tourist tax|city tax|toeristenbelasting|kurtaxe/],
  ['Train', /\bsncf\b|\btgv\b|\bter\b|ouigo|inoui|eurostar|thalys|trenitalia|\bitalo\b|\bsbb\b|deutsche bahn|\bns international\b|ns\.nl|centraal|\btrain\b|\btrein\b|2nd class|2e classe|classe 2|one-way ticket|billet tarif|justificatif d'achat/],
  ['Avion', /boarding|airline|air france|\bklm\b|easyjet|ryanair|lufthansa|transavia|vueling|flight|\bvol\b/],
  ['Métro', /\bratp\b|\bstib\b|\bgvb\b|\bret\b|metro|\btram\b|navigo|t\+ ticket/],
  ['Taxi', /\btaxi|\buber\b|\bbolt\b|\bg7\b|heetch/],
  ['Hôtel', /\bhotel|booking\.com|\bibis\b|novotel|mercure|accor|\bnuitee|chambre|check-in|check-out|\broom\b/],
  ['Parking', /parking|stationnement/],
  ['Péage', /peage|autoroute|\btoll\b|vinci autoroutes|\baprr\b|\bsanef\b/],
  ['Carburant', /carburant|gazole|diesel|\bsp ?9[58]\b|\be10\b|litres?\b/],
  ['Inscription', /registration|inscription|conference fee|congress/],
  ['Repas', /restaurant|brasserie|bistro|\bcafe\b|menu|\bplat\b|boisson|beverage|\bfood\b|burger|pizza|sandwich|couvert|take ?out|eat ?in|boulangerie|mcdonald|starbucks|\bpaul\b|lunch|diner|dejeuner|traiteur/],
];

/** Category guess, or ''. Meals are split by the receipt time when there is one. */
export function guessCategory(text) {
  const t = fold(String(text));
  const hit = RULES.find(([, re]) => re.test(t));
  if (!hit) return '';
  if (hit[0] !== 'Repas') return hit[0];
  const time = findTime(text);
  if (!time) return 'Repas midi';
  const h = Number(time.slice(0, 2));
  if (h < 10) return 'Petit-déjeuner';
  return h < 16 ? 'Repas midi' : 'Repas soir';
}

/** Everything at once: {amount, date, time, category}; empty strings when unknown. */
export function readReceipt(text, range) {
  return { amount: findAmount(text), date: findDate(text, range), time: findTime(text), category: guessCategory(text) };
}
