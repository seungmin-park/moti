-- The owner organizes saved products: fixes a name, writes a memo, files a product into collections, records a
-- purchase and renames a collection. Collection writes `title` and the owner writes `owner_title`; product_json shows
-- the owner's when there is one, so a later collection never erases the owner's fix. `revision` counts committed owner
-- changes, so collection progress never makes an owner's change look late.

create function moti.is_clean_title(p_title text) returns boolean
language sql immutable set search_path = '' as $$
  select p_title is not null and char_length(p_title) between 1 and 120 and p_title = btrim(p_title)
    and p_title !~ '[[:cntrl:]]' and p_title is nfc normalized
$$;

revoke all on function moti.is_clean_title(text) from public;
grant execute on function moti.is_clean_title(text) to moti_rpc;

alter table moti.products
  add column owner_title text check (owner_title is null or moti.is_clean_title(owner_title));

comment on column moti.products.title is 'Collected name. Only collection writes it; product_json shows coalesce(owner_title, title).';
comment on column moti.products.owner_title is 'The owner''s name for the product. Only moti_edit_product writes it.';
comment on column moti.products.revision is 'Committed owner changes. A change that alters stored values bumps it; collection never does.';

create or replace function moti.product_json(p moti.products) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', p.id, 'source_url', p.source_url, 'identity_url', p.identity_url, 'option', p.option,
    'shop', p.shop, 'title', coalesce(p.owner_title, p.title), 'note', p.note, 'revision', p.revision,
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
    'metadata_stalled', p.metadata_phase in ('queued', 'running') and exists (
      select 1 from moti.metadata_jobs j
      where j.product_id = p.id and j.generation = p.metadata_generation and moti.is_stalled(j)
    ),
    'metadata_image', p.metadata_image, 'metadata_image_error_code', p.metadata_image_error_code,
    'last_success_amount_minor', p.last_success_amount_minor,
    'last_success_currency', p.last_success_currency, 'last_success_at', p.last_success_at,
    -- The job that made the current copy: a version for caches, never the object name.
    'picture_version', p.picture_job_id
  )
$$;

-- Each change locks only its product row (or collection row) and never a metadata job, so it cannot deadlock with
-- settling_product's job-then-product order. The columns it writes are disjoint from collection's.
create function moti.product_for_change(p_owner uuid, p_product_id uuid) returns moti.products
language plpgsql set search_path = '' as $$
declare
  v_product moti.products;
begin
  select * into v_product from moti.products p where p.id = p_product_id and p.owner_id = p_owner for update;
  if v_product.id is null then
    raise exception using errcode = 'M0006', message = 'product missing';
  end if;
  return v_product;
end
$$;

-- Called after the equal-value check: sending what is already stored is never a conflict, whatever revision it saw.
create function moti.require_revision(p_stored integer, p_sent integer) returns void
language plpgsql set search_path = '' as $$
begin
  if p_stored is distinct from p_sent then
    raise exception using errcode = 'M0008', message = 'revision conflict';
  end if;
end
$$;

create function moti.edit_product(
  p_owner uuid, p_product_id uuid, p_revision integer, p_title text, p_note text, p_collection_ids uuid[]
) returns jsonb
language plpgsql set search_path = '' as $$
declare
  v_product moti.products;
  v_ids uuid[];
  v_current uuid[];
  v_owner_title text;
begin
  if p_revision is null or p_revision < 1
    or (p_title is not null and not moti.is_clean_title(p_title))
    or p_note is null or char_length(p_note) > 3000
    or p_collection_ids is null or cardinality(p_collection_ids) > 100
    or array_position(p_collection_ids, null) is not null
  then
    raise exception using errcode = 'M0002', message = 'invalid product edit';
  end if;

  v_product := moti.product_for_change(p_owner, p_product_id);
  select coalesce(array_agg(distinct id order by id), '{}') into v_ids from unnest(p_collection_ids) as id;
  if (select count(*) from moti.collections c where c.owner_id = p_owner and c.id = any(v_ids)) <> cardinality(v_ids) then
    raise exception using errcode = 'M0003', message = 'collection missing';
  end if;
  select coalesce(array_agg(m.collection_id order by m.collection_id), '{}') into v_current
  from moti.product_collections m where m.product_id = v_product.id;

  -- A name equal to the one shown fixes nothing, so a collected name keeps following collection.
  v_owner_title := case
    when p_title is null or p_title = coalesce(v_product.owner_title, v_product.title) then v_product.owner_title
    else p_title
  end;
  if v_owner_title is not distinct from v_product.owner_title and p_note = v_product.note and v_ids = v_current then
    return moti.product_json(v_product);
  end if;
  perform moti.require_revision(v_product.revision, p_revision);

  update moti.products p
  set owner_title = v_owner_title, note = p_note, revision = p.revision + 1, updated_at = now()
  where p.id = v_product.id
  returning * into v_product;
  delete from moti.product_collections m where m.product_id = v_product.id and m.collection_id <> all(v_ids);
  insert into moti.product_collections (owner_id, product_id, collection_id)
  select p_owner, v_product.id, id from unnest(v_ids) as id
  on conflict do nothing;
  return moti.product_json(v_product);
