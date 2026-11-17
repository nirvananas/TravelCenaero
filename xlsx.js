// Replicon expense table as an .xlsx workbook (SpreadsheetML, written by hand: one
// sheet, inline strings, real dates and numbers, a SUM formula for the total).
// Columns follow a Replicon expense sheet: Date Incurred, Description, Type,
// Bill Client, Type of mission, Amount; the N° column matches the justificatifs PDF.
import { zipStore, utf8, escXml } from './odt.js';

const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';

export const COLUMNS = ['N°', 'Date Incurred', 'Description', 'Type', 'Bill Client', 'Type of mission', 'Amount (€)'];
const WIDTHS = [6, 13, 40, 24, 11, 18, 13];
const FIRST_ROW = 7; // header on row 6

/** Excel serial day number of a YYYY-MM-DD date (1900 date system). */
export function excelDate(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  return (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000;
}

const col = (i) => String.fromCharCode(65 + i);
const str = (ref, s, style = 0) =>
  `<c r="${ref}" t="inlineStr"${style ? ` s="${style}"` : ''}><is><t xml:space="preserve">${escXml(s)}</t></is></c>`;
const numCell = (ref, v, style) => `<c r="${ref}" s="${style}"><v>${v}</v></c>`;

/**
 * meta: {title, description, project, participant}
 * rows: [{date, description, type, billClient, missionType, amount}] in justificatifs order.
 */
export function buildRepliconXlsx(meta, rows) {
  const out = [];
  const row = (r, cells) => out.push(`<row r="${r}">${cells.join('')}</row>`);
  const last = FIRST_ROW + rows.length - 1;
  const total = rows.reduce((s, x) => s + (x.amount ? Number(x.amount) : 0), 0);

  row(1, [str('A1', `Expense Sheet — ${meta.title}`, 1)]);
  row(2, [str('A2', 'Participant', 1), str('C2', meta.participant || '')]);
  row(3, [str('A3', 'Description', 1), str('C3', meta.description || '')]);
  row(4, [str('A4', 'Project', 1), str('C4', meta.project || '')]);
  row(5, [str('A5', 'Total Reimbursement', 1),
    rows.length ? `<c r="C5" s="4"><f>SUM(G${FIRST_ROW}:G${last})</f><v>${total.toFixed(2)}</v></c>` : numCell('C5', 0, 4)]);
  row(6, COLUMNS.map((c, i) => str(`${col(i)}6`, c, 1)));
  rows.forEach((x, k) => {
    const r = FIRST_ROW + k;
    const amount = x.amount === '' || x.amount == null ? null : Number(x.amount);
    if (amount !== null && !Number.isFinite(amount)) throw new Error(`Row ${k + 1}: invalid amount "${x.amount}"`);
    row(r, [
      numCell(`A${r}`, k + 1, 0),
      x.date ? numCell(`B${r}`, excelDate(x.date), 2) : '',
      str(`C${r}`, x.description || ''),
      str(`D${r}`, x.type || ''),
      str(`E${r}`, x.billClient || ''),
      str(`F${r}`, x.missionType || ''),
      amount === null ? '' : numCell(`G${r}`, amount, 3),
    ]);
  });

  const sheet =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">` +
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="6" topLeftCell="A7" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
    `<cols>${WIDTHS.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` +
    `<sheetData>${out.join('')}</sheetData></worksheet>`;

  const styles =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="${NS_MAIN}">` +
    '<numFmts count="2"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/><numFmt numFmtId="165" formatCode="#,##0.00\\ &quot;€&quot;"/></numFmts>' +
    '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
    '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="5">' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' + // 0 default
    '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' + // 1 bold
    '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' + // 2 date
    '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' + // 3 euros
    '<xf numFmtId="165" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>' + // 4 bold euros
    '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';

  const workbook =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">` +
    '<sheets><sheet name="Dépenses" sheetId="1" r:id="rId1"/></sheets></workbook>';
  const workbookRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${NS_PKG}">` +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    '</Relationships>';
  const rootRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${NS_PKG}">` +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>';
  const types =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    '</Types>';

  return zipStore([
    { name: '[Content_Types].xml', data: utf8(types) },
    { name: '_rels/.rels', data: utf8(rootRels) },
    { name: 'xl/workbook.xml', data: utf8(workbook) },
    { name: 'xl/_rels/workbook.xml.rels', data: utf8(workbookRels) },
    { name: 'xl/styles.xml', data: utf8(styles) },
    { name: 'xl/worksheets/sheet1.xml', data: utf8(sheet) },
  ]);
}
