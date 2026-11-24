import 'server-only';
import Papa from 'papaparse';
import ExcelJS from 'exceljs';

/** Parse an uploaded CSV/XLSX into rows keyed by normalised (lower_snake) header. */
export async function parseTabularFile(file: File): Promise<Record<string, string>[]> {
  const name = file.name.toLowerCase();
  const norm = (h: string) => h.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  if (name.endsWith('.csv') || file.type === 'text/csv') {
    const text = await file.text();
    const res = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true, transformHeader: norm });
    return res.data.slice(0, 20000);
  }
  if (name.endsWith('.xlsx')) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await file.arrayBuffer());
    const ws = wb.worksheets[0];
    if (!ws) return [];
    const header: string[] = [];
    ws.getRow(1).eachCell((c, i) => { header[i] = norm(String(c.text ?? '')); });
    const out: Record<string, string>[] = [];
    ws.eachRow((row, idx) => {
      if (idx === 1 || out.length >= 20000) return;
      const rec: Record<string, string> = {};
      row.eachCell((c, i) => { if (header[i]) rec[header[i]!] = String(c.text ?? '').trim(); });
      out.push(rec);
    });
    return out;
  }
  throw new Error('unsupported_file');
}