end
$$;

create function moti.purchase_product(p_owner uuid, p_product_id uuid, p_revision integer) returns jsonb
language plpgsql set search_path = '' as $$
declare
  v_product moti.products;
begin
  if p_revision is null or p_revision < 1 then
    raise exception using errcode = 'M0002', message = 'invalid revision';
  end if;
  v_product := moti.product_for_change(p_owner, p_product_id);
  if v_product.purchase_status = 'purchased' then
    return moti.product_json(v_product);
  end if;
  perform moti.require_revision(v_product.revision, p_revision);
  update moti.products p
  set purchase_status = 'purchased', purchased_on = null, purchased_amount_minor = null, purchased_currency = null,
      revision = p.revision + 1, updated_at = now()
  where p.id = v_product.id
  returning * into v_product;
  return moti.product_json(v_product);
end
$$;

create function moti.record_purchase(
  p_owner uuid, p_product_id uuid, p_revision integer, p_date date, p_amount_minor bigint, p_currency text
) returns jsonb
language plpgsql set search_path = '' as $$
declare
  v_product moti.products;
begin
  if p_revision is null or p_revision < 1
    or (p_date is not null and p_date not between date '1900-01-01' and (now() at time zone 'Asia/Seoul')::date)
    or (p_amount_minor is null) <> (p_currency is null)
    or (p_amount_minor is not null and (p_amount_minor not between 0 and 9007199254740991 or p_currency <> 'KRW'))
  then
    raise exception using errcode = 'M0002', message = 'invalid purchase record';
  end if;
  v_product := moti.product_for_change(p_owner, p_product_id);
  if v_product.purchase_status = 'purchased' and v_product.purchased_on is not distinct from p_date
    and v_product.purchased_amount_minor is not distinct from p_amount_minor
    and v_product.purchased_currency is not distinct from p_currency then
    return moti.product_json(v_product);
  end if;
  perform moti.require_revision(v_product.revision, p_revision);
  -- A client that saw this revision saw a wish, so the request is malformed rather than late.
  if v_product.purchase_status <> 'purchased' then
    raise exception using errcode = 'M0002', message = 'not purchased';
  end if;
  update moti.products p
  set purchased_on = p_date, purchased_amount_minor = p_amount_minor, purchased_currency = p_currency,
      revision = p.revision + 1, updated_at = now()
  where p.id = v_product.id
  returning * into v_product;
  return moti.product_json(v_product);
end
$$;

create function moti.return_to_wish(p_owner uuid, p_product_id uuid, p_revision integer) returns jsonb
language plpgsql set search_path = '' as $$
declare
  v_product moti.products;
begin
  if p_revision is null or p_revision < 1 then
    raise exception using errcode = 'M0002', message = 'invalid revision';
  end if;
  v_product := moti.product_for_change(p_owner, p_product_id);
  if v_product.purchase_status = 'wish' then
    return moti.product_json(v_product);
  end if;
  perform moti.require_revision(v_product.revision, p_revision);
  update moti.products p
  set purchase_status = 'wish', purchased_on = null, purchased_amount_minor = null, purchased_currency = null,
      revision = p.revision + 1, updated_at = now()
  where p.id = v_product.id
  returning * into v_product;
  return moti.product_json(v_product);
end
$$;

create function moti.rename_collection(p_owner uuid, p_collection_id uuid, p_revision integer, p_name text) returns jsonb
language plpgsql set search_path = '' as $$
declare
  v_collection moti.collections;
