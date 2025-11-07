-- Optional indexes to improve history queries. Safe to run multiple times.
create index if not exists idx_transfers_created_at on public.transfers(created_at desc);
create index if not exists idx_transfers_status_created_at on public.transfers(status, created_at desc);
create index if not exists idx_transfers_dest_created on public.transfers(dest_id, created_at desc);

