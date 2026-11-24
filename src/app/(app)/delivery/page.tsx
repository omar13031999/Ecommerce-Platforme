import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { requirePage } from '@/lib/auth/session';
import { createClient } from '@/lib/supabase/server';
import { PageHeader } from '@/components/app/page-header';
import { StatCard } from '@/components/app/stat-card';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { DeliveryBadge } from '@/components/app/status-badge';
import { formatDateTime, formatNumber, type AppLocale } from '@/lib/format';
import { DELIVERY_STATUSES, IN_TRANSIT_STATUSES, type DeliveryStatus } from '@/lib/domain/statuses';
import { DeliveryQueue, ProviderPollButton, StatusImport } from './delivery-client';

export default async function DeliveryPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const session = await requirePage('delivery.view');
  const { tab = 'waiting' } = await searchParams;
  const t = await getTranslations();
  const locale = (await getLocale()) as AppLocale;
  const supabase = await createClient();

  const counts = await Promise.all(
    DELIVERY_STATUSES.map(async (s) => {
      const q = supabase.from('orders').select('id', { count: 'exact', head: true }).eq('delivery_status', s);
      const { count } = s === 'not_submitted' ? await q.eq('confirmation_status', 'confirmed') : await q;
      return [s, count ?? 0] as const;
    }),
  );
  const c = Object.fromEntries(counts) as Record<DeliveryStatus, number>;
  const inTransit = IN_TRANSIT_STATUSES.reduce((sum, s) => sum + (c[s] ?? 0), 0) - (c.out_for_delivery ?? 0);

  const tabStatuses: Record<string, DeliveryStatus[]> = {
    waiting: ['not_submitted'], failed: ['submission_failed', 'pending_submission'],
    transit: ['submitted', 'processing', 'ready_for_pickup', 'picked_up', 'in_transit'], out: ['out_for_delivery'],
    distributed: ['distributed'], delivered: ['delivered'], failed_delivery: ['failed_delivery'], returned: ['returned'],
  };
  const statuses = tabStatuses[tab] ?? tabStatuses.waiting!;
  let listQ = supabase.from('orders')
    .select('id, reference, customer_name, phone, wilaya_code, commune, total_amount, delivery_status, delivery_provider_id, tracking_number, submitted_at, delivery_status_at')
    .in('delivery_status', statuses).order('delivery_status_at', { ascending: false, nullsFirst: false }).limit(200);
  if (tab === 'waiting') listQ = listQ.eq('confirmation_status', 'confirmed');
  const [{ data: rows }, { data: providers }] = await Promise.all([
    listQ,
    supabase.from('delivery_providers').select('id, name, code, is_active, polling_enabled, last_polled_at, tracking_url_template, webhook_enabled').order('name'),
  ]);
  const { data: shipments } = rows?.length
    ? await supabase.from('delivery_shipments').select('order_id, status, error_message, last_synced_at, provider_status').eq('is_active', true).in('order_id', rows.map((r) => r.id))
    : { data: [] };
  const shipByOrder = Object.fromEntries((shipments ?? []).map((s) => [s.order_id, s]));
  const providerById = Object.fromEntries((providers ?? []).map((p) => [p.id, p]));
  const { count: unknownCount } = await supabase.from('delivery_shipments').select('id', { count: 'exact', head: true }).eq('status', 'unknown');

  const tabs: [string, string, number][] = [
    ['waiting', t('deliveryPage.waiting'), c.not_submitted], ['failed', t('deliveryPage.failed'), (c.submission_failed ?? 0) + (c.pending_submission ?? 0)],
    ['transit', t('deliveryPage.inTransit'), inTransit], ['out', t('deliveryPage.outForDelivery'), c.out_for_delivery],
    ['distributed', t('deliveryPage.distributed'), c.distributed], ['delivered', t('deliveryPage.delivered'), c.delivered],
    ['failed_delivery', t('deliveryPage.failedDelivery'), c.failed_delivery], ['returned', t('deliveryPage.returned'), c.returned],
  ];

  return (
    <div className="grid gap-5">
      <PageHeader title={t('deliveryPage.title')} actions={session.can('delivery.manage') ? <StatusImport /> : null} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
        {tabs.map(([key, label, n]) => (
          <StatCard key={key} label={label} value={formatNumber(n, locale)} href={`/delivery?tab=${key}`} tone={key === tab ? 'positive' : 'default'} />
        ))}
      </div>
      {unknownCount ? <p className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">{t('deliveryPage.unknownShipments')}: <strong>{unknownCount}</strong></p> : null}

      <Card>
        <CardHeader><CardTitle>{t('integrations.deliveryProviders')}</CardTitle></CardHeader>
        <CardContent className="p-0">
          {!providers?.length ? <p className="p-4 text-sm text-muted-foreground">{t('deliveryPage.noProvider')}</p> : (
            <Table>
              <THead><TR><TH>{t('common.name')}</TH><TH>{t('integrations.adapter')}</TH><TH>{t('common.status')}</TH><TH>{t('deliveryPage.lastSync')}</TH><TH /></TR></THead>
              <TBody>
                {providers.map((p) => (
                  <TR key={p.id}>
                    <TD className="font-medium">{p.name}</TD>
                    <TD>{t(`integrations.adapter_${p.code}` as 'integrations.adapter_manual')}</TD>
                    <TD>{p.is_active ? t('common.active') : t('common.inactive')}</TD>
                    <TD className="text-xs text-muted-foreground">{p.last_polled_at ? formatDateTime(p.last_polled_at, locale) : t('common.never')}</TD>
                    <TD>{session.can('delivery.manage') && p.code !== 'manual' && p.is_active ? <ProviderPollButton providerId={p.id} /> : null}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card className="overflow-hidden">
        {tab === 'waiting' && session.can('delivery.manage') ? (
          <DeliveryQueue
            rows={(rows ?? []).map((r) => ({ id: r.id, reference: r.reference, customer_name: r.customer_name, wilaya: `${r.wilaya_code ?? ''} ${r.commune ?? ''}`, total: Number(r.total_amount) }))}
            providers={(providers ?? []).filter((p) => p.is_active).map((p) => ({ id: p.id, name: p.name, code: p.code }))}
          />
        ) : (
          <Table>
            <THead><TR><TH>{t('orders.reference')}</TH><TH>{t('orders.customer')}</TH><TH>{t('orders.wilaya')}</TH><TH>{t('orders.provider')}</TH><TH>{t('orders.tracking')}</TH><TH>{t('orders.deliveryStatus')}</TH><TH>{t('deliveryPage.submittedAt')}</TH><TH>{t('deliveryPage.lastSync')}</TH></TR></THead>
            <TBody>
              {(rows ?? []).map((r) => {
                const p = r.delivery_provider_id ? providerById[r.delivery_provider_id] : null;
                const sh = shipByOrder[r.id];
                const url = p?.tracking_url_template && r.tracking_number ? p.tracking_url_template.replace('{tracking}', encodeURIComponent(r.tracking_number)) : null;
                return (
                  <TR key={r.id}>
                    <TD><Link className="font-medium text-primary hover:underline" href={`/orders/${r.id}`}>#{r.reference}</Link></TD>
                    <TD>{r.customer_name}</TD>
                    <TD className="whitespace-nowrap">{r.wilaya_code} {r.commune}</TD>
                    <TD>{p?.name ?? '—'}</TD>
                    <TD className="font-mono text-xs">{url ? <a className="text-primary hover:underline" href={url} target="_blank" rel="noopener noreferrer">{r.tracking_number}</a> : r.tracking_number ?? '—'}</TD>
                    <TD>
                      <DeliveryBadge status={r.delivery_status as DeliveryStatus} />
                      {sh?.error_message ? <div className="mt-1 max-w-[260px] truncate text-xs text-destructive" title={sh.error_message}>{sh.error_message}</div> : null}
                      {sh?.provider_status ? <div className="text-xs text-muted-foreground">{sh.provider_status}</div> : null}
                    </TD>
                    <TD className="text-xs">{formatDateTime(r.submitted_at, locale)}</TD>
                    <TD className="text-xs text-muted-foreground">{formatDateTime(sh?.last_synced_at ?? r.delivery_status_at, locale)}</TD>
                  </TR>
                );
              })}
              {!rows?.length ? <TR><TD colSpan={8} className="text-center text-muted-foreground">{t('common.noResults')}</TD></TR> : null}
            </TBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
