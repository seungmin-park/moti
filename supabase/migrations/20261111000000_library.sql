create schema if not exists moti;
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'moti_rpc') then
    create role moti_rpc nologin noinherit nosuperuser nobypassrls;
  end if;
end
$$;

grant moti_rpc to postgres;
revoke all on schema moti from public, anon, authenticated, service_role;
grant usage on schema moti, auth, extensions to moti_rpc;

create table moti.owner_config (
  singleton boolean primary key default true check (singleton),
  owner_id uuid not null references auth.users(id) on delete cascade,
  google_subject text not null check (char_length(google_subject) between 1 and 255)
);

create table moti.collections (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 40),
  name_key text generated always as (lower(name)) stored,
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, id),
  unique (owner_id, name_key)
);

create table moti.products (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  source_url text not null check (char_length(source_url) between 1 and 4096),
  identity_url text not null check (char_length(identity_url) between 1 and 49152),
  option text not null default '' check (char_length(option) <= 120),
  identity_hash bytea generated always as (
    extensions.digest(char_length(identity_url)::text || ':' || identity_url || option, 'sha256')
  ) stored,
  title text not null default '새로 담은 상품' check (char_length(title) between 1 and 120),
  shop text not null,
  note text not null default '' check (char_length(note) <= 3000),
  revision integer not null default 1 check (revision > 0),
  metadata_generation integer not null default 1 check (metadata_generation > 0),
  metadata_phase text not null default 'queued' check (metadata_phase in ('queued', 'running', 'ready', 'failed')),
  metadata_attempts integer not null default 0 check (metadata_attempts >= 0),
  metadata_error_code text,
  metadata_completed_at timestamptz,
  last_success_amount_minor bigint check (last_success_amount_minor between 0 and 9007199254740991),
  last_success_currency text check (last_success_currency ~ '^[A-Z]{3}$'),
  last_success_at timestamptz,
  purchase_status text not null default 'wish' check (purchase_status in ('wish', 'purchased')),
  purchased_on date,
  purchased_amount_minor bigint check (purchased_amount_minor between 0 and 9007199254740991),
  purchased_currency text check (purchased_currency ~ '^[A-Z]{3}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, id),
  unique (owner_id, identity_hash),
  check (
    (metadata_phase in ('queued', 'running') and metadata_error_code is null and metadata_completed_at is null)
    or (metadata_phase = 'ready' and metadata_error_code is null and metadata_completed_at is not null)
    or (metadata_phase = 'failed' and char_length(metadata_error_code) > 0 and metadata_completed_at is null)
  ),
  check (
    (last_success_amount_minor is null and last_success_currency is null and last_success_at is null)
    or (last_success_amount_minor is not null and last_success_currency is not null and last_success_at is not null)
  ),
  check (
    (purchase_status = 'wish' and purchased_on is null and purchased_amount_minor is null and purchased_currency is null)
    or (purchase_status = 'purchased' and (purchased_amount_minor is null) = (purchased_currency is null))
  )
);

create table moti.product_collections (
  owner_id uuid not null references auth.users(id) on delete cascade,
  product_id uuid not null,
  collection_id uuid not null,
  primary key (product_id, collection_id),
  foreign key (owner_id, product_id) references moti.products(owner_id, id) on delete cascade,
  foreign key (owner_id, collection_id) references moti.collections(owner_id, id) on delete cascade
);

create table moti.metadata_jobs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  product_id uuid not null,
  generation integer not null check (generation > 0),
  status text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'failed')),
  created_at timestamptz not null default now(),
  unique (product_id, generation),
  foreign key (owner_id, product_id) references moti.products(owner_id, id) on delete cascade
);

alter table moti.owner_config enable row level security;
alter table moti.owner_config force row level security;
alter table moti.collections enable row level security;
alter table moti.collections force row level security;
alter table moti.products enable row level security;
alter table moti.products force row level security;
alter table moti.product_collections enable row level security;
alter table moti.product_collections force row level security;
alter table moti.metadata_jobs enable row level security;
alter table moti.metadata_jobs force row level security;

revoke all on all tables in schema moti from public, anon, authenticated, service_role;
grant select on moti.owner_config, auth.identities to moti_rpc;
grant select, insert, update, delete on moti.collections, moti.products, moti.product_collections, moti.metadata_jobs to moti_rpc;

create function public.moti_snapshot() returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  raise exception using errcode = '0A000', message = 'moti_snapshot is not implemented';
end
$$;

create function public.moti_save_link(
  p_source_url text,
  p_identity_url text,
  p_option text,
  p_shop text,
  p_collection_ids uuid[]
) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  raise exception using errcode = '0A000', message = 'moti_save_link is not implemented';
end
$$;

create function public.moti_create_collection(p_name text) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  raise exception using errcode = '0A000', message = 'moti_create_collection is not implemented';
end
$$;

grant usage, create on schema public to moti_rpc;
alter function public.moti_snapshot() owner to moti_rpc;
alter function public.moti_save_link(text, text, text, text, uuid[]) owner to moti_rpc;
alter function public.moti_create_collection(text) owner to moti_rpc;
revoke create on schema public from moti_rpc;

revoke all on function public.moti_snapshot() from public, anon, authenticated, service_role;
revoke all on function public.moti_save_link(text, text, text, text, uuid[]) from public, anon, authenticated, service_role;
revoke all on function public.moti_create_collection(text) from public, anon, authenticated, service_role;
grant execute on function public.moti_snapshot() to authenticated;
grant execute on function public.moti_save_link(text, text, text, text, uuid[]) to authenticated;
grant execute on function public.moti_create_collection(text) to authenticated;
