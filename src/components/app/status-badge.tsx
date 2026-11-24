import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { TONE_CLASSES, confirmationTone, deliveryTone, type ConfirmationStatus, type DeliveryStatus } from '@/lib/domain/statuses';

export function ConfirmationBadge({ status }: { status: ConfirmationStatus }) {
  const t = useTranslations('confirmation');
  return <Badge className={TONE_CLASSES[confirmationTone(status)]}>{t(status)}</Badge>;
}

export function DeliveryBadge({ status }: { status: DeliveryStatus }) {
  const t = useTranslations('delivery');
  return <Badge className={TONE_CLASSES[deliveryTone(status)]}>{t(status)}</Badge>;
}
