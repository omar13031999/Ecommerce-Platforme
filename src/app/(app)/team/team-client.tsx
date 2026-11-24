'use client';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Pencil, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox, Input, Select } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { useAction } from '@/components/app/use-action';
import { createStaffMember, resetStaffPassword, updateStaffMember } from '@/lib/actions/team';
import { PERMISSIONS, SENSITIVE_PERMISSIONS, roleDefaultPermissions, type Permission, type Role } from '@/lib/auth/permissions';

export function CreateMemberDialog({ isOwner }: { isOwner: boolean }) {
  const t = useTranslations();
  const { run, pending } = useAction();
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button><Plus />{t('team.new')}</Button></DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>{t('team.new')}</DialogTitle></DialogHeader>
        <form className="grid gap-3" onSubmit={(e) => {
          e.preventDefault();
          const d = Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>;
          run(() => createStaffMember({
            full_name: d.full_name ?? '', email: d.email ?? '', phone: d.phone, password: d.password ?? '',
            role: (d.role ?? 'agent') as Role, max_active_orders: d.max_active_orders ?? '30', locale: (d.locale ?? 'fr') as 'fr',
          }), { success: t('team.created'), onSuccess: () => setOpen(false) });
        }}>
          <div className="grid gap-1.5"><Label>{t('team.fullName')}</Label><Input name="full_name" required minLength={2} /></div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5"><Label>{t('team.email')}</Label><Input name="email" type="email" required dir="ltr" autoComplete="off" /></div>
            <div className="grid gap-1.5"><Label>{t('team.phone')}</Label><Input name="phone" dir="ltr" /></div>
          </div>
          <div className="grid gap-1.5"><Label>{t('team.password')}</Label><Input name="password" type="password" required minLength={8} autoComplete="new-password" /></div>
          <div className="grid grid-cols-3 gap-3">
            <div className="grid gap-1.5"><Label>{t('team.role')}</Label>
              <Select name="role" defaultValue="agent">
                <option value="agent">{t('team.role_agent')}</option>
                {isOwner ? <><option value="manager">{t('team.role_manager')}</option><option value="admin">{t('team.role_admin')}</option></> : null}
              </Select>
            </div>
            <div className="grid gap-1.5"><Label className="text-xs">{t('team.capacity')}</Label><Input name="max_active_orders" type="number" min={0} defaultValue={30} /></div>
            <div className="grid gap-1.5"><Label>{t('common.language')}</Label><Select name="locale" defaultValue="fr"><option value="fr">Français</option><option value="ar">العربية</option></Select></div>
          </div>
          <DialogFooter><Button type="submit" disabled={pending}>{t('common.create')}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

type Member = { id: string; full_name: string; phone: string | null; role: string; permissions: string[]; is_active: boolean; max_active_orders: number; accepts_assignments: boolean };

export function EditMemberDialog({ member, isOwner }: { member: Member; isOwner: boolean }) {
  const t = useTranslations();
  const { run, pending } = useAction();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState(member);
  const [pw, setPw] = useState('');
  const defaults = new Set<string>(roleDefaultPermissions(f.role as Role));
  const togglePerm = (p: Permission) => setF((x) => ({ ...x, permissions: x.permissions.includes(p) ? x.permissions.filter((y) => y !== p) : [...x.permissions, p] }));
  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (o) setF(member); }}>
      <DialogTrigger asChild><Button size="icon" variant="ghost" aria-label={t('common.edit')}><Pencil /></Button></DialogTrigger>
      <DialogContent className="max-w-xl">
        <DialogHeader><DialogTitle>{member.full_name}</DialogTitle><DialogDescription>{t('team.sensitiveHint')}</DialogDescription></DialogHeader>
        <div className="grid gap-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5"><Label>{t('team.fullName')}</Label><Input value={f.full_name} onChange={(e) => setF({ ...f, full_name: e.target.value })} /></div>
            <div className="grid gap-1.5"><Label>{t('team.phone')}</Label><Input dir="ltr" value={f.phone ?? ''} onChange={(e) => setF({ ...f, phone: e.target.value })} /></div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            {isOwner ? (
              <div className="grid gap-1.5"><Label>{t('team.role')}</Label>
                <Select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
                  {(['agent', 'manager', 'admin'] as const).map((r) => <option key={r} value={r}>{t(`team.role_${r}`)}</option>)}
                </Select>
              </div>
            ) : null}
            <div className="grid gap-1.5"><Label className="text-xs">{t('team.capacity')}</Label><Input type="number" min={0} value={f.max_active_orders} onChange={(e) => setF({ ...f, max_active_orders: Number(e.target.value) })} /></div>
          </div>
          <label className="flex items-center gap-2 text-sm"><Checkbox checked={f.is_active} onChange={(e) => setF({ ...f, is_active: e.target.checked })} />{t('common.active')}</label>
          <label className="flex items-center gap-2 text-sm"><Checkbox checked={f.accepts_assignments} onChange={(e) => setF({ ...f, accepts_assignments: e.target.checked })} />{t('team.acceptsAssignments')}</label>
          {isOwner && f.role !== 'admin' ? (
            <fieldset className="grid gap-1 rounded-md border p-3">
              <legend className="px-1 text-sm font-medium">{t('team.permissions')}</legend>
              <div className="grid gap-1 sm:grid-cols-2">
                {PERMISSIONS.map((p) => (
                  <label key={p} className="flex items-center gap-2 text-xs">
                    <Checkbox disabled={defaults.has(p)} checked={defaults.has(p) || f.permissions.includes(p)} onChange={() => togglePerm(p)} />
                    <span className={SENSITIVE_PERMISSIONS.includes(p) ? 'font-medium text-warning' : ''}>{t(`permissions.${p.replace('.', '_')}` as 'permissions.finance_view')}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          ) : null}
          <div className="flex gap-2 border-t pt-3">
            <Input type="password" autoComplete="new-password" placeholder={t('team.password')} value={pw} onChange={(e) => setPw(e.target.value)} />
            <Button variant="outline" disabled={pw.length < 8 || pending} onClick={() => run(() => resetStaffPassword({ userId: member.id, password: pw }), { success: t('common.saved'), onSuccess: () => setPw('') })}>{t('common.save')}</Button>
          </div>
        </div>
        <DialogFooter>
          <Button disabled={pending} onClick={() => run(() => updateStaffMember({
            userId: member.id,
            patch: {
              full_name: f.full_name, phone: f.phone ?? '', is_active: f.is_active, max_active_orders: f.max_active_orders, accepts_assignments: f.accepts_assignments,
              ...(isOwner ? { role: f.role as Role, permissions: f.permissions.filter((p) => !defaults.has(p)) as Permission[] } : {}),
            },
          }), { success: t('common.saved'), onSuccess: () => setOpen(false) })}>{t('common.save')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
