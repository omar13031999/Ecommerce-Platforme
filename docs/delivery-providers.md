# Delivery providers

## ECOTRACK (Navex and other ECOTRACK-based companies)

Dedicated adapter (`src/lib/integrations/delivery/adapters/ecotrack.ts`), written from the official
[ECOTRACK API Postman documentation](https://documenter.getpostman.com/view/14517169/Tz5je15g).

*Paramètres → Intégrations → Nouveau transporteur → ECOTRACK*

* **URL de base** — the company's ECOTRACK instance, e.g. `https://navexdelivery.ecotrack.dz`.
* **Token API** — generated in the ECOTRACK account (sent as `Authorization: Bearer`).
* **Configuration JSON** (optional): `{ "auto_validate": false, "ask_collection": true, "use_stock": false }` — with `auto_validate`
  the order is also shipped (`valid/order`) right after creation; otherwise validate it in the ECOTRACK panel.
* **Importer les communes** fills the communes reference table with the company's exact spelling (`get/communes`);
  the order forms then offer a commune list filtered by wilaya (stop-desk communes only for stop-desk orders).
* **Importer les produits** creates/renames products so SKU = ECOTRACK reference and name = ECOTRACK title
  (`get/products/list`). Selling prices and costs stay to be filled in the platform.
* `"use_stock": true` sends parcels prepared from the stock held by the company (`stock=1`, `produit` = references,
  `quantite` = quantities); every order line must then be matched to a product with a SKU.
* Statuses are read in batches of 100 with `get/orders/status?status=all` (rate limits: 50 req/min) and mapped
  to internal statuses (overridable in *Correspondance des statuts*).
* **Webhooks**: the payload format is not in the public documentation, so a webhook is only a trigger: tracking
  numbers found in the body are re-read from the API with the account token. Declare the URL shown in the
  provider dialog in ECOTRACK → Webhooks. Raw payloads are kept in `webhook_inbox`.
* Not covered: labels (PDF requires the token; download from the panel), per-parcel fees (use *Tarifs transporteur*
  or the COD statement import).

## Why there is no Yalidine / ZR Express / … adapter yet (other providers)

The brief requires using official provider documentation and never inventing endpoints, authentication or payload
formats. While building, the providers' documentation hosts were unreachable from the build environment, so no
provider-specific code was written from memory. Instead the platform ships:

* **Manual** — for companies without an API: tracking numbers and statuses are entered on the order page or imported
  (CSV/XLSX with columns `tracking,status` — *Livraison → Importer des statuts*). Settlements and real delivery costs
  are imported from the provider statement (*Rapprochement COD → Importer un relevé*).
* **Configurable REST** — for any provider with a JSON API. Everything provider-specific is configuration copied
  from the provider's official documentation, so nothing is guessed in code.

Both support the full pipeline: idempotent submission, ambiguous-timeout reconciliation, webhooks, polling, status
mapping, fees, tracking links, delivery history.

## Configuring a REST provider

*Paramètres → Intégrations → Nouveau transporteur → API REST configurable*

* **Base URL** — the API root from the provider docs.
* **Credentials** — `api_key`, optional `api_id`, optional `webhook_secret`. Stored encrypted; referenced in the
  config as `{{credentials.api_key}}`.
* **Configuration JSON** — schema (all paths are dot paths, e.g. `data.0.tracking`):

```jsonc
{
  "auth": { "headers": { "<HEADER-FROM-DOCS>": "{{credentials.api_key}}" } },
  "test": { "path": "<endpoint that validates the key>" },
  "create": {
    "method": "POST",
    "path": "<create-order endpoint>",
    "body": {
      // map the provider's field names to our variables:
      // {{reference}} {{customerName}} {{firstName}} {{lastName}} {{phone}} {{phone2}}
      // {{wilayaCode}} {{wilayaName}} {{commune}} {{address}} {{deliveryType}}
      // {{productsLabel}} {{products}} {{codAmount}} {{deliveryFeeCharged}} {{notes}}
    },
    "tracking_path": "<path of the tracking number in the response>",
    "id_path": "<optional>", "label_path": "<optional>", "success_path": "<optional boolean flag>"
  },
  "lookup":   { "path": "<find order by our reference, use {{reference}}>", "tracking_path": "…" },
  "tracking": { "path": "<tracking endpoint, use {{tracking}}>", "events_path": "<optional list>",
                "status_path": "…", "date_path": "…" },
  "fees":     { "path": "<optional, use {{tracking}}>", "fee_path": "…", "return_fee_path": "…" },
  "webhook":  { "signature_header": "<optional, HMAC-SHA256 of raw body with webhook_secret>",
                "signature_encoding": "hex", "events_path": "…", "tracking_path": "…",
                "status_path": "…", "date_path": "…", "id_path": "…" },
  "status_map": { "<provider status text>": "<internal status>" }
}
```

Internal statuses: `submitted, processing, ready_for_pickup, picked_up, in_transit, out_for_delivery, distributed,
delivered, failed_delivery, returned, cancelled`. Unmapped provider statuses are stored (with the raw payload) but do
not change the order; add mappings in the provider's *Correspondance des statuts* dialog.

**Configure `lookup`** whenever the provider offers a search by reference: it is what makes retries after a timeout
safe. Without it, an ambiguous submission requires manual verification.

### Webhooks

Enable *Webhooks* to get the URL `https://<APP_URL>/api/webhooks/delivery/<provider id>/<secret token>` and declare it
at the provider. Providers that require a subscription handshake need a dedicated adapter (`handleWebhook` can return
`{ kind: 'challenge' }`).

### Before enabling automatic submission

1. *Tester* (connection test endpoint) must succeed.
2. Submit one real test parcel manually from an order page and check tracking, label and status updates.
3. Add the status mappings for every status the provider can send.
4. Then enable *Envoi automatique* in *Paramètres → Livraison*.

## Writing a dedicated adapter

Implement `DeliveryAdapter` (`src/lib/integrations/delivery/types.ts`) from the official docs, register it in
`registry.ts`, and add its label to `messages/*.json` (`integrations.adapter_<code>`). Required behaviour:

* `createShipment` must throw `ProviderError('ambiguous')` when the outcome is unknown (timeout, 5xx) and
  `validation`/`auth` when the provider definitively refused.
* Provide `findShipmentByReference` if the API allows it.
* `fetchTracking` returns all events (the engine deduplicates); `handleWebhook` must verify signatures.
