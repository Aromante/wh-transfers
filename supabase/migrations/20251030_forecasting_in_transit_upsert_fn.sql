-- Ensure uniqueness for (sku, location_id) to allow upsert
do $$ begin
  if not exists (
    select 1 from pg_indexes where schemaname = 'public' and indexname = 'uq_forecasting_inventory_today_sku_loc'
  ) then
    create unique index uq_forecasting_inventory_today_sku_loc
      on public.forecasting_inventory_today (sku, location_id);
  end if;
end $$;

-- Batch upsert function: sets in_transit_units exactly to provided qty
create or replace function public.forecast_set_in_transit_batch(items jsonb)
returns void
language plpgsql
as $$
declare
  rec jsonb;
  v_sku text;
  v_loc int;
  v_units numeric;
begin
  if items is null or jsonb_typeof(items) <> 'array' then
    raise exception 'items must be a json array';
  end if;

  foreach rec in array (select jsonb_array_elements(items)) loop
    v_sku := trim(both from (rec->>'sku'));
    v_loc := (rec->>'location_id')::int;
    v_units := coalesce((rec->>'in_transit_units')::numeric, 0);
    if v_sku is null or v_sku = '' or v_loc is null then
      continue;
    end if;
    insert into public.forecasting_inventory_today as t (sku, location_id, in_transit_units)
      values (v_sku, v_loc, v_units)
      on conflict (sku, location_id)
      do update set in_transit_units = excluded.in_transit_units;
  end loop;
end $$;

