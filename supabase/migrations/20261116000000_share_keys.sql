-- The owner's iPhone Shortcut adds a link with a key that can do nothing else. A link becomes a product and its first
-- collection job in one place, so the owner's save and the key's add cannot drift apart.

-- moti_save_link's link checks.
create function moti.is_link_input(p_source_url text, p_identity_url text, p_option text, p_shop text) returns boolean
language sql immutable set search_path = '' as $$
  select moti.is_web_url(p_source_url, 4096)
    and moti.is_web_url(p_identity_url, 49152)
    and p_option is not null and char_length(p_option) <= 120 and p_option = btrim(p_option)
    and p_option is nfc normalized
    and p_shop is not null and char_length(p_shop) between 1 and 255
$$;

-- Runs as its caller, so the caller's grants and row policies decide what it may touch. Collections stay with the
-- owner's save: a caller that may only add links has no privilege on them.
create function moti.add_link(p_owner uuid, p_source_url text, p_identity_url text, p_option text, p_shop text)
returns table (kind text, product_id uuid)
language plpgsql set search_path = '' as $$
declare
  v_id uuid;
  v_generation integer;
  v_identity_url text;
  v_option text;
begin
  if not moti.is_link_input(p_source_url, p_identity_url, p_option, p_shop) then
    raise exception using errcode = 'M0002', message = 'invalid link input';
  end if;

  insert into moti.products (owner_id, source_url, identity_url, option, shop)
  values (p_owner, p_source_url, p_identity_url, p_option, p_shop)
  on conflict (owner_id, identity_hash) do nothing
  returning id, metadata_generation into v_id, v_generation;

  if v_id is not null then
    insert into moti.metadata_jobs (owner_id, product_id, generation) values (p_owner, v_id, v_generation);
    kind := 'added';
    product_id := v_id;
    return next;
    return;
  end if;

  select p.id, p.identity_url, p.option into v_id, v_identity_url, v_option from moti.products p
  where p.owner_id = p_owner
    and p.identity_hash = extensions.digest(char_length(p_identity_url)::text || ':' || p_identity_url || p_option, 'sha256');
  if v_identity_url is distinct from p_identity_url or v_option is distinct from p_option then
    raise exception using errcode = 'M0005', message = 'identity conflict';
  end if;
  kind := 'duplicate';
  product_id := v_id;
  return next;
end
$$;

revoke all on function moti.is_link_input(text, text, text, text), moti.add_link(uuid, text, text, text, text) from public;
grant execute on function moti.is_link_input(text, text, text, text), moti.add_link(uuid, text, text, text, text) to moti_rpc;

create or replace function public.moti_save_link(
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
  v_kind text;
  v_product_id uuid;
  v_product moti.products;
begin
  if not moti.is_link_input(p_source_url, p_identity_url, p_option, p_shop)
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

  select a.kind, a.product_id into v_kind, v_product_id
  from moti.add_link(v_owner, p_source_url, p_identity_url, p_option, p_shop) a;
  if v_kind = 'added' then
    insert into moti.product_collections (owner_id, product_id, collection_id)
    select v_owner, v_product_id, id from unnest(v_collections) as id;
  end if;

  select * into v_product from moti.products p where p.id = v_product_id;
  return jsonb_build_object('kind', v_kind, 'product', moti.product_json(v_product));
end
$$;

-- The owner's share key. Only its SHA-256 is stored; the secret is shown once when it is made. One key is active per
-- owner, and revoked keys stay so the screen can say when a key stopped working.
create table moti.share_keys (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  token_hash bytea not null unique check (octet_length(token_hash) = 32),
  hint text not null check (hint ~ '^[A-Za-z0-9_-]{4}$'),
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz check (revoked_at is null or revoked_at >= created_at),
  -- Accepted adds in the window that started at window_started_at; see moti_share_add.
  window_started_at timestamptz,
  window_uses integer not null default 0 check (window_uses >= 0)
);
create unique index share_keys_one_active on moti.share_keys (owner_id) where revoked_at is null;

alter table moti.share_keys enable row level security;
alter table moti.share_keys force row level security;
revoke all on moti.share_keys from public, anon, authenticated, service_role;
-- The owner's functions never read the hash or the use window.
grant select (id, owner_id, hint, created_at, last_used_at, revoked_at), insert (owner_id, token_hash, hint),
  update (revoked_at) on moti.share_keys to moti_rpc;
create policy owner_manages_share_keys on moti.share_keys
  for all to moti_rpc using (owner_id = (select moti.current_user_id())) with check (owner_id = (select moti.current_user_id()));

create function moti.share_key_json(p_id uuid) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', k.id, 'hint', k.hint, 'created_at', k.created_at, 'last_used_at', k.last_used_at, 'revoked_at', k.revoked_at
  )
  from moti.share_keys k where k.id = p_id
