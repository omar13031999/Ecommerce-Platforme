# Gestion Commandes — plateforme e-commerce (Algérie)

Order management, confirmation, delivery and financial platform for an e-commerce business operating in Algeria.
French (default, LTR) and Arabic (RTL) interface.

| Module | What it does |
| --- | --- |
| Orders | Import (Google Sheets, manual), multi-product orders, full field-level history, advanced filters, bulk actions, CSV/Excel export |
| Confirmation | 14 statuses (Nouveau → Pas de réponse 1–9 → Injoignable / Annulé / Doublé / Confirmé), notes, optimistic locking |
| Assignment | **Capacity-based** auto-assignment (lowest active workload, never round-robin), waiting queue, rebalancing, history |
| Redistribution | Configurable "No answer" threshold, prefers agents who never handled the order, loop protection, notes preserved |
| Delivery | Adapter architecture (API, webhooks **and** polling), idempotent submission, status mapping, tracking history |
| COD reconciliation | Expected / collected / provider fees / transferred / outstanding — delivery ≠ payment |
| Products | SKU, selling price, confidential purchase cost, **historical cost snapshots**, matching rules for imported labels |
| Finance | Profit maturity (potential / expected / realized / returns), daily-weekly-monthly, double-counting warnings |
| Expenses | Unlimited custom categories, recurring expenses (idempotent generation), attachments, payment status |
| Meta Ads | OAuth (`ads_read`), multi-account daily insights sync, FX to DZD, attribution + estimated allocation |
| Team | Roles (owner / confirmation manager / agent), extra permissions, capacity, performance |

## Stack

Next.js 15 (App Router, Server Actions) · TypeScript (strict) · Tailwind CSS + shadcn-style components (Radix) ·
Supabase (PostgreSQL, Auth, RLS, Storage) · next-intl · TanStack Query · React Hook Form + Zod · Recharts · ExcelJS.

## Security model (summary)

* **Financial privacy is enforced by PostgreSQL**, not by the UI. Confidential data lives in dedicated tables
  (`product_costs`, `order_item_costs`, `order_financials`, `cod_settlements`, `expenses*`, `ad_*`, `delivery_rates`,
  raw delivery API responses) whose RLS policies require `finance.*` / `ads.*` / `delivery.*` permissions.
  An agent manipulating requests, URLs or the REST API directly gets **zero rows** (covered by `supabase/tests/30_*`).
* Agents only see orders currently assigned to them; after a redistribution they immediately lose access.
* Workflow columns (status, assignment, delivery) cannot be updated directly — only through `SECURITY DEFINER`
  RPCs that validate permissions and transitions and write history.
* Internal engine functions are **not executable** by signed-in users (explicit EXECUTE allow-list, migration 0010).
* Every server action / route re-checks permissions server-side (`requireUser`) and uses the user's RLS-scoped
  client; the service-role client is only used after an explicit check (cron, webhooks, integrations, auth admin).
* Integration tokens and API keys are AES-256-GCM encrypted (`ENCRYPTION_KEY`) in a table with RLS and **no policy**
  (service role only). Never sent to the browser.
* OAuth flows use single-use, user-bound `state` (+ PKCE for Google). Webhooks use an unguessable per-provider path
  token, optional HMAC signature, raw payload storage and idempotent processing.
* Exports are permission-checked **and** run as the user (RLS) with spreadsheet formula-injection protection.
* Audit log for settings, staff/permission changes, products, costs, expenses, settlements, integrations.

Details: [docs/architecture.md](docs/architecture.md).

## Getting started

```bash
npm install
cp .env.example .env.local   # fill in the values
```

1. Create a Supabase project (or `npx supabase start` locally).
2. Apply the migrations in `supabase/migrations` in order (`npx supabase db push`, or run them in the SQL editor).
3. In Supabase Auth settings, **disable public sign-ups** (accounts are created by the owner from the *Équipe* page).
4. Create the first owner account:

   ```bash
   node --env-file=.env.local scripts/create-admin.mjs owner@example.com 'StrongPassword' 'Nom du propriétaire'
   ```

5. Run the app: `npm run dev` → <http://localhost:3000>.

### Scheduler

Background work (assignment queue & redistribution sweep, Google Sheets sync, delivery polling, automatic delivery
submission, Meta sync, recurring expenses) runs from `GET /api/cron` with `Authorization: Bearer $CRON_SECRET`.
Recommended: Supabase `pg_cron` + `pg_net` calling it every 5 minutes (works on the Vercel Hobby plan, which only
allows daily Vercel crons) — see `docs/deployment.md`. Each job holds a database lease, so overlapping calls are harmless.

## Tests

```bash
npm test          # unit tests: sheet mapping, amount/date parsing, ad allocation, templates, dates, i18n parity
npm run test:db   # PostgreSQL suite: migrations, assignment engine, redistribution, RLS privacy,
                  # delivery state machine, profit formulas, recurring expenses, 300-order concurrency test
npm run typecheck && npm run lint && npm run build
```

`test:db` needs a local PostgreSQL 15+ (`initdb`, `pg_ctl`); it emulates the Supabase `auth` schema and roles.

## Integrations status

| Integration | Status |
| --- | --- |
| Google Sheets | Implemented with the official OAuth 2.0 + Sheets API v4 (read-only scope). Requires `GOOGLE_CLIENT_ID/SECRET`. Not exercised against Google in CI (no credentials). See [docs/integrations.md](docs/integrations.md). |
| Meta Marketing / Insights API | Implemented with official Graph API endpoints (`ads_read`, long-lived token, `appsecret_proof`). Requires a Meta app and, for business use, App Review. Not exercised against Meta in CI. |
| Delivery companies | **No provider-specific adapter ships yet**, on purpose: their official documentation could not be retrieved while building, and endpoints must not be guessed. Two working adapters are provided: *Manual* (tracking/status by hand or CSV/Excel import) and *Configurable REST* (endpoints, payload template, response paths, webhook format and status mapping entered from the provider's official docs). See [docs/delivery-providers.md](docs/delivery-providers.md) for how to configure Yalidine, ZR Express, Maystro, Ecotrack-based companies, etc., or to add a dedicated adapter. |

## Project layout

```
supabase/migrations   schema, engine, RLS, reporting (source of truth for authorization)
supabase/tests        SQL test-suite + concurrency test
src/app/(app)         authenticated pages (dashboard, orders, delivery, finance, …)
src/app/api           cron, webhooks, OAuth callbacks, exports, notifications
src/lib/actions       server actions (validated with Zod, permission-checked)
src/lib/services      delivery orchestration, sheets sync, Meta sync, jobs, exports
src/lib/integrations  delivery adapters, Google Sheets mapping/client, Meta client
src/lib/domain        pure business logic (statuses, ad allocation)
messages/{fr,ar}.json translations (parity enforced by tests)
```
