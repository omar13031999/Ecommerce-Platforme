import { reviewReason, type ExternalOrder } from './mapping';

/** Shape returned by the AI extractor (kept here, free of server-only imports, so it can be unit-tested). */
export type AiRow = {
  customer_name: string | null; phone: string | null; phone2: string | null; wilaya_code: number | null;
  commune: string | null; address: string | null; delivery_type: 'home' | 'stopdesk';
  products: { name: string; sku: string | null; quantity: number; unit_price: number | null }[];
  total_amount: number | null; delivery_fee: number | null; notes: string | null;
  missing: string[];
};

const digits = (s: string | null) => (s ?? '').replace(/\D/g, '').replace(/^(00213|213)(?=\d{9}$)/, '0');
const validPhone = (p: string) => /^0[5-7]\d{8}$|^0[2-4]\d{7,8}$/.test(p);

/** Raw row as "header: value | …" so confirmers always see what the sheet said. */
export function rawRowText(cells: Record<string, string>): string {
  return Object.entries(cells).filter(([, v]) => String(v ?? '').trim()).map(([k, v]) => `${k}: ${String(v).trim()}`).join(' | ');
}

/** Turns one AI-extracted row into an order for upsert_external_order, flagging anything uncertain. */
export function aiRowToOrder(ai: AiRow, externalId: string, rowNumber: number, cells: Record<string, string>, orderedAt: string | null): ExternalOrder {
  const missing = new Set<string>();
  const phone = digits(ai.phone);
  const phone2 = digits(ai.phone2);
  if (!ai.customer_name?.trim()) missing.add('customer_name');
  if (!validPhone(phone)) missing.add('phone');
  const wilaya = ai.wilaya_code && ai.wilaya_code >= 1 && ai.wilaya_code <= 58 ? ai.wilaya_code : null;
  if (!wilaya) missing.add('wilaya');
  if (!ai.commune?.trim()) missing.add('commune');
  const items = ai.products
    .filter((p) => p.name?.trim() || p.sku?.trim())
    .map((p) => ({
      product_name: (p.name || p.sku || '').trim(), sku: p.sku?.trim() || null,
      quantity: Math.max(1, Math.round(p.quantity || 1)), unit_price: Math.max(0, Math.round((p.unit_price ?? 0) * 100) / 100),
    }));
  if (!items.length) missing.add('product_name');
  // A single product with no unit price but a known total: derive it from the total.
  if (items.length === 1 && items[0]!.unit_price === 0 && ai.total_amount) {
    items[0]!.unit_price = Math.max(0, Math.round(((ai.total_amount - (ai.delivery_fee ?? 0)) / items[0]!.quantity) * 100) / 100);
  }
  if (items.some((i) => i.unit_price === 0)) missing.add('product_price');
  for (const m of ai.missing) if (m === 'address' && ai.delivery_type === 'home') missing.add('address');

  const needsReview = missing.size > 0;
  return {
    external_id: externalId,
    customer_name: ai.customer_name?.trim() ?? '',
    phone: validPhone(phone) ? phone : (ai.phone ?? '').trim(),
    phone2: phone2 && phone2 !== phone ? phone2 : null,
    wilaya: wilaya ? String(wilaya) : null,
    commune: ai.commune?.trim() || null,
    address: ai.address?.trim() || null,
    customer_notes: ai.notes?.trim() || null,
    delivery_fee: ai.delivery_fee,
    total_amount: ai.total_amount,
    ordered_at: orderedAt,
    delivery_type: ai.delivery_type,
    items,
    row_numbers: [rowNumber],
    needs_review: needsReview,
    review_reason: needsReview ? `${reviewReason(missing)} — ligne d'origine : ${rawRowText(cells)}`.slice(0, 1000) : null,
  };
}