$$;

-- The active key, or the latest revoked one, or null.
create function moti.share_key_read(p_owner uuid) returns jsonb
language sql stable set search_path = '' as $$
  select moti.share_key_json(k.id) from moti.share_keys k
  where k.owner_id = p_owner
  order by k.revoked_at is null desc, k.created_at desc, k.id
  limit 1
$$;

-- Replaces the active key only when it is the one the owner's screen showed (null when it showed none), so a stale tab
-- never kills a key that was just put into the Shortcut. The secret is 256 random bits after a fixed prefix.
create function moti.share_key_issue(p_owner uuid, p_replaces uuid) returns jsonb
language plpgsql set search_path = '' as $$
declare
  v_active uuid;
  v_secret text;
  v_id uuid;
begin
  select k.id into v_active from moti.share_keys k where k.owner_id = p_owner and k.revoked_at is null for update;
  if v_active is distinct from p_replaces then
    raise exception using errcode = 'M0008', message = 'revision conflict';
  end if;
  update moti.share_keys k set revoked_at = now() where k.id = v_active;
  v_secret := 'moti_sk_' || rtrim(translate(encode(extensions.gen_random_bytes(32), 'base64'), '+/', '-_'), '=');
  insert into moti.share_keys (owner_id, token_hash, hint)
  values (p_owner, extensions.digest(v_secret, 'sha256'), right(v_secret, 4))
  returning id into v_id;
  return jsonb_build_object('key', moti.share_key_json(v_id), 'secret', v_secret);
exception when unique_violation then
  -- Another issue committed first while this one saw no active key.
  raise exception using errcode = 'M0008', message = 'revision conflict';
end
$$;

-- Idempotent: a revoked key keeps the time it was first revoked.
create function moti.share_key_revoke(p_owner uuid, p_key_id uuid) returns jsonb
language plpgsql set search_path = '' as $$
declare
  v_id uuid;
begin
  update moti.share_keys k set revoked_at = coalesce(k.revoked_at, now())
  where k.id = p_key_id and k.owner_id = p_owner
  returning k.id into v_id;
  if v_id is null then
    raise exception using errcode = 'M0011', message = 'share key missing';
  end if;
  return moti.share_key_json(v_id);
end
$$;

revoke all on function moti.share_key_json(uuid), moti.share_key_read(uuid), moti.share_key_issue(uuid, uuid),
  moti.share_key_revoke(uuid, uuid) from public;
grant execute on function moti.share_key_json(uuid), moti.share_key_read(uuid), moti.share_key_issue(uuid, uuid),
  moti.share_key_revoke(uuid, uuid) to moti_rpc;

create function public.moti_share_key_read() returns jsonb
language sql stable security definer set search_path = '' as $$
  select moti.share_key_read(moti.require_owner())
$$;

create function public.moti_share_key_issue(p_replaces uuid) returns jsonb
language sql security definer set search_path = '' as $$
  select moti.share_key_issue(moti.require_owner(), p_replaces)
$$;

create function public.moti_share_key_revoke(p_key_id uuid) returns jsonb
language sql security definer set search_path = '' as $$
  select moti.share_key_revoke(moti.require_owner(), p_key_id)
$$;

grant usage, create on schema public to moti_rpc;
alter function public.moti_share_key_read() owner to moti_rpc;
alter function public.moti_share_key_issue(uuid) owner to moti_rpc;
alter function public.moti_share_key_revoke(uuid) owner to moti_rpc;
revoke create on schema public from moti_rpc;

revoke all on function public.moti_share_key_read() from public, anon, authenticated, service_role;
revoke all on function public.moti_share_key_issue(uuid) from public, anon, authenticated, service_role;
revoke all on function public.moti_share_key_revoke(uuid) from public, anon, authenticated, service_role;
grant execute on function public.moti_share_key_read() to authenticated;
grant execute on function public.moti_share_key_issue(uuid) to authenticated;
grant execute on function public.moti_share_key_revoke(uuid) to authenticated;
