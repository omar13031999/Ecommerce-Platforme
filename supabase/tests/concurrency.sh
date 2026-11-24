#!/usr/bin/env bash
# 20 parallel sessions × 15 orders each arrive simultaneously; 4 agents.
# Expected: every order assigned exactly once, workloads balanced (max-min <= 1).
set -euo pipefail
read -r -a PSQL <<< "$PSQL_CMD"
"${PSQL[@]}" -o /dev/null <<'SQL'
delete from public.orders;
select tests.create_user('c1@t', 'agent', true, 1000), tests.create_user('c2@t', 'agent', true, 1000),
       tests.create_user('c3@t', 'agent', true, 1000), tests.create_user('c4@t', 'agent', true, 1000);
SQL
pids=()
for i in $(seq 1 20); do
  "${PSQL[@]}" -o /dev/null -c "do \$\$ begin for j in 1..15 loop perform tests.new_order('C$i-' || j); end loop; end \$\$;" &
  pids+=($!)
done
for p in "${pids[@]}"; do wait "$p"; done
"${PSQL[@]}" -o /dev/null <<'SQL'
do $$
declare v_total int; v_unassigned int; v_open int; v_max int; v_min int;
begin
  select count(*), count(*) filter (where assigned_to is null) into v_total, v_unassigned from public.orders;
  select count(*) into v_open from public.order_assignments where ended_at is null;
  select max(c), min(c) into v_max, v_min from (
    select count(o.id) c from public.profiles p left join public.orders o on o.assigned_to = p.id
    where p.email like 'c_@t' group by p.id) s;
  perform tests.assert(v_total = 300, 'all 300 orders created');
  perform tests.assert(v_unassigned = 0, 'no unassigned order');
  perform tests.assert(v_open = 300, 'exactly one open assignment per order');
  perform tests.assert(v_max - v_min <= 1, format('balanced workloads (max %s, min %s)', v_max, v_min));
end $$;
SQL
echo "   concurrency ok (300 simultaneous orders, balanced)"
