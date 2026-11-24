-- =============================================================================
-- 0009 — Reporting: operational dashboards, profit per order, summaries
-- All dates are bucketed in Africa/Algiers time.
-- =============================================================================

create or replace function public.local_date(p timestamptz)
returns date language sql immutable as $$
  select (p at time zone 'Africa/Algiers')::date
$$;

-- ---------------------------------------------------------------------------
-- Operational dashboard (security invoker: RLS limits agents to their orders)
-- ---------------------------------------------------------------------------
create or replace function public.dashboard_operational(p_from date, p_to date, p_agent uuid default null)
returns jsonb
language sql stable security invoker set search_path = ''
as $$
  with o as (
    select * from public.orders
    where public.local_date(ordered_at) between p_from and p_to
      and (p_agent is null or assigned_to = p_agent)
  ),
  c as (
    select
      count(*) as total,
      count(*) filter (where confirmation_status = 'new') as new,
      count(*) filter (where confirmation_status = any (public.workload_statuses())) as awaiting_confirmation,
      count(*) filter (where public.na_level(confirmation_status) > 0) as no_answer,
      count(*) filter (where confirmation_status = 'unreachable') as unreachable,
      count(*) filter (where confirmation_status = 'confirmed') as confirmed,
      count(*) filter (where confirmation_status = 'cancelled') as cancelled,
      count(*) filter (where confirmation_status = 'duplicate') as duplicate,
      count(*) filter (where confirmation_status = 'confirmed' and delivery_status in ('not_submitted', 'submission_failed', 'pending_submission')) as awaiting_delivery,
      count(*) filter (where delivery_status in ('submitted', 'processing', 'ready_for_pickup', 'picked_up', 'in_transit', 'out_for_delivery')) as in_transit,
      count(*) filter (where delivery_status = 'distributed') as distributed,
      count(*) filter (where delivery_status = 'delivered') as delivered,
      count(*) filter (where delivery_status = 'returned') as returned,
      count(*) filter (where delivery_status = 'failed_delivery') as failed_delivery,
      count(*) filter (where needs_review) as needs_review,
      count(*) filter (where awaiting_assignment and assigned_to is null
                         and confirmation_status = any (public.workload_statuses())) as unassigned
    from o
  )
  select jsonb_build_object(
    'counts', to_jsonb(c),
    'confirmation_rate', case when c.total - c.duplicate > 0 then round(c.confirmed::numeric / (c.total - c.duplicate), 4) end,
    'delivery_success_rate', case when c.distributed + c.delivered + c.returned > 0
       then round((c.distributed + c.delivered)::numeric / (c.distributed + c.delivered + c.returned), 4) end,
    'return_rate', case when c.distributed + c.delivered + c.returned > 0
       then round(c.returned::numeric / (c.distributed + c.delivered + c.returned), 4) end
  )
  from c
$$;

-- Status breakdown per day (for charts)
create or replace function public.orders_timeseries(p_from date, p_to date)
returns table (day date, total bigint, confirmed bigint, cancelled bigint, delivered bigint, returned bigint)
language sql stable security invoker set search_path = ''
as $$
  select d::date,
         count(o.id),
         count(o.id) filter (where o.confirmation_status = 'confirmed'),
         count(o.id) filter (where o.confirmation_status = 'cancelled'),
         count(o.id) filter (where o.delivery_status in ('distributed', 'delivered')),
         count(o.id) filter (where o.delivery_status = 'returned')
  from generate_series(p_from, p_to, interval '1 day') d
  left join public.orders o on public.local_date(o.ordered_at) = d::date
  group by d
  order by d
$$;

