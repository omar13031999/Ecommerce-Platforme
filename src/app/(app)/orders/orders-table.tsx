'use client';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ArrowDown, ArrowUp, Columns3, Copy, PackageX, Send, UserMinus, UserPlus, Wand2 } from 'lucide-react';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { Checkbox, Select } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuLabel, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ConfirmationBadge, DeliveryBadge } from '@/components/app/status-badge';
import { useAction } from '@/components/app/use-action';
import { formatDZD, formatDateTime, type AppLocale } from '@/lib/format';
import type { ConfirmationStatus, DeliveryStatus } from '@/lib/domain/statuses';
import { assignOrders, autoAssignOrders, submitToDelivery, unassignOrders } from '@/lib/actions/orders';

export type OrderRow = {
  id: string; reference: number; external_id: string | null; source: string; customer_name: string; phone: string;
  wilaya_code: number | null; commune: string | null; total_amount: number; confirmation_status: ConfirmationStatus;
  delivery_status: DeliveryStatus; assigned_to: string | null; ordered_at: string; tracking_number: string | null;
  needs_review: boolean; has_unmatched_items: boolean; possible_duplicate_of: string | null; contact_attempts: number;
  order_items: { product_name: string; quantity: number }[];
};

const COLUMNS = ['reference', 'date', 'customer', 'phone', 'wilaya', 'products', 'total', 'confirmation', 'delivery', 'agent', 'tracking'] as const;
type Col = (typeof COLUMNS)[number];
const STORAGE_KEY = 'orders.columns.v1';

export function OrdersTable({
  rows, agentNames, agents, providers, canAssign, canSubmit, showAgent, sort,
}: {
  rows: OrderRow[]; agentNames: Record<string, string>; agents: { id: string; full_name: string }[];
  providers: { id: string; name: string; code: string }[]; canAssign: boolean; canSubmit: boolean; showAgent: boolean;
  sort: { col: string; dir: 'asc' | 'desc' };
}) {
  const t = useTranslations();
  const locale = useLocale() as AppLocale;
  const pathname = usePathname();
  const params = useSearchParams();
  const { run, pending } = useAction();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [hidden, setHidden] = useState<Set<Col>>(new Set());
  const [agentId, setAgentId] = useState('');
  const [providerId, setProviderId] = useState(providers[0]?.id ?? '');

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
  const bulk = canAssign || canSubmit;

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
  };
  const plainLabel: Record<Col, string> = {
    reference: t('orders.reference'), date: t('orders.createdAt'), customer: t('orders.customer'), phone: t('orders.phone'),
    wilaya: t('orders.wilaya'), products: t('orders.products'), total: t('orders.totalAmount'), confirmation: t('orders.confirmationStatus'),
    delivery: t('orders.deliveryStatus'), agent: t('orders.assignedTo'), tracking: t('orders.tracking'),
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
          </div>
        );
      case 'date': return <span className="whitespace-nowrap text-xs text-muted-foreground">{formatDateTime(r.ordered_at, locale)}</span>;
      case 'customer': return <span className="font-medium">{r.customer_name}</span>;
      case 'phone': return <span dir="ltr" className="tabular whitespace-nowrap">{r.phone}</span>;
      case 'wilaya': return <span className="whitespace-nowrap">{r.wilaya_code ? String(r.wilaya_code).padStart(2, '0') : '—'} {r.commune ?? ''}</span>;
      case 'products': return <span className="line-clamp-2 max-w-[220px] text-xs">{r.order_items.map((i) => `${i.product_name} ×${i.quantity}`).join(', ')}</span>;
      case 'total': return <span className="tabular whitespace-nowrap">{formatDZD(r.total_amount, locale)}</span>;
      case 'confirmation': return <ConfirmationBadge status={r.confirmation_status} />;
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
