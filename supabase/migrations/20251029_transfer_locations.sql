-- Catálogo de ubicaciones para transfers
create table if not exists public.transfer_locations (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  is_default_origin boolean not null default false
);

insert into public.transfer_locations (code, name, is_default_origin)
  values
    ('WH/Existencias', 'Bodega de producción', true),
    ('KRONI/Existencias', 'CEDIS (KRONI)', false),
    ('P-CEI/Existencias', 'Tienda CEIBA', false),
    ('P-CON/Existencias', 'Tienda Conquista', false)
on conflict (code) do update set name = excluded.name, is_default_origin = excluded.is_default_origin;