-- Agent performance (team.view)
create or replace function public.agent_performance(p_from date, p_to date)
returns table (
  agent_id uuid, full_name text, is_active boolean, max_active_orders integer, accepts_assignments boolean,
  current_workload integer, assigned bigint, confirmed bigint, cancelled bigint, no_answer bigint,
  status_changes bigint, confirmation_rate numeric, avg_minutes_to_confirm numeric
)
language plpgsql stable security definer set search_path = ''
as $$
#variable_conflict use_column
begin
  if not public.has_permission('team.view') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query
  select p.id, p.full_name, p.is_active, p.max_active_orders, p.accepts_assignments,
         public.agent_workload(p.id),
         (select count(*) from public.order_assignments a
           where a.agent_id = p.id and public.local_date(a.started_at) between p_from and p_to),
         (select count(*) from public.order_events e
           where e.actor_id = p.id and e.event_type = 'status_change' and e.new_value = 'confirmed'
             and public.local_date(e.created_at) between p_from and p_to),
         (select count(*) from public.order_events e
           where e.actor_id = p.id and e.event_type = 'status_change' and e.new_value in ('cancelled', 'duplicate')
             and public.local_date(e.created_at) between p_from and p_to),
         (select count(*) from public.order_events e
           where e.actor_id = p.id and e.event_type = 'status_change' and e.new_value like 'no_answer_%'
             and public.local_date(e.created_at) between p_from and p_to),
         (select count(*) from public.order_events e
           where e.actor_id = p.id and e.event_type = 'status_change'
             and public.local_date(e.created_at) between p_from and p_to),
         (select case when count(*) > 0 then round(
                   count(*) filter (where e.new_value = 'confirmed')::numeric
                   / count(*) filter (where e.new_value in ('confirmed', 'cancelled')) , 4) end
            from public.order_events e
           where e.actor_id = p.id and e.event_type = 'status_change' and e.new_value in ('confirmed', 'cancelled')
             and public.local_date(e.created_at) between p_from and p_to),
         (select round(avg(extract(epoch from (e.created_at - a.started_at)) / 60)::numeric, 1)
            from public.order_events e
            join public.order_assignments a on a.order_id = e.order_id and a.agent_id = p.id
                 and e.created_at >= a.started_at and (a.ended_at is null or e.created_at <= a.ended_at)
           where e.actor_id = p.id and e.event_type = 'status_change' and e.new_value = 'confirmed'
             and public.local_date(e.created_at) between p_from and p_to)
  from public.profiles p
  where p.role = 'agent'
  order by p.is_active desc, p.full_name;
end
$$;

-- Product operational stats (no money besides selling revenue; reports.operational)
create or replace function public.product_operational_stats(p_from date, p_to date)
returns table (
  product_id uuid, product_name text, orders bigint, quantity bigint, confirmed bigint, cancelled bigint,
  distributed bigint, delivered bigint, returned bigint, revenue numeric
)
language plpgsql stable security definer set search_path = ''
as $$
#variable_conflict use_column
begin
  if not (public.has_permission('reports.operational') or public.has_permission('finance.view')) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query
  select i.product_id, coalesce(p.name, min(i.product_name)),
         count(distinct o.id), sum(i.quantity)::bigint,
         count(distinct o.id) filter (where o.confirmation_status = 'confirmed'),
         count(distinct o.id) filter (where o.confirmation_status = 'cancelled'),
         count(distinct o.id) filter (where o.delivery_status = 'distributed'),
         count(distinct o.id) filter (where o.delivery_status = 'delivered'),
         count(distinct o.id) filter (where o.delivery_status = 'returned'),
         coalesce(sum(i.line_total) filter (where o.delivery_status in ('distributed', 'delivered')), 0)
  from public.order_items i
  join public.orders o on o.id = i.order_id
  left join public.products p on p.id = i.product_id
  where public.local_date(o.ordered_at) between p_from and p_to
  group by i.product_id, p.name;
end
$$;

