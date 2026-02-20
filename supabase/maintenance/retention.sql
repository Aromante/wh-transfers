-- Retention policy (manual/cron): purge old transfers safely
-- Adjust windows as needed

-- Purge logs older than 180 days for cancelled/validated transfers
delete from public.transfer_logs tl
using public.transfers t
where tl.transfer_id = t.id
  and t.status in ('cancelled','validated')
  and t.created_at < now() - interval '180 days';

-- Purge cancelled transfers older than 180 days
delete from public.transfers t
where t.status = 'cancelled'
  and t.created_at < now() - interval '180 days';

-- Purge validated transfers older than 365 days
delete from public.transfers t
where t.status = 'validated'
  and t.created_at < now() - interval '365 days';

-- Note: transfer_lines have ON DELETE CASCADE from transfers
-- Schedule with pg_cron or run manually.

