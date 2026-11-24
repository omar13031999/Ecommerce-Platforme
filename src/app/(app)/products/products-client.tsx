'use client';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Archive, ArchiveRestore, History, Pencil, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { useAction } from '@/components/app/use-action';
import { recalculateCosts, saveProduct, setProductArchived } from '@/lib/actions/products';
import { todayInAlgiers } from '@/lib/dates';

type P = { id?: string; name: string; sku: string; description: string; selling_price: number; purchase_cost: number | null; packaging_cost: number | null; storage_cost: number | null };
const EMPTY: P = { name: '', sku: '', description: '', selling_price: 0, purchase_cost: null, packaging_cost: null, storage_cost: null };

export function ProductDialog({ product, canCost, canEdit = true }: { product?: P; canCost: boolean; canEdit?: boolean }) {
  const t = useTranslations();
  const { run, pending } = useAction();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState<P>(product ?? EMPTY);
  const n = (v: string) => (v === '' ? null : Number(v));
  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (o) setF(product ?? EMPTY); }}>
      <DialogTrigger asChild>
        {product ? <Button size="icon" variant="ghost" aria-label={t('common.edit')}><Pencil /></Button> : <Button><Plus />{t('products.new')}</Button>}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>{product ? product.name : t('products.new')}</DialogTitle></DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5"><Label>{t('common.name')}</Label><Input disabled={!canEdit} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5"><Label>{t('products.sku')}</Label><Input disabled={!canEdit} dir="ltr" value={f.sku} onChange={(e) => setF({ ...f, sku: e.target.value })} /></div>
            <div className="grid gap-1.5"><Label>{t('products.sellingPrice')}</Label><Input disabled={!canEdit} type="number" min={0} value={f.selling_price} onChange={(e) => setF({ ...f, selling_price: Number(e.target.value) })} /></div>
          </div>
          <div className="grid gap-1.5"><Label>{t('common.description')}</Label><Textarea disabled={!canEdit} rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></div>
          {canCost ? (
            <div className="grid gap-3 rounded-md border border-primary/30 bg-accent/30 p-3 sm:grid-cols-3">
              <div className="grid gap-1.5"><Label>{t('products.purchaseCost')}</Label><Input type="number" min={0} value={f.purchase_cost ?? ''} onChange={(e) => setF({ ...f, purchase_cost: n(e.target.value) })} /></div>
              <div className="grid gap-1.5"><Label className="text-xs">{t('products.packagingCost')}</Label><Input type="number" min={0} value={f.packaging_cost ?? ''} onChange={(e) => setF({ ...f, packaging_cost: n(e.target.value) })} /></div>
              <div className="grid gap-1.5"><Label className="text-xs">{t('products.storageCost')}</Label><Input type="number" min={0} value={f.storage_cost ?? ''} onChange={(e) => setF({ ...f, storage_cost: n(e.target.value) })} /></div>
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button disabled={pending || !f.name.trim()} onClick={() => run(() => saveProduct({
            ...f, ...(canCost ? {} : { purchase_cost: undefined, packaging_cost: undefined, storage_cost: undefined }),
          }), { success: t('common.saved'), onSuccess: () => setOpen(false) })}>{t('common.save')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ArchiveButton({ id, archived }: { id: string; archived: boolean }) {
  const t = useTranslations('common');
  const { run, pending } = useAction();
  return (
    <Button size="icon" variant="ghost" disabled={pending} aria-label={archived ? t('unarchive') : t('archive')} onClick={() => run(() => setProductArchived(id, !archived))}>
      {archived ? <ArchiveRestore /> : <Archive />}
    </Button>
  );
}

export function RecalculateDialog({ productId }: { productId: string }) {
  const t = useTranslations();
  const { run, pending } = useAction();
  const [from, setFrom] = useState(`${todayInAlgiers().slice(0, 7)}-01`);
  const [to, setTo] = useState(todayInAlgiers());
  return (
    <Dialog>
      <DialogTrigger asChild><Button size="icon" variant="ghost" aria-label={t('products.recalculate')}><History /></Button></DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('products.recalculate')}</DialogTitle>
          <DialogDescription>{t('products.recalculateHelp')}</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div className="grid gap-1.5"><Label>{t('common.from')}</Label><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
          <div className="grid gap-1.5"><Label>{t('common.to')}</Label><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
        </div>
        <DialogFooter>
          <Button variant="warning" disabled={pending} onClick={() => run(() => recalculateCosts({ productId, from, to }), { success: (n) => t('products.recalculated', { count: Number(n) }) })}>{t('common.confirm')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
