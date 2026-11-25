import 'server-only';
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';

/**
 * AI extraction of order rows whose columns are mixed up or inconsistent
 * (phone in the name column, "wilaya - commune" in one cell, product + price
 * in a free-text cell…). Claude reads each raw row with its headers and returns
 * normalised fields. Values that are not in the row are returned as null —
 * never invented — and listed in `missing` so the confirmers complete them.
 */

const MODEL = 'claude-opus-5-5';
const ROWS_PER_REQUEST = 15;

export function aiExtractionAvailable(): boolean {
  // Anthropic API keys start with "sk-ant-"; a placeholder value means "not configured yet".
  return /^sk-ant-/.test(process.env.ANTHROPIC_API_KEY?.trim() ?? '');
}

const ExtractedRow = z.object({
  row: z.number().int().describe('The row number given in the input'),
  customer_name: z.string().nullable(),
  phone: z.string().nullable().describe('Main phone, digits only, Algerian format starting with 0 (e.g. 0555123456)'),
  phone2: z.string().nullable(),
  wilaya_code: z.number().int().nullable().describe('Algerian wilaya code 1-58'),
  commune: z.string().nullable().describe('Commune name in Latin script (official French spelling)'),
  address: z.string().nullable(),
  delivery_type: z.enum(['home', 'stopdesk']),
  products: z.array(z.object({
    name: z.string().describe('Product as written, or the exact catalogue name when it clearly matches'),
    sku: z.string().nullable().describe('Catalogue reference when the product clearly matches one, else null'),
    quantity: z.number().int(),
    unit_price: z.number().nullable(),
  })),
  total_amount: z.number().nullable().describe('Total to collect from the customer, when written in the row'),
  delivery_fee: z.number().nullable(),
  notes: z.string().nullable().describe('Customer remarks worth keeping (colour, size, delivery time…)'),
  missing: z.array(z.enum(['customer_name', 'phone', 'wilaya', 'commune', 'address', 'product', 'price'])),
});
const ExtractionResult = z.object({ orders: z.array(ExtractedRow) });
export type AiExtractedRow = z.infer<typeof ExtractedRow>;

const SYSTEM = `You extract e-commerce orders (cash on delivery, Algeria) from spreadsheet rows.
Rows come from landing pages and Google Sheets filled by hand, so columns are often wrong or mixed:
a phone number can sit in the name column, "Alger - Bab Ezzouar" can be in one cell, product and price can be one text.
Read every cell of the row, whatever its header, and return one object per input row (same "row" number).

Rules:
- Only use information present in the row. Never invent a value: use null and list the field in "missing".
- phone: Algerian numbers. Remove spaces, dots, "+213"/"00213" (replace by 0). Mobile = 10 digits starting 05/06/07; fixed = 9 digits starting 02-04. A second number goes to phone2.
- customer_name: the person's name only (no phone, no city). Keep Arabic names in Arabic.
- wilaya_code: 1-58 (the 58 Algerian wilayas, e.g. 16 Alger, 31 Oran, 25 Constantine, 9 Blida, 8 Béchar). Accept names in Arabic, French, with typos, or the number.
- commune: Latin-script official French spelling used by Algerian delivery companies (transliterate from Arabic, e.g. "باب الزوار" -> "Bab Ezzouar"). Never put a delivery type, wilaya or address in it.
- delivery_type: "stopdesk" when the row says office/bureau/agence/stop desk/مكتب/التوصيل للمكتب, otherwise "home".
- products: one entry per product; quantity defaults to 1. If a catalogue product clearly matches (same model and size), use its exact name and reference.
- unit_price / total_amount / delivery_fee: numbers in DZD (accept "4 500 DA", "4.500", "4500دج").
- notes: useful remarks only; do not repeat fields already extracted.`;

function catalogBlock(catalog: { name: string; sku: string | null }[]): string {
  if (!catalog.length) return 'Product catalogue: (empty)';
  return `Product catalogue (reference | name):\n${catalog.map((p) => `${p.sku ?? '-'} | ${p.name}`).join('\n')}`;
}

/**
 * Extracts rows in batches. Returns the rows that were extracted, keyed by row
 * number; rows that failed (API error, refusal) are simply absent so the caller
 * can fall back to column mapping for them.
 */
export async function extractRowsWithAI(
  rows: { row: number; cells: Record<string, string> }[],
  catalog: { name: string; sku: string | null }[],
): Promise<{ results: Map<number, AiExtractedRow>; errors: string[] }> {
  const client = new Anthropic();
  const results = new Map<number, AiExtractedRow>();
  const errors: string[] = [];
  const system: Anthropic.Beta.BetaTextBlockParam[] = [
    { type: 'text', text: SYSTEM },
    // Stable prefix (instructions + catalogue) is cached across batches and syncs.
    { type: 'text', text: catalogBlock(catalog), cache_control: { type: 'ephemeral' } },
  ];

  for (let i = 0; i < rows.length; i += ROWS_PER_REQUEST) {
    const batch = rows.slice(i, i + ROWS_PER_REQUEST);
    const input = batch.map((r) => ({ row: r.row, cells: Object.fromEntries(Object.entries(r.cells).filter(([, v]) => String(v ?? '').trim())) }));
    try {
      const response = await client.beta.messages.parse({
        model: MODEL,
        max_tokens: 16000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system,
        output_config: { effort: 'low', format: betaZodOutputFormat(ExtractionResult) },
        messages: [{ role: 'user', content: `Extract these ${input.length} rows:\n${JSON.stringify(input)}` }],
      });
      if (response.stop_reason === 'refusal') {
        errors.push(`refusal rows ${batch[0]!.row}-${batch[batch.length - 1]!.row}`);
        continue;
      }
      const wanted = new Set(batch.map((r) => r.row));
      for (const o of response.parsed_output?.orders ?? []) if (wanted.has(o.row)) results.set(o.row, o);
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError) {
        errors.push('ai_invalid_api_key');
        break;
      }
      if (e instanceof Anthropic.RateLimitError) {
        errors.push('ai_rate_limited');
        break; // remaining rows are retried on the next sync
      }
      errors.push(e instanceof Anthropic.APIError ? `ai_api_error ${e.status ?? ''}: ${e.message}`.slice(0, 200) : `ai_error: ${(e as Error).message}`.slice(0, 200));
    }
  }
  return { results, errors };
}
