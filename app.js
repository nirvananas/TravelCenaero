import { fileBase, fillMissionForm, inspectTemplate, FORM_GROUPS, PERSISTENT_KEYS } from './odt.js';
import { buildJustificatifsPdf, formatAmount, formatDateFr } from './pdf.js';

const MAX_PX = 2000; // longest side of a stored photo
const JPEG_QUALITY = 0.85;
const CHIPS = ['Train', 'Métro', 'Bus', 'Taxi', 'Repas midi', 'Repas soir', 'Petit-déjeuner',
  'Hôtel', 'Taxe de séjour', 'Parking', 'Carburant', 'Péage', 'Inscription'];
const NUMBERED_CHIPS = ['Repas midi', 'Repas soir', 'Petit-déjeuner'];

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
};

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
const today = () => new Date().toLocaleDateString('sv'); // YYYY-MM-DD in local time
const missionBase = (m) => fileBase({ lastName: m.lastName, city: m.city, startDate: m.departDate });
const getDefaults = async () => (await db.get('settings', 'defaults')) || { lastName: '', form: {} };

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

// ---------------------------------------------------------------------------
// Photos: decode (EXIF orientation applied), downscale, re-encode as JPEG
// ---------------------------------------------------------------------------

async function canvasToJpeg(c) {
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', JPEG_QUALITY));
  if (!blob) throw new Error('Could not encode the photo as JPEG');
  return { blob, w: c.width, h: c.height };
}

async function photoFromFile(file) {
  let bmp;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch (err) {
    throw new Error(`Impossible de lire « ${file.name} » (${file.type || 'type inconnu'}) : ${err.message}`);
  }
  const s = Math.min(1, MAX_PX / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * s);
  c.height = Math.round(bmp.height * s);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; // transparent PNG screenshots -> white background
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  return canvasToJpeg(c);
}

