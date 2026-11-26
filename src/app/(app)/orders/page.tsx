import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { Plus } from 'lucide-react';
import { requirePage } from '@/lib/auth/session';
import { createClient } from '@/lib/supabase/server';
import { applyOrderFilters, ORDER_VIEWS, orderSelect, sortOf, viewRule, type OrderSearchParams, type OrderView } from '@/lib/orders-query';
import { cn } from '@/lib/utils';
import { fromDbError } from '@/lib/errors';
import { PageHeader } from '@/components/app/page-header';
import { Pagination } from '@/components/app/pagination';
import { buttonVariants } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { OrdersFilters } from './orders-filters';
import { OrdersTable, type OrderRow } from './orders-table';
import type { AppLocale } from '@/lib/format';

export default async function OrdersPage({ searchParams }: { searchParams: Promise<OrderSearchParams> }) {
  const session = await requirePage();
  const sp = await searchParams;
  const t = await getTranslations();
  const locale = (await getLocale()) as AppLocale;
  const supabase = await createClient();

  const page = Math.max(1, Number(sp.page) || 1);
  const size = [25, 50, 100].includes(Number(sp.size)) ? Number(sp.size) : 25;
  const { data: ws } = await supabase.rpc('workload_statuses');
  const workload = (ws ?? ['new']) as string[];

  const base = supabase.from('orders').select(orderSelect(sp), { count: 'exact' });
  const { query } = applyOrderFilters(base, sp, workload);
  const { col, ascending } = sortOf(sp);
  const { data, count, error } = await query.order(col, { ascending }).order('id').range((page - 1) * size, page * size - 1);
  if (error) throw fromDbError(error);

  // Tab counters (RLS applies: confirmers count only their own orders).
  const counts = await Promise.all((['process', 'confirmed', 'tracking', 'closed'] as const).map(async (v) => {
    const rule = viewRule(v);
    let cq = supabase.from('orders').select('id', { count: 'exact', head: true });
    if (rule.status) cq = cq.in('confirmation_status', rule.status);
    if (rule.delivery) cq = cq.in('delivery_status', rule.delivery);
    if (rule.notDelivery) cq = cq.not('delivery_status', 'in', `(${rule.notDelivery.join(',')})`);
    return (await cq).count ?? 0;
  }));
  const view = ORDER_VIEWS.includes(sp.view as OrderView) ? (sp.view as OrderView) : sp.status || sp.delivery ? 'all' : 'process';
  const tabs = [
    { key: 'process', href: '/orders', label: t('orders.tabToProcess'), count: counts[0]! },
    { key: 'confirmed', href: '/orders?view=confirmed', label: t('orders.tabConfirmed'), count: counts[1]! },
    { key: 'tracking', href: '/orders?view=tracking&sort=updated_at&dir=desc', label: t('orders.tabTracking'), count: counts[2]! },
    { key: 'closed', href: '/orders?view=closed&sort=updated_at&dir=desc', label: t('orders.tabClosed'), count: counts[3]! },
  ];

  const canAssign = session.can('orders.assign');
  const [agentsRes, productsRes, wilayasRes, providersRes] = await Promise.all([
    session.can('orders.view_all') ? supabase.from('staff_directory').select('id, full_name, role, is_active').order('full_name') : Promise.resolve({ data: [] }),
    supabase.from('products').select('id, name').eq('is_archived', false).order('name'),
    supabase.from('wilayas').select('code, name_fr, name_ar').order('code'),
    session.can('delivery.manage') ? supabase.from('delivery_providers').select('id, name, code').eq('is_active', true).order('name') : Promise.resolve({ data: [] }),
  ]);
  const staff = (agentsRes.data ?? []) as { id: string; full_name: string; role: string; is_active: boolean }[];
  const agentNames = Object.fromEntries(staff.map((a) => [a.id, a.full_name]));

  return (
    <div>
      <PageHeader
        title={session.profile.role === 'agent' ? t('orders.myTitle') : t('orders.title')}
        actions={session.can('orders.create') ? (
          <Link href="/orders/new" className={buttonVariants()}><Plus />{t('orders.new')}</Link>
        ) : null}
      />
      <nav className="mb-4 flex flex-wrap gap-1.5 rounded-xl border border-border/70 bg-card p-1.5 shadow-sm" aria-label={t('orders.title')}>
        {tabs.map((tab) => (
          <Link key={tab.key} href={tab.href} className={cn('flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition-all',
            view === tab.key ? 'bg-brand text-white shadow-md shadow-primary/25' : 'text-muted-foreground hover:bg-muted hover:text-foreground')}>
            {tab.label}
            <span className={cn('rounded-full px-2 py-0.5 text-xs tabular', view === tab.key ? 'bg-white/20 text-white' : 'bg-muted text-foreground')}>{tab.count}</span>
          </Link>
        ))}
      </nav>
      <OrdersFilters
        agents={staff.filter((a) => a.role === 'agent')}
        products={productsRes.data ?? []}
        wilayas={(wilayasRes.data ?? []).map((w) => ({ code: w.code, name: locale === 'ar' ? w.name_ar : w.name_fr }))}
        showAgentFilter={session.can('orders.view_all')}
        canExport={session.can('orders.export')}
      />
      <Card className="mt-4 overflow-hidden">
        <OrdersTable
          rows={(data ?? []) as unknown as OrderRow[]}
          agentNames={agentNames}
          agents={staff.filter((a) => a.role === 'agent' && a.is_active)}
          providers={(providersRes.data ?? []) as { id: string; name: string; code: string }[]}
          canAssign={canAssign}
          canSubmit={session.can('delivery.manage')}
          showAgent={session.can('orders.view_all')}
          sort={{ col, dir: ascending ? 'asc' : 'desc' }}
          currentUserId={session.userId}
          isManager={session.can('orders.manage')}
          canDelete={session.profile.role === 'admin'}
        />
      </Card>
      <Pagination page={page} pageSize={size} total={count ?? 0} searchParams={sp as Record<string, string | undefined>} />
    </div>
  );
}
