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
