// Pure document logic, no DOM: shared by the app (browser) and the tests (Node).
// ZIP read/write, file naming, and filling the Cenaero Mission Request Form (.odt).
// An .odt file is a ZIP archive; we write it uncompressed ("stored"), which every
// ODF reader accepts and which keeps this file dependency-free.

// ---------------------------------------------------------------------------
// ZIP
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const enc = new TextEncoder();
const dec = new TextDecoder();
export const utf8 = (s) => enc.encode(s);
export const fromUtf8 = (b) => dec.decode(b);

/** entries: [{name, data: Uint8Array}] -> Uint8Array (ZIP, method 0 = stored). */
export function zipStore(entries, now = new Date()) {
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = utf8(name);
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true); // version needed
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, 0, true); // stored
    local.setUint16(10, dosTime, true);
    local.setUint16(12, dosDate, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);
    locals.push(new Uint8Array(local.buffer), nameBytes, data);

    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true);
    cen.setUint16(4, 20, true);
    cen.setUint16(6, 20, true);
    cen.setUint16(8, 0x0800, true);
    cen.setUint16(10, 0, true);
    cen.setUint16(12, dosTime, true);
    cen.setUint16(14, dosDate, true);
    cen.setUint32(16, crc, true);
    cen.setUint32(20, data.length, true);
    cen.setUint32(24, data.length, true);
    cen.setUint16(28, nameBytes.length, true);
    cen.setUint32(42, offset, true);
    centrals.push(new Uint8Array(cen.buffer), nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const cdSize = centrals.reduce((s, b) => s + b.length, 0);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, entries.length, true);
  eocd.setUint16(10, entries.length, true);
  eocd.setUint32(12, cdSize, true);
  eocd.setUint32(16, offset, true);
  return concat([...locals, ...centrals, new Uint8Array(eocd.buffer)]);
}

/**
 * Read a ZIP archive. inflateRaw(Uint8Array) -> Promise<Uint8Array> decodes method 8
 * (injected: DecompressionStream in the browser, zlib in Node).
 * Returns [{name, data}] in archive order.
 */
export async function unzip(bytes, inflateRaw) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a ZIP/ODT file: end-of-central-directory record not found');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = [];
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error(`Corrupt ZIP: bad central header at ${p}`);
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true);
    const xlen = dv.getUint16(p + 30, true);
    const clen = dv.getUint16(p + 32, true);
    const lho = dv.getUint32(p + 42, true);
    const name = fromUtf8(bytes.subarray(p + 46, p + 46 + nlen));
    const start = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true);
    const raw = bytes.subarray(start, start + csize);
    let data;
    if (method === 0) data = raw.slice();
    else if (method === 8) data = await inflateRaw(raw);
    else throw new Error(`Unsupported ZIP compression method ${method} for ${name}`);
    out.push({ name, data });
    p += 46 + nlen + xlen + clen;
  }
  return out;
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((s, b) => s + b.length, 0));
  let o = 0;
  for (const b of parts) { out.set(b, o); o += b.length; }
  return out;
}

// ---------------------------------------------------------------------------
// XML helpers
// ---------------------------------------------------------------------------