begin
  if p_revision is null or p_revision < 1
    or p_name is null or p_name <> btrim(p_name) or char_length(p_name) not between 1 and 40
    or not (p_name is nfc normalized)
  then
    raise exception using errcode = 'M0002', message = 'invalid collection name';
  end if;
  select * into v_collection from moti.collections c where c.id = p_collection_id and c.owner_id = p_owner for update;
  if v_collection.id is null then
    raise exception using errcode = 'M0003', message = 'collection missing';
  end if;
  if v_collection.name = p_name then
    return moti.collection_json(v_collection);
  end if;
  perform moti.require_revision(v_collection.revision, p_revision);
  update moti.collections c set name = p_name, revision = c.revision + 1, updated_at = now()
  where c.id = v_collection.id
  returning * into v_collection;
  return moti.collection_json(v_collection);
exception when unique_violation then
  raise exception using errcode = 'M0004', message = 'collection duplicate';
end
$$;

revoke all on function moti.product_for_change(uuid, uuid), moti.require_revision(integer, integer),
  moti.edit_product(uuid, uuid, integer, text, text, uuid[]), moti.purchase_product(uuid, uuid, integer),
  moti.record_purchase(uuid, uuid, integer, date, bigint, text), moti.return_to_wish(uuid, uuid, integer),
  moti.rename_collection(uuid, uuid, integer, text) from public;
grant execute on function moti.product_for_change(uuid, uuid), moti.require_revision(integer, integer),
  moti.edit_product(uuid, uuid, integer, text, text, uuid[]), moti.purchase_product(uuid, uuid, integer),
  moti.record_purchase(uuid, uuid, integer, date, bigint, text), moti.return_to_wish(uuid, uuid, integer),
  moti.rename_collection(uuid, uuid, integer, text) to moti_rpc;

create function public.moti_edit_product(
  p_product_id uuid, p_revision integer, p_title text, p_note text, p_collection_ids uuid[]
) returns jsonb
language sql security definer set search_path = '' as $$
  select moti.edit_product(moti.require_owner(), p_product_id, p_revision, p_title, p_note, p_collection_ids)
$$;

create function public.moti_purchase_product(p_product_id uuid, p_revision integer) returns jsonb
language sql security definer set search_path = '' as $$
  select moti.purchase_product(moti.require_owner(), p_product_id, p_revision)
$$;

create function public.moti_record_purchase(
  p_product_id uuid, p_revision integer, p_date date, p_amount_minor bigint, p_currency text
) returns jsonb
language sql security definer set search_path = '' as $$
  select moti.record_purchase(moti.require_owner(), p_product_id, p_revision, p_date, p_amount_minor, p_currency)
$$;

create function public.moti_return_to_wish(p_product_id uuid, p_revision integer) returns jsonb
language sql security definer set search_path = '' as $$
  select moti.return_to_wish(moti.require_owner(), p_product_id, p_revision)
$$;

create function public.moti_rename_collection(p_collection_id uuid, p_revision integer, p_name text) returns jsonb
language sql security definer set search_path = '' as $$
  select moti.rename_collection(moti.require_owner(), p_collection_id, p_revision, p_name)
$$;

grant usage, create on schema public to moti_rpc;
alter function public.moti_edit_product(uuid, integer, text, text, uuid[]) owner to moti_rpc;
alter function public.moti_purchase_product(uuid, integer) owner to moti_rpc;
alter function public.moti_record_purchase(uuid, integer, date, bigint, text) owner to moti_rpc;
alter function public.moti_return_to_wish(uuid, integer) owner to moti_rpc;
alter function public.moti_rename_collection(uuid, integer, text) owner to moti_rpc;
revoke create on schema public from moti_rpc;

revoke all on function public.moti_edit_product(uuid, integer, text, text, uuid[]) from public, anon, authenticated, service_role;
revoke all on function public.moti_purchase_product(uuid, integer) from public, anon, authenticated, service_role;
revoke all on function public.moti_record_purchase(uuid, integer, date, bigint, text) from public, anon, authenticated, service_role;
revoke all on function public.moti_return_to_wish(uuid, integer) from public, anon, authenticated, service_role;
revoke all on function public.moti_rename_collection(uuid, integer, text) from public, anon, authenticated, service_role;
grant execute on function public.moti_edit_product(uuid, integer, text, text, uuid[]) to authenticated;
grant execute on function public.moti_purchase_product(uuid, integer) to authenticated;
grant execute on function public.moti_record_purchase(uuid, integer, date, bigint, text) to authenticated;
grant execute on function public.moti_return_to_wish(uuid, integer) to authenticated;
grant execute on function public.moti_rename_collection(uuid, integer, text) to authenticated;
