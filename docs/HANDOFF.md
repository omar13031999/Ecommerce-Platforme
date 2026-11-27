# Handoff — Gestion Commandes (plateforme e-commerce COD, Algérie)

> **ملخّص بالعربية:** هذا الملف يلخّص كل ما بُني في المنصة حتى الآن، وأين يوجد كل شيء، وما بقي من عمل، لكي تواصل
> العمل في جلسة أو منصة أخرى. لا يحتوي أي مفتاح سري أو كلمة مرور (هي محفوظة مشفّرة في Vercel وفي المنصة).
> ابدأ بقسم «Où en est-on» ثم «Next steps».

Owner: the store owner (admin role). Team: 2 confirmers (agents). Business: cash-on-delivery e-commerce in Algeria
(shoes "Tn …" in sizes 39–44, car accessories, gadgets), carriers **Navex (ECOTRACK)** and **Maystro Delivery**.
The owner communicates in **Arabic** (sometimes French); answer in Arabic.

---

## 1. Where things are

| Item | Value |
| --- | --- |
| Repository | `omar13031999/Ecommerce-Platforme` (GitHub) |
| Working / production branch | `claude/serene-cori-1cgxok` (every push deploys production) |
| Production URL | https://ecommerce-platforme.vercel.app |
| Vercel | team `team_qrqqLhg5IYKs5Rf7E6N5d4RM` (slug `omar-04ce`), project `prj_lfhzmjohD4BjSHth7p4bb9u4Nx9J`, **Hobby plan** |
| Database | Supabase created by the Vercel ↔ Supabase integration (project ref `usnoaryhhliltyibubgd`, US). The older Paris project `wgmmypwvbhbcaykfmpgr` is **unused**. |
| Scheduler | Supabase `pg_cron` + `pg_net` call `GET /api/cron` every 5 min (Bearer `CRON_SECRET` from Supabase Vault `app_cron_secret`). Vercel crons are not used (Hobby = daily only). |
| Migrations | Applied automatically at every Vercel build by `scripts/migrate.mjs` (table `_app_migrations`), against `POSTGRES_URL_NON_POOLING`. |

### Vercel environment variables (names only — values are secret)
`APP_URL`, `CRON_SECRET`, `ENCRYPTION_KEY` (AES-GCM for integration secrets), `OWNER_EMAIL`, `OWNER_TEMP_PASSWORD`
(one-shot temp owner password, applied once by a marker row — **to delete** once the owner changed the password),
`META_GRAPH_VERSION`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `ANTHROPIC_API_KEY` (placeholder `A_REMPLACER` →
ignored; AI goes through Vercel AI Gateway), Supabase integration vars (`POSTGRES_*`, `SUPABASE_*`,
`NEXT_PUBLIC_SUPABASE_*`). Optional: `AI_GATEWAY_API_KEY`, `AI_EXTRACT_MODEL`.

Carrier tokens are **not** env vars: they are saved per provider in the app (Paramètres → Intégrations), encrypted in
`integration_secrets` (RLS, no policy → service role only).

---

## 2. Stack & architecture

Next.js 15.5 App Router (server actions) · TypeScript strict · Tailwind + shadcn-style UI · Supabase (Postgres, Auth,
RLS, Storage) · next-intl (FR default LTR, AR RTL; locale in cookie) · TanStack Query · RHF + Zod · Recharts · ExcelJS ·
`@anthropic-ai/sdk` + `@vercel/oidc` (AI extraction).

* **Authorization lives in Postgres**: `has_permission()`, RLS on every table, workflow columns only changed through
  `SECURITY DEFINER` RPCs; EXECUTE allow-list (migration 0010 — new functions are NOT executable by `authenticated`
  unless granted explicitly).
* Roles: `admin` (owner, everything), `manager`, `agent`. Agents (defaults since 0022): `delivery.view`,
  `products.create` — they see only their assigned orders and **never** costs/finance.
* Key folders: `supabase/migrations` (source of truth), `supabase/tests` (SQL tests), `src/lib/actions` (server
  actions), `src/lib/services` (delivery, sheets-sync, jobs, ecotrack-sync…), `src/lib/integrations/delivery/adapters`
  (`manual`, `rest`, `ecotrack`, `maystro`), `src/app/(app)` (pages), `messages/{fr,ar}.json` (parity enforced by tests).
