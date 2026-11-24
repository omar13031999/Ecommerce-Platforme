import { cookies } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';
import { DEFAULT_LOCALE, LOCALE_COOKIE, isLocale } from './config';

/**
 * The locale is the user's saved preference (profiles.locale), mirrored into a
 * cookie at sign-in and on every language switch. French is the default.
 */
export default getRequestConfig(async () => {
  const store = await cookies();
  const value = store.get(LOCALE_COOKIE)?.value;
  const locale = isLocale(value) ? value : DEFAULT_LOCALE;
  return {
    locale,
    timeZone: 'Africa/Algiers',
    messages: (await import(`../../messages/${locale}.json`)).default,
  };
});