-- ---------------------------------------------------------------------------
-- Profit per order (CONFIDENTIAL; returns nothing without finance.view)
--
-- Buckets (profit maturity):
--   not_confirmed        – not counted
--   potential            – confirmed, not yet handed to a carrier
--   in_delivery          – with the carrier
--   delivered_unsettled  – distributed/delivered, cash not yet confirmed (EXPECTED)
--   realized             – distributed/delivered AND collection/transfer recorded
--   returned             – returned: loss (delivery + return fees + operational costs)
--   cancelled            – cancelled after confirmation/at carrier: excluded
-- ---------------------------------------------------------------------------
create view public.order_profit
with (security_invoker = true) as
with fin_settings as (
  select coalesce((select (value ->> 'include_customer_delivery_fee_in_revenue')::boolean
                     from public.app_settings where key = 'finance'), true) as include_fee,
         coalesce((select (value ->> 'product_recovered_on_return')::boolean
                     from public.app_settings where key = 'finance'), true) as recovered,
         (select nullif(value ->> 'default_provider_id', '')::uuid
            from public.app_settings where key = 'delivery') as default_provider
),
items as (
  select i.order_id,
         sum(i.line_total) as gross_items,
         sum(i.quantity * c.unit_cost) as product_cost,
         bool_and(i.product_id is not null and c.unit_cost is not null) as cost_complete
  from public.order_items i
  left join public.order_item_costs c on c.order_item_id = i.id
  group by i.order_id
),
base as (
  select o.id as order_id, o.reference, o.ordered_at, o.confirmed_at, o.submitted_at, o.delivered_at, o.returned_at,
         o.confirmation_status, o.delivery_status, o.delivery_provider_id, o.wilaya_code, o.assigned_to,
         o.meta_campaign_id, o.meta_ad_id, o.utm_campaign,
         coalesce(it.gross_items, 0) - o.discount as product_revenue,
         o.delivery_fee as delivery_fee_charged,
         o.total_amount,
         it.product_cost,
         coalesce(it.cost_complete, false) as cost_complete,
         f.actual_delivery_cost,
         coalesce(f.actual_delivery_cost, f.estimated_delivery_cost,
           (select case when o.delivery_type = 'stopdesk' then coalesce(r.stopdesk_cost, r.home_cost) else r.home_cost end
              from public.delivery_rates r, fin_settings fs
             where r.provider_id = coalesce(o.delivery_provider_id, fs.default_provider) and r.wilaya_code = o.wilaya_code)
         ) as delivery_cost,
         coalesce(f.return_fee, 0) as return_fee,
         coalesce(f.exchange_fee, 0) as exchange_fee,
         coalesce(f.confirmation_cost + f.packaging_cost + f.storage_cost + f.other_cost + f.extra_direct_cost, 0) as operational_cost,
         f.allocated_ad_cost,
         s.status as settlement_status, s.expected_amount, s.collected_amount, s.provider_fees, s.transferred_amount,
         case
           when o.confirmation_status <> 'confirmed' then 'not_confirmed'
           when o.delivery_status = 'returned' then 'returned'
           when o.delivery_status = 'cancelled' then 'cancelled'
           when o.delivery_status in ('not_submitted', 'pending_submission', 'submission_failed') then 'potential'
           when o.delivery_status in ('distributed', 'delivered') then
             case when s.status in ('collected', 'partially_transferred', 'transferred') then 'realized' else 'delivered_unsettled' end
           else 'in_delivery'
         end as bucket
  from public.orders o
  left join items it on it.order_id = o.id
  left join public.order_financials f on f.order_id = o.id
  left join public.cod_settlements s on s.order_id = o.id
  where public.has_permission('finance.view')
)
select b.*,
       b.actual_delivery_cost is null as delivery_cost_estimated,
       case
         when b.bucket in ('realized', 'delivered_unsettled') then public.local_date(coalesce(b.delivered_at, b.confirmed_at, b.ordered_at))
         when b.bucket = 'returned' then public.local_date(coalesce(b.returned_at, b.confirmed_at, b.ordered_at))
         else public.local_date(coalesce(b.confirmed_at, b.ordered_at))
       end as period_date,
       case
         when b.bucket in ('potential', 'in_delivery', 'delivered_unsettled', 'realized') then
           case when b.cost_complete and b.delivery_cost is not null then
             b.product_revenue
             + case when fs.include_fee then b.delivery_fee_charged else 0 end
             - b.product_cost - b.delivery_cost - b.operational_cost - b.exchange_fee
           end
         when b.bucket = 'returned' then
           - (coalesce(b.delivery_cost, 0) + b.return_fee + b.operational_cost
              + case when fs.recovered then 0 else coalesce(b.product_cost, 0) end)
       end as gross_profit,
       (b.bucket in ('potential', 'in_delivery', 'delivered_unsettled', 'realized')
        and not (b.cost_complete and b.delivery_cost is not null)) as profit_incomplete
