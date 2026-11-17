// Backup file of everything the app stores (missions, expenses, receipt photos,
// profile, form template), as a ZIP: data.json + photos/*.jpg + template.odt.
// Pure functions on bytes, no DOM, so the format is tested in Node.
import { zipStore, unzip, utf8, fromUtf8 } from './odt.js';

export const BACKUP_FORMAT = 'frais-mission-backup';
export const BACKUP_VERSION = 1;

/**
 * data: {missions, expenses (photos: [{data: Uint8Array, w, h}]), defaults, template: {name, importedAt, data} | null}
 * Returns the ZIP bytes.
 */
export function packBackup(data, now = new Date()) {
  const files = [];
  const expenses = data.expenses.map((e) => ({
    ...e,
    photos: e.photos.map((p, i) => {
      const name = `photos/${e.id}_${i + 1}.jpg`;
      files.push({ name, data: p.data });
      return { file: name, w: p.w, h: p.h };
    }),
  }));
  let template = null;
  if (data.template) {
    files.push({ name: 'template.odt', data: data.template.data });
    template = { name: data.template.name, importedAt: data.template.importedAt, file: 'template.odt' };
  }
  const json = { format: BACKUP_FORMAT, version: BACKUP_VERSION, exported: now.toISOString(),
    missions: data.missions, expenses, defaults: data.defaults || null, template };
  return zipStore([{ name: 'data.json', data: utf8(JSON.stringify(json)) }, ...files], now);
}

/** Inverse of packBackup; fails loudly on anything that is not a backup of this app. */
export async function unpackBackup(bytes, inflateRaw) {
  const entries = new Map((await unzip(bytes, inflateRaw)).map((e) => [e.name, e.data]));
  const raw = entries.get('data.json');
  if (!raw) throw new Error('Ce fichier n’est pas une sauvegarde Frais de mission (data.json absent)');
  const json = JSON.parse(fromUtf8(raw));
  if (json.format !== BACKUP_FORMAT) throw new Error(`Format inconnu « ${json.format} »`);
  if (json.version > BACKUP_VERSION) throw new Error(`Sauvegarde version ${json.version}, trop récente pour cette appli (version ${BACKUP_VERSION}) : mettez l’appli à jour`);
  const file = (name) => {
    const d = entries.get(name);
    if (!d) throw new Error(`Sauvegarde incomplète : ${name} manquant`);
    return d;
  };
  const missionIds = new Set(json.missions.map((m) => m.id));
  for (const e of json.expenses) {
    if (!missionIds.has(e.missionId)) throw new Error(`Sauvegarde incohérente : dépense ${e.id} sans mission`);
  }
  return {
    exported: json.exported,
    missions: json.missions,
    expenses: json.expenses.map((e) => ({ ...e, photos: e.photos.map((p) => ({ data: file(p.file), w: p.w, h: p.h })) })),
    defaults: json.defaults,
    template: json.template ? { name: json.template.name, importedAt: json.template.importedAt, data: file(json.template.file) } : null,
  };
}
