import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { requirePage } from '@/lib/auth/session';
import { NAV } from '@/components/app/nav';
import { Sidebar } from '@/components/app/sidebar';
import { Topbar } from '@/components/app/topbar';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await requirePage();
  const t = await getTranslations();
  const sections = NAV.map((s) => ({ ...s, items: s.items.filter((i) => !i.any || i.any.some((p) => session.can(p))) }));
  const isAgent = session.profile.role === 'agent';
  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 overflow-y-auto border-e bg-card md:block">
        <Link href="/dashboard" className="flex h-14 items-center gap-2 border-b px-4">
          <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-sm font-bold text-primary-foreground">GC</span>
          <span className="text-sm font-semibold">{t('app.name')}</span>
        </Link>
        <Sidebar sections={sections} isAgent={isAgent} />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar name={session.profile.full_name || session.profile.email || ''} roleLabel={t(`team.role_${session.profile.role}`)} sections={sections} isAgent={isAgent} />
        <main className="mx-auto w-full min-w-0 max-w-[1400px] flex-1 p-4 md:p-6">{children}</main>
      </div>
    </div>
  );
}
