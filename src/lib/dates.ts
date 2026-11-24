/** Date-range presets, computed in Africa/Algiers (UTC+1, no DST). */
export const RANGE_PRESETS = ['today', 'yesterday', 'last7', 'last30', 'this_month', 'prev_month', 'custom'] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];
export type DateRange = { from: string; to: string; preset: RangePreset };

const ALGIERS_OFFSET_MS = 60 * 60 * 1000;

export function todayInAlgiers(now = new Date()): string {
  return new Date(now.getTime() + ALGIERS_OFFSET_MS).toISOString().slice(0, 10);
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export function resolveRange(
  params: { range?: string; from?: string; to?: string },
  fallback: RangePreset = 'last30',
  now = new Date(),
): DateRange {
  const today = todayInAlgiers(now);
  const preset = (RANGE_PRESETS as readonly string[]).includes(params.range ?? '') ? (params.range as RangePreset) : fallback;
  switch (preset) {
    case 'today':
      return { from: today, to: today, preset };
    case 'yesterday': {
      const y = addDays(today, -1);
      return { from: y, to: y, preset };
    }
    case 'last7':
      return { from: addDays(today, -6), to: today, preset };
    case 'last30':
      return { from: addDays(today, -29), to: today, preset };
    case 'this_month':
      return { from: `${today.slice(0, 7)}-01`, to: today, preset };
    case 'prev_month': {
      const firstThis = `${today.slice(0, 7)}-01`;
      const lastPrev = addDays(firstThis, -1);
      return { from: `${lastPrev.slice(0, 7)}-01`, to: lastPrev, preset };
    }
    case 'custom': {
      let from = params.from && ISO.test(params.from) ? params.from : addDays(today, -29);
      let to = params.to && ISO.test(params.to) ? params.to : today;
      if (from > to) [from, to] = [to, from];
      return { from, to, preset };
    }
  }
}

/** Start/end instants (UTC ISO strings) covering local Algiers days [from, to]. */
export function rangeToInstants(range: { from: string; to: string }) {
  const start = new Date(new Date(`${range.from}T00:00:00Z`).getTime() - ALGIERS_OFFSET_MS).toISOString();
  const end = new Date(new Date(`${addDays(range.to, 1)}T00:00:00Z`).getTime() - ALGIERS_OFFSET_MS).toISOString();
  return { start, end };
}