export const escXml = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const escAttr = (s) =>
  escXml(s).replace(/"/g, '&quot;').replace(/\r?\n/g, '&#x0a;').replace(/\t/g, '&#x09;');
export const unescXml = (s) =>
  s.replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// ---------------------------------------------------------------------------
// File naming: LASTNAME_CITY_DD_MM_YYYY  (e.g. TAGUEMA_DELFT_19_05_2026)
// ---------------------------------------------------------------------------

const slug = (s) =>
  String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase().trim().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');

export function fileBase({ lastName, city, startDate }) {
  const [y, m, d] = (startDate || '').split('-');
  const parts = [slug(lastName) || 'NOM', slug(city) || 'VILLE'];
  parts.push(y && m && d ? `${d}_${m}_${y}` : 'DATE');
  return parts.join('_');
}

// ---------------------------------------------------------------------------
// Cenaero Mission Request Form (SUPBPM-F-003-06): fill the form controls of a
// template .odt that the user imports once (any earlier filled-in form works).
// Controls are addressed by xml:id; the expected form:name is checked so that a
// different template version fails loudly instead of filling the wrong boxes.
// ---------------------------------------------------------------------------

export const FORM_VERSION = 'SUPBPM-F-003-06';

const T = (id, name, key, label, type = 'text') => ({ id, name, key, label, type });

export const FORM_GROUPS = [
  { title: 'Participant', fields: [
    T('control1', 'Text Box 1', 'participant', "Participant's name"),
    { key: 'missionType', label: 'Mission type', type: 'choice', name: 'Option Button 1', options: [
      { id: 'control59', label: 'Training' },
      { id: 'control57', label: 'Conference' },
      { id: 'control58', label: 'Meeting/Fair/Misc.' },
    ] },
    T('control2', 'Text Box 2', 'project', 'Project to be charged'),
  ] },
  { title: 'Mission description', fields: [
    T('control3', 'Text Box purpose', 'purpose', 'Purpose'),
    T('control4', 'Text Box Place', 'place', 'Place'),
    T('control5', 'Text Box City', 'cityCountry', 'City & country'),
    T('control7', 'Date Field startEvent', 'startDate', 'Start date', 'date'),
    T('control8', 'Time Field startEvent', 'startTime', 'Start time', 'time'),
    T('control9', 'Date Field endEvent', 'endDate', 'End date', 'date'),
    T('control10', 'Time Field endEvent', 'endTime', 'End time', 'time'),
    T('control11', 'Text Box commentEvent', 'eventComments', 'Comments', 'textarea'),
  ] },
  { title: 'Flights', fields: [
    T('control12', 'Date Field leavingFlights', 'flightOutDate', 'Leaving date', 'date'),
    T('control13', 'Time Field leavingFlights', 'flightOutTime', 'Leaving time', 'time'),
    T('control14', 'Text Box fromFlights', 'flightOutFrom', 'From'),
    T('control15', 'Text Box toFlights', 'flightOutTo', 'To'),
    T('control16', 'Text Box flnbLeavingFlights', 'flightOutNb', 'Airline / flight number'),
    T('control17', 'Date Field returningFlights', 'flightBackDate', 'Returning date', 'date'),
    T('control18', 'Time Field returningFlights', 'flightBackTime', 'Returning time', 'time'),
    T('control19', 'Text Box returningFromFlights', 'flightBackFrom', 'From'),
    T('control20', 'Text Box returningToFlights', 'flightBackTo', 'To'),
    T('control21', 'Text Box returnNbFlights', 'flightBackNb', 'Airline / flight number'),
    T('control22', 'Text Box priceFlights', 'flightPrice', 'Price'),
    T('control23', 'Text Box websiteFlights', 'flightWebsite', 'On the website'),
    T('control24', 'Text Box commentFlights', 'flightComments', 'Comments', 'textarea'),
    T('control62', 'Text Box commentFlights', 'flightMotivation', 'Motivation of your choice', 'textarea'),
  ] },
  { title: 'Trains', fields: [
    T('control25', 'Date Field leavingTrains', 'trainOutDate', 'Leaving date', 'date'),
    T('control26', 'Time Field leavingTrains', 'trainOutTime', 'Leaving time', 'time'),
    T('control27', 'Text Box leavingFromTrains', 'trainOutFrom', 'From'),
    T('control28', 'Text Box leavingToTrains', 'trainOutTo', 'To'),
    T('control29', 'Date Field returningTrains', 'trainBackDate', 'Returning date', 'date'),
    T('control30', 'Time Field returningTrains', 'trainBackTime', 'Returning time', 'time'),
    T('control31', 'Text Box returningFromTrains', 'trainBackFrom', 'From'),
    T('control32', 'Text Box returningToTrains', 'trainBackTo', 'To'),
    T('control33', 'Text Box priceTrains', 'trainPrice', 'Price'),
    T('control34', 'Text Box websiteTrains', 'trainWebsite', 'On the website'),
    T('control35', 'Text Box commentsTrains', 'trainComments', 'Comments', 'textarea'),
    T('control63', 'Text Box commentsTrains', 'trainMotivation', 'Motivation of your choice', 'textarea'),
  ] },
  { title: 'Rental car', fields: [
    T('control36', 'Date Field pickUpRental', 'carPickDate', 'Pick-up date', 'date'),
    T('control37', 'Time Field pickUpRental', 'carPickTime', 'Pick-up time', 'time'),
    T('control38', 'Text Box fromPickUp', 'carPickFrom', 'From'),
    T('control39', 'Date Field returnPickUp', 'carReturnDate', 'Return date', 'date'),
    T('control40', 'Time Field returnPickUp', 'carReturnTime', 'Return time', 'time'),
    T('control41', 'Text Box atPickUp', 'carReturnAt', 'At'),
    T('control42', 'Text Box pricePickUp', 'carPrice', 'Price'),
    T('control43', 'Text Box websitePickUp', 'carWebsite', 'On the website'),
    T('control44', 'Text Box commentPickUp', 'carComments', 'Comments', 'textarea'),
    T('control61', 'Text Box commentPickUp', 'carMotivation', 'Motivation of your choice', 'textarea'),
  ] },
  { title: 'Hotel', fields: [
    T('control45', 'Text Box nameHotel', 'hotelName', 'Name'),
    T('control46', 'Date Field ckeckInHotel', 'hotelIn', 'Check-in date', 'date'),
    T('control47', 'Time Field checkInHotel', 'hotelInTime', 'Late check-in time', 'time'),
    T('control48', 'Date Field ckeckOutHotel', 'hotelOut', 'Check-out date', 'date'),
    T('control49', 'Text Box priceHotel', 'hotelPrice', 'Price'),
    T('control50', 'Text Box websiteHotel', 'hotelWebsite', 'On the website'),
    T('control51', 'Text Box commentHotel', 'hotelComments', 'Comments', 'textarea'),
    T('control60', 'Text Box commentHotel', 'hotelMotivation', 'Motivation of your choice', 'textarea'),
  ] },
  { title: 'Registration', fields: [
    T('control52', 'Option Button yesRegistration', 'registration', 'Registration: yes', 'check'),
    T('control53', 'Text Box positionRegistration', 'regPosition', 'Your position (author, participant…)'),
    T('control54', 'Text Box priceRegistration', 'regPrice', 'Price'),
    T('control55', 'Text Box websiteRegistration', 'regWebsite', 'On the website'),
    T('control56', 'Text Box commentsRegistration', 'regComments', 'Comments', 'textarea'),
  ] },
  { title: 'General comments', fields: [
    T('control6', 'Comments', 'generalComments', 'General comments (visa, cards, agendas…)', 'textarea'),
  ] },
];

export const FORM_FIELDS = FORM_GROUPS.flatMap((g) => g.fields);

/** Values carried over from one mission to the next. */
export const PERSISTENT_KEYS = ['participant', 'missionType', 'project', 'regPosition', 'generalComments'];

const tagRe = (id) => new RegExp(`<form:\\w+\\b[^>]*\\bxml:id="${id}"[^>]*>`);
const attr = (tag, name) => {
  const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`));
  return m ? unescXml(m[1]) : undefined;
};

function controlTag(xml, id) {
  const m = xml.match(tagRe(id));
  if (!m) throw new Error(`Form template: control ${id} not found (expected form ${FORM_VERSION})`);
  return m[0];
}

/** Returns a list of problems; empty means the template matches the field map. */
export function checkTemplate(contentXml) {
  const problems = [];
  for (const f of FORM_FIELDS) {
    for (const id of f.options ? f.options.map((o) => o.id) : [f.id]) {
      const m = contentXml.match(tagRe(id));
      if (!m) { problems.push(`${id} missing`); continue; }
      const name = attr(m[0], 'form:name');
      if (name !== f.name) problems.push(`${id} is "${name}", expected "${f.name}"`);
    }
  }
  return problems;
}

export const isoTimeToHHMM = (v) => {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:[\d.]+S)?$/.exec(v || '');
  if (!m || (!m[1] && !m[2])) return '';
  return `${String(+(m[1] || 0)).padStart(2, '0')}:${String(+(m[2] || 0)).padStart(2, '0')}`;
};
export const hhmmToIsoTime = (v) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v || '');
  if (!m) throw new Error(`Invalid time "${v}", expected HH:MM`);
  return `PT${+m[1]}H${+m[2]}M`;
};

/** Read the current values of every mapped control (used to prefill from an old form). */
export function readFormValues(contentXml) {
  const v = {};
  for (const f of FORM_FIELDS) {
    if (f.type === 'choice') {
      const sel = f.options.find((o) => attr(controlTag(contentXml, o.id), 'form:current-selected') === 'true');
      v[f.key] = sel ? sel.label : '';
    } else if (f.type === 'check') {
      v[f.key] = attr(controlTag(contentXml, f.id), 'form:current-selected') === 'true';
    } else {
      const raw = attr(controlTag(contentXml, f.id), 'form:current-value') ?? '';
      v[f.key] = f.type === 'time' ? isoTimeToHHMM(raw) : raw;
    }
  }
  return v;
}

function setAttr(tag, name, value) {
  let t = tag.replace(new RegExp(`\\s${name}="[^"]*"`), '');
  if (value == null) return t;
  return t.replace(/(\/?>)$/, ` ${name}="${escAttr(value)}"$1`);
}

