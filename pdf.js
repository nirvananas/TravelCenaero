// Justificatifs PDF, no dependencies. JPEG photos are embedded as-is (DCTDecode);
// text uses the PDF base-14 Helvetica fonts with WinAnsi encoding (covers French).

const PAGE_W = 595.28; // A4 in points
const PAGE_H = 841.89;
const MARGIN = 56.69; // 2 cm
const CW = PAGE_W - 2 * MARGIN;
const CH = PAGE_H - 2 * MARGIN;
const GAP = 8; // below each photo
// A photo may be shrunk down to this fraction of its best size to fill the rest of a
// page; below that it moves to the next page so receipts stay readable.
const MIN_SCALE = 0.6;

export function formatDateFr(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

export function formatAmount(n) {
  return Number(n).toFixed(2).replace('.', ',') + ' €';
}

// ---------------------------------------------------------------------------
// Text: WinAnsi encoding and Helvetica metrics (AFM widths, 1/1000 em)
// ---------------------------------------------------------------------------

const WINANSI = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87,
  0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91,
  0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98,
  0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
};
const SUBST = { '→': '->', '←': '<-', '⇒': '=>', '≈': '~', '×': 'x' };

/** String -> WinAnsi byte values; characters outside WinAnsi become '?'. */
export function winAnsi(s) {
  const out = [];
  for (const ch of String(s).normalize('NFC')) {
    if (SUBST[ch]) { out.push(...[...SUBST[ch]].map((c) => c.charCodeAt(0))); continue; }
    const c = ch.codePointAt(0);
    if ((c >= 0x20 && c < 0x7f) || (c >= 0xa0 && c <= 0xff)) out.push(c);
    else if (WINANSI[c]) out.push(WINANSI[c]);
    else out.push(0x3f);
  }
  return out;
}

// Helvetica widths for 0x20..0x7e.
const HELV = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015,
  667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611,
  722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333,
  556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278,
  556, 500, 722, 500, 500, 500, 334, 260, 334, 584];

/** Approximate width in points (accented letters use their base letter; bold ~7 % wider). */
export function textWidth(s, size, bold = false) {
  let w = 0;
  for (const ch of String(s).normalize('NFD')) {
    const c = ch.codePointAt(0);
    if (c >= 0x300 && c <= 0x36f) continue;
    w += c >= 0x20 && c < 0x7f ? HELV[c - 0x20] : 556;
  }
  return (w * size * (bold ? 1.07 : 1)) / 1000;
}

export function wrap(s, size, bold, maxW) {
  const lines = [];
  for (const para of String(s).split(/\r?\n/)) {
    let line = '';
    for (let word of para.split(/\s+/).filter(Boolean)) {
      while (textWidth(word, size, bold) > maxW) { // hard-break a word longer than a line
        let k = word.length - 1;
        while (k > 1 && textWidth(word.slice(0, k), size, bold) > maxW) k--;
        if (line) { lines.push(line); line = ''; }
        lines.push(word.slice(0, k));
        word = word.slice(k);
      }
      const cand = line ? `${line} ${word}` : word;
      if (textWidth(cand, size, bold) <= maxW) line = cand;
      else { lines.push(line); line = word; }
    }
    lines.push(line);
  }
  return lines;
}

const hex = (bytes) => '<' + bytes.map((b) => b.toString(16).padStart(2, '0')).join('') + '>';
const num = (x) => (Math.round(x * 100) / 100).toString();

// ---------------------------------------------------------------------------
// JPEG
// ---------------------------------------------------------------------------

/** Width, height and component count from the JPEG SOF marker. */
export function jpegInfo(b) {
  if (b[0] !== 0xff || b[1] !== 0xd8) throw new Error('Photo is not a JPEG (missing SOI marker)');
  let p = 2;
  while (p + 9 < b.length) {
    if (b[p] !== 0xff) throw new Error(`Corrupt JPEG: expected marker at byte ${p}`);
    const m = b[p + 1];
    if (m === 0xff) { p++; continue; }
    p += 2;
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) continue;
    const len = (b[p] << 8) | b[p + 1];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { h: (b[p + 3] << 8) | b[p + 4], w: (b[p + 5] << 8) | b[p + 6], nc: b[p + 7] };
    }
    p += len;
  }
  throw new Error('Corrupt JPEG: no frame header found');
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/** Fit (w, h) inside (maxW, maxH) keeping the aspect ratio. */
export function fit(w, h, maxW, maxH) {
  if (!(w > 0 && h > 0)) throw new Error(`Invalid image size ${w}x${h}`);
  const s = Math.min(maxW / w, maxH / h);
  return [w * s, h * s];
}

/**
 * mission: {title}
 * expenses: [{title, date, amount, note, photos: [{data: Uint8Array (JPEG)}]}]
 * Expenses are numbered (1), (2), ... in the given order. Returns the PDF bytes.
 */
