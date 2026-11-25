'use client';
import { useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, KeyRound, Languages, LogOut, Menu, X } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { setLocale, signOut } from '@/lib/actions/auth';
import { useAction } from './use-action';
import { Sidebar } from './sidebar';
import type { NavSection } from './nav';
import { formatDateTime } from '@/lib/format';

type Notification = { id: number; type: string; params: Record<string, string | number>; link: string | null; read_at: string | null; created_at: string };

function NotificationsBell() {
  const t = useTranslations('notifications');
  const locale = useLocale() as 'fr' | 'ar';
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['notifications'],
    queryFn: async () => (await (await fetch('/api/notifications', { cache: 'no-store' })).json()) as { items: Notification[]; unread: number },
    refetchInterval: 60_000,
  });
  async function markAll() {
    await fetch('/api/notifications', { method: 'POST' });
    qc.invalidateQueries({ queryKey: ['notifications'] });
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={t('title')} className="relative">
          <Bell />
          {data?.unread ? (
            <span className="absolute -end-0.5 -top-0.5 flex size-4 items-center justify-center rounded-full bg-destructive text-[10px] text-destructive-foreground">
              {data.unread > 9 ? '9+' : data.unread}
            </span>
          ) : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <div className="flex items-center justify-between px-2 py-1">
          <DropdownMenuLabel className="p-0">{t('title')}</DropdownMenuLabel>
          {data?.unread ? <button className="text-xs text-primary hover:underline" onClick={markAll}>{t('markAllRead')}</button> : null}
        </div>
        <DropdownMenuSeparator />
        {!data?.items.length ? <div className="p-3 text-sm text-muted-foreground">{t('empty')}</div> : null}
        {data?.items.map((n) => (
          <DropdownMenuItem key={n.id} asChild>
            <Link href={n.link ?? '#'} className={n.read_at ? 'opacity-60' : ''}>
              <div className="grid gap-0.5">
                <span className="text-sm">{t.has(n.type) ? t(n.type, n.params as Record<string, string>) : n.type}</span>
                <span className="text-xs text-muted-foreground">{formatDateTime(n.created_at, locale)}</span>
              </div>
            </Link>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function Topbar({ name, roleLabel, sections, isAgent }: { name: string; roleLabel: string; sections: NavSection[]; isAgent: boolean }) {
  const t = useTranslations('common');
  const tAccount = useTranslations('account');
  const locale = useLocale();
  const { run } = useAction();
  const [open, setOpen] = useState(false);
  return (
    <>
      <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b bg-card/90 px-3 backdrop-blur md:px-5">
        <Button variant="ghost" size="icon" className="md:hidden" onClick={() => setOpen(true)} aria-label="Menu">
          <Menu />
        </Button>
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="sm"
          onClick={() => run(() => setLocale(locale === 'fr' ? 'ar' : 'fr'))}
          aria-label={t('language')}
        >
          <Languages />
          {locale === 'fr' ? 'العربية' : 'Français'}
        </Button>
        <NotificationsBell />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="gap-2">
              <span className="flex size-7 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">
                {name.slice(0, 2).toUpperCase()}
              </span>
              <span className="hidden text-start sm:block">
                <span className="block text-sm leading-tight">{name}</span>
                <span className="block text-[11px] leading-tight text-muted-foreground">{roleLabel}</span>
              </span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem asChild>
              <Link href="/account"><KeyRound className="size-4" /> {tAccount('menu')}</Link>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => signOut()}>
              <LogOut className="size-4" /> {t('logout')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>
      {open ? (
        <div className="fixed inset-0 z-50 md:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 start-0 w-64 overflow-y-auto border-e bg-card">
            <div className="flex h-14 items-center justify-end px-3">
              <Button variant="ghost" size="icon" onClick={() => setOpen(false)} aria-label={t('close')}><X /></Button>
            </div>
            <Sidebar sections={sections} isAgent={isAgent} onNavigate={() => setOpen(false)} />
          </aside>
        </div>
      ) : null}
    </>
  );
}
