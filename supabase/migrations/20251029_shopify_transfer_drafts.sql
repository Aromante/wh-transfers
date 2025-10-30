create table if not exists public.shopify_transfer_drafts (
  id uuid primary key default gen_random_uuid(),
  transfer_id uuid not null references public.transfers(id) on delete cascade,
  origin_code text not null,
  dest_code text not null,
  origin_shopify_location_id text,
  dest_shopify_location_id text,
  lines jsonb not null default '[]'::jsonb,
  status text not null default 'pending',
  shopify_transfer_id text,
  notes text,
  created_at timestamptz not null default now()
);

create index if not exists idx_shopify_drafts_transfer on public.shopify_transfer_drafts(transfer_id);