export function buildJustificatifsPdf(mission, expenses) {
  const images = []; // {data, w, h, nc}
  const pages = [];
  let page;
  let y;
  const newPage = () => { page = { ops: [], xobjs: [] }; pages.push(page); y = PAGE_H - MARGIN; };
  const atTop = () => y === PAGE_H - MARGIN;
  const textLine = (s, size, bold, grey = 0) => {
    y -= size * 1.25;
    page.ops.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${grey} g ${num(MARGIN)} ${num(y + size * 0.25)} Td ${hex(winAnsi(s))} Tj ET`);
  };

  newPage();
  for (const l of wrap(`${mission.title} — justificatifs`, 14, true, CW)) textLine(l, 14, true);
  y -= 6;

  let total = 0;
  let anyAmount = false;
  expenses.forEach((e, i) => {
    const cap = wrap(`(${i + 1}) ${e.title || 'Sans titre'}`, 12, true, CW);
    const info = [];
    if (e.date) info.push(formatDateFr(e.date));
    if (e.amount !== '' && e.amount != null && Number.isFinite(Number(e.amount))) {
      info.push(formatAmount(e.amount));
      total += Number(e.amount);
      anyAmount = true;
    }
    if (e.note) info.push(e.note);
    if (!e.photos?.length) info.push('pas de justificatif');
    const infoLines = info.length ? wrap(info.join(' · '), 10, false, CW) : [];
    const headH = 12 + cap.length * 15 + infoLines.length * 12.5 + 6;

    const imgs = (e.photos || []).map((ph, j) => {
      const where = `Expense (${i + 1}) "${e.title}", photo ${j + 1}`;
      let jpeg;
      try { jpeg = jpegInfo(ph.data); } catch (err) { throw new Error(`${where}: ${err.message}`); }
      const { w, h, nc } = jpeg;
      if (nc !== 1 && nc !== 3) throw new Error(`${where}: JPEG with ${nc} colour components is not supported`);
      // Largest size that still fits under the caption on an empty page.
      const [dw, dh] = fit(w, h, CW, CH - headH - GAP);
      images.push({ data: ph.data, w, h, nc });
      return { idx: images.length, w, h, dw, dh };
    });

    // Keep the caption on the same page as (at least a shrunk) first photo.
    const firstH = imgs.length ? imgs[0].dh * MIN_SCALE + GAP : 0;
    if (!atTop() && y - headH - firstH < MARGIN) newPage();
    y -= 12;
    cap.forEach((l) => textLine(l, 12, true));
    infoLines.forEach((l) => textLine(l, 10, false, 0.33));
    y -= 6;
    for (const im of imgs) {
      let { dw, dh } = im;
      const avail = y - MARGIN - GAP;
      if (dh > avail) {
        if (dh * MIN_SCALE <= avail) [dw, dh] = fit(im.w, im.h, CW, avail); // shrink to finish the page
        else newPage();
      }
      y -= dh;
      page.ops.push(`q ${num(dw)} 0 0 ${num(dh)} ${num(MARGIN + (CW - dw) / 2)} ${num(y)} cm /Im${im.idx} Do Q`);
      page.xobjs.push(im.idx);
      y -= GAP;
    }
  });
  if (anyAmount) {
    if (y - 30 < MARGIN) newPage();
    y -= 14;
    textLine(`Total : ${formatAmount(total)}`, 12, true);
  }

  // Footer with page numbers.
  pages.forEach((p, k) => {
    const s = `${mission.title} — justificatifs — page ${k + 1}/${pages.length}`;
    const x = PAGE_W - MARGIN - textWidth(s, 8);
    p.ops.push(`BT /F1 8 Tf 0.45 g ${num(x)} ${num(MARGIN / 2)} Td ${hex(winAnsi(s))} Tj ET`);
  });

  return serialize(mission.title, images, pages);
}

// ---------------------------------------------------------------------------
// PDF file structure
// ---------------------------------------------------------------------------

function serialize(title, images, pages) {
  const enc = new TextEncoder();
  const chunks = [];
  const offsets = [];
  let pos = 0;
  const put = (x) => { const b = typeof x === 'string' ? enc.encode(x) : x; chunks.push(b); pos += b.length; };
  const obj = (n, dict, stream) => {
    offsets[n] = pos;
    if (stream) {
      put(`${n} 0 obj\n${dict.replace(/>>$/, ` /Length ${stream.length} >>`)}\nstream\n`);
      put(stream);
      put('\nendstream\nendobj\n');
    } else {
      put(`${n} 0 obj\n${dict}\nendobj\n`);
    }
  };

  // 1 catalog, 2 pages, 3-4 fonts, 5 info, 6.. images, then (page, content) pairs.
  const imgObj = (k) => 5 + k; // image k is 1-based
  const pageObj = (k) => 6 + images.length + 2 * k;
  put(new Uint8Array([...enc.encode('%PDF-1.4\n%'), 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); // binary marker line
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, k) => `${pageObj(k)} 0 R`).join(' ')}] >>`);
  obj(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  obj(4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const utf16 = [0xfe, 0xff];
  for (const ch of `${title} justificatifs`) {
    const c = ch.codePointAt(0);
    const units = c > 0xffff ? [0xd800 + ((c - 0x10000) >> 10), 0xdc00 + ((c - 0x10000) & 0x3ff)] : [c];
    for (const u of units) utf16.push(u >> 8, u & 0xff);
  }
  obj(5, `<< /Title ${hex(utf16)} /Producer (Frais de mission PWA) >>`);
  images.forEach((im, k) => {
    const cs = im.nc === 1 ? '/DeviceGray' : '/DeviceRGB';
    obj(imgObj(k + 1), `<< /Type /XObject /Subtype /Image /Width ${im.w} /Height ${im.h} /ColorSpace ${cs} /BitsPerComponent 8 /Filter /DCTDecode >>`, im.data);
  });
  pages.forEach((p, k) => {
    const xo = [...new Set(p.xobjs)].map((i) => `/Im${i} ${imgObj(i)} 0 R`).join(' ');
    obj(pageObj(k), `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
      `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> /XObject << ${xo} >> >> /Contents ${pageObj(k) + 1} 0 R >>`);
    obj(pageObj(k) + 1, '<< >>', enc.encode(p.ops.join('\n')));
  });

  const n = offsets.length;
  const xref = pos;
  put(`xref\n0 ${n}\n0000000000 65535 f \n`);
  for (let i = 1; i < n; i++) put(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`);
  put(`trailer\n<< /Size ${n} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  const out = new Uint8Array(pos);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}
