import type { DeliveryAdapter } from '../types';
import { baseValidation } from '../types';

/**
 * Provider without API: tracking numbers and statuses are entered manually or
 * imported (CSV/Excel). Fully functional, nothing is simulated.
 */
export const manualAdapter: DeliveryAdapter = {
  code: 'manual',
  name: 'Manuel / sans API',
  docsUrl: null,
  integrationLevel: 'manual',
  defaultBaseUrl: null,
  credentialFields: [],
  configFields: [],
  capabilities: { createShipment: false, findByReference: false, tracking: false, webhooks: false, fees: false },
  statusMap: {},
  validate: baseValidation,
};
