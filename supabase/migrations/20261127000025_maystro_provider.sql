-- "API REST configurable" providers named Maystro with no REST configuration
-- cannot submit anything: switch them to the dedicated Maystro adapter
-- (the saved API key is the Maystro store token for both; store_id is kept).
update public.delivery_providers
   set code = 'maystro',
       base_url = case when base_url ilike '%maystro%' then base_url else null end,
       tracking_url_template = case when tracking_url_template like '%{tracking}%' and tracking_url_template not like '%…%' then tracking_url_template else null end,
       polling_enabled = true
 where code = 'rest'
   and (name ilike '%maystro%' or base_url ilike '%maystro%')
   and not (coalesce(config, '{}'::jsonb) ? 'create');
