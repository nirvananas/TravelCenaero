import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { unzip, fromUtf8 } from '../odt.js';
import { buildRepliconXlsx, excelDate, COLUMNS } from '../xlsx.js';

const inflateRaw = async (b) => new Uint8Array(inflateRawSync(b));

test('excelDate matches Excel serial numbers', () => {
  assert.equal(excelDate('1900-03-01'), 61);
  assert.equal(excelDate('2026-05-19'), 46161);
});

test('workbook parts, header, rows, SUM formula and escaping', async () => {
  const x = buildRepliconXlsx(
    { title: 'TAGUEMA_DELFT_19_05_2026', description: 'Presenting at ERCOFTAC <DLES> & co', project: 'CENAERO FR', participant: 'Ludovic TAGUEMA' },
    [
      { date: '2026-05-19', description: 'Train Annecy -> Delft', type: 'Avions, trains, métros', billClient: 'Yes', missionType: 'Conférence', amount: '157' },
      { date: '', description: 'Repas midi 1', type: 'Avance', billClient: 'Yes', missionType: 'Conférence', amount: '28.45' },
      { date: '2026-05-20', description: 'Sans montant', type: 'Avance', billClient: 'Yes', missionType: 'Conférence', amount: '' },
    ],
  );
  const parts = Object.fromEntries((await unzip(x, inflateRaw)).map((e) => [e.name, fromUtf8(e.data)]));
  assert.deepEqual(Object.keys(parts).sort(), ['[Content_Types].xml', '_rels/.rels', 'xl/_rels/workbook.xml.rels',
    'xl/styles.xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml']);
  const s = parts['xl/worksheets/sheet1.xml'];
  for (const c of COLUMNS) assert.ok(s.includes(`>${c}<`), c);
  assert.match(s, /<c r="B7" s="2"><v>46161<\/v><\/c>/);
  assert.match(s, /<c r="G7" s="3"><v>157<\/v><\/c>/);
  assert.match(s, /<f>SUM\(G7:G9\)<\/f><v>185.45<\/v>/);
  assert.match(s, /Presenting at ERCOFTAC &lt;DLES&gt; &amp; co/);
  assert.doesNotMatch(s, /r="B8"/); // no date -> empty cell
  assert.doesNotMatch(s, /r="G9"/); // no amount -> empty cell
});

test('an invalid amount fails loudly', () => {
  assert.throws(() => buildRepliconXlsx({ title: 'X' }, [{ description: 'a', amount: 'abc' }]), /Row 1: invalid amount "abc"/);
});
