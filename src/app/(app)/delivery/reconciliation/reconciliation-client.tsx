'use client';
import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox, Input, Textarea } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { useAction } from '@/components/app/use-action';
import { importSettlementFile, saveSettlement } from '@/lib/actions/delivery';

type Row = { orderId: string; collected_amount: number | null; provider_fees: number | null; transferred_amount: number | null; transfer_date: string | null; payment_reference: string | null; notes: string | null; not_applicable: boolean };

export function SettlementEditor({ row }: { row: Row }) {
  const t = useTranslations();
  const { run, pending } = useAction();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState(row);
  const num = (v: string) => (v === '' ? null : Number(v));
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button size="sm" variant="outline">{t('common.edit')}</Button></DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>{t('reconciliation.edit')}</DialogTitle></DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5"><Label>{t('reconciliation.collected')}</Label><Input type="number" value={f.collected_amount ?? ''} onChange={(e) => setF({ ...f, collected_amount: num(e.target.value) })} /></div>
          <div className="grid gap-1.5"><Label>{t('reconciliation.providerFees')}</Label><Input type="number" value={f.provider_fees ?? ''} onChange={(e) => setF({ ...f, provider_fees: num(e.target.value) })} /></div>
          <div className="grid gap-1.5"><Label>{t('reconciliation.transferred')}</Label><Input type="number" value={f.transferred_amount ?? ''} onChange={(e) => setF({ ...f, transferred_amount: num(e.target.value) })} /></div>
          <div className="grid gap-1.5"><Label>{t('reconciliation.transferDate')}</Label><Input type="date" value={f.transfer_date ?? ''} onChange={(e) => setF({ ...f, transfer_date: e.target.value || null })} /></div>
          <div className="grid gap-1.5 sm:col-span-2"><Label>{t('reconciliation.paymentReference')}</Label><Input value={f.payment_reference ?? ''} onChange={(e) => setF({ ...f, payment_reference: e.target.value || null })} /></div>
          <div className="grid gap-1.5 sm:col-span-2"><Label>{t('common.notes')}</Label><Textarea rows={2} value={f.notes ?? ''} onChange={(e) => setF({ ...f, notes: e.target.value || null })} /></div>
          <label className="flex items-center gap-2 text-sm"><Checkbox checked={f.not_applicable} onChange={(e) => setF({ ...f, not_applicable: e.target.checked })} />{t('reconciliation.not_applicable')}</label>
        </div>
        <DialogFooter>
          <Button disabled={pending} onClick={() => run(() => saveSettlement(f), { success: t('common.saved'), onSuccess: () => setOpen(false) })}>{t('common.save')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function SettlementImport() {
  const t = useTranslations('reconciliation');
  const ref = useRef<HTMLInputElement>(null);
  const { run, pending } = useAction();
  return (
    <div className="flex items-center gap-2">
      <span className="hidden max-w-xs text-xs text-muted-foreground lg:block">{t('importHelp')}</span>
      <input ref={ref} type="file" accept=".csv,.xlsx" className="hidden" onChange={(e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const fd = new FormData();
        fd.set('file', file);
        run(() => importSettlementFile(fd), { success: (d) => t('importDone', { matched: d?.matched ?? 0, unmatched: d?.unmatched ?? 0 }) });
        e.target.value = '';
      }} />
      <Button variant="outline" disabled={pending} onClick={() => ref.current?.click()}><Upload />{t('import')}</Button>
    </div>
  );
}
