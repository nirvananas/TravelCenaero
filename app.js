import { fileBase, fillMissionForm, inspectTemplate, FORM_GROUPS, PERSISTENT_KEYS } from './odt.js';
import { buildJustificatifsPdf, formatAmount, formatDateFr } from './pdf.js';
import { buildRepliconXlsx } from './xlsx.js';
import { CATEGORIES, NUMBERED, REPLICON_TYPES, repliconType, categoryOfTitle, readReceipt } from './receipt.js';
import { spendingSummary } from './summary.js';
import { packBackup, unpackBackup } from './backup.js';

const MAX_PX = 2000; // longest side of a stored photo
const PDF_MAX_PX = 2400; // longest side of a rendered PDF page (small print on e-tickets)
const MAX_PDF_PAGES = 20;
const JPEG_QUALITY = 0.85;
const INBOX = 'frais-inbox'; // Cache Storage bucket filled by the service worker (Share → Frais)
// Replicon "Type of mission" from the form's mission type. Only "Formation" has been
// seen on a real Replicon sheet; the other two are guesses, editable per mission.
const REPLICON_MISSION = { Training: 'Formation', Conference: 'Conférence', 'Meeting/Fair/Misc.': 'Réunion' };

// ---------------------------------------------------------------------------
// Storage (IndexedDB, on the phone only)
// ---------------------------------------------------------------------------

const dbp = new Promise((resolve, reject) => {
  const r = indexedDB.open('frais-mission', 1);
  r.onupgradeneeded = () => {
    const d = r.result;
    d.createObjectStore('missions', { keyPath: 'id' });
    d.createObjectStore('expenses', { keyPath: 'id' }).createIndex('missionId', 'missionId');
    d.createObjectStore('settings');
  };
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});

async function tx(store, mode, fn) {
  const d = await dbp;
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const req = fn(t.objectStore(store));
    let out;
    if (req) req.onsuccess = () => { out = req.result; };
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error(`IndexedDB transaction on ${store} aborted`));
  });
}
const db = {
  get: (s, k) => tx(s, 'readonly', (o) => o.get(k)),
  put: (s, v, k) => tx(s, 'readwrite', (o) => o.put(v, k)),
  del: (s, k) => tx(s, 'readwrite', (o) => o.delete(k)),
  all: (s) => tx(s, 'readonly', (o) => o.getAll()),
  expensesOf: async (missionId) =>
    (await tx('expenses', 'readonly', (o) => o.index('missionId').getAll(missionId))).sort((a, b) => a.pos - b.pos),
  /** Read-modify-write of one record in a single transaction (fn must be synchronous). */
  patch: (s, k, fn) => tx(s, 'readwrite', (o) => {
    const r = o.get(k);
    r.onsuccess = () => { if (r.result) { fn(r.result); o.put(r.result); } };
  }),
};

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
const today = () => new Date().toLocaleDateString('sv'); // YYYY-MM-DD in local time
const missionBase = (m) => fileBase({ lastName: m.lastName, city: m.city, startDate: m.departDate });
const missionRange = (m) => ({ start: m.form.startDate || m.departDate, end: m.form.endDate || m.form.startDate || m.departDate });
const repliconMission = (m) => m.repliconMissionType || REPLICON_MISSION[m.form.missionType] || '';
const expenseType = (e) => e.type || repliconType(e.category || categoryOfTitle(e.title));
const getDefaults = async () => (await db.get('settings', 'defaults')) || { lastName: '', form: {} };

/** Title for a category, numbering meals: "Repas midi 3". */
function titleFor(category, expenses, selfId) {
  if (!NUMBERED.includes(category)) return category;
  const k = expenses.filter((x) => x.id !== selfId && (x.title || '').toLowerCase().startsWith(category.toLowerCase())).length;
  return `${category} ${k + 1}`;
}

async function newExpense(missionId) {
  const exps = await db.expensesOf(missionId);
  const e = { id: uid(), missionId, pos: exps.length ? exps[exps.length - 1].pos + 1 : 0,
    title: '', category: '', type: '', date: today(), dateSet: false, amount: '', note: '', photos: [] };
  await db.put('expenses', e);
  navigator.storage?.persist?.();
  return e;
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const h = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const view = $('#view');
let objectUrls = [];
const blobUrl = (b) => { const u = URL.createObjectURL(b); objectUrls.push(u); return u; };

function toast(msg, ms = 3000) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), ms);
}
window.addEventListener('error', (e) => toast(`Erreur : ${e.message}`, 6000));
window.addEventListener('unhandledrejection', (e) => toast(`Erreur : ${e.reason?.message || e.reason}`, 6000));

function setBar(title, back) {
  $('#barTitle').textContent = title;
  $('#back').hidden = !back;
  $('#settings').hidden = location.hash.startsWith('#/settings');
}
$('#back').onclick = () => history.length > 1 ? history.back() : (location.hash = '#/');
$('#settings').onclick = () => { location.hash = '#/settings'; };

const parseAmount = (s) => {
  const t = String(s ?? '').trim().replace(/\s/g, '').replace(',', '.').replace(/€$/, '');
  if (t === '') return '';
  return /^\d+(\.\d{1,2})?$/.test(t) ? t : null;
};
const missionTotal = (exps) => exps.reduce((s, e) => s + (e.amount ? Number(e.amount) : 0), 0);
const isPdf = (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name || '');

// ---------------------------------------------------------------------------
// Receipts: photos (EXIF orientation applied, downscaled, JPEG) and PDF pages
// ---------------------------------------------------------------------------

