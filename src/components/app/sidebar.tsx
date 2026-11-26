'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  BarChart3, GitMerge, LayoutDashboard, Megaphone, Package, Plug, Receipt, Scale, ScrollText, Settings, ShoppingBag, Truck, Users, Wallet,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { NavSection } from './nav';

const ICONS = { BarChart3, GitMerge, LayoutDashboard, Megaphone, Package, Plug, Receipt, Scale, ScrollText, Settings, ShoppingBag, Truck, Users, Wallet };

export function Sidebar({ sections, isAgent, onNavigate, variant = 'light' }: { sections: NavSection[]; isAgent: boolean; onNavigate?: () => void; variant?: 'light' | 'dark' }) {
  const dark = variant === 'dark';
  const t = useTranslations('nav');
  const pathname = usePathname();
  const allHrefs = sections.flatMap((s) => s.items.map((i) => i.href));
  // Longest matching prefix wins (so /products/matching doesn't also highlight /products)
  const active = allHrefs.filter((h) => pathname === h || pathname.startsWith(`${h}/`)).sort((a, b) => b.length - a.length)[0];
  return (
    <nav className="flex flex-col gap-6 px-3 py-4">
      {sections.map((section) =>
        section.items.length ? (
          <div key={section.key}>
            <div className={cn('mb-1.5 px-3 text-[11px] font-semibold uppercase tracking-wider', dark ? 'text-sidebar-muted/80' : 'text-muted-foreground')}>{t(section.key)}</div>
            <ul className="grid gap-0.5">
              {section.items.map((item) => {
                const Icon = ICONS[item.icon as keyof typeof ICONS];
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      onClick={onNavigate}
                      className={cn(
                        'group relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-all',
                        dark
                          ? 'text-sidebar-foreground/75 hover:bg-sidebar-accent hover:text-white'
                          : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                        active === item.href && (dark
                          ? 'bg-sidebar-accent font-medium text-white shadow-inner before:absolute before:inset-y-2 before:start-0 before:w-1 before:rounded-full before:bg-sidebar-active'
                          : 'bg-accent font-medium text-accent-foreground'),
                      )}
                    >
                      <Icon className={cn('size-[18px] transition-colors', dark && (active === item.href ? 'text-sidebar-active' : 'text-sidebar-muted group-hover:text-sidebar-active'))} />
                      {item.key === 'orders' && isAgent ? t('myOrders') : t(item.key)}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null,
      )}
    </nav>
  );
}
