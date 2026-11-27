'use client';
import { useTranslations } from 'next-intl';
import { MessageCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

/** Algerian number -> international digits for wa.me (0555… -> 213555…). Null when not a usable mobile/fixed number. */
export function whatsappNumber(phone: string): string | null {
  let d = (phone ?? '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('213')) d = d.slice(3);
  if (d.startsWith('0')) d = d.slice(1);
  return /^[5-7]\d{8}$|^[2-4]\d{7,8}$/.test(d) ? `213${d}` : null;
}

type Ctx = { name: string; reference: number; total: string; products: string; tracking?: string | null; when?: string | null };

/** Ready-made customer messages (Arabic, the customers' usual language). */
export function whatsappTemplates(c: Ctx): { key: string; text: string }[] {
  const hello = c.name && c.name !== 'Client sans nom' ? `السلام عليكم ${c.name}،` : 'السلام عليكم،';
  return [
    { key: 'confirm', text: `${hello}\nنتصل بكم بخصوص طلبكم رقم ${c.reference}: ${c.products}.\nالمبلغ الإجمالي: ${c.total}.\nهل تؤكدون الطلب والعنوان؟ شكراً.` },
    { key: 'noAnswer', text: `${hello}\nحاولنا الاتصال بكم لتأكيد طلبكم رقم ${c.reference} (${c.products}) ولم نتمكن من الوصول إليكم.\nيرجى الرد على هذه الرسالة أو معاودة الاتصال بنا. شكراً.` },
    { key: 'postponed', text: `${hello}\nكما اتفقنا، سنعاود الاتصال بكم${c.when ? ` يوم ${c.when}` : ''} بخصوص طلبكم رقم ${c.reference}. شكراً.` },
    { key: 'shipped', text: `${hello}\nتم إرسال طلبكم رقم ${c.reference} مع شركة التوصيل${c.tracking ? `، رقم التتبع: ${c.tracking}` : ''}.\nالمبلغ عند الاستلام: ${c.total}. شكراً لثقتكم.` },
  ];
}

export function WhatsAppButton({ phone, ctx, iconOnly = false }: { phone: string; ctx: Ctx; iconOnly?: boolean }) {
  const t = useTranslations('orders');
  const num = whatsappNumber(phone);
  if (!num) return null;
  const open = (text: string) => window.open(`https://wa.me/${num}?text=${encodeURIComponent(text)}`, '_blank', 'noopener,noreferrer');
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" size="icon" variant="outline" className={iconOnly ? 'size-8 shrink-0 text-[#1fa855]' : 'shrink-0 text-[#1fa855]'} title="WhatsApp" aria-label="WhatsApp">
          <MessageCircle />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>WhatsApp</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => open('')}>{t('waEmpty')}</DropdownMenuItem>
        {whatsappTemplates(ctx).map((m) => <DropdownMenuItem key={m.key} onSelect={() => open(m.text)}>{t(`wa_${m.key}` as 'wa_confirm')}</DropdownMenuItem>)}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
