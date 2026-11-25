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
/** No column is mandatory: incomplete rows are imported and flagged for review. */
export const REQUIRED_FIELDS: readonly MappableField[] = [];
/** Fields reported in the review note when a row does not provide them. */
const REVIEW_FIELDS = ['customer_name', 'phone', 'product_name', 'wilaya'] as const;

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
  needs_review?: boolean;
  review_reason?: string | null;
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
    if (!colName) continue;
    const idx = index.get(norm(colName));
    if (idx === undefined) missing.push(field);
    else cols[field] = idx;
  }
  return { cols, missing, found: Object.keys(cols).length };
}

/** Stable id for rows without an order id: same row content -> same id on every sync. */
export function rowFingerprint(parts: string[]): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (const ch of parts.map((p) => p.trim().toLowerCase()).join('\u241f')) {
    const c = ch.codePointAt(0)!;
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  return `auto-${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}

export function rowsToOrders(
  header: string[],
  rows: string[][],
  mapping: ColumnMapping,
  options: MappingOptions = {},
  firstDataRowNumber = 2,
): { orders: ExternalOrder[]; errors: RowError[]; missingColumns: MappableField[] } {
  const { cols, missing, found } = resolveColumns(header, mapping);
  // Nothing recognised at all: wrong tab / header row — report instead of importing garbage.
  if (!found) return { orders: [], errors: [], missingColumns: missing.length ? missing : ['external_id'] };

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

    const name = get('customer_name');
    const phone = get('phone');
    const productCell = get('product_name') || get('sku');
    const externalId = get('external_id') || rowFingerprint([get('created_at'), phone, name, productCell, get('total_amount')]);
    const missingInfo = new Set<string>(REVIEW_FIELDS.filter((f) => !get(f) && !(f === 'product_name' && productCell)));
    const sep = options.multi_product_separator || undefined;
    const names = productCell ? splitCell(productCell, sep) : [];
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
      if (unit === null) missingInfo.add('product_price');
      items.push({ product_name: token.name, sku: skus[k] || null, quantity, unit_price: Math.round((unit ?? 0) * 100) / 100 });
    }
    if (!productCell) missingInfo.add('product_name');

    const existing = group ? byId.get(externalId) : undefined;
    if (existing) {
      existing.items.push(...items);
      existing.row_numbers.push(rowNumber);
      if (missingInfo.size && !existing.needs_review) {
        existing.needs_review = true;
        existing.review_reason = reviewReason(missingInfo);
      }
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
      needs_review: missingInfo.size > 0,
      review_reason: missingInfo.size ? reviewReason(missingInfo) : null,
    });
  });

  return { orders: [...byId.values()], errors, missingColumns: missing };
}

const REVIEW_LABELS: Record<string, string> = {
  customer_name: 'nom', phone: 'téléphone', product_name: 'produit', wilaya: 'wilaya', product_price: 'prix',
};
function reviewReason(fields: Set<string>): string {
  return `Import incomplet — à compléter : ${[...fields].map((f) => REVIEW_LABELS[f] ?? f).join(', ')}`;
}

/** Accepts a full Google Sheets URL or a bare spreadsheet ID. */
export function extractSpreadsheetId(input: string): string | null {
  const m = /\/spreadsheets\/d\/([a-zA-Z0-9-_]{20,})/.exec(input);
  if (m) return m[1] ?? null;
  return /^[a-zA-Z0-9-_]{20,}$/.test(input.trim()) ? input.trim() : null;
}

/** Worksheet tab id ("gid") from a Google Sheets URL (#gid=123 or ?gid=123); defaults to the first tab. */
export function extractGid(input: string): string {
  const m = /[#&?]gid=(\d+)/.exec(input);
  return m?.[1] ?? '0';
}
