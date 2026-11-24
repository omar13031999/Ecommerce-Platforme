export const CONFIRMATION_STATUSES = [
  'new',
  'no_answer_1', 'no_answer_2', 'no_answer_3', 'no_answer_4', 'no_answer_5',
  'no_answer_6', 'no_answer_7', 'no_answer_8', 'no_answer_9',
  'unreachable',
  'cancelled',
  'duplicate',
  'confirmed',
] as const;
export type ConfirmationStatus = (typeof CONFIRMATION_STATUSES)[number];

export const DELIVERY_STATUSES = [
  'not_submitted',
  'pending_submission',
  'submission_failed',
  'submitted',
  'processing',
  'ready_for_pickup',
  'picked_up',
  'in_transit',
  'out_for_delivery',
  'distributed',
  'delivered',
  'failed_delivery',
  'returned',
  'cancelled',
] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export const IN_TRANSIT_STATUSES: readonly DeliveryStatus[] = [
  'submitted', 'processing', 'ready_for_pickup', 'picked_up', 'in_transit', 'out_for_delivery',
];
export const NOT_SENT_STATUSES: readonly DeliveryStatus[] = ['not_submitted', 'submission_failed'];

export function naLevel(s: ConfirmationStatus): number {
  const m = /^no_answer_(\d)$/.exec(s);
  return m ? Number(m[1]) : 0;
}

/** Next "no answer" status for the one-click "Pas de réponse" button. */
export function nextNoAnswer(s: ConfirmationStatus): ConfirmationStatus | null {
  const lvl = naLevel(s);
  if (lvl >= 9) return null;
  return `no_answer_${lvl + 1}` as ConfirmationStatus;
}

export function isConfirmationStatus(v: string): v is ConfirmationStatus {
  return (CONFIRMATION_STATUSES as readonly string[]).includes(v);
}
export function isDeliveryStatus(v: string): v is DeliveryStatus {
  return (DELIVERY_STATUSES as readonly string[]).includes(v);
}

type Tone = 'slate' | 'blue' | 'amber' | 'orange' | 'red' | 'green' | 'purple' | 'cyan' | 'zinc' | 'emerald' | 'rose';

export function confirmationTone(s: ConfirmationStatus): Tone {
  if (s === 'new') return 'blue';
  if (s === 'confirmed') return 'green';
  if (s === 'cancelled') return 'red';
  if (s === 'duplicate') return 'zinc';
  if (s === 'unreachable') return 'purple';
  const lvl = naLevel(s);
  return lvl >= 7 ? 'rose' : lvl >= 4 ? 'orange' : 'amber';
}

export function deliveryTone(s: DeliveryStatus): Tone {
  switch (s) {
    case 'not_submitted': return 'slate';
    case 'pending_submission': return 'amber';
    case 'submission_failed': return 'red';
    case 'submitted':
    case 'processing': return 'blue';
    case 'ready_for_pickup':
    case 'picked_up':
    case 'in_transit': return 'cyan';
    case 'out_for_delivery': return 'purple';
    case 'distributed': return 'emerald';
    case 'delivered': return 'green';
    case 'failed_delivery': return 'orange';
    case 'returned': return 'rose';
    case 'cancelled': return 'zinc';
  }
}

export const TONE_CLASSES: Record<Tone, string> = {
  slate: 'bg-slate-100 text-slate-700 ring-slate-200 dark:bg-slate-800 dark:text-slate-200 dark:ring-slate-700',
  blue: 'bg-blue-50 text-blue-700 ring-blue-200 dark:bg-blue-950 dark:text-blue-200 dark:ring-blue-900',
  amber: 'bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-950 dark:text-amber-200 dark:ring-amber-900',
  orange: 'bg-orange-50 text-orange-800 ring-orange-200 dark:bg-orange-950 dark:text-orange-200 dark:ring-orange-900',
  red: 'bg-red-50 text-red-700 ring-red-200 dark:bg-red-950 dark:text-red-200 dark:ring-red-900',
  green: 'bg-green-50 text-green-700 ring-green-200 dark:bg-green-950 dark:text-green-200 dark:ring-green-900',
  emerald: 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-950 dark:text-emerald-200 dark:ring-emerald-900',
  purple: 'bg-purple-50 text-purple-700 ring-purple-200 dark:bg-purple-950 dark:text-purple-200 dark:ring-purple-900',
  cyan: 'bg-cyan-50 text-cyan-800 ring-cyan-200 dark:bg-cyan-950 dark:text-cyan-200 dark:ring-cyan-900',
  zinc: 'bg-zinc-100 text-zinc-600 ring-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:ring-zinc-700',
  rose: 'bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-950 dark:text-rose-200 dark:ring-rose-900',
};
