/**
 * Pure conversion of spreadsheet rows into normalised external orders.
 * Column names are configurable per source (no assumption about the sheet
 * layout). Supports multi-product orders either:
 *  - in one row, with a separator inside product/quantity/price cells
 *    ("Montre x2 | Bracelet"), or
 *  - as several rows sharing the same external order ID.
 */
export const MAPPABLE_FIELDS = [
  'external_id',
  'customer_name',
  'phone',
  'phone2',
  'wilaya',
  'commune',
  'address',
  'product_name',
  'sku',
  'quantity',
  'product_price',
  'delivery_price',
  'total_amount',
  'customer_notes',
  'created_at',
  'delivery_type',
  'utm_source',
  'utm_campaign',
  'meta_campaign_id',
  'meta_ad_id',
] as const;
export type MappableField = (typeof MAPPABLE_FIELDS)[number];
export const REQUIRED_FIELDS: readonly MappableField[] = ['external_id', 'customer_name', 'phone', 'product_name'];

export type ColumnMapping = Partial<Record<MappableField, string>>;
export type MappingOptions = {
  multi_product_separator?: string; // e.g. "|", "+", "\n" ; empty = disabled
  group_rows_by_external_id?: boolean; // default true
  price_is_line_total?: boolean; // product_price column holds qty*price
  date_format?: 'auto' | 'dmy' | 'mdy';
};

export type ExternalOrderItem = { product_name: string; sku?: string | null; quantity: number; unit_price: number };
export type ExternalOrder = {
  external_id: string;
  customer_name: string;
  phone: string;
  phone2?: string | null;
  wilaya?: string | null;
  commune?: string | null;
  address?: string | null;
  customer_notes?: string | null;
  delivery_fee?: number | null;
  total_amount?: number | null;
  ordered_at?: string | null;
  delivery_type?: 'home' | 'stopdesk';
  utm_source?: string | null;
  utm_campaign?: string | null;
  meta_campaign_id?: string | null;
  meta_ad_id?: string | null;
  items: ExternalOrderItem[];
  row_numbers: number[];
};
export type RowError = { row: number; external_id: string | null; error: string };

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase().replace(/\s+/g, ' ');