from base b, fin_settings fs;

-- ---------------------------------------------------------------------------
-- Financial summary for a period (CONFIDENTIAL)
-- ---------------------------------------------------------------------------
create or replace function public.financial_summary(p_from date, p_to date)
returns jsonb
language plpgsql stable security invoker set search_path = ''
as $$
#variable_conflict use_column
declare
  v_buckets jsonb;
  v_totals jsonb;
  v_ads jsonb;
  v_exp jsonb;
  v_realized numeric;
  v_unsettled numeric;
  v_in_delivery numeric;
  v_potential numeric;
  v_returned numeric;
  v_ad_total numeric;
  v_overhead numeric;
  v_warnings jsonb := '[]'::jsonb;
  v_ops jsonb;
begin
  if not public.has_permission('finance.view') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select coalesce(jsonb_object_agg(bucket, x), '{}'::jsonb) into v_buckets
  from (
    select bucket, jsonb_build_object(
      'orders', count(*),
      'product_revenue', coalesce(sum(product_revenue), 0),
      'delivery_fees_charged', coalesce(sum(delivery_fee_charged), 0),
      'product_cost', coalesce(sum(product_cost) filter (where cost_complete), 0),
      'delivery_cost', coalesce(sum(delivery_cost), 0),
      'operational_cost', coalesce(sum(operational_cost), 0),
      'gross_profit', coalesce(sum(gross_profit), 0),
      'incomplete_orders', count(*) filter (where profit_incomplete),
      'estimated_delivery_cost_orders', count(*) filter (where delivery_cost_estimated and delivery_cost is not null)
    ) as x
    from public.order_profit
    where period_date between p_from and p_to and bucket not in ('not_confirmed', 'cancelled')
    group by bucket
  ) s;

  v_realized := coalesce((v_buckets -> 'realized' ->> 'gross_profit')::numeric, 0);
  v_unsettled := coalesce((v_buckets -> 'delivered_unsettled' ->> 'gross_profit')::numeric, 0);
  v_in_delivery := coalesce((v_buckets -> 'in_delivery' ->> 'gross_profit')::numeric, 0);
  v_potential := coalesce((v_buckets -> 'potential' ->> 'gross_profit')::numeric, 0);
  v_returned := coalesce((v_buckets -> 'returned' ->> 'gross_profit')::numeric, 0);

  -- Advertising: actual platform spend (API) + manual ad expenses marked "deduct"
  select jsonb_build_object(
    'meta_spend_dzd', coalesce(sum(spend_dzd), 0),
    'rows_missing_fx', count(*) filter (where spend_dzd is null and spend > 0),
    'spend_missing_fx_by_currency', coalesce(jsonb_object_agg(currency, missing) filter (where missing > 0), '{}'::jsonb)
  ) into v_ads
  from (
    select currency, spend_dzd, spend,
           sum(spend) filter (where spend_dzd is null) over (partition by currency) as missing
    from public.ad_spend_daily where date between p_from and p_to
  ) a;

  select jsonb_build_object(
    'advertising_expenses', coalesce(sum(e.amount) filter (where c.kind = 'advertising' and c.profit_treatment = 'deduct'), 0),
    'overhead', coalesce(sum(e.amount) filter (where c.kind <> 'advertising' and c.profit_treatment = 'deduct'), 0),
    'informational', coalesce(sum(e.amount) filter (where c.profit_treatment = 'informational'), 0),
    'by_kind', coalesce((select jsonb_object_agg(kind, amt) from (
        select c2.kind, sum(e2.amount) as amt from public.expenses e2
        join public.expense_categories c2 on c2.id = e2.category_id
        where e2.expense_date between p_from and p_to and c2.profit_treatment = 'deduct'
        group by c2.kind) k), '{}'::jsonb)
  ) into v_exp
  from public.expenses e
  join public.expense_categories c on c.id = e.category_id
  where e.expense_date between p_from and p_to;

  v_ad_total := (v_ads ->> 'meta_spend_dzd')::numeric + (v_exp ->> 'advertising_expenses')::numeric;
  v_overhead := (v_exp ->> 'overhead')::numeric;

  -- Double-counting guard: per-order operational costs AND the same kind of
  -- expense being deducted from profit at the same time.
  v_ops := coalesce((select value from public.app_settings where key = 'operational_costs'), '{}'::jsonb);
  if coalesce((v_ops ->> 'confirmation_cost')::numeric, 0) > 0 and coalesce((v_exp -> 'by_kind' ->> 'confirmation')::numeric, 0) > 0 then
    v_warnings := v_warnings || jsonb_build_array('double_count_confirmation');
  end if;
  if coalesce((v_ops ->> 'packaging_cost')::numeric, 0) > 0 and coalesce((v_exp -> 'by_kind' ->> 'packaging')::numeric, 0) > 0 then
    v_warnings := v_warnings || jsonb_build_array('double_count_packaging');
  end if;
  if coalesce((v_ops ->> 'storage_cost')::numeric, 0) > 0 and coalesce((v_exp -> 'by_kind' ->> 'storage')::numeric, 0) > 0 then
    v_warnings := v_warnings || jsonb_build_array('double_count_storage');
  end if;
  if coalesce((v_exp -> 'by_kind' ->> 'delivery')::numeric, 0) > 0 then
    v_warnings := v_warnings || jsonb_build_array('double_count_delivery');
  end if;
  if coalesce((v_exp -> 'by_kind' ->> 'product_purchase')::numeric, 0) > 0 then
    v_warnings := v_warnings || jsonb_build_array('double_count_product_purchase');
  end if;
  if (v_ads ->> 'rows_missing_fx')::integer > 0 then
    v_warnings := v_warnings || jsonb_build_array('ads_missing_fx');
  end if;
  if exists (select 1 from public.order_profit where period_date between p_from and p_to and profit_incomplete) then
    v_warnings := v_warnings || jsonb_build_array('incomplete_costs');
  end if;

  select jsonb_build_object(
    'product_revenue', coalesce(sum(product_revenue) filter (where bucket in ('realized', 'delivered_unsettled')), 0),
    'delivery_fees_charged', coalesce(sum(delivery_fee_charged) filter (where bucket in ('realized', 'delivered_unsettled')), 0),
    'product_cost', coalesce(sum(product_cost) filter (where bucket in ('realized', 'delivered_unsettled') and cost_complete), 0),
    'delivery_cost', coalesce(sum(delivery_cost) filter (where bucket in ('realized', 'delivered_unsettled', 'returned')), 0),
    'operational_cost', coalesce(sum(operational_cost) filter (where bucket in ('realized', 'delivered_unsettled', 'returned')), 0)
  ) into v_totals
  from public.order_profit
  where period_date between p_from and p_to;

  return jsonb_build_object(
    'period', jsonb_build_object('from', p_from, 'to', p_to),
    'buckets', v_buckets,
    'delivered_totals', v_totals,
    'ads', v_ads || jsonb_build_object('advertising_expenses', v_exp ->> 'advertising_expenses', 'total_dzd', v_ad_total),
    'expenses', v_exp,
    'profit', jsonb_build_object(
      'potential', v_potential,
      'expected', v_in_delivery + v_unsettled,
      'realized_gross', v_realized,
      'returned_losses', v_returned,
      'gross_delivered', v_realized + v_unsettled + v_returned,
      'net_realized', v_realized + v_returned - v_ad_total - v_overhead,
      'net_delivered_estimate', v_realized + v_unsettled + v_returned - v_ad_total - v_overhead,
      'net_pipeline_estimate', v_potential + v_in_delivery + v_unsettled + v_realized + v_returned - v_ad_total - v_overhead
    ),
    'warnings', v_warnings
  );
