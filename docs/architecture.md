# Architecture

## Layers

1. **PostgreSQL (Supabase)** — schema, business invariants, authorization (RLS + permission-checked RPCs),
   history triggers, the assignment engine, the delivery state machine and financial reporting.
2. **Server (Next.js server components, server actions, route handlers)** — input validation (Zod),
   permission checks, orchestration of external APIs (Google, Meta, delivery providers), scheduled jobs.
3. **Client** — UI only. It never receives data the user's database role cannot read.

## Roles and permissions

| Role | Defaults |
| --- | --- |
| `admin` (owner) | everything |
| `manager` (responsable confirmation) | `orders.*`, `team.view/manage` (agents only), `delivery.view/manage`, `reports.operational` |
| `agent` | assigned orders only |

Extra permissions are stored in `profiles.permissions`. Financial / owner permissions
(`finance.*`, `expenses.manage`, `ads.*`, `integrations.manage`, `settings.manage`) can only be granted by an admin —
enforced in `update_staff_member()`. The single authorization primitive is `public.has_permission(text)`, used by all
RLS policies and RPCs. `src/lib/auth/permissions.ts` mirrors it for navigation only.

## Confidential data separation

| Visible to staff (RLS: assigned order or `orders.view_all`) | Confidential (RLS: finance / ads / delivery permissions) |
| --- | --- |
| `orders` (customer, amounts charged, statuses) | `order_item_costs` (cost snapshot per line) |
| `order_items` (product, qty, selling price) | `product_costs`, `product_cost_history` |
| `order_events`, `order_notes` | `order_financials` (actual delivery cost, operational costs) |
| `products` (name, SKU, selling price) | `cod_settlements`, `delivery_rates`, `delivery_shipments` (raw API responses) |
| | `expenses`, `expense_categories`, `recurring_expenses` (incl. salaries) |
| | `ad_accounts`, `ad_insights_daily`, allocations; `order_profit` view |

## Capacity-based assignment (migration 0004)

* Eligible agents: role `agent`, active, `accepts_assignments`, workload `< max_active_orders`.
* Workload = orders assigned to the agent whose confirmation status is in the configurable *workload statuses*
  (default: Nouveau, Pas de réponse 1–9, Injoignable) and not yet sent to delivery.
* Choice: never-handled-this-order first → lowest workload → longest since last assignment.
* **Concurrency**: every read-workload-then-assign decision runs under one transaction-scoped advisory lock
  (`lock_assignment_engine`), then locks the order row (`FOR UPDATE`). Consistent lock order ⇒ no deadlocks,
  no stale workloads, no duplicate assignment. Verified with 300 simultaneous orders from 20 sessions.
* No capacity ⇒ order stays in the waiting queue (`awaiting_assignment`), managers are notified (throttled),
  and the queue is drained when capacity frees up (status change, capacity increase, new agent, cron).
* Deactivating an agent releases their active orders; lowering capacity rebalances the excess.
* Every assignment is an `order_assignments` row (start/end, reason, statuses) plus an `order_events` entry.

## Redistribution

`set_confirmation_status()` redistributes when the new "no answer" level ≥ threshold, the order has been
redistributed fewer than `max_redistributions` times and not already at this level (loop protection). The previous
agent's notes and status explanations are snapshotted in `order_redistributions.notes_snapshot`; the new agent sees
them; the previous agent loses access immediately (RLS). The final level (default *Pas de réponse 9*) flags the order
for review (or auto-cancels, configurable). A cron sweep retries redistributions that found no agent.

## Delivery

* `claim_shipment_submission` → provider call → `complete_shipment_submission` / `fail_shipment_submission`.
* Stable idempotency key per attempt (`ORD<reference>-<n>`) sent as the provider order reference.
* Timeout / network / 5xx ⇒ shipment `unknown`: the next attempt first **looks the order up at the provider by
  reference**; it is only re-created if the provider confirms it does not exist. Without a lookup endpoint, manual
  verification is required — never a blind second shipment.
* Tracking events (webhook or polling) go through `apply_delivery_event`: dedupe key, original payload and provider
  status kept, out-of-order events cannot regress the status.
* Delivered/distributed opens a COD settlement row; profit is *realized* only once collection/transfer is recorded.

## Financial model

Per order (`order_profit` view):

```
gross = product revenue (lines − discount)
      + delivery fee charged to the customer      (setting, default on)
      − product cost snapshot                       (unknown ⇒ profit not computed, never assumed 0)
      − actual delivery cost (else tariff estimate, flagged)
      − operational cost snapshot (confirmation, packaging, storage, other, direct)
returned order ⇒ loss = delivery cost + return fee + operational costs (+ product cost if not recovered)
```

Period: `net = realized/delivered gross + returned losses − advertising − other expenses (treatment "deduct")`.

Advertising = Meta spend from the API (converted to DZD with the account FX rate) + advertising expenses for other
platforms. Expense categories marked **informational** (e.g. Meta top-ups, stock purchases, delivery invoices)
are cash records already counted elsewhere and are never deducted again. `financial_summary()` returns explicit
double-counting warnings when per-order operational costs and same-kind deducted expenses coexist.

Product-level advertising allocation: attributed spend (campaign/ad ids on orders, or campaign→product mapping)
first, then the remaining spend allocated by the chosen estimate method (equal / distributed / revenue / manual).
Attributed and estimated amounts are always shown separately and never exceed actual spend.
