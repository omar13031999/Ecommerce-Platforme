\o /dev/null
\echo '--- AI re-extraction rewrites untouched scattered sheet orders only'
begin;
select tests.login(null);
create temp table src as select gen_random_uuid() as id;
insert into public.sheet_sources (id, name, spreadsheet_id, worksheet_title) select id, 'S', 'x', 'F' from src;

select public.upsert_external_order('google_sheets', (select id from src),
  '{"external_id": "AI-1", "customer_name": "", "phone": "", "items": [], "needs_review": true,
    "review_reason": "Import incomplet — à compléter : lecture IA impossible — ligne d''origine : A: Karim 0555123456 Alger"}'::jsonb);

create temp table r as select public.ai_reimport_order((select id from src),
  '{"external_id": "AI-1", "customer_name": "Karim", "phone": "0555123456", "wilaya": "16", "commune": "Kouba",
    "address": "Rue 1", "delivery_type": "stopdesk", "total_amount": 5200,
    "items": [{"product_name": "Montre", "quantity": 2, "unit_price": 2300}], "needs_review": false}'::jsonb) as v;
select tests.assert((select v ->> 'action' from r) = 'reextracted', 'scattered order re-extracted');
select tests.assert((select customer_name = 'Karim' and phone = '0555123456' and wilaya_code = 16 and commune = 'Kouba'
                       and delivery_type = 'stopdesk' and total_amount = 5200 and not needs_review and review_reason is null
                       from public.orders where external_id = 'AI-1'), 'fields placed in the right columns');
select tests.assert((select count(*) = 1 and bool_and(product_name = 'Montre' and quantity = 2)
                       from public.order_items i join public.orders o on o.id = i.order_id where o.external_id = 'AI-1'),
                    'placeholder product replaced');

-- Once reviewed (needs_review cleared) or worked on, it is never rewritten
select tests.assert((select public.ai_reimport_order((select id from src),
  '{"external_id": "AI-1", "customer_name": "Autre"}'::jsonb) ->> 'action') = 'unchanged', 'reviewed order is left alone');
select tests.assert((select customer_name = 'Karim' from public.orders where external_id = 'AI-1'), 'name kept');

-- Not callable by app users
do $$ begin
  set local role authenticated;
  perform public.ai_reimport_order(gen_random_uuid(), '{}'::jsonb);
  raise exception 'ASSERTION FAILED: authenticated can call ai_reimport_order';
exception when insufficient_privilege then null;
end $$;
reset role;
rollback;
\o
\echo ok