async function canvasToJpeg(c) {
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', JPEG_QUALITY));
  if (!blob) throw new Error('Could not encode the photo as JPEG');
  return { blob, w: c.width, h: c.height };
}

function whiteCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; // transparent PNG screenshots -> white background
  ctx.fillRect(0, 0, w, h);
  return [c, ctx];
}

async function photoFromFile(file) {
  let bmp;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch (err) {
    throw new Error(`Impossible de lire « ${file.name} » (${file.type || 'type inconnu'}) : ${err.message}`);
  }
  const s = Math.min(1, MAX_PX / Math.max(bmp.width, bmp.height));
  const [c, ctx] = whiteCanvas(Math.round(bmp.width * s), Math.round(bmp.height * s));
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  return canvasToJpeg(c);
}

async function rotatePhoto(p) {
  const bmp = await createImageBitmap(p.blob);
  const [c, ctx] = whiteCanvas(bmp.height, bmp.width);
  ctx.translate(c.width, 0);
  ctx.rotate(Math.PI / 2);
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  return canvasToJpeg(c);
}

let pdfjsP;
/** Every page of a PDF as a JPEG photo, plus the PDF's own text (empty for a scan). */
async function pdfToPhotos(file) {
  pdfjsP ||= import('./vendor/pdfjs/pdf.min.mjs').then((m) => {
    m.GlobalWorkerOptions.workerSrc = new URL('vendor/pdfjs/pdf.worker.min.mjs', location.href).href;
    return m;
  });
  const pdfjs = await pdfjsP;
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  let doc;
  try {
    doc = await task.promise;
  } catch (err) {
    throw new Error(`Impossible d’ouvrir le PDF « ${file.name} » : ${err.message}`);
  }
  try {
    if (doc.numPages > MAX_PDF_PAGES) throw new Error(`« ${file.name} » a ${doc.numPages} pages (maximum ${MAX_PDF_PAGES})`);
    const photos = [];
    let text = '';
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const vp1 = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(PDF_MAX_PX / Math.max(vp1.width, vp1.height), 4) });
      const [c] = whiteCanvas(Math.floor(viewport.width), Math.floor(viewport.height));
      await page.render({ canvas: c, viewport }).promise;
      photos.push(await canvasToJpeg(c));
      const tc = await page.getTextContent();
      text += tc.items.map((it) => it.str + (it.hasEOL ? '\n' : ' ')).join('') + '\n';
    }
    return { photos, text };
  } finally {
    await task.destroy(); // frees the document and its worker-side data
  }
}

let ocrWorkerP;
let ocrProgress = () => {};
/** Text of a photo, read on the phone (Tesseract, French model, no network). */
async function ocr(blob) {
  ocrWorkerP ||= import('./vendor/tesseract/tesseract.esm.min.js').then(({ default: T }) => {
    const abs = (p) => new URL(p, location.href).href;
    return T.createWorker('fra', 1, {
      workerPath: abs('vendor/tesseract/worker.min.js'),
      corePath: abs('vendor/tesseract/tesseract-core-simd-lstm.wasm.js'),
      langPath: abs('vendor/tesseract/lang'),
      workerBlobURL: false,
      logger: (m) => ocrProgress(m),
    });
  });
  const worker = await ocrWorkerP;
  const { data } = await worker.recognize(blob);
  return data.text;
}

/**
 * Add receipt files (photos or PDFs) to an expense, then read them to fill the
 * fields that are still empty: amount, date (if not set by hand), title/category, type.
 * onStatus(text) reports progress. Returns the fields that were filled.
 */
