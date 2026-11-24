import 'server-only';
import ExcelJS from 'exceljs';
import Papa from 'papaparse';

export type Column = { key: string; header: string; width?: number; numFmt?: string };

/** Neutralise spreadsheet formula injection (=, +, -, @, tab, CR at cell start). */
function safeCell(v: unknown): unknown {
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(v)) return `'${v}`;
  return v ?? '';
}

export async function toXlsx(sheetName: string, columns: Column[], rows: Record<string, unknown>[], rtl = false): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.created = new Date();
  const ws = wb.addWorksheet(sheetName.slice(0, 31), { views: [{ state: 'frozen', ySplit: 1, rightToLeft: rtl }] });
  ws.columns = columns.map((c) => ({ header: c.header, key: c.key, width: c.width ?? 16, style: c.numFmt ? { numFmt: c.numFmt } : {} }));
  ws.getRow(1).font = { bold: true };
  for (const r of rows) ws.addRow(Object.fromEntries(columns.map((c) => [c.key, safeCell(r[c.key])])));
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export function toCsv(columns: Column[], rows: Record<string, unknown>[]): string {
  const data = rows.map((r) => Object.fromEntries(columns.map((c) => [c.header, safeCell(r[c.key])])));
  return `﻿${Papa.unparse({ fields: columns.map((c) => c.header), data: data.map((d) => columns.map((c) => d[c.header])) })}`;
}
