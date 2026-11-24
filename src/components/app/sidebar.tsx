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

export function Sidebar({ sections, isAgent, onNavigate }: { sections: NavSection[]; isAgent: boolean; onNavigate?: () => void }) {
  const t = useTranslations('nav');
  const pathname = usePathname();
  const allHrefs = sections.flatMap((s) => s.items.map((i) => i.href));
  // Longest matching prefix wins (so /products/matching doesn't also highlight /products)
  const active = allHrefs.filter((h) => pathname === h || pathname.startsWith(`${h}/`)).sort((a, b) => b.length - a.length)[0];
  return (
    <nav className="flex flex-col gap-5 p-3">
      {sections.map((section) =>
        section.items.length ? (
          <div key={section.key}>
            <div className="mb-1 px-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{t(section.key)}</div>
            <ul className="grid gap-0.5">
              {section.items.map((item) => {
                const Icon = ICONS[item.icon as keyof typeof ICONS];
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      onClick={onNavigate}
                      className={cn(
                        'flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground',
                        active === item.href && 'bg-accent font-medium text-accent-foreground',
                      )}
                    >
                      <Icon className="size-4" />
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
