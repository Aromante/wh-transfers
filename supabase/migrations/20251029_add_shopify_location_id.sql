alter table if exists public.transfer_locations
  add column if not exists shopify_location_id text;

