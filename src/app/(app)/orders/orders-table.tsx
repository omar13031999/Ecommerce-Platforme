'use client';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ArrowDown, ArrowUp, Columns3, Copy, PackageX, PhoneMissed, Send, Trash2, UserMinus, UserPlus, Wand2 } from 'lucide-react';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { Checkbox, Select } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuLabel, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ConfirmationBadge, DeliveryBadge } from '@/components/app/status-badge';
import { useAction } from '@/components/app/use-action';
import { PostponeDialog } from '@/components/app/postpone-dialog';
import { WhatsAppButton } from '@/components/app/whatsapp-button';
import { formatDZD, formatDateTime, type AppLocale } from '@/lib/format';
import { CONFIRMATION_STATUSES, nextNoAnswer, type ConfirmationStatus, type DeliveryStatus } from '@/lib/domain/statuses';
import { assignOrders, autoAssignOrders, blockOrderPhones, bulkChangeStatus, changeConfirmationStatus, deleteOrders, submitToDelivery, unassignOrders } from '@/lib/actions/orders';

export type OrderRow = {
  id: string; reference: number; external_id: string | null; source: string; customer_name: string; phone: string;
  wilaya_code: number | null; commune: string | null; total_amount: number; confirmation_status: ConfirmationStatus;
  delivery_status: DeliveryStatus; assigned_to: string | null; ordered_at: string; tracking_number: string | null;
  needs_review: boolean; has_unmatched_items: boolean; possible_duplicate_of: string | null; contact_attempts: number;
  version: number; postponed_until: string | null; delivery_type: 'home' | 'stopdesk'; utm_source: string | null; customer_blocked: boolean; order_items: { product_name: string; quantity: number }[];
};

const COLUMNS = ['reference', 'date', 'elapsed', 'customer', 'phone', 'wilaya', 'products', 'total', 'confirmation', 'delivery', 'agent', 'tracking', 'utm'] as const;
type Col = (typeof COLUMNS)[number];
const STORAGE_KEY = 'orders.columns.v2';
/** Hidden until the user shows them (column menu). */
const DEFAULT_HIDDEN: Col[] = ['utm'];

