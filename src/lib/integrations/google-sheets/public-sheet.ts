import 'server-only';
import Papa from 'papaparse';
import { ProviderError } from '@/lib/integrations/http';

/**
 * Reads a Google Sheet shared as "Anyone with the link can view" through
 * Google's public CSV export — no Google Cloud project or OAuth needed.
 * worksheet is stored as "gid:<tab id>".
 */
export async function readPublicSheet(spreadsheetId: string, worksheet: string, headerRow: number) {
  const gid = /^gid:(\d+)$/.exec(worksheet)?.[1] ?? '0';
  const url = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(spreadsheetId)}/export?format=csv&gid=${gid}`;
  let res: Response;
  try {
    res = await fetch(url, { redirect: 'follow', cache: 'no-store', signal: AbortSignal.timeout(45000) });
  } catch (e) {
    throw new ProviderError('ambiguous', `network_error: ${(e as Error).message}`);
  }
  const type = res.headers.get('content-type') ?? '';
  if (res.status === 401 || res.status === 403 || res.status === 404 || type.includes('text/html')) {
    throw new ProviderError('auth', 'sheet_not_public');
  }
  if (!res.ok) throw new ProviderError(res.status >= 500 ? 'ambiguous' : 'validation', `http_${res.status}`);
  const text = await res.text();
  const parsed = Papa.parse<string[]>(text, { skipEmptyLines: false });
  const rows = parsed.data.slice(Math.max(0, headerRow - 1));
  return { header: (rows[0] ?? []).map((h) => String(h ?? '')), rows: rows.slice(1) };
}
