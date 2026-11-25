'use client';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Archive, ArchiveRestore, FileUp, History, Pencil, Plus, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox, Input, Select, Textarea } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { useAction } from '@/components/app/use-action';
import { applyPriceImport, previewPriceImport, recalculateCosts, saveProduct, setProductArchived } from '@/lib/actions/products';
import { importProviderProducts } from '@/lib/actions/delivery';
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

export function SyncStockButton({ providerId, label }: { providerId: string; label: string }) {
  const t = useTranslations();
  const { run, pending } = useAction();
  return (
    <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => importProviderProducts(providerId), {
      success: (d) => t('integrations.productsImported', { total: d?.total ?? 0, created: d?.created ?? 0, updated: d?.updated ?? 0 }),
    })}><RefreshCw className={pending ? 'animate-spin' : ''} />{t('products.syncStock', { provider: label })}</Button>
  );
}

type PreviewRow = { line: number; code: string; name: string; price: number | null; rule: string | null; products: { sku: string | null; name: string }[] };

/** Paste a price list (CODE / name / price) and apply it as purchase cost or selling price. */
export function PriceImportDialog({ canCost, canProducts }: { canCost: boolean; canProducts: boolean }) {
  const t = useTranslations();
  const { run, pending } = useAction();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [field, setField] = useState<'purchase_cost' | 'selling_price'>(canCost ? 'purchase_cost' : 'selling_price');
  const [createMissing, setCreateMissing] = useState(false);
  const [rows, setRows] = useState<PreviewRow[] | null>(null);
  const missing = rows?.filter((r) => !r.products.length && r.price !== null).length ?? 0;
  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) setRows(null); }}>
      <DialogTrigger asChild><Button size="sm" variant="outline"><FileUp />{t('products.importPrices')}</Button></DialogTrigger>
      <DialogContent className="max-w-3xl">
        <DialogHeader><DialogTitle>{t('products.importPrices')}</DialogTitle><DialogDescription>{t('products.importPricesHelp')}</DialogDescription></DialogHeader>
        <div className="grid gap-3">
          <Textarea dir="auto" rows={rows ? 4 : 10} className="font-mono text-xs" value={text} placeholder={'TG41\tTn Gold 41\t3500\nTMD\tTn Madrid (toutes tailles)\t4700'}
            onChange={(e) => { setText(e.target.value); setRows(null); }} />
          <div className="flex flex-wrap items-center gap-3">
            <Label>{t('products.applyAs')}</Label>
            <Select className="w-56" value={field} onChange={(e) => setField(e.target.value as typeof field)}>
              {canCost ? <option value="purchase_cost">{t('products.purchaseCost')}</option> : null}
              {canProducts ? <option value="selling_price">{t('products.sellingPrice')}</option> : null}
            </Select>
            <Button variant="outline" disabled={!text.trim() || pending} onClick={() => run(() => previewPriceImport({ text }), { refresh: false, onSuccess: (d) => setRows(d ?? []) })}>{t('products.previewImport')}</Button>
          </div>
          {rows ? (
            <div className="max-h-[45vh] overflow-y-auto rounded-md border">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-muted"><tr><th className="p-1.5 text-start">{t('products.sku')}</th><th className="p-1.5 text-start">{t('common.name')}</th><th className="p-1.5 text-end">DA</th><th className="p-1.5 text-start">{t('products.matchedTo')}</th></tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.line} className={!r.products.length ? 'bg-warning/10' : r.price === null ? 'bg-destructive/10' : ''}>
                      <td className="p-1.5 font-mono">{r.code}</td>
                      <td className="p-1.5">{r.name}</td>
                      <td className="p-1.5 text-end tabular">{r.price ?? '⚠'}</td>
                      <td className="p-1.5">{r.products.length ? <span className="font-mono">{r.products.map((p) => p.sku ?? p.name).join(', ')}{r.rule !== 'sku' ? <span className="ms-1 font-sans text-muted-foreground">({t(`products.rule_${r.rule}` as 'products.rule_sku')})</span> : null}</span> : <span className="text-warning">{t('products.notFound')}</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {rows && missing && canProducts ? (
            <label className="flex items-center gap-2 text-sm"><Checkbox checked={createMissing} onChange={(e) => setCreateMissing(e.target.checked)} />{t('products.createMissing', { count: missing })}</label>
          ) : null}
        </div>
        <DialogFooter>
          <Button disabled={!rows || pending} onClick={() => run(() => applyPriceImport({ text, field, createMissing }), {
            success: (d) => t('products.importPricesDone', { updated: d?.updated ?? 0, created: d?.created ?? 0, skipped: d?.skipped ?? 0 }),
            onSuccess: () => { setOpen(false); setRows(null); setText(''); },
          })}>{t('common.apply')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
