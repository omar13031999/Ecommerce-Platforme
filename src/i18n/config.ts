export const LOCALES = ['fr', 'ar'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'fr';
export const LOCALE_COOKIE = 'NEXT_LOCALE';
export const isLocale = (v: unknown): v is Locale => v === 'fr' || v === 'ar';
export const dirOf = (l: Locale) => (l === 'ar' ? 'rtl' : 'ltr');