* Docs: `README.md`, `docs/architecture.md`, `docs/delivery-providers.md`, `docs/integrations.md`, `docs/deployment.md`.

### Migrations (in order)
0001 foundation · 0002 catalog · 0003 orders · 0004 assignment engine (capacity-based, advisory lock) · 0005 delivery
state machine · 0006 finance · 0007 integrations · 0008 RPC & RLS · 0009 reporting · 0010 function privileges · 0011
storage · 0012 auth metadata sync · 0013 fixes · 0014 search_path · **0015 communes** · **0016 ecotrack provider
(auto-convert old REST Navex)** · **0017 provider stock mirror** · **0018 import incomplete orders** · **0019 confirmer
workspace (`update_order_items`, `clear_import_review`)** · **0020 reset sheet back-off** · **0021 `postponed` enum** ·
**0022 postpone + reminders, owner-only `delete_orders`, agent defaults, `products.create`** · **0023 phone blacklist +
saved filters** · **0024 `product_provider_links`** · **0025 auto-convert REST "Maystro" provider**.

### Tests
```bash
npm test            # 76 unit tests (vitest), incl. adapters with mocked fetch, workspace SSR render
npm run test:db     # PostgreSQL suite (needs local postgres): engine, RLS, delivery, imports, postpone/delete, blacklist
npm run typecheck && npm run lint
NODE_USE_ENV_PROXY=1 npm run test:live   # LIVE carrier tests (tests/live/*.live.ts) — need network + tokens
```
`tests/live/ecotrack.live.ts` creates test orders on Navex **with `auto_validate: false`** and deletes them (a shipped
ECOTRACK order cannot be deleted). `maystro.live.ts` and `stock.live.ts` are read-only.

---

## 3. Features in production

**Orders**
* Tabs: *À traiter* (new, no answer 1–9, unreachable, postponed — not sent) · *Confirmées à envoyer* · *Suivi des
  colis* (sent) · *Annulées / doublons*. Explicit filters without a tab search all orders.
* Inline status select + one-click "no answer" + postpone (📅) in the list; columns incl. elapsed time, stop desk badge,
  UTM, ⛔ blacklist; filters (status, delivery, agent, wilaya, product, total min/max, delivery type, UTM, blacklisted,
  review, waiting queue), per-user **saved filters**, Excel/CSV export.
* Bulk: assign / auto-assign / unassign, submit to carrier, change status (managers), block phone (managers), delete
  (owner only).
* Order page = **"Fiche de commande"**: customer, delivery (home/stop desk, wilaya, commune list), notes, product lines
  editable, totals; status buttons save first; *Confirmer* blocked while phone/wilaya/commune/address missing;
  WhatsApp templates (wa.me); history, notes, submission error card.
* **Postponed** status with date; `notify_due_postponed()` (cron job `postponed`) notifies the assigned confirmer once.
* Duplicate detection by phone (7 days); **phone blacklist** (`blocked_phones`, flag + review on new orders).
* Capacity-based auto-assignment + redistribution after N no-answers (settings page).

**Google Sheets import** (`src/lib/services/sheets-sync.ts`)
* OAuth or public share link (CSV export by gid); sync every 5 min; header row auto-detected.
* **Incomplete rows are imported** (placeholder name/product, `needs_review` + reason); resyncs never blank values
  corrected by confirmers; stable fingerprint id when no order-id column.
* Optional **AI extraction** per source ("Extraction intelligente par IA"): new rows only, batches of 15, max 60/sync,
  via **Vercel AI Gateway** (OIDC, model `anthropic/claude-haiku-5.5`) or direct Anthropic key. Falls back to column
  mapping. Needs the Vercel team's AI Gateway free credits unlocked (payment method on Vercel). Not yet observed on a
  real new row.

**Navex = ECOTRACK** (`adapters/ecotrack.ts`, docs: Postman collection 14517169/Tz5je15g)
* Bearer token (validate/token needs `api_token` query). Create (`create/order`, query params), **auto "Expédier"
  (`valid/order`) right after creation by default** (no pickup for stock orders; failure → note on order), stock mode
  automatic when all lines have a SKU, status polling via `get/orders/status?status=all` (batches of 100), lookup by
  reference, webhook used as a trigger.
