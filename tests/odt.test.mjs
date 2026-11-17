// Run: node --test tests/
// The form tests need a filled Mission Request Form; set MISSION_FORM to its path
// (default: the DELFT one in ~/Documents/Travels). They are skipped if it is absent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { homedir } from 'node:os';
import {
  crc32, zipStore, unzip, utf8, fromUtf8, fileBase,
  fillMissionForm, inspectTemplate, fillFormXml, isoTimeToHHMM, hhmmToIsoTime,
  escAttr, unescXml, FORM_FIELDS,
} from '../odt.js';

const inflateRaw = async (b) => new Uint8Array(inflateRawSync(b));
const FORM = process.env.MISSION_FORM ||
  `${homedir()}/Documents/Travels/TAGUEMA_DELFT_19_05_2026.odt`;
const hasForm = existsSync(FORM);

test('crc32 of "123456789" is the standard check value', () => {
  assert.equal(crc32(utf8('123456789')), 0xcbf43926);
});

test('zipStore round-trips through unzip, mimetype first and uncompressed', async () => {
  const z = zipStore([
    { name: 'mimetype', data: utf8('application/vnd.oasis.opendocument.text') },
    { name: 'dir/é.txt', data: utf8('héllo') },
  ]);
  assert.equal(fromUtf8(z.subarray(30, 38)), 'mimetype'); // ODF requirement
  const e = await unzip(z, inflateRaw);
  assert.deepEqual(e.map((x) => x.name), ['mimetype', 'dir/é.txt']);
  assert.equal(fromUtf8(e[1].data), 'héllo');
});

test('fileBase follows LASTNAME_CITY_DD_MM_YYYY', () => {
  assert.equal(fileBase({ lastName: 'Taguema', city: 'Delft', startDate: '2026-05-19' }), 'TAGUEMA_DELFT_19_05_2026');
  assert.equal(fileBase({ lastName: 'Taguema', city: 'Châteaufort', startDate: '2025-10-13' }), 'TAGUEMA_CHATEAUFORT_13_10_2025');
  assert.equal(fileBase({ lastName: 'Taguema', city: 'Den Haag', startDate: '2026-01-02' }), 'TAGUEMA_DEN-HAAG_02_01_2026');
});

test('time and attribute conversions', () => {
  assert.equal(isoTimeToHHMM('PT8H30M'), '08:30');
  assert.equal(isoTimeToHHMM('PT18H'), '18:00');
  assert.equal(isoTimeToHHMM('P0D'), '');
  assert.equal(hhmmToIsoTime('08:30'), 'PT8H30M');
  assert.throws(() => hhmmToIsoTime('8h30'));
  const s = 'a & "b" <c>\nd';
  assert.equal(unescXml(escAttr(s)), s);
});

test('form template is recognised and its values are read', { skip: !hasForm && `no form at ${FORM}` }, async () => {
  const { problems, values } = await inspectTemplate(new Uint8Array(readFileSync(FORM)), inflateRaw);
  assert.deepEqual(problems, []);
  assert.equal(values.participant, 'Ludovic TAGUEMA');
  assert.equal(values.missionType, 'Conference');
  assert.equal(values.startDate, '2026-05-19');
  assert.equal(values.startTime, '08:30');
  assert.equal(values.registration, true);
  assert.equal(values.flightOutDate, '');
});

test('filling the form sets, clears and round-trips every field', { skip: !hasForm && `no form at ${FORM}` }, async () => {
  const values = {};
  for (const f of FORM_FIELDS) {
    values[f.key] = f.type === 'date' ? '2027-01-31' : f.type === 'time' ? '07:05'
      : f.type === 'choice' ? 'Training' : f.type === 'check' ? false : `${f.key} "x" & <y>\nz`;
  }
  const odt = await fillMissionForm(new Uint8Array(readFileSync(FORM)), values, inflateRaw);
  const e = await unzip(odt, inflateRaw);
  assert.equal(e[0].name, 'mimetype');
  assert.ok(!e.some((x) => x.name.startsWith('Thumbnails/')));
  assert.doesNotMatch(fromUtf8(e.find((x) => x.name === 'META-INF/manifest.xml').data), /Thumbnails/);
  const { values: back } = await inspectTemplate(odt, inflateRaw);
  assert.deepEqual(back, values);

  const cleared = await fillMissionForm(odt, {}, inflateRaw);
  const { values: empty } = await inspectTemplate(cleared, inflateRaw);
  for (const f of FORM_FIELDS) assert.ok(!empty[f.key], `${f.key} not cleared`);
});

test('a template with a renamed control is rejected', { skip: !hasForm && `no form at ${FORM}` }, async () => {
  const e = await unzip(new Uint8Array(readFileSync(FORM)), inflateRaw);
  const xml = fromUtf8(e.find((x) => x.name === 'content.xml').data).replace('form:name="Text Box purpose"', 'form:name="Other"');
  assert.throws(() => fillFormXml(xml, {}), /control3 is "Other", expected "Text Box purpose"/);
});
