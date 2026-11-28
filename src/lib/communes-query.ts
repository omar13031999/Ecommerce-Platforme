import type { SupabaseClient } from '@supabase/supabase-js';

export type CommuneRow = { wilaya_code: number; name: string; has_stop_desk: boolean };

/**
 * All active communes (≈1 550). The API returns at most 1 000 rows per request
 * whatever .range() asks, so the list is read page by page.
 */
export async function loadCommunes(supabase: SupabaseClient): Promise<{ data: CommuneRow[] }> {
  const PAGE = 1000;
  const out: CommuneRow[] = [];
  for (let from = 0; from < 20_000; from += PAGE) {
    const { data, error } = await supabase.from('communes').select('wilaya_code, name, has_stop_desk')
      .eq('is_active', true).order('wilaya_code').order('name').order('id').range(from, from + PAGE - 1);
    if (error) throw error;
    out.push(...((data ?? []) as CommuneRow[]));
    if (!data || data.length < PAGE) break;
  }
  out.sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  return { data: out };
}
