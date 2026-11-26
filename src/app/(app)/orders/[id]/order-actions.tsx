'use client';
import { CommuneSelect, type CommuneOption } from '@/components/app/commune-select';
import { PostponeDialog } from '@/components/app/postpone-dialog';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Ban, Check, Copy, PhoneMissed, PhoneOff, Send, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox, Input, Select, Textarea } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { useAction } from '@/components/app/use-action';
import { CONFIRMATION_STATUSES, DELIVERY_STATUSES, nextNoAnswer, type ConfirmationStatus } from '@/lib/domain/statuses';
import {
  addOrderNote, assignOrders, autoAssignOrders, changeConfirmationStatus, matchOrderItem, resolveReview,
  deleteOrders, setDeliveryManual, submitToDelivery, updateOrderCustomer,
} from '@/lib/actions/orders';

export function StatusActions({ orderId, status, version, isManager, beforeChange, confirmBlockers }: {
  orderId: string; status: ConfirmationStatus; version: number; isManager: boolean;
  /** Saves pending edits first; returns the new order version, or null to abort. */
  beforeChange?: () => Promise<number | null>;
  /** Missing fields that prevent confirming the order. */
  confirmBlockers?: string[];
}) {
  const t = useTranslations();
  const { run, pending } = useAction();
  const [note, setNote] = useState('');
  const [manual, setManual] = useState<string>('');
  const next = nextNoAnswer(status);

  const apply = async (s: ConfirmationStatus) => {
    if (s === 'confirmed' && confirmBlockers?.length) {
      toast.error(t('orders.completeBeforeConfirm', { fields: confirmBlockers.join(', ') }));
      return;
    }
    let v = version;
    if (beforeChange) {
      const saved = await beforeChange();
      if (saved === null) return;
      v = saved;
    }
    run(() => changeConfirmationStatus({ orderId, status: s, note, version: v }), {
      success: t(`confirmation.${s}`),
      onSuccess: () => setNote(''),
    });
  };

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap gap-2">
        <Button variant="success" disabled={pending || status === 'confirmed'} onClick={() => void apply('confirmed')}><Check />{t('orders.markConfirmed')}</Button>
        {next ? <Button variant="warning" disabled={pending} onClick={() => void apply(next)}><PhoneMissed />{t('orders.noAnswerNext')} ({next.slice(-1)})</Button> : null}
        <Button variant="outline" disabled={pending || status === 'unreachable'} onClick={() => void apply('unreachable')}><PhoneOff />{t('orders.markUnreachable')}</Button>
        <PostponeDialog orderId={orderId} version={version} beforeChange={beforeChange} />
        <Button variant="outline" disabled={pending || status === 'duplicate'} onClick={() => void apply('duplicate')}><Copy />{t('orders.markDuplicate')}</Button>
        <Button variant="destructive" disabled={pending || status === 'cancelled'} onClick={() => void apply('cancelled')}><Ban />{t('orders.markCancelled')}</Button>
      </div>
      <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('orders.statusNote')} maxLength={4000} rows={2} />
      {isManager ? (
        <div className="flex gap-2">
          <Select value={manual} onChange={(e) => setManual(e.target.value)} className="max-w-xs" aria-label={t('orders.changeStatus')}>
            <option value="">{t('orders.changeStatus')}…</option>
            {CONFIRMATION_STATUSES.filter((s) => s !== 'postponed').map((s) => <option key={s} value={s}>{t(`confirmation.${s}`)}</option>)}
          </Select>
          <Button variant="outline" disabled={!manual || pending} onClick={() => void apply(manual as ConfirmationStatus)}>{t('common.apply')}</Button>
        </div>
      ) : null}
    </div>
  );
}

export function NoteForm({ orderId }: { orderId: string }) {
  const t = useTranslations('orders');
  const { run, pending } = useAction();
  const [body, setBody] = useState('');
  return (
    <form
      className="grid gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!body.trim()) return;
        run(() => addOrderNote({ orderId, body }), { onSuccess: () => setBody('') });
      }}
    >
      <Textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder={t('notePlaceholder')} rows={2} maxLength={4000} />
      <Button type="submit" size="sm" variant="secondary" disabled={pending || !body.trim()}>{t('addNote')}</Button>
    </form>
  );
}