end
$$;

-- Daily series for charts (CONFIDENTIAL)
create or replace function public.profit_timeseries(p_from date, p_to date)
returns table (day date, product_revenue numeric, gross_profit numeric, returned_losses numeric,
               ad_spend numeric, expenses numeric, net_profit numeric)
language plpgsql stable security invoker set search_path = ''
as $$
#variable_conflict use_column
begin
  if not public.has_permission('finance.view') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query
  with days as (select d::date as day from generate_series(p_from, p_to, interval '1 day') d),
  op as (
    select period_date,
           sum(product_revenue) filter (where bucket in ('realized', 'delivered_unsettled')) as rev,
           sum(gross_profit) filter (where bucket in ('realized', 'delivered_unsettled')) as gp,
           sum(gross_profit) filter (where bucket = 'returned') as ret
    from public.order_profit where period_date between p_from and p_to group by period_date
  ),
  ads as (select date, sum(spend_dzd) as spend from public.ad_spend_daily where date between p_from and p_to group by date),
  ex as (
    select e.expense_date, sum(e.amount) as amt from public.expenses e
    join public.expense_categories c on c.id = e.category_id
    where e.expense_date between p_from and p_to and c.profit_treatment = 'deduct'
    group by e.expense_date
  )
  select days.day, coalesce(op.rev, 0), coalesce(op.gp, 0), coalesce(op.ret, 0),
         coalesce(ads.spend, 0), coalesce(ex.amt, 0),
         coalesce(op.gp, 0) + coalesce(op.ret, 0) - coalesce(ads.spend, 0) - coalesce(ex.amt, 0)
  from days
  left join op on op.period_date = days.day
  left join ads on ads.date = days.day
  left join ex on ex.expense_date = days.day
  order by days.day;
