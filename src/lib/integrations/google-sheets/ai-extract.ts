import 'server-only';
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';

/**
 * AI extraction of order rows whose columns are mixed up or inconsistent
 * (phone in the name column, "wilaya - commune" in one cell, product + price
 * in a free-text cell…). Claude reads each raw row with its headers and returns
 * normalised fields. Values that are not in the row are returned as null —
 * never invented — and listed in `missing` so the confirmers complete them.
 */

const ROWS_PER_REQUEST = 15;
const GATEWAY_URL = 'https://ai-gateway.vercel.sh';
/** Default model through Vercel AI Gateway (no key needed on Vercel; cheapest Claude with structured output). */
const GATEWAY_DEFAULT_MODEL = 'anthropic/claude-haiku-5.5';
/** Default model with a direct Anthropic API key. */
const DIRECT_DEFAULT_MODEL = 'claude-opus-5-5';

const directKey = () => (/^sk-ant-/.test(process.env.ANTHROPIC_API_KEY?.trim() ?? '') ? process.env.ANTHROPIC_API_KEY!.trim() : null);

/**
 * Two ways to reach the model:
 *  - direct Anthropic API, when ANTHROPIC_API_KEY holds a real key (sk-ant-…);
 *  - otherwise Vercel AI Gateway, authenticated with the deployment's OIDC token
 *    (automatic on Vercel, draws on the team's AI Gateway credits) or AI_GATEWAY_API_KEY.
 * AI_EXTRACT_MODEL overrides the model (gateway ids look like "anthropic/claude-haiku-5.5").
 */
export function aiExtractionAvailable(): boolean {
  return Boolean(directKey() || process.env.AI_GATEWAY_API_KEY?.trim() || process.env.VERCEL === '1');
}

async function aiClient(): Promise<{ client: Anthropic; model: string; direct: boolean } | null> {
  const key = directKey();
  if (key) return { client: new Anthropic({ apiKey: key }), model: process.env.AI_EXTRACT_MODEL?.trim() || DIRECT_DEFAULT_MODEL, direct: true };
  let token = process.env.AI_GATEWAY_API_KEY?.trim() || null;
  if (!token) {
    try {
      const { getVercelOidcToken } = await import('@vercel/oidc');
      token = (await getVercelOidcToken()) || null;
    } catch {
      token = null;
    }
  }
  if (!token) return null;
  return { client: new Anthropic({ apiKey: token, baseURL: GATEWAY_URL }), model: process.env.AI_EXTRACT_MODEL?.trim() || GATEWAY_DEFAULT_MODEL, direct: false };
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
  const results = new Map<number, AiExtractedRow>();
  const errors: string[] = [];
  const ai = await aiClient();
  if (!ai) return { results, errors: ['ai_not_configured'] };
  const system: Anthropic.TextBlockParam[] = [
    { type: 'text', text: SYSTEM },
    // Stable prefix (instructions + catalogue) is cached across batches and syncs.
    { type: 'text', text: catalogBlock(catalog), cache_control: { type: 'ephemeral' } },
  ];

  for (let i = 0; i < rows.length; i += ROWS_PER_REQUEST) {
    const batch = rows.slice(i, i + ROWS_PER_REQUEST);
    const input = batch.map((r) => ({ row: r.row, cells: Object.fromEntries(Object.entries(r.cells).filter(([, v]) => String(v ?? '').trim())) }));
    try {
      const out = await callModel(ai, system, `Extract these ${input.length} rows:\n${JSON.stringify(input)}`);
      if (out === 'refusal') {
        errors.push(`refusal rows ${batch[0]!.row}-${batch[batch.length - 1]!.row}`);
        continue;
      }
      const wanted = new Set(batch.map((r) => r.row));
      for (const o of out.orders) if (wanted.has(o.row)) results.set(o.row, o);
    } catch (e) {
      const err = describeError(e);
      errors.push(err);
      if (/^ai_(invalid_api_key|gateway_credits|rate_limited)/.test(err)) break; // remaining rows retried next sync
    }
  }
  return { results, errors };
}

