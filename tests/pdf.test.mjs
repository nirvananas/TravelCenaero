import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildJustificatifsPdf, jpegInfo, winAnsi, wrap, textWidth, fit, formatAmount } from '../pdf.js';

const fixture = (n) => new Uint8Array(readFileSync(new URL(`./fixtures/${n}`, import.meta.url)));
const latin1 = (b) => Buffer.from(b).toString('latin1');

test('jpegInfo reads size and components', () => {
  assert.deepEqual(jpegInfo(fixture('receipt.jpg')), { w: 30, h: 60, nc: 3 });
  assert.deepEqual(jpegInfo(fixture('gray.jpg')), { w: 40, h: 20, nc: 1 });
  assert.throws(() => jpegInfo(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), /not a JPEG/);
});

test('winAnsi covers French text and the euro sign', () => {
  assert.deepEqual(winAnsi('é€à'), [0xe9, 0x80, 0xe0]);
  assert.deepEqual(winAnsi('œ–'), [0x9c, 0x96]);
  assert.deepEqual(winAnsi('A→B'), [0x41, 0x2d, 0x3e, 0x42]);
  assert.deepEqual(winAnsi('漢'), [0x3f]);
});

test('wrap keeps every line inside the width and loses no words', () => {
  const s = 'Train régional Rotterdam–Utrecht pas de ticket papier ' + 'x'.repeat(200);
  const lines = wrap(s, 10, false, 200);
  assert.ok(lines.length > 1);
  for (const l of lines) assert.ok(textWidth(l, 10) <= 200, l);
  assert.equal(lines.join('').replace(/\s/g, ''), s.replace(/\s/g, ''));
});

test('fit keeps aspect ratio', () => {
  const [w, h] = fit(540, 2048, 480, 700);
  assert.ok(Math.abs(w / h - 540 / 2048) < 1e-12 && h <= 700 && w <= 480);
  assert.equal(formatAmount('28.4'), '28,40 €');
});

test('PDF structure: header, xref offsets, pages, images, captions', () => {
  const jpg = fixture('receipt.jpg');
  const pdf = buildJustificatifsPdf({ title: 'TAGUEMA_DELFT_19_05_2026' }, [
    { title: 'Train Annecy → Delft', date: '2026-05-19', amount: '157', type: 'Avions, trains, métros', photos: [{ data: jpg }, { data: fixture('gray.jpg') }] },
    { title: 'Repas (midi) 1', amount: '28.45', photos: [] },
    { title: 'Hôtel', amount: '420', photos: [{ data: jpg }] },
  ]);
  const s = latin1(pdf);
  assert.ok(s.startsWith('%PDF-1.4\n'));
  assert.ok(s.endsWith('%%EOF\n'));
  // Every xref entry must point at the start of its object.
  const xrefAt = +s.match(/startxref\n(\d+)/)[1];
  const [, count] = s.slice(xrefAt).match(/^xref\n0 (\d+)/);
  const entries = s.slice(xrefAt).split('\n').slice(3, 2 + +count);
  entries.forEach((line, i) => assert.ok(s.startsWith(`${i + 1} 0 obj`, +line.slice(0, 10)), `object ${i + 1}`));
  assert.equal((s.match(/\/Subtype \/Image/g) || []).length, 3);
  assert.match(s, /\/ColorSpace \/DeviceGray/);
  // Captions are hex-encoded WinAnsi.
  const hx = (t) => Buffer.from(winAnsi(t)).toString('hex');
  assert.ok(s.includes(hx('(1) Train Annecy -> Delft')));
  assert.ok(s.includes(hx('(2) Repas (midi) 1')));
  assert.ok(s.includes(hx('28,45 € · pas de justificatif')));
  assert.ok(s.includes(hx('Avions, trains, métros')));
  assert.ok(s.includes(hx('605,45 €'))); // total row of the summary table
  assert.ok(s.includes(hx('Total')));
});

test('a non-JPEG photo fails loudly with the expense number', () => {
  assert.throws(() => buildJustificatifsPdf({ title: 'X' }, [{ title: 'a', photos: [{ data: new Uint8Array(20) }] }]), /Expense \(1\) "a", photo 1: Photo is not a JPEG/);
});
