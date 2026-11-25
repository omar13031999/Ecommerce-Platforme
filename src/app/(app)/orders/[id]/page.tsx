import Link from 'next/link';
import { ConfirmationWorkspace } from './workspace';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AlertTriangle, ArrowLeft, Copy, ExternalLink, PackageX } from 'lucide-react';
import { requirePage } from '@/lib/auth/session';
import { createClient } from '@/lib/supabase/server';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { ConfirmationBadge, DeliveryBadge } from '@/components/app/status-badge';
import { formatDZD, formatDateTime, type AppLocale } from '@/lib/format';
import { isConfirmationStatus, isDeliveryStatus, type ConfirmationStatus, type DeliveryStatus } from '@/lib/domain/statuses';
import { NoteForm, AssignControl, DeliveryControl, ReviewControl, ItemMatcher } from './order-actions';

type Event = { id: number; actor_id: string | null; actor_label: string | null; event_type: string; field: string | null; old_value: string | null; new_value: string | null; note: string | null; metadata: Record<string, string>; created_at: string };

export default async function OrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePage();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const t = await getTranslations();
  const locale = (await getLocale()) as AppLocale;
  const supabase = await createClient();

  const { data: order } = await supabase.from('orders').select('*, wilayas(name_fr, name_ar)').eq('id', id).maybeSingle();
  if (!order) {
    return (
      <Card className="mx-auto mt-10 max-w-md">
        <CardContent className="p-6 text-center">
          <p className="mb-3">{t('orders.orderNotFound')}</p>
          <Link className="text-primary hover:underline" href="/orders">{t('common.back')}</Link>
        </CardContent>
      </Card>
    );
  }

  const canFinance = session.can('finance.view');
  const canDeliveryView = session.can('delivery.view');
  const [items, events, notes, staff, redistributions, deliveryEvents, providers, profit, products, wilayas, communes] = await Promise.all([
    supabase.from('order_items').select('id, product_id, product_name, sku, variant, quantity, unit_price, line_total, match_status').eq('order_id', id).order('created_at'),
    supabase.from('order_events').select('*').eq('order_id', id).order('created_at', { ascending: false }).limit(300),
    supabase.from('order_notes').select('id, author_id, body, created_at').eq('order_id', id).order('created_at', { ascending: false }),
    supabase.from('staff_directory').select('id, full_name, role, is_active'),
    supabase.from('order_redistributions').select('*').eq('order_id', id).order('created_at'),
    canDeliveryView ? supabase.from('delivery_events').select('id, source, provider_status, internal_status, occurred_at').eq('order_id', id).order('occurred_at', { ascending: false }) : Promise.resolve({ data: null }),
    session.can('delivery.manage') ? supabase.from('delivery_providers').select('id, name, code').eq('is_active', true) : Promise.resolve({ data: [] }),
    canFinance ? supabase.from('order_profit').select('*').eq('order_id', id).maybeSingle() : Promise.resolve({ data: null }),
    supabase.from('products').select('id, name, sku, selling_price').eq('is_archived', false).order('name'),
    supabase.from('wilayas').select('code, name_fr, name_ar').order('code'),
    supabase.from('communes').select('wilaya_code, name, has_stop_desk').eq('is_active', true).order('name').range(0, 4999),
  ]);
  const { data: lastShipment } = order.delivery_status === 'submission_failed' || order.delivery_status === 'pending_submission'
    ? await supabase.from('delivery_shipments').select('status, error_code, error_message, attempt_count, updated_at').eq('order_id', id)
      .order('created_at', { ascending: false }).limit(1).maybeSingle()
    : { data: null };
  const names: Record<string, string> = Object.fromEntries((staff.data ?? []).map((s) => [s.id, s.full_name]));
  const { data: provider } = order.delivery_provider_id
    ? await supabase.from('delivery_provider_directory').select('name, tracking_url_template').eq('id', order.delivery_provider_id).maybeSingle()
    : { data: null };

  const isAssigned = order.assigned_to === session.userId;
  const canWork = (isAssigned || session.can('orders.manage')) && ['not_submitted', 'submission_failed'].includes(order.delivery_status);
  const wilaya = order.wilayas as { name_fr: string; name_ar: string } | null;
  const trackingUrl = provider?.tracking_url_template && order.tracking_number ? provider.tracking_url_template.replace('{tracking}', encodeURIComponent(order.tracking_number)) : null;
  const statusLabel = (v: string | null) => (v && isConfirmationStatus(v) ? t(`confirmation.${v}`) : v ?? '—');
  const deliveryLabel = (v: string | null) => (v && isDeliveryStatus(v) ? t(`delivery.${v}`) : v ?? '—');
  const who = (e: Event) => (e.actor_id ? names[e.actor_id] ?? '—' : e.actor_label === 'google_sheets' ? t('orders.sourceGoogle') : e.actor_label && e.actor_label !== 'system' ? e.actor_label : t('orders.system'));

  function describe(e: Event) {
    switch (e.event_type) {
      case 'created': return t('orders.eventCreated', { source: e.new_value ?? '' });
      case 'status_change': return t('orders.eventStatus', { from: statusLabel(e.old_value), to: statusLabel(e.new_value) });
      case 'assignment': return t('orders.eventAssignment', { from: e.old_value ? names[e.old_value] ?? '—' : '—', to: e.new_value ? names[e.new_value] ?? '—' : '—' });
      case 'delivery_status': return t('orders.eventDelivery', { from: deliveryLabel(e.old_value), to: deliveryLabel(e.new_value) });
      case 'note_added': return t('orders.eventNote');
      case 'item_added': return `${t('orders.eventItemAdded')}: ${e.new_value}`;
      case 'item_updated': return `${t('orders.eventItemUpdated')}: ${e.old_value} → ${e.new_value}`;
      case 'item_removed': return `${t('orders.eventItemRemoved')}: ${e.old_value}`;
      case 'assignment_waiting': return t('orders.eventWaiting');
      case 'assignment_skipped': return t('orders.eventSkipped');
      case 'review_flag': return t('orders.eventReview', { to: e.new_value === 'true' ? t('common.yes') : t('common.no') });
      case 'assignment_queue': return t('orders.eventQueue', { to: e.new_value === 'true' ? t('common.yes') : t('common.no') });
      default: return t('orders.eventField', { field: e.field ?? e.event_type, from: e.old_value ?? '', to: e.new_value ?? '' });
    }
  }

  const evts = (events.data ?? []) as Event[];
  const otherAgentNotes = (redistributions.data ?? []).flatMap((r) => (r.notes_snapshot as { at: string; author_id: string; body: string | null }[]).filter((n) => n.body));

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Link href="/orders" className="text-muted-foreground hover:text-foreground" aria-label={t('common.back')}><ArrowLeft className="size-5 rtl:rotate-180" /></Link>
        <h1 className="text-2xl font-semibold">#{order.reference}</h1>
        <ConfirmationBadge status={order.confirmation_status as ConfirmationStatus} />
        <DeliveryBadge status={order.delivery_status as DeliveryStatus} />
        {order.needs_review ? <Badge className="bg-warning/15 text-warning ring-warning/30"><AlertTriangle className="size-3" />{t('orders.needsReview')}</Badge> : null}
        {order.possible_duplicate_of ? (
          <Link href={`/orders/${order.possible_duplicate_of}`}><Badge className="bg-muted text-muted-foreground ring-border"><Copy className="size-3" />{t('orders.possibleDuplicate')}</Badge></Link>
        ) : null}
        {order.has_unmatched_items ? <Badge className="bg-destructive/10 text-destructive ring-destructive/30"><PackageX className="size-3" />{t('orders.unmatched')}</Badge> : null}
      </div>

      {!['not_submitted', 'submission_failed'].includes(order.delivery_status) ? (
        <p className="rounded-md border bg-muted/40 p-2 text-sm text-muted-foreground">{t('orders.lockedDelivery')}</p>
      ) : null}

      {lastShipment && ['failed', 'unknown'].includes(lastShipment.status) ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
          <p className="font-medium text-destructive">{lastShipment.status === 'unknown' ? t('orders.submissionUnknown') : t('orders.submissionFailed')}</p>
          <p dir="ltr" className="mt-1 break-words font-mono text-xs">{lastShipment.error_message ?? lastShipment.error_code ?? '—'}</p>
          {/not_configured/.test(lastShipment.error_message ?? '') ? <p className="mt-1 text-xs text-muted-foreground">{t('orders.providerNotConfiguredHint')}</p> : null}
          {/commune|wilaya/i.test(lastShipment.error_message ?? '') ? <p className="mt-1 text-xs text-muted-foreground">{t('orders.communeHint')}</p> : null}
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="grid gap-4 lg:col-span-2">
          {canWork ? (
            <Card className="border-primary/30">
              <CardHeader><CardTitle>{t('orders.workspace')}</CardTitle></CardHeader>
              <CardContent>
                <ConfirmationWorkspace
                  orderId={order.id}
                  version={order.version}
                  status={order.confirmation_status}
                  isManager={session.can('orders.manage')}
                  initial={{
                    customer_name: order.customer_name, phone: order.phone ?? '', phone2: order.phone2 ?? '', wilaya_code: order.wilaya_code,
                    commune: order.commune ?? '', address: order.address ?? '', delivery_type: order.delivery_type, customer_notes: order.customer_notes ?? '',
                  }}
                  items={(items.data ?? []).map((i) => ({ id: i.id, product_id: i.product_id, product_name: i.product_name, sku: i.sku, quantity: i.quantity, unit_price: Number(i.unit_price) }))}
                  catalog={(products.data ?? []).map((p) => ({ ...p, selling_price: Number(p.selling_price) }))}
                  wilayas={(wilayas.data ?? []).map((w) => ({ code: w.code, name: locale === 'ar' ? w.name_ar : w.name_fr }))}
                  communes={communes.data ?? []}
                  deliveryFee={Number(order.delivery_fee)}
                  discount={Number(order.discount)}
                  reviewReason={order.needs_review ? order.review_reason ?? t('orders.needsReview') : null}
                />
              </CardContent>
            </Card>
          ) : (
            <>
          <Card>
            <CardHeader className="flex-row items-center justify-between">
              <CardTitle>{t('orders.customer')}</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
                <Field label={t('orders.customerName')} value={order.customer_name} />
                <Field label={t('orders.phone')} value={<a dir="ltr" className="tabular text-primary hover:underline" href={`tel:${order.phone}`}>{order.phone}</a>} />
                <Field label={t('orders.phone2')} value={order.phone2 ? <a dir="ltr" className="tabular text-primary hover:underline" href={`tel:${order.phone2}`}>{order.phone2}</a> : '—'} />
                <Field label={t('orders.wilaya')} value={order.wilaya_code ? `${String(order.wilaya_code).padStart(2, '0')} — ${locale === 'ar' ? wilaya?.name_ar : wilaya?.name_fr}` : order.wilaya_raw ?? '—'} />
                <Field label={t('orders.commune')} value={order.commune ?? '—'} />
                <Field label={t('orders.deliveryType')} value={t(`orders.${order.delivery_type}`)} />
                <Field label={t('orders.address')} value={order.address ?? '—'} className="sm:col-span-2" />
                {order.customer_notes ? <Field label={t('orders.customerNotes')} value={order.customer_notes} className="sm:col-span-2" /> : null}
              </dl>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>{t('orders.products')}</CardTitle></CardHeader>
            <CardContent className="p-0">
              <Table>
                <THead><TR><TH>{t('orders.product')}</TH><TH>{t('orders.quantity')}</TH><TH>{t('orders.unitPrice')}</TH><TH>{t('orders.lineTotal')}</TH></TR></THead>
                <TBody>
                  {(items.data ?? []).map((i) => (
                    <TR key={i.id}>
                      <TD>
                        <div className="font-medium">{i.product_name}{i.variant ? ` (${i.variant})` : ''}</div>
                        {i.sku ? <div className="text-xs text-muted-foreground">{i.sku}</div> : null}
                        {!i.product_id && session.can('orders.manage') && (products.data ?? []).length ? <ItemMatcher itemId={i.id} products={products.data ?? []} /> : null}
                      </TD>
                      <TD className="tabular">{i.quantity}</TD>
                      <TD className="tabular">{formatDZD(i.unit_price, locale)}</TD>
                      <TD className="tabular">{formatDZD(i.line_total, locale)}</TD>
                    </TR>
                  ))}
                  <TR><TD colSpan={3} className="text-end text-muted-foreground">{t('orders.subtotal')}</TD><TD className="tabular">{formatDZD(order.subtotal, locale)}</TD></TR>
                  <TR><TD colSpan={3} className="text-end text-muted-foreground">{t('orders.deliveryFee')}</TD><TD className="tabular">{formatDZD(order.delivery_fee, locale)}</TD></TR>
                  {Number(order.discount) > 0 ? <TR><TD colSpan={3} className="text-end text-muted-foreground">{t('orders.discount')}</TD><TD className="tabular">−{formatDZD(order.discount, locale)}</TD></TR> : null}
                  <TR><TD colSpan={3} className="text-end font-semibold">{t('orders.totalAmount')}</TD><TD className="tabular font-semibold">{formatDZD(order.total_amount, locale)}</TD></TR>
                </TBody>
              </Table>
            </CardContent>
          </Card>

            </>
          )}

          {profit.data ? (
            <Card className="border-primary/30">
              <CardHeader><CardTitle>{t('finance.title')}</CardTitle></CardHeader>
              <CardContent className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
                <Field label={t('finance.productRevenue')} value={formatDZD(profit.data.product_revenue, locale)} />
                <Field label={t('finance.productCost')} value={profit.data.cost_complete ? formatDZD(profit.data.product_cost, locale) : <span className="text-destructive">{t('products.missingCost')}</span>} />
                <Field label={t('finance.deliveryCost')} value={<>{formatDZD(profit.data.delivery_cost, locale)} {profit.data.delivery_cost_estimated && profit.data.delivery_cost != null ? <span className="text-xs text-muted-foreground">({t('common.estimated')})</span> : null}</>} />
                <Field label={t('finance.operationalCost')} value={formatDZD(profit.data.operational_cost, locale)} />
                <Field label={t('finance.bucket')} value={t(`finance.bucket_${profit.data.bucket}`)} />
                <Field label={t('finance.grossProfit')} value={<strong>{formatDZD(profit.data.gross_profit, locale)}</strong>} />
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader><CardTitle>{t('orders.history')}</CardTitle></CardHeader>
            <CardContent>
              <ol className="relative grid gap-3 border-s ps-4">
                {evts.map((e) => (
                  <li key={e.id} className="relative">
                    <span className="absolute -start-[21px] top-1.5 size-2.5 rounded-full border-2 border-card bg-primary/60" />
                    <div className="text-sm">{describe(e)}</div>
                    {e.event_type === 'note_added' ? <p className="mt-1 whitespace-pre-wrap rounded bg-muted/50 p-2 text-sm">{e.new_value}</p> : null}
                    {e.note && e.event_type !== 'note_added' ? <p className="mt-1 whitespace-pre-wrap text-sm italic text-muted-foreground">“{e.note}”</p> : null}
                    {e.metadata?.reason ? <span className="text-xs text-muted-foreground">{t('orders.reason')}: {e.metadata.reason}</span> : null}
                    <div className="text-xs text-muted-foreground">{who(e)} · {formatDateTime(e.created_at, locale)}</div>
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>
        </div>

        <div className="grid content-start gap-4">
          <Card>
            <CardHeader><CardTitle>{t('common.details')}</CardTitle></CardHeader>
            <CardContent className="grid gap-2 text-sm">
              <Field label={t('orders.createdAt')} value={formatDateTime(order.ordered_at, locale)} />
              <Field label={t('orders.source')} value={`${order.source}${order.external_id ? ` · ${order.external_id}` : ''}`} />
              <Field label={t('orders.assignedTo')} value={order.assigned_to ? names[order.assigned_to] ?? '—' : <span className="text-warning">{t('orders.unassigned')}</span>} />
              <Field label={t('orders.attempts')} value={order.contact_attempts} />
              <Field label={t('orders.redistributions')} value={order.redistribution_count} />
              <Field label={t('orders.provider')} value={provider?.name ?? '—'} />
              <Field label={t('orders.tracking')} value={order.tracking_number ? (
                <span className="inline-flex items-center gap-1 font-mono">{order.tracking_number}{trackingUrl ? <a href={trackingUrl} target="_blank" rel="noopener noreferrer" aria-label={t('deliveryPage.trackingLink')}><ExternalLink className="size-3.5 text-primary" /></a> : null}</span>
              ) : '—'} />
            </CardContent>
          </Card>

          {session.can('orders.assign') ? (
            <Card>
              <CardHeader><CardTitle>{t('orders.assign')}</CardTitle></CardHeader>
              <CardContent>
                <AssignControl orderId={order.id} agents={(staff.data ?? []).filter((s) => s.role === 'agent' && s.is_active)} />
              </CardContent>
            </Card>
          ) : null}

          {order.needs_review && session.can('orders.manage') ? (
            <Card className="border-warning/40">
              <CardContent className="pt-4"><ReviewControl orderId={order.id} /></CardContent>
            </Card>
          ) : null}

          {session.can('delivery.manage') && order.confirmation_status === 'confirmed' ? (
            <Card>
              <CardHeader><CardTitle>{t('nav.delivery')}</CardTitle></CardHeader>
              <CardContent>
                <DeliveryControl orderId={order.id} deliveryStatus={order.delivery_status} providers={providers.data ?? []} currentProvider={order.delivery_provider_id} tracking={order.tracking_number ?? ''} />
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader><CardTitle>{t('orders.internalNotes')}</CardTitle></CardHeader>
            <CardContent className="grid gap-3">
              {canWork || session.can('orders.manage') ? <NoteForm orderId={order.id} /> : null}
              {(notes.data ?? []).map((n) => (
                <div key={n.id} className="rounded-md bg-muted/50 p-2 text-sm">
                  <p className="whitespace-pre-wrap">{n.body}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{n.author_id ? names[n.author_id] : '—'} · {formatDateTime(n.created_at, locale)}</p>
                </div>
              ))}
              {otherAgentNotes.length ? (
                <div className="border-t pt-2">
                  <p className="mb-1 text-xs font-semibold text-muted-foreground">{t('orders.previousNotes')}</p>
                  {otherAgentNotes.map((n, i) => (
                    <p key={i} className="text-xs"><span className="text-muted-foreground">{names[n.author_id] ?? '—'}:</span> {n.body}</p>
                  ))}
                </div>
              ) : null}
            </CardContent>
          </Card>

          {deliveryEvents.data?.length ? (
            <Card>
              <CardHeader><CardTitle>{t('orders.deliveryHistory')}</CardTitle></CardHeader>
              <CardContent className="grid gap-2 text-sm">
                {deliveryEvents.data.map((d) => (
                  <div key={d.id} className="flex items-start justify-between gap-2">
                    <div>
                      <div>{d.internal_status ? deliveryLabel(d.internal_status) : '—'}</div>
                      <div className="text-xs text-muted-foreground">{d.provider_status} · {d.source}</div>
                    </div>
                    <span className="whitespace-nowrap text-xs text-muted-foreground">{formatDateTime(d.occurred_at, locale)}</span>
                  </div>
                ))}
              </CardContent>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Field({ label, value, className }: { label: string; value: React.ReactNode; className?: string }) {
  return (
    <div className={className}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5">{value}</dd>
    </div>
  );
}
