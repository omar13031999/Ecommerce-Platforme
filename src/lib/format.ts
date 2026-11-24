export type AppLocale = 'fr' | 'ar';

function intlLocale(locale: AppLocale) {
  // Arabic UI with Latin digits is the common convention for DZD amounts in Algeria.
  return locale === 'ar' ? 'ar-DZ-u-nu-latn' : 'fr-DZ';
}

export function formatDZD(value: number | string | null | undefined, locale: AppLocale = 'fr'): string {
  if (value === null || value === undefined || value === '') return '—';
  const raw = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(raw)) return '—';
  const n = Object.is(raw, -0) || Math.abs(raw) < 0.005 ? 0 : raw;
  return `${new Intl.NumberFormat(intlLocale(locale), { maximumFractionDigits: 2, minimumFractionDigits: 0 }).format(n)} ${locale === 'ar' ? 'د.ج' : 'DA'}`;
}

export function formatNumber(value: number | string | null | undefined, locale: AppLocale = 'fr', digits = 0): string {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return new Intl.NumberFormat(intlLocale(locale), { maximumFractionDigits: digits }).format(n);
}

export function formatPercent(value: number | string | null | undefined, locale: AppLocale = 'fr'): string {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return new Intl.NumberFormat(intlLocale(locale), { style: 'percent', maximumFractionDigits: 1 }).format(n);
}

export function formatDateTime(value: string | Date | null | undefined, locale: AppLocale = 'fr'): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat(intlLocale(locale), {
    dateStyle: 'short',
    timeStyle: 'short',
    hourCycle: 'h23',
    timeZone: 'Africa/Algiers',
  }).format(new Date(value));
}

export function formatDate(value: string | Date | null | undefined, locale: AppLocale = 'fr'): string {
  if (!value) return '—';
  const d = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00Z`) : new Date(value);
  return new Intl.DateTimeFormat(intlLocale(locale), { dateStyle: 'medium', timeZone: 'Africa/Algiers' }).format(d);
}