type CustomerFields = { customer_name: string; phone: string; phone2: string; wilaya_code: number | null; commune: string; address: string; delivery_type: string };

export function CustomerEditor({ orderId, version, initial, wilayas, communes }: { orderId: string; version: number; initial: CustomerFields; wilayas: { code: number; name: string }[]; communes: CommuneOption[] }) {
  const t = useTranslations();
  const { run, pending } = useAction();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState(initial);
  const set = (k: keyof CustomerFields, v: string | number | null) => setF((p) => ({ ...p, [k]: v }));
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button size="sm" variant="outline">{t('common.edit')}</Button></DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>{t('orders.editCustomer')}</DialogTitle></DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5"><Label>{t('orders.customerName')}</Label><Input value={f.customer_name} onChange={(e) => set('customer_name', e.target.value)} /></div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5"><Label>{t('orders.phone')}</Label><Input dir="ltr" value={f.phone} onChange={(e) => set('phone', e.target.value)} /></div>
            <div className="grid gap-1.5"><Label>{t('orders.phone2')}</Label><Input dir="ltr" value={f.phone2} onChange={(e) => set('phone2', e.target.value)} /></div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label>{t('orders.wilaya')}</Label>
              <Select value={f.wilaya_code ?? ''} onChange={(e) => set('wilaya_code', e.target.value ? Number(e.target.value) : null)}>
                <option value="">—</option>
                {wilayas.map((w) => <option key={w.code} value={w.code}>{String(w.code).padStart(2, '0')} — {w.name}</option>)}
              </Select>
            </div>
            <div className="grid gap-1.5"><Label>{t('orders.commune')}</Label><CommuneSelect communes={communes} wilayaCode={f.wilaya_code} value={f.commune} stopDeskOnly={f.delivery_type === 'stopdesk'} onChange={(v) => set('commune', v)} /></div>
          </div>
          <div className="grid gap-1.5"><Label>{t('orders.address')}</Label><Textarea value={f.address} onChange={(e) => set('address', e.target.value)} rows={2} /></div>
          <div className="grid gap-1.5">
            <Label>{t('orders.deliveryType')}</Label>
            <Select value={f.delivery_type} onChange={(e) => set('delivery_type', e.target.value)}>
              <option value="home">{t('orders.home')}</option>
              <option value="stopdesk">{t('orders.stopdesk')}</option>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>{t('common.cancel')}</Button>
          <Button disabled={pending} onClick={() => run(() => updateOrderCustomer({ orderId, version, patch: f }), { success: t('common.saved'), onSuccess: () => setOpen(false) })}>{t('common.save')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function AssignControl({ orderId, agents }: { orderId: string; agents: { id: string; full_name: string }[] }) {
  const t = useTranslations('orders');
  const { run, pending } = useAction();
  const [agentId, setAgentId] = useState('');
  const [force, setForce] = useState(false);
  return (
    <div className="grid gap-2">
      <Select value={agentId} onChange={(e) => setAgentId(e.target.value)} aria-label={t('assignTo')}>
        <option value="">{t('assignTo')}</option>
        {agents.map((a) => <option key={a.id} value={a.id}>{a.full_name}</option>)}
      </Select>
      <label className="flex items-center gap-2 text-xs text-muted-foreground"><Checkbox checked={force} onChange={(e) => setForce(e.target.checked)} />{t('forceCapacity')}</label>
      <div className="flex gap-2">
        <Button size="sm" disabled={!agentId || pending} onClick={() => run(() => assignOrders({ orderIds: [orderId], agentId, force }))}>{t('assign')}</Button>
        <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => autoAssignOrders([orderId]))}>{t('autoAssign')}</Button>
      </div>
    </div>
  );
}