* Commune replaced by ECOTRACK spelling before submit (`ecotrack-sync.ts`); communes + products + **stock mirror**
  refreshed every 30 min (communes daily). Verified live (create/read/delete). Status `prete_a_preparer` seen live.

**Maystro Delivery** (`adapters/maystro.ts`, official docs https://maystro.gitbook.io/maystro-delivery-documentation)
* `Authorization: Token <store token>`, base `https://backend.maystro-delivery.com/api`. Commune **ids** from
  `/shared/communes/` (fuzzy match ≤ 2 letters, never ambiguous: "Bab Ezzouar" → "Bab Azzouar" id 574). Products must
  be **Maystro product uuids** → "Lier les produits" dialog (`product_provider_links`); no auto-creation by default.
  Create `POST /stores/orders/` (source 4, delivery_type 1/2), tracking = `display_id`, status by `display_id`, 18
  documented status codes mapped (code 33 seen live, undocumented → stored unmapped), base64 webhooks as trigger.
* Verified on the live store: token, 188 products, 1004 orders, and (owner-approved) **create → status → lookup → cancel**
  of one test order (`tests/live/maystro-order.live.ts`). Config JSON: `{"store_id": "<store uuid>"}`.

**Other**: products (cost history, bulk price import with SKU families, carrier stock columns), finance (profit maturity,
COD reconciliation), expenses (recurring), Meta Ads, analytics, team & permissions, notifications, audit log (incl.
deletions), owner account page (password change), branded UI (dark sidebar, pill tabs, login hero).

---

## 4. Où en est-on (open items)

1. **Maystro**: owner must (a) make sure the provider type is *Maystro Delivery* (0025 converts a REST one named
   Maystro), (b) press *Tester*, (c) link products in *Lier les produits*. Live create/cancel was verified (test order
   37328030000013, cancelled with `PATCH /shared/status/{id}/ {"status":50,"abort_reason":21}`).
2. **Navex auto-ship**: first real submission after commit `7f6d486` must be checked in the Navex panel (expected to leave
   "Colis prêt"; exact label of the next state not confirmed).
3. **AI extraction**: confirm on the first new sheet row (cron logs: `[cron] sheets <id>: {"ai_rows":…}`).
4. **Security hygiene**: delete `OWNER_TEMP_PASSWORD` after password change; several carrier/API keys were pasted in
   chat by the owner → they must be **regenerated** (Maystro token, `ak_…`, two long secrets of unknown origin).
5. **Plan/backups**: Vercel Hobby is non-commercial per Vercel terms (Pro recommended); Supabase free plan has no
   restorable daily backups → owner offered a nightly backup export to Google Drive (not built yet).
6. **Google OAuth** app in "Testing": refresh tokens expire after ~7 days → publish the consent screen or use the public
   link mode.

## 5. Next steps (CODPilot gap list, owner must prioritise)

Recommended first: **(1) product variants** (size/colour instead of one product per size) and **(2) upsell lines, max
discount per product, customer delivery fee computed by wilaya/type**. Then: labels / bon de sortie printing + barcode
scan page; follow team with intervention tags; agent fees/payouts; exchanges; deeper analytics (per agent / wilaya /
product / carrier); extra statuses (fake order, confirmed without stock) + status editor; store channels (Shopify,
YouCan, LightFunnels); SMS/WhatsApp automation (paid provider); CRM & loyalty; trash/restore; dark-mode toggle;
nightly Google Drive backup.

## 6. Working rules that were followed (keep them)

* Never invent carrier endpoints: implement from official docs, then verify live with the owner's token (entered through
  a secure form, never in chat) and clean up test data.
* Never ask for secrets in chat; never print or commit secrets.
* Every DB change = a new migration + SQL test; every feature = unit tests; run `typecheck`, `lint`, `test`, `test:db`
  before pushing; watch the Vercel build (`READY`) after each push.
* Real orders/parcels in the owner's carrier accounts are created only with explicit approval.