end
$$;

-- Product profitability (CONFIDENTIAL). Order-level costs (delivery, operational,
-- returns) are spread over the order's lines proportionally to line revenue.
create or replace function public.product_financial_stats(p_from date, p_to date)
returns table (
  product_id uuid, product_name text, has_purchase_cost boolean,
  orders bigint, quantity bigint, confirmed bigint, cancelled bigint, distributed bigint, delivered bigint, returned bigint,
  revenue numeric, product_cost numeric, delivery_cost numeric, operational_cost numeric, return_losses numeric,
  gross_profit numeric, incomplete_orders bigint
)
language plpgsql stable security invoker set search_path = ''
as $$
#variable_conflict use_column
begin
  if not public.has_permission('finance.view') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query
  with lines as (
    select i.product_id, i.product_name, i.quantity, i.line_total, c.unit_cost, op.*,
           case when sum(i.line_total) over (partition by i.order_id) > 0
                then i.line_total / sum(i.line_total) over (partition by i.order_id)
                else 1.0 / count(*) over (partition by i.order_id) end as share
    from public.order_items i
    left join public.order_item_costs c on c.order_item_id = i.id
    join public.order_profit op on op.order_id = i.order_id
    where public.local_date(op.ordered_at) between p_from and p_to
  )
  select l.product_id,
         coalesce(p.name, min(l.product_name)),
         bool_and(pc.purchase_cost is not null),
         count(distinct l.order_id),
         sum(l.quantity)::bigint,
         count(distinct l.order_id) filter (where l.confirmation_status = 'confirmed'),
         count(distinct l.order_id) filter (where l.confirmation_status = 'cancelled'),
         count(distinct l.order_id) filter (where l.delivery_status = 'distributed'),
         count(distinct l.order_id) filter (where l.delivery_status = 'delivered'),
         count(distinct l.order_id) filter (where l.delivery_status = 'returned'),
         coalesce(sum(l.line_total) filter (where l.bucket in ('realized', 'delivered_unsettled')), 0),
         coalesce(sum(l.quantity * l.unit_cost) filter (where l.bucket in ('realized', 'delivered_unsettled')), 0),
         coalesce(sum(l.delivery_cost * l.share) filter (where l.bucket in ('realized', 'delivered_unsettled', 'returned')), 0),
         coalesce(sum(l.operational_cost * l.share) filter (where l.bucket in ('realized', 'delivered_unsettled', 'returned')), 0),
         coalesce(-sum(l.gross_profit * l.share) filter (where l.bucket = 'returned'), 0),
         coalesce(sum(l.gross_profit * l.share) filter (where l.bucket in ('realized', 'delivered_unsettled', 'returned')), 0),
         count(distinct l.order_id) filter (where l.profit_incomplete)
  from lines l
  left join public.products p on p.id = l.product_id
  left join public.product_costs pc on pc.product_id = l.product_id
  group by l.product_id, p.name;
end
$$;

grant select on public.order_profit to authenticated;