export function OrdersTable({
  rows, agentNames, agents, providers, canAssign, canSubmit, showAgent, sort, currentUserId, isManager, canDelete = false,
}: {
  rows: OrderRow[]; agentNames: Record<string, string>; agents: { id: string; full_name: string }[];
  providers: { id: string; name: string; code: string }[]; canAssign: boolean; canSubmit: boolean; showAgent: boolean;
  sort: { col: string; dir: 'asc' | 'desc' }; currentUserId: string; isManager: boolean; canDelete?: boolean;
}) {
  const t = useTranslations();
  const locale = useLocale() as AppLocale;
  const pathname = usePathname();
  const params = useSearchParams();
  const { run, pending } = useAction();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [hidden, setHidden] = useState<Set<Col>>(new Set(DEFAULT_HIDDEN));
  const [agentId, setAgentId] = useState('');
  const [providerId, setProviderId] = useState(providers[0]?.id ?? '');
  const [bulkStatus, setBulkStatus] = useState('');

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) setHidden(new Set(JSON.parse(raw) as Col[]));
    } catch { /* storage unavailable */ }
  }, []);
  useEffect(() => setSelected(new Set()), [rows]);

  function toggleCol(c: Col) {
    const next = new Set(hidden);
    if (next.has(c)) next.delete(c);
    else next.add(c);
    setHidden(next);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify([...next])); } catch { /* ignore */ }
  }
  const visible = useMemo(() => COLUMNS.filter((c) => !hidden.has(c) && (c !== 'agent' || showAgent)), [hidden, showAgent]);
  const ids = [...selected];
  const allChecked = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const bulk = canAssign || canSubmit || canDelete || isManager;

  const sortHref = (col: string) => {
    const sp = new URLSearchParams(params.toString());
    sp.set('sort', col);
    sp.set('dir', sort.col === col && sort.dir === 'desc' ? 'asc' : 'desc');
    return `${pathname}?${sp.toString()}`;
  };
  const SortHead = ({ col, label }: { col: string; label: string }) => (
    <Link href={sortHref(col)} className="inline-flex items-center gap-1 hover:text-foreground">
      {label}
      {sort.col === col ? (sort.dir === 'asc' ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />) : null}
    </Link>
  );
  const labels: Record<Col, React.ReactNode> = {
    reference: <SortHead col="reference" label={t('orders.reference')} />,
    date: <SortHead col="ordered_at" label={t('orders.createdAt')} />,
    customer: t('orders.customer'),
    phone: t('orders.phone'),
    wilaya: t('orders.wilaya'),
    products: t('orders.products'),
    total: <SortHead col="total_amount" label={t('orders.totalAmount')} />,
    confirmation: <SortHead col="confirmation_status" label={t('orders.confirmationStatus')} />,
    delivery: <SortHead col="delivery_status" label={t('orders.deliveryStatus')} />,
    agent: t('orders.assignedTo'),
    tracking: t('orders.tracking'),
    elapsed: t('orders.elapsed'),
    utm: 'UTM',
  };
  const plainLabel: Record<Col, string> = {
    reference: t('orders.reference'), date: t('orders.createdAt'), customer: t('orders.customer'), phone: t('orders.phone'),
    wilaya: t('orders.wilaya'), products: t('orders.products'), total: t('orders.totalAmount'), confirmation: t('orders.confirmationStatus'),
    delivery: t('orders.deliveryStatus'), agent: t('orders.assignedTo'), tracking: t('orders.tracking'),
    elapsed: t('orders.elapsed'), utm: 'UTM source',
  };

  function cell(c: Col, r: OrderRow) {
    switch (c) {
      case 'reference':
        return (
          <div className="flex items-center gap-1.5">
            <Link href={`/orders/${r.id}`} className="font-medium text-primary hover:underline">#{r.reference}</Link>
            {r.needs_review ? <AlertTriangle className="size-3.5 text-warning" aria-label={t('orders.needsReview')} /> : null}
            {r.possible_duplicate_of ? <Copy className="size-3.5 text-muted-foreground" aria-label={t('orders.possibleDuplicate')} /> : null}
            {r.has_unmatched_items ? <PackageX className="size-3.5 text-destructive" aria-label={t('orders.unmatched')} /> : null}
            {r.customer_blocked ? <span title={t('orders.blockedCustomer')} aria-label={t('orders.blockedCustomer')}>⛔</span> : null}
          </div>
        );
      case 'date': return <span className="whitespace-nowrap text-xs text-muted-foreground">{formatDateTime(r.ordered_at, locale)}</span>;
      case 'customer': return <span className="font-medium">{r.customer_name}</span>;
      case 'phone': return (
        <div className="flex items-center gap-1">
          <span dir="ltr" className="tabular whitespace-nowrap">{r.phone}</span>
          <WhatsAppButton iconOnly phone={r.phone} ctx={{ name: r.customer_name, reference: r.reference, total: formatDZD(r.total_amount, locale), products: r.order_items.map((i) => `${i.product_name} ×${i.quantity}`).join('، '), tracking: r.tracking_number }} />
        </div>
      );
      case 'elapsed': return <Elapsed since={r.ordered_at} />;
      case 'utm': return <span className="text-xs text-muted-foreground">{r.utm_source ?? '—'}</span>;
      case 'wilaya': return (
        <span className="whitespace-nowrap">{r.wilaya_code ? String(r.wilaya_code).padStart(2, '0') : '—'} {r.commune ?? ''}
          {r.delivery_type === 'stopdesk' ? <span className="ms-1 rounded bg-cyan-100 px-1 text-[10px] font-medium text-cyan-800 dark:bg-cyan-950 dark:text-cyan-200">STOP DESK</span> : null}
        </span>
      );
      case 'products': return <span className="line-clamp-2 max-w-[220px] text-xs">{r.order_items.map((i) => `${i.product_name} ×${i.quantity}`).join(', ')}</span>;
      case 'total': return <span className="tabular whitespace-nowrap">{formatDZD(r.total_amount, locale)}</span>;
      case 'confirmation':
        if (r.confirmation_status === 'postponed' && !((isManager || r.assigned_to === currentUserId) && ['not_submitted', 'submission_failed'].includes(r.delivery_status)) && r.postponed_until) {
          return <div className="grid gap-0.5"><ConfirmationBadge status={r.confirmation_status} /><PostponedLabel due={new Date(r.postponed_until)} /></div>;
        }
        return (isManager || r.assigned_to === currentUserId) && ['not_submitted', 'submission_failed'].includes(r.delivery_status)
          ? <QuickStatus row={r} isManager={isManager} />
          : <ConfirmationBadge status={r.confirmation_status} />;
      case 'delivery': return <DeliveryBadge status={r.delivery_status} />;
      case 'agent': return r.assigned_to ? <span className="whitespace-nowrap text-xs">{agentNames[r.assigned_to] ?? '—'}</span> : <span className="text-xs text-warning">{t('orders.unassigned')}</span>;
      case 'tracking': return <span dir="ltr" className="font-mono text-xs">{r.tracking_number ?? '—'}</span>;
    }
  }

  return (
    <div>
      <div className="flex min-h-12 flex-wrap items-center gap-2 border-b bg-muted/30 px-3 py-2">
        {bulk && ids.length ? (
          <>
            <span className="text-sm font-medium">{t('common.selected', { count: ids.length })}</span>
            {canAssign ? (
              <>
                <Select className="h-8 w-44" value={agentId} onChange={(e) => setAgentId(e.target.value)} aria-label={t('orders.assignTo')}>
                  <option value="">{t('orders.assignTo')}</option>
                  {agents.map((a) => <option key={a.id} value={a.id}>{a.full_name}</option>)}
                </Select>
                <Button size="sm" variant="outline" disabled={!agentId || pending}
                  onClick={() => run(() => assignOrders({ orderIds: ids, agentId }), { success: (n) => t('orders.bulkAssigned', { count: Number(n) }) })}>
                  <UserPlus />{t('orders.assign')}
                </Button>
                <Button size="sm" variant="outline" disabled={pending}
                  onClick={() => run(() => autoAssignOrders(ids), { success: (n) => t('orders.bulkAssigned', { count: Number(n) }) })}>
                  <Wand2 />{t('orders.autoAssign')}
                </Button>
                <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => unassignOrders(ids), { success: t('common.saved') })}>
                  <UserMinus />{t('orders.unassign')}
                </Button>
              </>
            ) : null}
            {canSubmit && providers.length ? (
              <>
                <Select className="h-8 w-40" value={providerId} onChange={(e) => setProviderId(e.target.value)} aria-label={t('deliveryPage.chooseProvider')}>
                  {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </Select>
                <Button size="sm" disabled={!providerId || pending}
                  onClick={() => run(() => submitToDelivery({ orderIds: ids, providerId }), { success: (d) => t('orders.bulkSubmitted', { ok: d?.ok ?? 0, failed: d?.failed ?? 0 }) })}>
                  <Send />{t('orders.submitDelivery')}
                </Button>
              </>
            ) : null}
            {isManager ? (
              <>
                <Select className="h-8 w-44" value={bulkStatus} onChange={(e) => setBulkStatus(e.target.value)} aria-label={t('orders.changeStatus')}>
                  <option value="">{t('orders.changeStatus')}…</option>
                  {CONFIRMATION_STATUSES.filter((s) => s !== 'postponed').map((s) => <option key={s} value={s}>{t(`confirmation.${s}`)}</option>)}
                </Select>
                <Button size="sm" variant="outline" disabled={!bulkStatus || pending}
                  onClick={() => run(() => bulkChangeStatus({ orderIds: ids, status: bulkStatus }), { success: (d) => t('orders.bulkStatusDone', { ok: d?.ok ?? 0, failed: d?.failed ?? 0 }), onSuccess: () => setBulkStatus('') })}>
                  {t('common.apply')}
                </Button>
                <Button size="sm" variant="outline" disabled={pending}
                  onClick={() => { const reason = window.prompt(t('orders.blockReason')); if (reason !== null) run(() => blockOrderPhones({ orderIds: ids, reason }), { success: (n) => t('orders.blockedDone', { count: Number(n) }) }); }}>
                  ⛔ {t('orders.block')}
                </Button>
              </>
            ) : null}
            {canDelete ? (
              <Button size="sm" variant="destructive" disabled={pending}
                onClick={() => { if (confirm(t('orders.deleteConfirm', { count: ids.length }))) run(() => deleteOrders(ids), { success: (n) => t('orders.deleted', { count: Number(n) }) }); }}>
                <Trash2 />{t('common.delete')}
              </Button>
            ) : null}
          </>
        ) : <span className="text-sm text-muted-foreground">{rows.length ? '' : t('common.noResults')}</span>}
        <div className="ms-auto">
          <DropdownMenu>
            <DropdownMenuTrigger asChild><Button size="sm" variant="ghost"><Columns3 />{t('common.columns')}</Button></DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>{t('common.columns')}</DropdownMenuLabel>
              {COLUMNS.filter((c) => c !== 'agent' || showAgent).map((c) => (
                <DropdownMenuCheckboxItem key={c} checked={!hidden.has(c)} onCheckedChange={() => toggleCol(c)} onSelect={(e) => e.preventDefault()}>
                  {plainLabel[c]}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <Table>
        <THead>
          <TR>
            {bulk ? (
              <TH className="w-8">
                <Checkbox aria-label="select all" checked={allChecked} onChange={() => setSelected(allChecked ? new Set() : new Set(rows.map((r) => r.id)))} />
              </TH>
            ) : null}
            {visible.map((c) => <TH key={c}>{labels[c]}</TH>)}
          </TR>
        </THead>
        <TBody>
          {rows.map((r) => (
            <TR key={r.id} data-state={selected.has(r.id) ? 'selected' : undefined}>
              {bulk ? (
                <TD>
                  <Checkbox aria-label={`#${r.reference}`} checked={selected.has(r.id)} onChange={() => {
                    const next = new Set(selected);
                    if (next.has(r.id)) next.delete(r.id);
                    else next.add(r.id);
                    setSelected(next);
                  }} />
                </TD>
              ) : null}
              {visible.map((c) => <TD key={c}>{cell(c, r)}</TD>)}
            </TR>
          ))}
        </TBody>
      </Table>
    </div>
  );
}

const AGENT_CHOICES: ConfirmationStatus[] = ['confirmed', 'unreachable', 'duplicate', 'cancelled'];

/** Inline confirmation status change (no need to open the order). */
function QuickStatus({ row, isManager }: { row: OrderRow; isManager: boolean }) {
  const t = useTranslations();
  const { run, pending } = useAction();
  const next = nextNoAnswer(row.confirmation_status);
  const choices = (isManager
    ? [...CONFIRMATION_STATUSES]
    : [...new Set<ConfirmationStatus>([row.confirmation_status, ...(next ? [next] : []), ...AGENT_CHOICES])])
    .filter((s) => s !== 'postponed' || s === row.confirmation_status);
  const apply = (status: ConfirmationStatus) => {
    if (status === row.confirmation_status) return;
    run(() => changeConfirmationStatus({ orderId: row.id, status, version: row.version }), { success: `#${row.reference} → ${t(`confirmation.${status}`)}` });
  };
  const due = row.confirmation_status === 'postponed' && row.postponed_until ? new Date(row.postponed_until) : null;
  return (
    <div className="grid gap-0.5">
    <div className="flex items-center gap-1">
      <Select className="h-8 w-40 text-xs" value={row.confirmation_status} disabled={pending} aria-label={t('orders.changeStatus')}
        onChange={(e) => apply(e.target.value as ConfirmationStatus)}>
        {choices.map((s) => <option key={s} value={s}>{t(`confirmation.${s}`)}</option>)}
      </Select>
      {next ? (
        <Button size="icon" variant="warning" className="size-8 shrink-0" disabled={pending} title={`${t('orders.noAnswerNext')} (${next.slice(-1)})`} aria-label={t('orders.noAnswerNext')}
          onClick={() => apply(next)}><PhoneMissed /></Button>
      ) : null}
      <PostponeDialog orderId={row.id} version={row.version} iconOnly />
    </div>
    {due ? <PostponedLabel due={due} /> : null}
    </div>
  );
}

function PostponedLabel({ due }: { due: Date }) {
  const t = useTranslations('orders');
  const locale = useLocale() as AppLocale;
  const late = due.getTime() <= Date.now();
  return (
    <span className={late ? 'text-xs font-medium text-destructive' : 'text-xs text-muted-foreground'}>
      {late ? '⏰ ' : ''}{t('callBackAt', { date: formatDateTime(due.toISOString(), locale) })}
    </span>
  );
}

/** Time since the order came in ("2 h", "3 j"), red after 24 h while still to process. */
function Elapsed({ since }: { since: string }) {
  const t = useTranslations('orders');
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(since)) / 60000));
  const label = mins < 60 ? t('elapsedMin', { n: mins }) : mins < 1440 ? t('elapsedHours', { n: Math.floor(mins / 60) }) : t('elapsedDays', { n: Math.floor(mins / 1440) });
  return <span className={mins >= 1440 ? 'whitespace-nowrap text-xs font-medium text-destructive' : mins >= 180 ? 'whitespace-nowrap text-xs text-warning' : 'whitespace-nowrap text-xs text-muted-foreground'}>{label}</span>;
}