type AiConn = NonNullable<Awaited<ReturnType<typeof aiClient>>>;

/** First JSON object in a text answer (tolerates ```json fences or a sentence around it). */
export function parseJsonAnswer(text: string): z.infer<typeof ExtractionResult> | null {
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try {
    const r = ExtractionResult.safeParse(JSON.parse(text.slice(a, b + 1)));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

/**
 * Structured output first; if the endpoint rejects that request shape (some
 * gateway/provider routes do not accept output_config), ask for plain JSON text
 * and validate it with the same schema.
 */
async function callModel(ai: AiConn, system: Anthropic.TextBlockParam[], userText: string): Promise<z.infer<typeof ExtractionResult> | 'refusal'> {
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: userText }];
  try {
    const response = ai.direct
      // Direct API: server-side refusal fallback (AI Gateway has its own provider failover).
      ? await ai.client.beta.messages.parse({
        model: ai.model, max_tokens: 16000, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default', system,
        output_config: { format: betaZodOutputFormat(ExtractionResult) }, messages,
      })
      : await ai.client.messages.parse({ model: ai.model, max_tokens: 16000, system, output_config: { format: zodOutputFormat(ExtractionResult) }, messages });
    if (response.stop_reason === 'refusal') return 'refusal';
    if (response.parsed_output) return response.parsed_output;
  } catch (e) {
    if (!(e instanceof Anthropic.BadRequestError || e instanceof Anthropic.NotFoundError || e instanceof Anthropic.UnprocessableEntityError
      || (e instanceof Error && !(e instanceof Anthropic.APIError)))) throw e;
    console.warn('[ai] structured output rejected, retrying as plain JSON:', describeError(e));
  }
  const response = await ai.client.messages.create({
    model: ai.model, max_tokens: 16000, system,
    messages: [{ role: 'user', content: `${userText}\n\nAnswer with ONLY a JSON object {"orders": [...]} following the rules, no other text.` }],
  });
  if (response.stop_reason === 'refusal') return 'refusal';
  const text = response.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
  const parsed = parseJsonAnswer(text);
  if (!parsed) throw new Error(`invalid_json_answer: ${text.slice(0, 120)}`);
  return parsed;
}

function describeError(e: unknown): string {
  if (e instanceof Anthropic.AuthenticationError) return `ai_invalid_api_key: ${e.message}`.slice(0, 200);
  if (e instanceof Anthropic.RateLimitError) return 'ai_rate_limited';
  if (e instanceof Anthropic.APIError && (e.status === 402 || /credit|verification|budget|payment/i.test(e.message))) {
    return `ai_gateway_credits: ${e.message}`.slice(0, 200);
  }
  if (e instanceof Anthropic.APIError) return `ai_api_error ${e.status ?? ''}: ${e.message}`.slice(0, 200);
  return `ai_error: ${(e as Error)?.message ?? String(e)}`.slice(0, 200);
}

/** One tiny extraction to tell, in the logs, whether the AI path works in this deployment. */
export async function aiSelfTest(): Promise<string> {
  const ai = await aiClient();
  if (!ai) return 'ai_not_configured (no key, no OIDC token)';
  try {
    const out = await callModel(ai, [{ type: 'text', text: SYSTEM }], 'Extract these 1 rows:\n[{"row":1,"cells":{"Nom":"0555 12 34 56","Téléphone":"Karim","Adresse":"Alger - Kouba"}}]');
    if (out === 'refusal') return `refusal (${ai.model})`;
    const o = out.orders[0];
    return `ok via ${ai.direct ? 'anthropic' : 'gateway'} ${ai.model}: phone=${o?.phone} name=${o?.customer_name} wilaya=${o?.wilaya_code}`;
  } catch (e) {
    return `${describeError(e)} (via ${ai.direct ? 'anthropic' : 'gateway'} ${ai.model})`;
  }
}
