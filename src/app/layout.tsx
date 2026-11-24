import type { Metadata } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages, getTranslations } from 'next-intl/server';
import { dirOf, type Locale } from '@/i18n/config';
import { Providers } from '@/components/app/providers';
import './globals.css';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('app');
  return { title: { default: t('name'), template: `%s · ${t('name')}` }, description: t('tagline'), robots: { index: false, follow: false } };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = (await getLocale()) as Locale;
  const messages = await getMessages();
  const dir = dirOf(locale);
  return (
    <html lang={locale} dir={dir} suppressHydrationWarning>
      <body>
        <NextIntlClientProvider locale={locale} messages={messages} timeZone="Africa/Algiers">
          <Providers dir={dir}>{children}</Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
