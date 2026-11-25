import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { Plus } from 'lucide-react';
import { requirePage } from '@/lib/auth/session';
import { createClient } from '@/lib/supabase/server';
import { applyOrderFilters, orderSelect, sortOf, type OrderSearchParams } from '@/lib/orders-query';
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
        />
      </Card>
      <Pagination page={page} pageSize={size} total={count ?? 0} searchParams={sp as Record<string, string | undefined>} />
    </div>
  );
}