/** Set every mapped control from values (missing/empty values clear the control). */
export function fillFormXml(contentXml, values) {
  const problems = checkTemplate(contentXml);
  if (problems.length) throw new Error(`Form template does not match ${FORM_VERSION}: ${problems.join('; ')}`);
  let xml = contentXml;
  const replaceTag = (id, fn) => {
    const tag = controlTag(xml, id);
    xml = xml.replace(tag, () => fn(tag));
  };
  for (const f of FORM_FIELDS) {
    const val = values[f.key];
    if (f.type === 'choice') {
      if (val && !f.options.some((o) => o.label === val)) throw new Error(`Unknown ${f.label} "${val}"`);
      for (const o of f.options) replaceTag(o.id, (t) => setAttr(t, 'form:current-selected', o.label === val ? 'true' : null));
    } else if (f.type === 'check') {
      replaceTag(f.id, (t) => setAttr(t, 'form:current-selected', val ? 'true' : null));
    } else if (f.type === 'time') {
      replaceTag(f.id, (t) => setAttr(t, 'form:current-value', val ? hhmmToIsoTime(val) : null));
    } else if (f.type === 'date') {
      if (val && !/^\d{4}-\d{2}-\d{2}$/.test(val)) throw new Error(`Invalid date "${val}" for ${f.label}`);
      replaceTag(f.id, (t) => setAttr(t, 'form:current-value', val || null));
    } else {
      replaceTag(f.id, (t) => setAttr(t, 'form:current-value', val ? String(val) : null));
    }
  }
  return xml;
}