/** Locale-tolerant amount parser: "2 500,00 DA" -> 2500, "1,500.50" -> 1500.5 */
export function parseAmount(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).replace(/[\s  ]/g, '').replace(/[^\d,.-]/g, '');
  if (!s || !/\d/.test(s)) return null;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    const decimalSep = lastComma > lastDot ? ',' : '.';
    const thousandSep = decimalSep === ',' ? '.' : ',';
    s = s.split(thousandSep).join('').replace(decimalSep, '.');
  } else if (lastComma >= 0) {
    const decimals = s.length - lastComma - 1;
    s = decimals > 0 && decimals <= 2 && s.indexOf(',') === lastComma ? s.replace(',', '.') : s.split(',').join('');
  } else if (lastDot >= 0) {
    const decimals = s.length - lastDot - 1;
    if (decimals === 3 && s.indexOf('.') !== lastDot) s = s.split('.').join('');
    else if (decimals === 3 && s.indexOf('.') === lastDot && s.length > 4) s = s.split('.').join('');
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Dates as typed in sheets -> ISO string in Algiers time (UTC+1). */
export function parseSheetDate(raw: string | null | undefined, format: MappingOptions['date_format'] = 'auto'): string | null {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const iso = s.length === 10 ? `${s}T12:00:00+01:00` : s.replace(' ', 'T');
    const d = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}+01:00`);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (m) {
    const [, a, b, y, hh = '12', mi = '00', ss = '00'] = m;
    let day = Number(a);
    let month = Number(b);
    if (format === 'mdy' || (format === 'auto' && month > 12 && day <= 12)) [day, month] = [month, day];
    const year = Number(y!.length === 2 ? `20${y}` : y);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${hh.padStart(2, '0')}:${mi}:${ss}+01:00`;
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

/** "Montre x2", "2 x Montre", "Montre (2)" -> name + quantity */
export function parseProductToken(token: string): { name: string; quantity: number | null } {
  const t = token.trim();
  let m = /^(.*?)\s*[x×*]\s*(\d{1,4})$/i.exec(t);
  if (m && m[1]) return { name: m[1].trim(), quantity: Number(m[2]) };
  m = /^(\d{1,4})\s*[x×*]\s*(.+)$/i.exec(t);
  if (m && m[2]) return { name: m[2].trim(), quantity: Number(m[1]) };
  m = /^(.*?)\s*\((\d{1,4})\)$/.exec(t);
  if (m && m[1]) return { name: m[1].trim(), quantity: Number(m[2]) };
  return { name: t, quantity: null };
}

function splitCell(value: string, sep: string | undefined): string[] {
  if (!sep) return [value];
  const s = sep === '\\n' ? '\n' : sep;
  return value.split(s).map((v) => v.trim()).filter((v) => v.length > 0);
}

export function resolveColumns(header: string[], mapping: ColumnMapping) {
  const index = new Map<string, number>();
  header.forEach((h, i) => {
    const k = norm(h ?? '');
    if (k && !index.has(k)) index.set(k, i);
  });
  const cols: Partial<Record<MappableField, number>> = {};
  const missing: MappableField[] = [];
  for (const field of MAPPABLE_FIELDS) {
    const colName = mapping[field];
    if (!colName) {
      if (REQUIRED_FIELDS.includes(field)) missing.push(field);
      continue;
    }
    const idx = index.get(norm(colName));
    if (idx === undefined) {
      if (REQUIRED_FIELDS.includes(field)) missing.push(field);
      else missing.push(field);
      continue;
    }
    cols[field] = idx;
  }
  return { cols, missing };
}

export function rowsToOrders(
  header: string[],
  rows: string[][],
  mapping: ColumnMapping,
  options: MappingOptions = {},
  firstDataRowNumber = 2,
): { orders: ExternalOrder[]; errors: RowError[]; missingColumns: MappableField[] } {
  const { cols, missing } = resolveColumns(header, mapping);
  const requiredMissing = missing.filter((f) => REQUIRED_FIELDS.includes(f));
  if (requiredMissing.length) return { orders: [], errors: [], missingColumns: missing };

  const group = options.group_rows_by_external_id !== false;
  const byId = new Map<string, ExternalOrder>();
  const errors: RowError[] = [];

  rows.forEach((row, i) => {
    const rowNumber = firstDataRowNumber + i;
    const get = (f: MappableField) => {
      const idx = cols[f];
      return idx === undefined ? '' : String(row[idx] ?? '').trim();
    };
    if (row.every((c) => !String(c ?? '').trim())) return; // blank line

    const externalId = get('external_id');
    if (!externalId) {
      errors.push({ row: rowNumber, external_id: null, error: 'missing_external_id' });
      return;
    }
    const name = get('customer_name');
    const phone = get('phone');
    const productCell = get('product_name');
    if (!name || !phone || !productCell) {
      errors.push({ row: rowNumber, external_id: externalId, error: !name ? 'missing_customer_name' : !phone ? 'missing_phone' : 'missing_product' });
      return;
    }

    const sep = options.multi_product_separator || undefined;
    const names = splitCell(productCell, sep);
    const skus = splitCell(get('sku'), sep);
    const qtys = splitCell(get('quantity'), sep);
    const prices = splitCell(get('product_price'), sep);
    const items: ExternalOrderItem[] = [];
    for (let k = 0; k < names.length; k++) {
      const token = parseProductToken(names[k]!);
      const qtyRaw = qtys[k] ?? (names.length === 1 ? qtys[0] : undefined);
      const quantity = Math.max(1, Math.round(parseAmount(qtyRaw) ?? token.quantity ?? 1));
      let unit = parseAmount(prices[k] ?? (names.length === 1 ? prices[0] : undefined));
      if (unit !== null && options.price_is_line_total) unit = unit / quantity;
      if (unit === null) {
        errors.push({ row: rowNumber, external_id: externalId, error: 'missing_price' });
        return;
      }
      items.push({ product_name: token.name, sku: skus[k] || null, quantity, unit_price: Math.round(unit * 100) / 100 });
    }

    const existing = group ? byId.get(externalId) : undefined;
    if (existing) {
      existing.items.push(...items);
      existing.row_numbers.push(rowNumber);
      return;
    }
    if (!group && byId.has(externalId)) {
      errors.push({ row: rowNumber, external_id: externalId, error: 'duplicate_external_id' });
      return;
    }
    const dt = get('delivery_type').toLowerCase();
    byId.set(externalId, {
      external_id: externalId,
      customer_name: name,
      phone,
      phone2: get('phone2') || null,
      wilaya: get('wilaya') || null,
      commune: get('commune') || null,
      address: get('address') || null,
      customer_notes: get('customer_notes') || null,
      delivery_fee: parseAmount(get('delivery_price')),
      total_amount: parseAmount(get('total_amount')),
      ordered_at: parseSheetDate(get('created_at'), options.date_format),
      delivery_type: /stop|desk|bureau|agence|مكتب/.test(dt) ? 'stopdesk' : 'home',
      utm_source: get('utm_source') || null,
      utm_campaign: get('utm_campaign') || null,
      meta_campaign_id: get('meta_campaign_id') || null,
      meta_ad_id: get('meta_ad_id') || null,
      items,
      row_numbers: [rowNumber],
    });
  });

  return { orders: [...byId.values()], errors, missingColumns: missing };
}

/** Accepts a full Google Sheets URL or a bare spreadsheet ID. */
export function extractSpreadsheetId(input: string): string | null {
  const m = /\/spreadsheets\/d\/([a-zA-Z0-9-_]{20,})/.exec(input);
  if (m) return m[1] ?? null;
  return /^[a-zA-Z0-9-_]{20,}$/.test(input.trim()) ? input.trim() : null;
}