async function rotatePhoto(p) {
  const bmp = await createImageBitmap(p.blob);
  const c = document.createElement('canvas');
  c.width = bmp.height;
  c.height = bmp.width;
  const ctx = c.getContext('2d');
  ctx.translate(c.width, 0);
  ctx.rotate(Math.PI / 2);
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  return canvasToJpeg(c);
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

async function renderHome() {
  setBar('Frais de mission', false);
  const missions = (await db.all('missions')).sort((a, b) => (b.departDate || '').localeCompare(a.departDate || ''));
  const template = await db.get('settings', 'template');
  const rows = await Promise.all(missions.map(async (m) => {
    const exps = await db.expensesOf(m.id);
    return `<div class="card list-item row" data-id="${h(m.id)}"><div class="grow">
      <div class="title">${h(missionBase(m))}</div>
      <div class="muted">${exps.length} dépense(s) · ${formatAmount(missionTotal(exps))}</div></div><span>›</span></div>`;
  }));
  view.innerHTML = `
    ${template ? '' : `<div class="card warn">Pour générer aussi le <b>Mission Request Form</b> (.odt), importez une fois
      un ancien formulaire dans <a href="#/settings">Réglages</a>. Sans lui, seul le PDF des justificatifs est produit.</div>`}
    ${rows.join('') || '<p class="muted">Aucune mission. Créez-en une avec le bouton ci-dessous.</p>'}
    <button class="btn primary fab" id="new">＋ Nouvelle mission</button>`;
  $$('.list-item').forEach((el) => { el.onclick = () => { location.hash = `#/m/${el.dataset.id}`; }; });
  $('#new').onclick = async () => {
    const d = await getDefaults();
    const m = { id: uid(), created: Date.now(), lastName: d.lastName, city: '', departDate: today(),
      form: { ...d.form, startDate: today() } };
    await db.put('missions', m);
    navigator.storage?.persist?.();
    location.hash = `#/m/${m.id}?new`;
  };
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
  const template = await db.get('settings', 'template');
  setBar(missionBase(m), true);
  view.innerHTML = `
    <div class="card">
      <div class="pair">
        <div><label for="lastName">Nom</label><input id="lastName" value="${h(m.lastName)}" autocapitalize="characters"></div>
        <div><label for="city">Ville</label><input id="city" value="${h(m.city)}" placeholder="Delft"></div>
      </div>
      <label for="departDate">Date de départ</label><input id="departDate" type="date" value="${h(m.departDate)}">
      <div class="muted" style="margin-top:8px">Fichiers : <b id="base">${h(missionBase(m))}</b></div>
    </div>

    <h2>Dépenses</h2>
    ${exps.map((e, i) => `
      <div class="card row">
        <span class="num">(${i + 1})</span>
        <div class="grow list-item" data-id="${h(e.id)}">
          <div class="title">${h(e.title || 'Sans titre')}</div>
          <div class="muted">${[e.date && formatDateFr(e.date), e.amount && formatAmount(e.amount),
            e.photos.length ? `📷 ${e.photos.length}` : '⚠ pas de photo'].filter(Boolean).join(' · ')}</div>
        </div>
        <button class="btn small" data-move="-1" data-id="${h(e.id)}" ${i === 0 ? 'disabled' : ''} aria-label="Monter">↑</button>
        <button class="btn small" data-move="1" data-id="${h(e.id)}" ${i === exps.length - 1 ? 'disabled' : ''} aria-label="Descendre">↓</button>
      </div>`).join('') || '<p class="muted">Aucune dépense pour l’instant.</p>'}
    <div class="row"><span class="grow muted">Total</span><span class="total">${formatAmount(missionTotal(exps))}</span></div>

    <h2>Documents</h2>
    <div class="card">
      <div class="muted">${h(missionBase(m))}_justificatifs.pdf${template ? `<br>${h(missionBase(m))}.odt (Mission Request Form)` : '<br>(pas de modèle de formulaire importé)'}</div>
      <button class="btn primary block" id="generate">Générer les documents</button>
      <div id="out"></div>
    </div>

    <h2>Mission Request Form</h2>
    ${FORM_GROUPS.map((g, gi) => `<details ${isNew && gi < 2 ? 'open' : ''}><summary>${h(g.title)}</summary><div>
      ${g.fields.map((f) => formFieldHtml(f, m.form[f.key] ?? '')).join('')}</div></details>`).join('')}

    <button class="btn danger block" id="delMission">Supprimer la mission</button>
    <button class="btn primary fab" id="addExpense">＋ Dépense</button>`;

  const save = async () => { await db.put('missions', m); $('#base').textContent = missionBase(m); setBar(missionBase(m), true); };
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
  $$('[data-key]').forEach((el) => {
    el.onchange = () => { m.form[el.dataset.key] = el.type === 'checkbox' ? el.checked : el.value; save(); };
  });
  $$('.list-item').forEach((el) => { el.onclick = () => { location.hash = `#/m/${id}/e/${el.dataset.id}`; }; });
  $$('[data-move]').forEach((el) => {
    el.onclick = async () => {
      const i = exps.findIndex((e) => e.id === el.dataset.id);
      const j = i + Number(el.dataset.move);
      [exps[i].pos, exps[j].pos] = [exps[j].pos, exps[i].pos];
      await db.put('expenses', exps[i]);
      await db.put('expenses', exps[j]);
      render();
    };
  });
  $('#addExpense').onclick = async () => {
    const e = { id: uid(), missionId: id, pos: exps.length ? exps[exps.length - 1].pos + 1 : 0,
      title: '', date: today(), amount: '', note: '', photos: [] };
    await db.put('expenses', e);
    navigator.storage?.persist?.();
    location.hash = `#/m/${id}/e/${e.id}`;
  };
  $('#delMission').onclick = async () => {
    if (!confirm(`Supprimer ${missionBase(m)} et ses ${exps.length} dépense(s) ? Irréversible.`)) return;
    for (const e of exps) await db.del('expenses', e.id);
    await db.del('missions', id);
    location.hash = '#/';
  };
  $('#generate').onclick = () => generate(m, $('#out'));
}

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function generate(m, out) {
  const btn = $('#generate');
  btn.disabled = true;
  out.innerHTML = '<p class="muted">Génération…</p>';
  try {
    const base = missionBase(m);
    const exps = await db.expensesOf(m.id);
    const items = await Promise.all(exps.map(async (e) => ({
      ...e, photos: await Promise.all(e.photos.map(async (p) => ({ data: new Uint8Array(await p.blob.arrayBuffer()) }))),
    })));
    const files = [new File([buildJustificatifsPdf({ title: base }, items)], `${base}_justificatifs.pdf`, { type: 'application/pdf' })];
    const template = await db.get('settings', 'template');
    if (template) {
      const odt = await fillMissionForm(new Uint8Array(await template.blob.arrayBuffer()), m.form, inflateRaw);
      files.push(new File([odt], `${base}.odt`, { type: 'application/vnd.oasis.opendocument.text' }));
    }
    const shareable = files.filter((f) => navigator.canShare?.({ files: [f] }));
    out.innerHTML = files.map((f, i) => `<a class="btn block" data-dl="${i}" href="${blobUrl(f)}" download="${h(f.name)}">⬇ ${h(f.name)} (${(f.size / 1e6).toFixed(1)} Mo)</a>`).join('') +
      (shareable.length ? `<button class="btn primary block" id="share">Partager ${shareable.length > 1 ? 'les fichiers' : h(shareable[0].name)}</button>` : '');
    const share = $('#share');
    if (share) share.onclick = () => navigator.share({ files: shareable, title: base }).catch((e) => { if (e.name !== 'AbortError') toast(e.message); });
  } catch (err) {
    out.innerHTML = `<p class="warn card">${h(err.message)}</p>`;
    throw err;
  } finally {
    btn.disabled = false;
  }
}

async function renderExpense(missionId, expenseId) {
  const e = await db.get('expenses', expenseId);
  if (!e) { location.hash = `#/m/${missionId}`; return; }
  const exps = await db.expensesOf(missionId);
  const n = exps.findIndex((x) => x.id === expenseId) + 1;
  setBar(`Dépense (${n})`, true);
  view.innerHTML = `
    <div class="card">
      <label for="title">Intitulé</label><input id="title" value="${h(e.title)}" placeholder="Repas midi 1">
      <div class="chips">${CHIPS.map((c) => `<button class="chip" data-chip="${h(c)}">${h(c)}</button>`).join('')}</div>
      <div class="pair">
        <div><label for="date">Date</label><input id="date" type="date" value="${h(e.date)}"></div>
        <div><label for="amount">Montant (€)</label><input id="amount" inputmode="decimal" value="${h(e.amount ? e.amount.replace('.', ',') : '')}" placeholder="0,00"></div>
      </div>
      <label for="note">Remarque (optionnel)</label><input id="note" value="${h(e.note)}" placeholder="pas de ticket papier…">
    </div>
    <h2>Justificatifs</h2>
    <div class="row">
      <label class="btn primary grow" style="margin:0">📷 Photo<input id="cam" type="file" accept="image/*" capture="environment" hidden></label>
      <label class="btn grow" style="margin:0">🖼 Galerie<input id="gal" type="file" accept="image/*" multiple hidden></label>
    </div>
    <div class="photos">${e.photos.map((p, i) => `<div class="photo"><img src="${blobUrl(p.blob)}" alt="justificatif ${i + 1}">
      <button data-del="${i}" aria-label="Supprimer">×</button>
      <button data-rot="${i}" style="top:auto;bottom:4px" aria-label="Pivoter">⟳</button></div>`).join('')}</div>
    <button class="btn primary block" id="done">OK</button>
    <button class="btn danger block" id="delExpense">Supprimer la dépense</button>`;

  const save = () => db.put('expenses', e);
  $('#title').onchange = (ev) => { e.title = ev.target.value.trim(); save(); };
  $('#date').onchange = (ev) => { e.date = ev.target.value; save(); };
  $('#note').onchange = (ev) => { e.note = ev.target.value.trim(); save(); };
  $('#amount').onchange = (ev) => {
    const a = parseAmount(ev.target.value);
    ev.target.classList.toggle('warn', a === null);
    if (a === null) { toast('Montant invalide (ex. 12,50)'); return; }
    e.amount = a;
    save();
  };
  $$('[data-chip]').forEach((el) => {
    el.onclick = async () => {
      let t = el.dataset.chip;
      if (NUMBERED_CHIPS.includes(t)) {
        const k = exps.filter((x) => x.id !== e.id && (x.title || '').toLowerCase().startsWith(t.toLowerCase())).length;
        t = `${t} ${k + 1}`;
      }
      e.title = t;
      $('#title').value = t;
      await save();
    };
  });
  const addFiles = async (files) => {
    for (const f of files) e.photos.push(await photoFromFile(f));
    await save();
    render();
  };
  $('#cam').onchange = (ev) => addFiles([...ev.target.files]);
  $('#gal').onchange = (ev) => addFiles([...ev.target.files]);
  $$('[data-del]').forEach((el) => {
    el.onclick = async () => {
      if (!confirm('Supprimer cette photo ?')) return;
      e.photos.splice(Number(el.dataset.del), 1);
      await save();
      render();
    };
  });
  $$('[data-rot]').forEach((el) => {
    el.onclick = async () => {
      const i = Number(el.dataset.rot);
      e.photos[i] = await rotatePhoto(e.photos[i]);
      await save();
      render();
    };
  });
  $('#done').onclick = () => history.back();
  $('#delExpense').onclick = async () => {
    if (!confirm(`Supprimer la dépense (${n}) ?`)) return;
    await db.del('expenses', e.id);
    history.back();
  };
}

/** Drop an expense left completely empty (opened with "+ Dépense" then abandoned). */
async function pruneEmpty(expenseId) {
  const e = await db.get('expenses', expenseId);
  if (e && !e.title && !e.amount && !e.note && !e.photos.length) await db.del('expenses', expenseId);
}

async function renderSettings() {
  setBar('Réglages', true);
  const d = await getDefaults();
  const template = await db.get('settings', 'template');
  const defFields = FORM_GROUPS.flatMap((g) => g.fields).filter((f) => PERSISTENT_KEYS.includes(f.key));
  view.innerHTML = `
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
    <p class="muted" id="storage">Données stockées uniquement sur ce téléphone.</p>`;
  navigator.storage?.persisted?.().then((ok) => { if (ok) $('#storage').textContent += ' Stockage persistant accordé.'; });

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
  return renderHome();
}
window.addEventListener('hashchange', () => render(true));
render();

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
