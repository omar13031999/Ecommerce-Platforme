import type { Permission } from '@/lib/auth/permissions';

export type NavItem = { href: string; key: string; icon: string; any?: Permission[] };
export type NavSection = { key: string; items: NavItem[] };

/** `any`: visible if the user holds at least one of these permissions. */
export const NAV: NavSection[] = [
  {
    key: 'sectionOperations',
    items: [
      { href: '/dashboard', key: 'dashboard', icon: 'LayoutDashboard' },
      { href: '/orders', key: 'orders', icon: 'ShoppingBag' },
      { href: '/delivery', key: 'delivery', icon: 'Truck', any: ['delivery.view'] },
      { href: '/products', key: 'products', icon: 'Package', any: ['products.manage', 'products.create', 'finance.view'] },
      { href: '/products/matching', key: 'matching', icon: 'GitMerge', any: ['products.manage', 'orders.manage'] },
      { href: '/analytics', key: 'analytics', icon: 'BarChart3', any: ['reports.operational', 'finance.view'] },
    ],
  },
  {
    key: 'sectionFinance',
    items: [
      { href: '/finance', key: 'finance', icon: 'Wallet', any: ['finance.view'] },
      { href: '/delivery/reconciliation', key: 'reconciliation', icon: 'Scale', any: ['finance.view'] },
      { href: '/expenses', key: 'expenses', icon: 'Receipt', any: ['finance.view', 'expenses.manage'] },
      { href: '/ads', key: 'ads', icon: 'Megaphone', any: ['ads.view', 'finance.view'] },
    ],
  },
  {
    key: 'sectionAdmin',
    items: [
      { href: '/team', key: 'team', icon: 'Users', any: ['team.view'] },
      { href: '/settings', key: 'settings', icon: 'Settings', any: ['settings.manage'] },
      { href: '/settings/integrations', key: 'integrations', icon: 'Plug', any: ['integrations.manage'] },
      { href: '/settings/audit', key: 'audit', icon: 'ScrollText', any: ['settings.manage'] },
    ],
  },
];
