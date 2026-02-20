-- Transfers core tables
create table if not exists public.transfers (
  id uuid primary key default gen_random_uuid(),
  client_transfer_id uuid unique not null,
  origin_id text not null,
  dest_id text not null,
  status text not null default 'pending',
  odoo_picking_id text,
  picking_name text,
  created_by text,
  created_at timestamptz not null default now()
);

create table if not exists public.transfer_lines (
  id uuid primary key default gen_random_uuid(),
  transfer_id uuid not null references public.transfers(id) on delete cascade,
  product_id text,
  barcode text,
  sku text,
  qty numeric not null check (qty > 0)
);

create table if not exists public.transfer_logs (
  id uuid primary key default gen_random_uuid(),
  transfer_id uuid not null references public.transfers(id) on delete cascade,
  ts timestamptz not null default now(),
  event text not null,
  detail jsonb
);

create index if not exists idx_transfers_client_id on public.transfers(client_transfer_id);
create index if not exists idx_transfer_lines_transfer on public.transfer_lines(transfer_id);

