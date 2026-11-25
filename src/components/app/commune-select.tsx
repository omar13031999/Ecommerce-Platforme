'use client';
import { useTranslations } from 'next-intl';
import { Input, Select } from '@/components/ui/input';

export type CommuneOption = { wilaya_code: number; name: string; has_stop_desk: boolean };

/**
 * Commune picker filtered by wilaya (names as spelled by the delivery company).
 * Falls back to free text when no list is available for the wilaya; a current
 * value that is not in the list stays selectable and is flagged.
 */
export function CommuneSelect({ communes, wilayaCode, value, onChange, stopDeskOnly, name, className }: {
  communes: CommuneOption[];
  wilayaCode: number | null | undefined;
  value: string;
  onChange: (v: string) => void;
  stopDeskOnly?: boolean;
  name?: string;
  className?: string;
}) {
  const t = useTranslations('orders');
  const options = communes.filter((c) => c.wilaya_code === Number(wilayaCode) && (!stopDeskOnly || c.has_stop_desk));
  if (!wilayaCode || !communes.some((c) => c.wilaya_code === Number(wilayaCode))) {
    return <Input name={name} className={className} value={value} onChange={(e) => onChange(e.target.value)} />;
  }
  const known = options.some((c) => c.name.toLowerCase() === value.trim().toLowerCase());
  return (
    <Select name={name} className={className} value={known ? options.find((c) => c.name.toLowerCase() === value.trim().toLowerCase())!.name : value} onChange={(e) => onChange(e.target.value)}>
      <option value="">—</option>
      {value && !known ? <option value={value}>⚠ {value} ({t('communeUnknown')})</option> : null}
      {options.map((c) => <option key={c.name} value={c.name}>{c.name}{c.has_stop_desk ? ' · Stop desk' : ''}</option>)}
    </Select>
  );
}
