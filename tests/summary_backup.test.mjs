import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { spendingSummary, groupOf } from '../summary.js';
import { packBackup, unpackBackup } from '../backup.js';
import { zipStore, utf8 } from '../odt.js';

const inflateRaw = async (b) => new Uint8Array(inflateRawSync(b));
const ph = [{ data: new Uint8Array([1]) }];

test('spending summary: totals, today, groups, days, missing proof', () => {
  const s = spendingSummary([
    { title: 'Repas midi 1', date: '2026-05-19', amount: '0.1', photos: ph },
    { title: 'Repas soir 1', date: '2026-05-19', amount: '0.2', photos: ph },
    { title: 'Train', category: 'Train', date: '2026-05-20', amount: '157', photos: [] },
    { title: 'Divers', date: '2026-05-20', amount: '', photos: ph },
    { title: 'Taxi', date: '', amount: '25', photos: ph },
  ], '2026-05-19');
  assert.equal(s.total, 182.3);
  assert.equal(s.today, 0.3); // not 0.30000000000000004
  assert.equal(s.count, 5);
  assert.equal(s.withoutProof, 1);
  assert.equal(s.withoutAmount, 1);
  assert.deepEqual(s.byGroup, [['Train', 157], ['Taxi', 25], ['Repas', 0.3]]);
  assert.deepEqual(s.byDay, [['2026-05-19', 0.3], ['2026-05-20', 157]]);
  assert.equal(groupOf({ title: 'Petit-déjeuner 2' }), 'Repas');
  assert.equal(groupOf({ title: 'Musée' }), 'Autre');
});

test('backup round trip keeps missions, expenses, photos, profile and template', async () => {
  const data = {
    missions: [{ id: 'm1', city: 'Delft', departDate: '2026-05-19', closed: 1760000000000, form: { purpose: 'ERCOFTAC "DLES"' } }],
    expenses: [{ id: 'e1', missionId: 'm1', pos: 0, title: 'Repas midi 1', amount: '28.45',
      photos: [{ data: new Uint8Array([0xff, 0xd8, 1, 2]), w: 30, h: 60 }, { data: new Uint8Array([0xff, 0xd8, 3]), w: 60, h: 30 }] }],
    defaults: { lastName: 'TAGUEMA', form: { project: 'CENAERO FR' } },
    template: { name: 'form.odt', importedAt: 1, data: new Uint8Array([9, 9, 9]) },
  };
  const back = await unpackBackup(packBackup(data), inflateRaw);
  assert.deepEqual(back.missions, data.missions);
  assert.deepEqual(back.defaults, data.defaults);
  assert.deepEqual(back.template, data.template);
  assert.deepEqual(back.expenses, data.expenses);
});

test('backup without template or photos', async () => {
  const back = await unpackBackup(packBackup({ missions: [], expenses: [], defaults: null, template: null }), inflateRaw);
  assert.deepEqual(back.missions, []);
  assert.equal(back.template, null);
});

test('foreign or broken files are rejected with a clear message', async () => {
  await assert.rejects(unpackBackup(zipStore([{ name: 'x.txt', data: utf8('x') }]), inflateRaw), /pas une sauvegarde/);
  const bad = (json) => zipStore([{ name: 'data.json', data: utf8(JSON.stringify(json)) }]);
  await assert.rejects(unpackBackup(bad({ format: 'other' }), inflateRaw), /Format inconnu/);
  await assert.rejects(unpackBackup(bad({ format: 'frais-mission-backup', version: 99, missions: [], expenses: [] }), inflateRaw), /trop récente/);
  await assert.rejects(unpackBackup(bad({ format: 'frais-mission-backup', version: 1, missions: [],
    expenses: [{ id: 'e', missionId: 'zz', photos: [] }] }), inflateRaw), /sans mission/);
  await assert.rejects(unpackBackup(bad({ format: 'frais-mission-backup', version: 1, missions: [{ id: 'm' }],
    expenses: [{ id: 'e', missionId: 'm', photos: [{ file: 'photos/missing.jpg' }] }] }), inflateRaw), /photos\/missing\.jpg manquant/);
});
