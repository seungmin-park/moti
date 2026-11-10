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
grant usage on schema moti, extensions to moti_rpc;

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
    or (metadata_phase = 'failed' and metadata_error_code is not null and char_length(metadata_error_code) > 0 and metadata_completed_at is null)
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
grant select on moti.owner_config to moti_rpc;
grant select, insert, update, delete on moti.collections, moti.products, moti.product_collections, moti.metadata_jobs to moti_rpc;

create function moti.current_user_id() returns uuid
language sql stable set search_path = '' as $$
  select nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', '')::uuid
$$;

-- moti_rpc cannot read the auth schema, so this narrow check runs as the migration owner.
create function moti.has_google_identity(p_user uuid, p_subject text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from auth.identities i
    where i.user_id = p_user and i.provider = 'google' and i.provider_id = p_subject
  )
$$;

revoke all on function moti.current_user_id(), moti.has_google_identity(uuid, text) from public;
grant execute on function moti.current_user_id(), moti.has_google_identity(uuid, text) to moti_rpc;

create policy owner_reads_own_config on moti.owner_config
  for select to moti_rpc using (owner_id = (select moti.current_user_id()));
create policy owner_manages_collections on moti.collections
  for all to moti_rpc using (owner_id = (select moti.current_user_id())) with check (owner_id = (select moti.current_user_id()));
create policy owner_manages_products on moti.products
  for all to moti_rpc using (owner_id = (select moti.current_user_id())) with check (owner_id = (select moti.current_user_id()));
create policy owner_manages_memberships on moti.product_collections
  for all to moti_rpc using (owner_id = (select moti.current_user_id())) with check (owner_id = (select moti.current_user_id()));
create policy owner_manages_jobs on moti.metadata_jobs
  for all to moti_rpc using (owner_id = (select moti.current_user_id())) with check (owner_id = (select moti.current_user_id()));

create function moti.require_owner() returns uuid
language plpgsql stable set search_path = '' as $$
declare
  v_user uuid := moti.current_user_id();
begin
  if v_user is null or not exists (
    select 1 from moti.owner_config c
    where c.owner_id = v_user and moti.has_google_identity(c.owner_id, c.google_subject)
  ) then
    raise exception using errcode = 'M0001', message = 'moti owner required';
  end if;
  return v_user;
end
$$;

create function moti.is_web_url(p_url text, p_max integer) returns boolean
language sql immutable set search_path = '' as $$
  select p_url is not null
    and char_length(p_url) between 1 and p_max
    and p_url !~ '[[:cntrl:]]'
    and p_url ~* '^https?://(\[[0-9a-f:.]+\]|[^/?#@:\[\]]+)(:[0-9]{1,5})?([/?#].*)?$'
$$;

create function moti.collection_json(p moti.collections) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', p.id, 'name', p.name, 'revision', p.revision,
    'created_at', p.created_at, 'updated_at', p.updated_at
  )
$$;

create function moti.product_json(p moti.products) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', p.id, 'source_url', p.source_url, 'identity_url', p.identity_url, 'option', p.option,
    'shop', p.shop, 'title', p.title, 'note', p.note, 'revision', p.revision,
    'collection_ids', coalesce((
      select jsonb_agg(m.collection_id order by m.collection_id)
      from moti.product_collections m where m.product_id = p.id
    ), '[]'::jsonb),
    'created_at', p.created_at, 'updated_at', p.updated_at,
    'purchase_status', p.purchase_status, 'purchased_on', p.purchased_on,
    'purchased_amount_minor', p.purchased_amount_minor, 'purchased_currency', p.purchased_currency,
    'metadata_phase', p.metadata_phase, 'metadata_generation', p.metadata_generation,
    'metadata_attempts', p.metadata_attempts, 'metadata_error_code', p.metadata_error_code,
    'metadata_completed_at', p.metadata_completed_at,
    'last_success_amount_minor', p.last_success_amount_minor,
    'last_success_currency', p.last_success_currency, 'last_success_at', p.last_success_at
  )
$$;

revoke all on function moti.require_owner(), moti.is_web_url(text, integer),
  moti.collection_json(moti.collections), moti.product_json(moti.products) from public;
grant execute on function moti.require_owner(), moti.is_web_url(text, integer),
  moti.collection_json(moti.collections), moti.product_json(moti.products) to moti_rpc;

create function public.moti_snapshot() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid := moti.require_owner();
begin
  return jsonb_build_object(
    'products', coalesce((
      select jsonb_agg(moti.product_json(p) order by p.created_at desc, p.id)
      from moti.products p where p.owner_id = v_owner
    ), '[]'::jsonb),
    'collections', coalesce((
      select jsonb_agg(moti.collection_json(c) order by c.created_at, c.id)
      from moti.collections c where c.owner_id = v_owner
    ), '[]'::jsonb)
  );
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
declare
  v_owner uuid := moti.require_owner();
  v_collections uuid[];
  v_product moti.products;
begin
  if not moti.is_web_url(p_source_url, 4096)
    or not moti.is_web_url(p_identity_url, 49152)
    or p_option is null or char_length(p_option) > 120 or p_option <> btrim(p_option)
    or not (p_option is nfc normalized)
    or p_shop is null or char_length(p_shop) not between 1 and 255
    or p_collection_ids is null or cardinality(p_collection_ids) > 100
    or array_position(p_collection_ids, null) is not null
  then
    raise exception using errcode = 'M0002', message = 'invalid link input';
  end if;

  select coalesce(array_agg(distinct id), '{}') into v_collections from unnest(p_collection_ids) as id;
  if (select count(*) from moti.collections c where c.owner_id = v_owner and c.id = any(v_collections))
     <> cardinality(v_collections) then
    raise exception using errcode = 'M0003', message = 'collection missing';
  end if;

  insert into moti.products (owner_id, source_url, identity_url, option, shop)
  values (v_owner, p_source_url, p_identity_url, p_option, p_shop)
  on conflict (owner_id, identity_hash) do nothing
  returning * into v_product;

  if v_product.id is null then
    select * into v_product from moti.products p
    where p.owner_id = v_owner
      and p.identity_hash = extensions.digest(char_length(p_identity_url)::text || ':' || p_identity_url || p_option, 'sha256');
    if v_product.identity_url is distinct from p_identity_url or v_product.option is distinct from p_option then
      raise exception using errcode = 'M0005', message = 'identity conflict';
    end if;
    return jsonb_build_object('kind', 'duplicate', 'product', moti.product_json(v_product));
  end if;

  insert into moti.product_collections (owner_id, product_id, collection_id)
  select v_owner, v_product.id, id from unnest(v_collections) as id;
  insert into moti.metadata_jobs (owner_id, product_id, generation)
  values (v_owner, v_product.id, v_product.metadata_generation);

  return jsonb_build_object('kind', 'added', 'product', moti.product_json(v_product));
end
$$;

create function public.moti_create_collection(p_name text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid := moti.require_owner();
  v_collection moti.collections;
begin
  if p_name is null or p_name <> btrim(p_name) or char_length(p_name) not between 1 and 40
    or not (p_name is nfc normalized) then
    raise exception using errcode = 'M0002', message = 'invalid collection name';
  end if;
  insert into moti.collections (owner_id, name) values (v_owner, p_name) returning * into v_collection;
  return moti.collection_json(v_collection);
exception when unique_violation then
  raise exception using errcode = 'M0004', message = 'collection duplicate';
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