async function ingest(expenseId, files, onStatus = () => {}) {
  const exp0 = await db.get('expenses', expenseId);
  const m = await db.get('missions', exp0.missionId);
  const texts = [];
  const toRead = [];
  for (const f of files) {
    if (isPdf(f)) {
      onStatus(`Ouverture de « ${f.name} »…`);
      const { photos, text } = await pdfToPhotos(f);
      await db.patch('expenses', expenseId, (e) => e.photos.push(...photos));
      if (text.trim()) texts.push(text); else toRead.push(photos[0].blob); // scanned PDF
    } else {
      onStatus('Préparation de la photo…');
      const p = await photoFromFile(f);
      await db.patch('expenses', expenseId, (e) => e.photos.push(p));
      toRead.push(p.blob);
    }
  }
  const cur = await db.get('expenses', expenseId);
  const needs = !cur.amount || !cur.title || !cur.dateSet;
  if (!needs) { onStatus(''); return {}; }
  if (!texts.length && toRead.length) {
    onStatus('Lecture automatique du ticket…');
    ocrProgress = (msg) => {
      if (msg.status === 'recognizing text') onStatus(`Lecture automatique du ticket… ${Math.round(msg.progress * 100)} %`);
    };
    try {
      texts.push(await ocr(toRead[0]));
    } finally {
      ocrProgress = () => {};
    }
  }
  const r = readReceipt(texts.join('\n'), missionRange(m));
  const exps = await db.expensesOf(m.id);
  const filled = {};
  await db.patch('expenses', expenseId, (e) => {
    if (!e.amount && r.amount) e.amount = filled.amount = r.amount;
    if (!e.dateSet && r.date) { e.date = filled.date = r.date; e.dateSet = true; }
    if (!e.title && r.category) {
      e.category = r.category; // the Replicon type follows the category unless set by hand
      e.title = filled.title = titleFor(r.category, exps, e.id);
    }
  });
  onStatus(Object.keys(filled).length
    ? `Lu automatiquement : ${[filled.title, filled.date && formatDateFr(filled.date), filled.amount && formatAmount(filled.amount)].filter(Boolean).join(' · ')} — à vérifier`
    : 'Rien de lisible trouvé : complétez à la main');
  return filled;
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** The three documents of a mission, as File objects. */
async function buildDocs(m) {
  const base = missionBase(m);
  const exps = await db.expensesOf(m.id);
  const items = await Promise.all(exps.map(async (e) => ({
    ...e, type: expenseType(e),
    photos: await Promise.all(e.photos.map(async (p) => ({ data: new Uint8Array(await p.blob.arrayBuffer()) }))),
  })));
  const f = m.form;
  const info = [
    ['Participant', f.participant], ['Projet', f.project], ['Mission', f.purpose],
    ['Lieu', [f.place, f.cityCountry || m.city].filter(Boolean).join(', ')],
    ['Dates', [f.startDate || m.departDate, f.endDate].filter(Boolean).map(formatDateFr).join(' – ')],
  ];
  const files = [
    new File([buildJustificatifsPdf({ title: base, info }, items)], `${base}_justificatifs.pdf`, { type: 'application/pdf' }),
    new File([buildRepliconXlsx(
      { title: base, participant: f.participant, project: f.project,
        description: [f.purpose, m.city].filter(Boolean).join(' — ') },
      items.map((e) => ({ date: e.date, description: e.title, type: e.type, billClient: m.billClient ?? 'Yes',
        missionType: repliconMission(m), amount: e.amount })),
    )], `${base}_depenses.xlsx`, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
  ];
  const template = await db.get('settings', 'template');
  if (template) {
    const odt = await fillMissionForm(new Uint8Array(await template.blob.arrayBuffer()), m.form, inflateRaw);
    files.push(new File([odt], `${base}.odt`, { type: 'application/vnd.oasis.opendocument.text' }));
  }
  return files;
}

let docsTimer;
let docsUrls = [];
let docsRun = 0;
/** Rebuild the documents shortly after a change and show download / share buttons. */
function refreshDocs(m, out, delay = 400) {
  clearTimeout(docsTimer);
  docsTimer = setTimeout(async () => {
    const run = ++docsRun;
    out.innerHTML = '<p class="muted">Mise à jour des documents…</p>';
    let files;
    try {
      files = await buildDocs(m);
    } catch (err) {
      if (out.isConnected) out.innerHTML = `<p class="card warn">${h(err.message)}</p>`;
      throw err;
    }
    if (run !== docsRun || !out.isConnected) return;
    docsUrls.forEach((u) => URL.revokeObjectURL(u));
    docsUrls = files.map((f) => URL.createObjectURL(f));
    const shareable = files.filter((f) => navigator.canShare?.({ files: [f] }));
    out.innerHTML = '<p class="muted">✓ Documents à jour</p>' +
      files.map((f, i) => `<a class="btn block" data-dl="${i}" href="${docsUrls[i]}" download="${h(f.name)}">⬇ ${h(f.name)} (${(f.size / 1e6).toFixed(1)} Mo)</a>`).join('') +
      (shareable.length ? `<button class="btn primary block" id="share">Partager ${shareable.length > 1 ? `les ${shareable.length} fichiers` : h(shareable[0].name)}</button>` : '');
    const share = $('#share', out);
    if (share) share.onclick = () => navigator.share({ files: shareable, title: missionBase(m) }).catch((e) => { if (e.name !== 'AbortError') toast(e.message); });
  }, delay);
}

// ---------------------------------------------------------------------------
// Inbox: receipts shared to the app from Gmail, Files… (stored by sw.js)
// ---------------------------------------------------------------------------

async function inboxFiles() {
  if (!('caches' in window)) return [];
  const c = await caches.open(INBOX);
  return Promise.all((await c.keys()).map(async (req) => {
    const res = await c.match(req);
    const blob = await res.blob();
    const name = decodeURIComponent(res.headers.get('x-name') || 'justificatif');
    return { req, file: new File([blob], name, { type: res.headers.get('content-type') || blob.type }) };
  }));
}

/** Mission in progress (started, not ended more than 3 days ago), else the latest. */
function currentMission(missions) {
  const t = today();
  const sorted = [...missions].sort((a, b) => (b.departDate || '').localeCompare(a.departDate || ''));
  return sorted.find((m) => m.departDate <= t && (m.form.endDate || m.departDate) >= shiftDate(t, -3)) || sorted[0];
}
function shiftDate(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function renderInbox() {
  setBar('Justificatifs reçus', true);
  const items = await inboxFiles();
  const missions = (await db.all('missions')).filter((m) => !m.closed);
  if (!items.length) { view.innerHTML = '<p class="muted">Aucun justificatif en attente.</p>'; return; }
  const cur = currentMission(missions);
  view.innerHTML = `
    <div class="card">${items.map(({ file }) => `<div class="row" style="margin:6px 0">
      ${isPdf(file) ? '<span style="font-size:28px">📄</span>' : `<img src="${blobUrl(file)}" alt="" style="width:44px;height:44px;object-fit:cover;border-radius:6px">`}
      <span class="grow">${h(file.name)}</span></div>`).join('')}</div>
    ${missions.length ? `
      <label for="target">Ajouter à la mission</label>
      <select id="target">${missions.map((m) => `<option value="${h(m.id)}" ${m === cur ? 'selected' : ''}>${h(missionBase(m))}</option>`).join('')}</select>
      <button class="btn primary block" id="each">Une dépense par justificatif</button>
      ${items.length > 1 ? '<button class="btn block" id="one">Une seule dépense pour tous</button>' : ''}`
    : '<p class="card warn">Aucune mission en cours : créez-en une (ou rouvrez-en une), puis revenez ici.</p><a class="btn primary block" href="#/">Mes missions</a>'}
    <button class="btn danger block" id="drop">Supprimer ces justificatifs</button>
    <p class="muted" id="status"></p>`;
  const status = (t) => { $('#status').textContent = t; };
  const run = async (grouped) => {
    $$('button', view).forEach((b) => { b.disabled = true; }); // not the header's back / settings
    const missionId = $('#target').value;
    const c = await caches.open(INBOX);
    const groups = grouped ? [items] : items.map((x) => [x]);
    let last;
    for (const [k, g] of groups.entries()) {
      last = await newExpense(missionId);
      await ingest(last.id, g.map((x) => x.file), (t) => status(`${k + 1}/${groups.length} — ${t}`));
      for (const x of g) await c.delete(x.req);
    }
    location.hash = groups.length === 1 ? `#/m/${missionId}/e/${last.id}` : `#/m/${missionId}`;
  };
  if ($('#each')) $('#each').onclick = () => run(false);
  if ($('#one')) $('#one').onclick = () => run(true);
  $('#drop').onclick = async () => {
    if (!confirm('Supprimer ces justificatifs reçus ?')) return;
    const c = await caches.open(INBOX);
    for (const x of items) await c.delete(x.req);
    location.hash = '#/';
  };
}

async function inboxBanner() {
  const n = (await inboxFiles()).length;
  return n ? `<a class="card row warn" href="#/inbox" style="text-decoration:none;color:inherit">
    <span style="font-size:24px">📥</span><span class="grow"><b>${n} justificatif(s) reçu(s)</b><br><span class="muted">à ranger dans une mission</span></span><span>›</span></a>` : '';
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

async function renderHome() {
  setBar('Frais de mission', false);
  const missions = (await db.all('missions')).sort((a, b) => (b.departDate || '').localeCompare(a.departDate || ''));
  const template = await db.get('settings', 'template');
  const row = async (m) => {
    const exps = await db.expensesOf(m.id);
    return `<div class="card list-item row" data-id="${h(m.id)}"><div class="grow">
      <div class="title">${m.closed ? '🔒 ' : ''}${h(missionBase(m))}</div>
      <div class="muted">${exps.length} dépense(s) · ${formatAmount(missionTotal(exps))}</div></div><span>›</span></div>`;
  };
  const open = await Promise.all(missions.filter((m) => !m.closed).map(row));
  const closed = await Promise.all(missions.filter((m) => m.closed).map(row));
  view.innerHTML = `
    ${await inboxBanner()}
    ${template ? '' : `<div class="card warn">Pour générer aussi le <b>Mission Request Form</b> (.odt), importez une fois
      un ancien formulaire dans <a href="#/settings">Profil</a>. Sans lui, le PDF et l’Excel sont quand même produits.</div>`}
    <h2>En cours</h2>
    ${open.join('') || '<p class="muted">Aucune mission en cours. Créez-en une avec le bouton ci-dessous.</p>'}
    ${closed.length ? `<h2>Missions clôturées</h2>${closed.join('')}` : ''}
    <button class="btn primary fab" id="new">＋ Nouvelle mission</button>`;
  $$('.list-item').forEach((el) => { el.onclick = () => { location.hash = `#/m/${el.dataset.id}`; }; });
  $('#new').onclick = async () => {
    const d = await getDefaults();
    const m = { id: uid(), created: Date.now(), lastName: d.lastName, city: '', departDate: today(),
      billClient: 'Yes', form: { ...d.form, startDate: today() } };
    await db.put('missions', m);
    navigator.storage?.persist?.();
    location.hash = `#/m/${m.id}?new`;
  };
}

/** "Spent so far" card: total, today, by category (bars), by day. */
function summaryHtml(exps) {
  const s = spendingSummary(exps, today());
  const max = Math.max(...s.byGroup.map((g) => g[1]), 1);
  const notes = [`Aujourd’hui : ${formatAmount(s.today)}`, `${s.count} dépense(s)`];
  if (s.withoutProof) notes.push(`⚠ ${s.withoutProof} sans justificatif`);
  if (s.withoutAmount) notes.push(`${s.withoutAmount} sans montant`);
  return `<div class="card" id="summary">
    <div class="row"><span class="grow muted">Dépensé jusqu’ici</span><span class="big">${formatAmount(s.total)}</span></div>
    <div class="muted">${notes.join(' · ')}</div>
    ${s.byGroup.map(([g, v]) => `<div class="bar"><span>${h(g)}</span>
      <span class="track"><span style="width:${(100 * v / max).toFixed(1)}%"></span></span><span>${formatAmount(v)}</span></div>`).join('')}
    ${s.byDay.length > 1 ? `<details class="plain"><summary class="muted">Par jour</summary>
      ${s.byDay.map(([d, v]) => `<div class="row"><span class="grow">${formatDateFr(d)}</span><span>${formatAmount(v)}</span></div>`).join('')}</details>` : ''}
  </div>`;
}

function formFieldHtml(f, v) {
  const id = `f_${f.key}`;
  if (f.type === 'choice') {
    return `<label for="${id}">${h(f.label)}</label><select id="${id}" data-key="${f.key}">
      <option value=""></option>${f.options.map((o) => `<option ${o.label === v ? 'selected' : ''}>${h(o.label)}</option>`).join('')}</select>`;
  }
  if (f.type === 'check') {
    return `<label class="check"><input type="checkbox" data-key="${f.key}" ${v ? 'checked' : ''}> ${h(f.label)}</label>`;
  }
  if (f.type === 'textarea') {
    return `<label for="${id}">${h(f.label)}</label><textarea id="${id}" data-key="${f.key}">${h(v)}</textarea>`;
  }
  return `<label for="${id}">${h(f.label)}</label><input id="${id}" data-key="${f.key}" type="${f.type}" value="${h(v)}">`;
}

async function renderMission(id, isNew) {
  const m = await db.get('missions', id);
  if (!m) { location.hash = '#/'; return; }
  const exps = await db.expensesOf(id);
  const ro = Boolean(m.closed);
  setBar(missionBase(m), true);
  view.innerHTML = `
    ${ro ? '' : await inboxBanner()}
    ${ro ? `<div class="card warn">🔒 Mission clôturée le ${new Date(m.closed).toLocaleDateString()} : lecture seule.
      Les documents restent disponibles ci-dessous ; « Rouvrir » en bas de page pour la modifier.</div>` : ''}
    ${summaryHtml(exps)}
    <fieldset class="plain" ${ro ? 'disabled' : ''}><div class="card">
      <div class="pair">
        <div><label for="lastName">Nom</label><input id="lastName" value="${h(m.lastName)}" autocapitalize="characters"></div>
        <div><label for="city">Ville</label><input id="city" value="${h(m.city)}" placeholder="Delft"></div>
      </div>
      <label for="departDate">Date de départ</label><input id="departDate" type="date" value="${h(m.departDate)}">
      <div class="muted" style="margin-top:8px">Fichiers : <b id="base">${h(missionBase(m))}</b></div>
    </div></fieldset>

    <h2>Dépenses</h2>
    ${exps.map((e, i) => `
      <div class="card row">
        <span class="num">(${i + 1})</span>
        <div class="grow list-item" data-id="${h(e.id)}">
          <div class="title">${h(e.title || 'Sans titre')}</div>
          <div class="muted">${[e.date && formatDateFr(e.date), e.amount && formatAmount(e.amount),
            e.photos.length ? `📷 ${e.photos.length}` : '⚠ pas de justificatif'].filter(Boolean).join(' · ')}</div>
        </div>
        ${ro ? '' : `<button class="btn small" data-move="-1" data-id="${h(e.id)}" ${i === 0 ? 'disabled' : ''} aria-label="Monter">↑</button>
        <button class="btn small" data-move="1" data-id="${h(e.id)}" ${i === exps.length - 1 ? 'disabled' : ''} aria-label="Descendre">↓</button>`}
      </div>`).join('') || '<p class="muted">Aucune dépense pour l’instant.</p>'}
    <div class="row"><span class="grow muted">Total</span><span class="total">${formatAmount(missionTotal(exps))}</span></div>

    <h2>Documents</h2>
    <div class="card" id="out"></div>

    <h2>Infos du voyage (Mission Request Form)</h2>
    <fieldset class="plain" ${ro ? 'disabled' : ''}>
    ${FORM_GROUPS.map((g, gi) => `<details ${isNew && gi < 2 ? 'open' : ''}><summary>${h(g.title)}</summary><div>
      ${g.fields.map((f) => formFieldHtml(f, m.form[f.key] ?? '')).join('')}</div></details>`).join('')}
    <details><summary>Replicon</summary><div>
      <label for="rMission">Type of mission</label>
      <input id="rMission" list="rMissionList" value="${h(m.repliconMissionType || '')}" placeholder="${h(REPLICON_MISSION[m.form.missionType] || 'Formation')}">
      <datalist id="rMissionList">${Object.values(REPLICON_MISSION).map((v) => `<option value="${h(v)}">`).join('')}</datalist>
      <label for="billClient">Bill Client</label>
      <select id="billClient">${['Yes', 'No'].map((v) => `<option ${v === (m.billClient ?? 'Yes') ? 'selected' : ''}>${v}</option>`).join('')}</select>
    </div></details>
    </fieldset>

    <h2>Mission</h2>
    ${ro ? '<button class="btn primary block" id="reopen">🔓 Rouvrir la mission</button>'
    : '<button class="btn primary block" id="close">🔒 Clôturer la mission</button>'}
    <button class="btn block" id="duplicate">⧉ Dupliquer (nouvelle mission avec les mêmes infos)</button>
    <button class="btn danger block" id="delMission">Supprimer la mission</button>
    ${ro ? '' : '<button class="btn primary fab" id="addExpense">＋ Dépense</button>'}`;

  const out = $('#out');
  const save = async () => {
    await db.put('missions', m);
    $('#base').textContent = missionBase(m);
    setBar(missionBase(m), true);
    refreshDocs(m, out, 800);
  };
  $('#lastName').onchange = (e) => { m.lastName = e.target.value.trim(); save(); };
  $('#city').onchange = (e) => { m.city = e.target.value.trim(); save(); };
  $('#departDate').onchange = (e) => {
    const old = m.departDate;
    m.departDate = e.target.value;
    if (!m.form.startDate || m.form.startDate === old) { // keep the form's start date in step
      m.form.startDate = m.departDate;
      $('#f_startDate').value = m.departDate;
    }
    save();
  };
  $('#rMission').onchange = (e) => { m.repliconMissionType = e.target.value.trim(); save(); };
  $('#billClient').onchange = (e) => { m.billClient = e.target.value; save(); };
  $$('[data-key]').forEach((el) => {
    el.onchange = () => { m.form[el.dataset.key] = el.type === 'checkbox' ? el.checked : el.value; save(); };
  });
  $$('.list-item').forEach((el) => { el.onclick = () => { location.hash = `#/m/${id}/e/${el.dataset.id}`; }; });
  $$('[data-move]').forEach((el) => {
    el.onclick = async () => {
      const i = exps.findIndex((e) => e.id === el.dataset.id);
      const j = i + Number(el.dataset.move);
      const [pi, pj] = [exps[i].pos, exps[j].pos];
      await db.patch('expenses', exps[i].id, (e) => { e.pos = pj; });
      await db.patch('expenses', exps[j].id, (e) => { e.pos = pi; });
      render();
    };
  });
  if ($('#addExpense')) {
    $('#addExpense').onclick = async () => {
      const e = await newExpense(id);
      location.hash = `#/m/${id}/e/${e.id}`;
    };
  }
  if ($('#close')) {
    $('#close').onclick = async () => {
      if (!confirm(`Clôturer ${missionBase(m)} ? Elle passera en lecture seule ; vous pourrez la rouvrir.`)) return;
      m.closed = Date.now();
      await db.put('missions', m);
      toast('Mission clôturée. Pensez à faire une sauvegarde (Profil).', 5000);
      render(true);
    };
  }
  if ($('#reopen')) {
    $('#reopen').onclick = async () => {
      delete m.closed;
      await db.put('missions', m);
      render();
    };
  }
  $('#duplicate').onclick = async () => {
    const copy = { ...m, id: uid(), created: Date.now(), departDate: today(), form: { ...m.form } };
    delete copy.closed;
    for (const f of FORM_GROUPS.flatMap((g) => g.fields)) if (f.type === 'date') copy.form[f.key] = '';
    copy.form.startDate = copy.departDate;
    await db.put('missions', copy);
    toast('Copie créée sans dépenses : vérifiez les dates', 5000);
    location.hash = `#/m/${copy.id}?new`;
  };
  $('#delMission').onclick = async () => {
    if (!confirm(`Supprimer ${missionBase(m)} et ses ${exps.length} dépense(s) ? Irréversible.`)) return;
    for (const e of exps) await db.del('expenses', e.id);
    await db.del('missions', id);
    location.hash = '#/';
  };
  refreshDocs(m, out, 0);
}

async function renderExpense(missionId, expenseId) {
  const e = await db.get('expenses', expenseId);
  if (!e) { location.hash = `#/m/${missionId}`; return; }
  const exps = await db.expensesOf(missionId);
  const ro = Boolean((await db.get('missions', missionId))?.closed);
  const n = exps.findIndex((x) => x.id === expenseId) + 1;
  setBar(`Dépense (${n})`, true);
  view.innerHTML = `
    ${ro ? '<div class="card warn">🔒 Mission clôturée : lecture seule.</div>' : `
    <h2 style="margin-top:4px">Justificatif</h2>
    <div class="row">
      <label class="btn primary grow" style="margin:0">📷 Photo<input id="cam" type="file" accept="image/*" capture="environment" hidden></label>
      <label class="btn grow" style="margin:0">📄 Fichier / PDF<input id="gal" type="file" accept="image/*,application/pdf,.pdf" multiple hidden></label>
    </div>`}
    <p class="muted" id="status"></p>
    <div class="photos">${e.photos.map((p, i) => `<div class="photo"><img src="${blobUrl(p.blob)}" alt="justificatif ${i + 1}">
      ${ro ? '' : `<button data-del="${i}" aria-label="Supprimer">×</button>
      <button data-rot="${i}" style="top:auto;bottom:4px" aria-label="Pivoter">⟳</button>`}</div>`).join('')}</div>
    <fieldset class="plain" ${ro ? 'disabled' : ''}><div class="card" style="margin-top:12px">
      <label for="title">Intitulé</label><input id="title" value="${h(e.title)}" placeholder="Repas midi 1">
      <div class="chips">${CATEGORIES.map((c) => `<button class="chip" data-chip="${h(c)}">${h(c)}</button>`).join('')}</div>
      <div class="pair">
        <div><label for="date">Date</label><input id="date" type="date" value="${h(e.date)}"></div>
        <div><label for="amount">Montant (€)</label><input id="amount" inputmode="decimal" value="${h(e.amount ? e.amount.replace('.', ',') : '')}" placeholder="0,00"></div>
      </div>
      <label for="type">Type Replicon</label>
      <input id="type" list="typeList" value="${h(e.type)}" placeholder="${h(expenseType(e))}">
      <datalist id="typeList">${REPLICON_TYPES.map((t) => `<option value="${h(t)}">`).join('')}</datalist>
      <label for="note">Remarque (optionnel)</label><input id="note" value="${h(e.note)}" placeholder="pas de ticket papier…">
    </div></fieldset>
    <button class="btn primary block" id="done">OK</button>
    ${ro ? '' : '<button class="btn danger block" id="delExpense">Supprimer la dépense</button>'}`;

  const patch = (fn) => db.patch('expenses', expenseId, fn);
  $('#title').onchange = (ev) => {
    const t = ev.target.value.trim();
    patch((x) => { x.title = t; x.category = categoryOfTitle(t); });
  };
  $('#date').onchange = (ev) => { const v = ev.target.value; patch((x) => { x.date = v; x.dateSet = true; }); };
  $('#note').onchange = (ev) => { const v = ev.target.value.trim(); patch((x) => { x.note = v; }); };
  $('#type').onchange = (ev) => { const v = ev.target.value.trim(); patch((x) => { x.type = v; }); };
  $('#amount').onchange = (ev) => {
    const a = parseAmount(ev.target.value);
    ev.target.classList.toggle('warn', a === null);
    if (a === null) { toast('Montant invalide (ex. 12,50)'); return; }
    patch((x) => { x.amount = a; });
  };
  $$('[data-chip]').forEach((el) => {
    el.onclick = async () => {
      const c = el.dataset.chip;
      const t = titleFor(c, exps, expenseId);
      $('#title').value = t;
      $('#type').placeholder = repliconType(c);
      await patch((x) => { x.title = t; x.category = c; });
    };
  });
  const status = (t) => { const s = $('#status'); if (s) s.textContent = t; };
  const addFiles = async (files) => {
    if (!files.length) return;
    $$('#cam, #gal').forEach((i) => { i.disabled = true; });
    try {
      const filled = await ingest(expenseId, files, status);
      if (location.hash.endsWith(`/e/${expenseId}`)) {
        const msg = $('#status')?.textContent;
        await render(); // shows the new photos and the fields read from the receipt
        status(msg);
        if (Object.keys(filled).length) toast('Vérifiez les champs remplis automatiquement');
      }
    } finally {
      $$('#cam, #gal').forEach((i) => { i.disabled = false; });
    }
  };
  $('#done').onclick = () => history.back();
  if (ro) return;
  $('#cam').onchange = (ev) => addFiles([...ev.target.files]);
  $('#gal').onchange = (ev) => addFiles([...ev.target.files]);
  $$('[data-del]').forEach((el) => {
    el.onclick = async () => {
      if (!confirm('Supprimer ce justificatif ?')) return;
      await patch((x) => x.photos.splice(Number(el.dataset.del), 1));
      render();
    };
  });
  $$('[data-rot]').forEach((el) => {
    el.onclick = async () => {
      const i = Number(el.dataset.rot);
      const p = await rotatePhoto(e.photos[i]);
      await patch((x) => { x.photos[i] = p; });
      render();
    };
  });
  $('#delExpense').onclick = async () => {
    if (!confirm(`Supprimer la dépense (${n}) ?`)) return;
    await db.del('expenses', expenseId);
    history.back();
  };
}

/** Drop an expense left completely empty (opened with "+ Dépense" then abandoned). */
async function pruneEmpty(expenseId) {
  const e = await db.get('expenses', expenseId);
  if (e && !e.title && !e.amount && !e.note && !e.photos.length) await db.del('expenses', expenseId);
}

/** Everything on the phone, as a backup file (see backup.js). */
async function makeBackup() {
  const missions = await db.all('missions');
  const expenses = await Promise.all((await db.all('expenses')).map(async (e) => ({
    ...e, photos: await Promise.all(e.photos.map(async (p) => ({ data: new Uint8Array(await p.blob.arrayBuffer()), w: p.w, h: p.h }))),
  })));
  const t = await db.get('settings', 'template');
  const template = t ? { name: t.name, importedAt: t.importedAt, data: new Uint8Array(await t.blob.arrayBuffer()) } : null;
  const zip = packBackup({ missions, expenses, defaults: await db.get('settings', 'defaults'), template });
  return { file: new File([zip], `frais-sauvegarde-${today()}.zip`, { type: 'application/zip' }), missions: missions.length, expenses: expenses.length };
}

/** Restore a backup file: its missions replace those with the same id, others are kept. */
async function restoreBackup(file) {
  const b = await unpackBackup(new Uint8Array(await file.arrayBuffer()), inflateRaw);
  const existing = new Set((await db.all('missions')).map((m) => m.id));
  const replaced = b.missions.filter((m) => existing.has(m.id)).length;
  if (!confirm(`Sauvegarde du ${new Date(b.exported).toLocaleString()} : ${b.missions.length} mission(s), ${b.expenses.length} dépense(s).`
    + (replaced ? `\n${replaced} mission(s) déjà présente(s) seront remplacées par la version sauvegardée.` : '')
    + '\nLes autres missions du téléphone sont conservées. Restaurer ?')) return false;
  for (const m of b.missions) {
    if (existing.has(m.id)) for (const e of await db.expensesOf(m.id)) await db.del('expenses', e.id);
    await db.put('missions', m);
  }
  for (const e of b.expenses) {
    await db.put('expenses', { ...e, photos: e.photos.map((p) => ({ blob: new Blob([p.data], { type: 'image/jpeg' }), w: p.w, h: p.h })) });
  }
  if (b.defaults && !(await db.get('settings', 'defaults'))) await db.put('settings', b.defaults, 'defaults');
  if (b.template && !(await db.get('settings', 'template'))) {
    await db.put('settings', { blob: new Blob([b.template.data], { type: 'application/vnd.oasis.opendocument.text' }),
      name: b.template.name, importedAt: b.template.importedAt }, 'template');
  }
  return true;
}

async function renderSettings() {
  setBar('Profil', true);
  const d = await getDefaults();
  const template = await db.get('settings', 'template');
  const lastBackup = await db.get('settings', 'lastBackup');
  const defFields = FORM_GROUPS.flatMap((g) => g.fields).filter((f) => PERSISTENT_KEYS.includes(f.key));
  view.innerHTML = `
    ${await inboxBanner()}
    <div class="card">
      <label for="dLast">Nom de famille (pour le nom des fichiers)</label>
      <input id="dLast" value="${h(d.lastName)}" autocapitalize="characters" placeholder="TAGUEMA">
    </div>
    <h2>Modèle du Mission Request Form</h2>
    <div class="card">
      <div class="muted">${template ? `Importé : <b>${h(template.name)}</b> (${new Date(template.importedAt).toLocaleDateString()})`
        : 'Aucun modèle. Importez un ancien formulaire rempli (.odt) : ses champs seront réécrits pour chaque mission.'}</div>
      <label class="btn block">Importer un formulaire .odt<input id="tpl" type="file" accept=".odt,application/vnd.oasis.opendocument.text" hidden></label>
    </div>
    <h2>Valeurs par défaut des nouvelles missions</h2>
    <div class="card">${defFields.map((f) => formFieldHtml(f, d.form[f.key] ?? '')).join('')}</div>
    <h2>Sauvegarde</h2>
    <div class="card">
      <div class="muted">Vos missions ne sont que sur ce téléphone. Une sauvegarde (fichier .zip, à garder sur le PC ou Drive)
        permet de les retrouver sur un nouveau téléphone ou après une réinstallation.<br>
        Dernière sauvegarde : <b>${lastBackup ? new Date(lastBackup).toLocaleDateString() : 'jamais'}</b></div>
      <button class="btn primary block" id="backup">💾 Sauvegarder mes missions</button>
      <div id="backupOut"></div>
      <label class="btn block">Restaurer une sauvegarde<input id="restore" type="file" accept=".zip,application/zip" hidden></label>
    </div>
    <h2>Lecture automatique hors ligne</h2>
    <div class="card"><div class="muted" id="offline">Vérification…</div></div>
    <p class="muted" id="storage">Données stockées uniquement sur ce téléphone.</p>`;

  $('#backup').onclick = async () => {
    $('#backup').disabled = true;
    try {
      const { file, missions, expenses } = await makeBackup();
      await db.put('settings', Date.now(), 'lastBackup');
      const url = blobUrl(file);
      $('#backupOut').innerHTML = `<p class="muted">${missions} mission(s), ${expenses} dépense(s), ${(file.size / 1e6).toFixed(1)} Mo :</p>
        <a class="btn block" id="backupLink" href="${url}" download="${h(file.name)}">⬇ ${h(file.name)}</a>`
        + (navigator.canShare?.({ files: [file] }) ? '<button class="btn block" id="backupShare">Partager (Drive, mail…)</button>' : '');
      if ($('#backupShare')) $('#backupShare').onclick = () => navigator.share({ files: [file] }).catch((e) => { if (e.name !== 'AbortError') toast(e.message); });
    } finally {
      $('#backup').disabled = false;
    }
  };
  $('#restore').onchange = async (ev) => {
    const f = ev.target.files[0];
    if (!f) return;
    if (await restoreBackup(f)) { toast('Sauvegarde restaurée'); location.hash = '#/'; }
  };

  navigator.storage?.persisted?.().then((ok) => { if (ok) $('#storage').textContent += ' Stockage persistant accordé.'; });
  caches.open('frais-mission').then((c) => c.match('vendor/tesseract/lang/fra.traineddata.gz', { ignoreSearch: true }))
    .then((hit) => { const el = $('#offline'); if (el) el.textContent = hit ? '✓ Prête : photos et PDF sont lus sans internet.' : 'Pas encore téléchargée : ouvrez l’appli une fois avec internet (Wi-Fi conseillé, ~7 Mo).'; })
    .catch(() => {});
  const save = () => db.put('settings', d, 'defaults');
  $('#dLast').onchange = (ev) => { d.lastName = ev.target.value.trim(); save(); };
  $$('[data-key]').forEach((el) => {
    el.onchange = () => { d.form[el.dataset.key] = el.type === 'checkbox' ? el.checked : el.value; save(); };
  });
  $('#tpl').onchange = async (ev) => {
    const f = ev.target.files[0];
    if (!f) return;
    const { problems, values } = await inspectTemplate(new Uint8Array(await f.arrayBuffer()), inflateRaw);
    if (problems.length) {
      toast(`Ce fichier n’est pas le formulaire attendu : ${problems.slice(0, 3).join('; ')}`, 8000);
      return;
    }
    await db.put('settings', { blob: f, name: f.name, importedAt: Date.now() }, 'template');
    for (const k of PERSISTENT_KEYS) if (values[k] && !d.form[k]) d.form[k] = values[k];
    if (!d.lastName && values.participant) d.lastName = values.participant.trim().split(/\s+/).pop();
    await save();
    toast('Modèle importé');
    render();
  };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

let lastExpense = null;
async function render(scrollTop = false) {
  objectUrls.forEach((u) => URL.revokeObjectURL(u));
  objectUrls = [];
  const [path, query] = location.hash.slice(1).split('?');
  const p = (path || '/').split('/').filter(Boolean);
  if (lastExpense && !(p[0] === 'm' && p[2] === 'e' && p[3] === lastExpense)) {
    await pruneEmpty(lastExpense);
    lastExpense = null;
  }
  if (scrollTop) window.scrollTo(0, 0);
  if (p[0] === 'm' && p[2] === 'e') { lastExpense = p[3]; return renderExpense(p[1], p[3]); }
  if (p[0] === 'm') return renderMission(p[1], query === 'new');
  if (p[0] === 'settings') return renderSettings();
  if (p[0] === 'inbox') return renderInbox();
  return renderHome();
}
window.addEventListener('hashchange', () => render(true));
render();

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
