import type { DeliveryStatus } from '@/lib/domain/statuses';

export type ShipmentInput = {
  /** Our idempotency key, sent to the provider as its order reference. */
  reference: string;
  orderId: string;
  orderReference: number;
  customerName: string;
  firstName: string;
  lastName: string;
  phone: string;
  phone2?: string | null;
  wilayaCode: number | null;
  wilayaName: string | null;
  commune: string | null;
  address: string | null;
  deliveryType: 'home' | 'stopdesk';
  products: { name: string; quantity: number; unitPrice: number; sku?: string | null; productId?: string | null; externalId?: string | null }[];
  productsLabel: string;
  /** Amount the courier collects from the customer (COD). */
  codAmount: number;
  deliveryFeeCharged: number;
  notes?: string | null;
};

export type CreateShipmentResult = {
  trackingNumber: string;
  providerShipmentId?: string | null;
  providerReference?: string | null;
  labelUrl?: string | null;
  raw: unknown;
};

export type TrackingEvent = {
  trackingNumber: string;
  providerStatus: string;
  occurredAt: string | null;
  eventId?: string | null;
  reason?: string | null;
  raw: unknown;
};

export type FeeInfo = { trackingNumber: string; deliveryFee: number | null; returnFee?: number | null; raw: unknown };

export type AdapterContext = {
  baseUrl: string | null;
  credentials: Record<string, string>;
  config: Record<string, unknown>;
};

export type WebhookRequest = {
  method: string;
  headers: Record<string, string>;
  rawBody: string;
  query: Record<string, string>;
};

export type WebhookResult =
  | { kind: 'challenge'; response: string } // provider subscription handshake
  | { kind: 'events'; valid: boolean; events: TrackingEvent[] };

export type FieldSpec = { key: string; labelKey: string; secret: boolean; required: boolean; placeholder?: string };

export interface DeliveryAdapter {
  code: string;
  name: string;
  docsUrl: string | null;
  /**
   * 'documented': implemented from the provider's public API documentation but
   * must be validated with real credentials (test connection + a test parcel)
   * before enabling automatic submission.
   * 'manual': no API — statuses are entered manually or imported.
   */
  integrationLevel: 'documented' | 'manual';
  defaultBaseUrl: string | null;
  credentialFields: FieldSpec[];
  configFields: FieldSpec[];
  capabilities: {
    createShipment: boolean;
    findByReference: boolean;
    tracking: boolean;
    webhooks: boolean;
    fees: boolean;
  };
  /** Provider status (normalised lower-case) -> internal status. */
  statusMap: Record<string, DeliveryStatus>;
  /**
   * Cancels / deletes a parcel at the provider so the order can be edited and
   * sent again. Throws ProviderError('validation') when the provider refuses
   * (parcel already picked up / shipped).
   */
  cancelShipment?(ctx: AdapterContext, shipment: { trackingNumber: string; providerShipmentId: string | null }): Promise<void>;
  /** Returns missing/invalid field codes; empty array when valid. */
  validate(input: ShipmentInput): string[];
  testConnection?(ctx: AdapterContext): Promise<void>;
  createShipment?(ctx: AdapterContext, input: ShipmentInput): Promise<CreateShipmentResult>;
  findShipmentByReference?(ctx: AdapterContext, reference: string): Promise<CreateShipmentResult | null>;
  fetchTracking?(ctx: AdapterContext, trackingNumbers: string[]): Promise<TrackingEvent[]>;
  fetchFees?(ctx: AdapterContext, trackingNumbers: string[]): Promise<FeeInfo[]>;
  handleWebhook?(ctx: AdapterContext, req: WebhookRequest): Promise<WebhookResult>;
  trackingUrl?(trackingNumber: string): string | null;
}

export function normalizeProviderStatus(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Common validation shared by adapters. */
export function baseValidation(input: ShipmentInput): string[] {
  const errors: string[] = [];
  if (!input.customerName?.trim()) errors.push('customer_name');
  if (!/^0[5-7]\d{8}$|^0[2-4]\d{7,8}$/.test(input.phone.replace(/\D/g, ''))) errors.push('phone');
  if (!input.wilayaCode) errors.push('wilaya');
  if (!input.commune?.trim()) errors.push('commune');
  if (input.deliveryType === 'home' && !input.address?.trim()) errors.push('address');
  if (!input.products.length || input.products.some((p) => !p.name || p.quantity <= 0)) errors.push('products');
  if (!(input.codAmount >= 0)) errors.push('cod_amount');
  return errors;
}

export function splitName(full: string): { firstName: string; lastName: string } {
  const parts = full.trim().split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0] ?? '', lastName: parts[0] ?? '' };
  return { firstName: parts[0] ?? '', lastName: parts.slice(1).join(' ') };
}
