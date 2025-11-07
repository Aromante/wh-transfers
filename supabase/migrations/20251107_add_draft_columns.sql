-- Drafts support: metadata + timestamps on transfers
-- Safe, backwards compatible: only adds columns and indexes

alter table if exists public.transfers
  add column if not exists draft_owner text,
  add column if not exists draft_title text,
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists draft_locked boolean not null default false;

-- Status is text; we will use additional values like 'draft' | 'ready' | 'validated' | 'cancelled'.
-- No enum changes necessary.

-- Update trigger for updated_at
create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_transfers_set_updated_at on public.transfers;
create trigger trg_transfers_set_updated_at
before update on public.transfers
for each row execute function public.set_updated_at();

-- Index to list drafts quickly per owner
create index if not exists idx_transfers_status_owner_updated_at
  on public.transfers(status, draft_owner, updated_at desc);

