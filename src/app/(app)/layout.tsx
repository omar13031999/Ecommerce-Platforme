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
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 overflow-y-auto bg-sidebar text-sidebar-foreground md:block">
        <Link href="/dashboard" className="flex h-16 items-center gap-3 px-5">
          <span className="bg-brand flex size-9 items-center justify-center rounded-xl text-sm font-bold text-white shadow-lg shadow-black/20 ring-1 ring-white/20">GC</span>
          <span className="grid leading-tight">
            <span className="text-sm font-semibold text-white">{t('app.name')}</span>
            <span className="text-[11px] text-sidebar-muted">{t('app.tagline')}</span>
          </span>
        </Link>
        <Sidebar sections={sections} isAgent={isAgent} variant="dark" />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar name={session.profile.full_name || session.profile.email || ''} roleLabel={t(`team.role_${session.profile.role}`)} sections={sections} isAgent={isAgent} />
        <main className="mx-auto w-full min-w-0 max-w-[1400px] flex-1 p-4 md:p-6">{children}</main>
      </div>
    </div>
  );
}