/** Template .odt bytes + values -> filled .odt bytes. The stale preview thumbnail is dropped. */
export async function fillMissionForm(templateBytes, values, inflateRaw, now = new Date()) {
  const entries = await unzip(templateBytes, inflateRaw);
  const out = [];
  let sawContent = false;
  for (const e of entries) {
    if (e.name.startsWith('Thumbnails/')) continue;
    if (e.name === 'content.xml') {
      out.push({ name: e.name, data: utf8(fillFormXml(fromUtf8(e.data), values)) });
      sawContent = true;
    } else if (e.name === 'META-INF/manifest.xml') {
      const m = fromUtf8(e.data).replace(/\s*<manifest:file-entry manifest:full-path="Thumbnails\/[^"]*"[^>]*\/>/g, '');
      out.push({ name: e.name, data: utf8(m) });
    } else {
      out.push(e);
    }
  }
  if (!sawContent) throw new Error('Form template has no content.xml');
  out.sort((a, b) => (a.name === 'mimetype' ? -1 : b.name === 'mimetype' ? 1 : 0));
  return zipStore(out, now);
}

/** Template bytes -> {problems, values} for validation and prefill at import time. */
export async function inspectTemplate(templateBytes, inflateRaw) {
  const entries = await unzip(templateBytes, inflateRaw);
  const content = entries.find((e) => e.name === 'content.xml');
  if (!content) throw new Error('Not an ODT text document: content.xml missing');
  const xml = fromUtf8(content.data);
  const problems = checkTemplate(xml);
  return { problems, values: problems.length ? {} : readFormValues(xml) };
}
