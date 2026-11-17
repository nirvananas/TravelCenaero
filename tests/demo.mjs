// End-to-end check: build both documents with the real form template and real
// receipt photos, so they can be opened and rendered by a viewer.
// Usage: node tests/demo.mjs <form.odt> <out-dir> <image.jpg>...
// Every text field is filled with its own key, which makes the field map visible.
import { readFileSync, writeFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { fillMissionForm, fileBase, FORM_FIELDS } from '../odt.js';
import { buildJustificatifsPdf } from '../pdf.js';

const [form, outDir, ...images] = process.argv.slice(2);
const inflateRaw = async (b) => new Uint8Array(inflateRawSync(b));
const photos = images.map((p) => ({ data: new Uint8Array(readFileSync(p)) }));

const values = {};
for (const f of FORM_FIELDS) {
  values[f.key] = f.type === 'date' ? '2026-12-01' : f.type === 'time' ? '09:15'
    : f.type === 'choice' ? 'Meeting/Fair/Misc.' : f.type === 'check' ? true : f.key;
}
const base = fileBase({ lastName: 'Taguema', city: 'Delft', startDate: '2026-12-01' });
writeFileSync(`${outDir}/${base}.odt`, await fillMissionForm(new Uint8Array(readFileSync(form)), values, inflateRaw));
writeFileSync(`${outDir}/${base}_justificatifs.pdf`, buildJustificatifsPdf({ title: base }, [
  { title: 'Train Annecy → Delft', date: '2026-12-01', amount: '157', photos: photos.slice(0, 1) },
  { title: 'Repas midi 1', date: '2026-12-01', amount: '28.45', photos: photos.slice(1, 3) },
  { title: 'Train régional Rotterdam–Utrecht', amount: '4.4', note: 'pas de ticket papier', photos: [] },
  { title: 'Taxe de séjour', date: '2026-12-02', amount: '12', photos: photos.slice(3) },
]));
console.log(`${outDir}/${base}.odt\n${outDir}/${base}_justificatifs.pdf`);
