import { getTranslations } from 'next-intl/server';
import { LoginForm } from './login-form';

export async function generateMetadata() {
  const t = await getTranslations('auth');
  return { title: t('title') };
}

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  const t = await getTranslations();
  return (
    <main className="grid min-h-screen lg:grid-cols-2">
      <section className="bg-brand relative hidden overflow-hidden p-12 text-white lg:flex lg:flex-col lg:justify-between">
        <div className="pointer-events-none absolute -end-24 -top-24 size-96 rounded-full bg-white/10 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-32 -start-16 size-[28rem] rounded-full bg-black/10 blur-3xl" />
        <div className="relative flex items-center gap-3">
          <span className="flex size-11 items-center justify-center rounded-xl bg-white/15 text-base font-bold ring-1 ring-white/30">GC</span>
          <span className="text-lg font-semibold">{t('app.name')}</span>
        </div>
        <div className="relative max-w-md">
          <h2 className="text-4xl font-bold leading-tight">{t('auth.heroTitle')}</h2>
          <p className="mt-4 text-white/80">{t('auth.heroText')}</p>
        </div>
        <p className="relative text-sm text-white/60">{t('app.tagline')}</p>
      </section>
      <section className="flex items-center justify-center p-6">
        <div className="w-full max-w-sm">
          <div className="mb-8 text-center lg:text-start">
            <div className="bg-brand mx-auto mb-4 flex size-12 items-center justify-center rounded-xl text-lg font-bold text-white shadow-lg shadow-primary/30 lg:hidden">GC</div>
            <h1 className="text-2xl font-bold">{t('app.name')}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{t('app.tagline')}</p>
          </div>
          <LoginForm next={next ?? ''} />
        </div>
      </section>
    </main>
  );
}