export function ReviewControl({ orderId }: { orderId: string }) {
  const t = useTranslations('orders');
  const { run, pending } = useAction();
  const [note, setNote] = useState('');
  return (
    <div className="grid gap-2">
      <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('statusNote')} rows={2} />
      <Button size="sm" variant="warning" disabled={pending} onClick={() => run(() => resolveReview({ orderId, note }))}>{t('resolveReview')}</Button>
    </div>
  );
}

export function DeliveryControl({ orderId, deliveryStatus, providers, currentProvider, tracking }: {
  orderId: string; deliveryStatus: string; providers: { id: string; name: string; code: string }[]; currentProvider: string | null; tracking: string;
}) {
  const t = useTranslations();
  const { run, pending, errorMessage } = useAction();
  const [providerId, setProviderId] = useState(currentProvider ?? providers[0]?.id ?? '');
  const [status, setStatus] = useState(deliveryStatus);
  const [trk, setTrk] = useState(tracking);
  const provider = providers.find((p) => p.id === providerId);
  const canApi = provider && provider.code !== 'manual' && ['not_submitted', 'submission_failed', 'pending_submission'].includes(deliveryStatus);
  return (
    <div className="grid gap-3">
      <Select value={providerId} onChange={(e) => setProviderId(e.target.value)} aria-label={t('deliveryPage.chooseProvider')}>
        {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </Select>
      {canApi ? (
        <Button disabled={pending} onClick={() => run(() => submitToDelivery({ orderIds: [orderId], providerId }), {
          success: (d) => (d?.ok ? t('delivery.submitted') : errorMessage(d?.results[0]?.error ?? 'unknown', { fields: d?.results[0]?.details?.map((f) => (t.has(`fields.${f}`) ? t(`fields.${f}`) : f)).join(', ') ?? '' })),
        })}><Send />{t('orders.submitDelivery')}</Button>
      ) : null}
      <div className="grid gap-2 border-t pt-3">
        <Label className="text-xs text-muted-foreground">{t('orders.manualDelivery')}</Label>
        <Input dir="ltr" value={trk} onChange={(e) => setTrk(e.target.value)} placeholder={t('orders.tracking')} />
        <Select value={status} onChange={(e) => setStatus(e.target.value)}>
          {DELIVERY_STATUSES.map((s) => <option key={s} value={s}>{t(`delivery.${s}`)}</option>)}
        </Select>
        <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => setDeliveryManual({ orderId, status, tracking: trk, providerId: providerId || null }), { success: t('common.saved') })}>{t('common.save')}</Button>
      </div>
    </div>
  );
}

export function ItemMatcher({ itemId, products }: { itemId: string; products: { id: string; name: string; sku: string | null }[] }) {
  const t = useTranslations('products');
  const { run, pending } = useAction();
  const [productId, setProductId] = useState('');
  return (
    <div className="mt-1 flex gap-1">
      <Select className="h-7 text-xs" value={productId} onChange={(e) => setProductId(e.target.value)} aria-label={t('matchTo')}>
        <option value="">{t('matchTo')}…</option>
        {products.map((p) => <option key={p.id} value={p.id}>{p.name}{p.sku ? ` (${p.sku})` : ''}</option>)}
      </Select>
      <Button size="sm" className="h-7" disabled={!productId || pending} onClick={() => run(() => matchOrderItem({ itemId, productId, remember: true }))}>OK</Button>
    </div>
  );
}

/** Owner-only permanent deletion from the order page. */
export function DeleteOrderButton({ orderId, reference }: { orderId: string; reference: number }) {
  const t = useTranslations();
  const { run, pending } = useAction();
  const router = useRouter();
  return (
    <Button size="sm" variant="ghost" className="text-destructive hover:bg-destructive/10" disabled={pending}
      onClick={() => { if (confirm(t('orders.deleteOneConfirm', { reference }))) run(() => deleteOrders([orderId]), { success: t('orders.deleted', { count: 1 }), refresh: false, onSuccess: () => router.push('/orders') }); }}>
      <Trash2 />{t('common.delete')}
    </Button>
  );
}
