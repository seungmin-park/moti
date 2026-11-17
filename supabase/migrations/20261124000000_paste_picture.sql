-- The owner's pasted picture ("사진 붙여넣기"): a picture the owner copied (from a shop's page or app) and pasted into
-- the product's detail. The server runs it through the same sniffing and re-encoding as a collected copy and uploads it
-- with the owner's token under a name this file reserves. It is shown instead of the collected copy, like owner_title
-- over title: collection, "다시 가져오기" and the scheduled worker keep writing picture_* and never touch pasted_*, so
-- clearing the pasted picture shows the latest collected copy again. Nothing here changes metadata_complete.
--
-- A pasted object's name has the collected copies' form, <owner>/<product>/<paste>-1.webp, so the orphan sweep and the
-- app's name schema read it unchanged. may_write, may_discard and picture_orphans learn the two new references below.

alter table moti.products
  add column pasted_picture_id uuid,
  add column pasted_picture_version text,
  add column pasted_at timestamptz,
  -- The one name a paste may upload to, while the reservation lasts.
  add column paste_reserved_id uuid,
  add column paste_reserved_until timestamptz,
  add constraint products_pasted_picture_complete check (
    (pasted_picture_id is null and pasted_picture_version is null and pasted_at is null)
    or (pasted_picture_id is not null and pasted_picture_version is not null and pasted_at is not null)
  ),
  add constraint products_paste_reservation_complete check ((paste_reserved_id is null) = (paste_reserved_until is null));

comment on column moti.products.pasted_picture_id is
  'The owner''s pasted picture, shown instead of the collected copy. Only moti_picture_paste and moti_picture_paste_clear write it.';
comment on column moti.products.paste_reserved_id is
  'The name moti_picture_paste_reserve handed out; Storage admits an upload to it until paste_reserved_until.';

-- The pasted picture's object, or null.
create function moti.pasted_picture(p moti.products) returns text
language sql immutable set search_path = '' as $$
  select case when p.pasted_picture_id is not null then moti.picture_object(p.owner_id, p.id, p.pasted_picture_id, 1) end
$$;

-- The reserved name while it may still be uploaded and applied, or null.
create function moti.paste_reservation(p moti.products) returns text
language sql stable set search_path = '' as $$
  select case when p.paste_reserved_until > now() then moti.picture_object(p.owner_id, p.id, p.paste_reserved_id, 1) end
$$;

-- The pasted picture leads; picture_version follows whichever copy is shown, so a paste or a clear changes the src.
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
    'price_checked_at', p.price_checked_at, 'price_check_code', p.price_check_code,
    'wish_amount_minor', p.wish_amount_minor, 'wish_currency', p.wish_currency,
    -- The paste or the job that made the shown copy: a version for caches, never the object name.
    'picture_version', coalesce(p.pasted_picture_id, p.picture_job_id),
    'picture_pasted', p.pasted_picture_id is not null
  )
$$;

-- The shown copy's name, only while its object is the version that was recorded.
create or replace function moti.picture_locate(p_owner uuid, p_product_id uuid) returns text
language plpgsql stable set search_path = '' as $$
declare
  v_product moti.products;
  v_name text;
  v_version text;
begin
  select * into v_product from moti.products p where p.id = p_product_id and p.owner_id = p_owner;
  if v_product.id is null then
    raise exception using errcode = 'M0006', message = 'product missing';
  end if;
  if v_product.pasted_picture_id is not null then
    v_name := moti.pasted_picture(v_product);
    v_version := v_product.pasted_picture_version;
  elsif v_product.picture_job_id is not null then
    v_name := moti.picture_object(v_product.owner_id, v_product.id, v_product.picture_job_id, v_product.picture_attempt);
    v_version := v_product.picture_object_version;
  else
    return null;
  end if;
  -- An object changed after it was recorded, or gone, is not the recorded copy: no new link is signed for it.
  if moti.stored_picture_version(v_name) is distinct from v_version then
    return null;
  end if;
  return v_name;
end
$$;

-- A new name for one paste. A reservation not applied in a minute lapses; its object, if uploaded, is then
-- unreferenced and the sweep removes it after its ten-minute margin. A newer reservation replaces an older one.
create function moti.picture_paste_reserve(p_owner uuid, p_product_id uuid) returns text
language plpgsql set search_path = '' as $$
declare
  v_product moti.products;
begin
  v_product := moti.product_for_change(p_owner, p_product_id);
  update moti.products p
  set paste_reserved_id = gen_random_uuid(), paste_reserved_until = now() + interval '60 seconds'
  where p.id = v_product.id
  returning * into v_product;
  return moti.paste_reservation(v_product);
end
$$;

-- Points the product at the uploaded paste. The reservation must still be the product's and unexpired, and the object
-- must exist; its version is recorded so an object changed later is never signed. The pasted copy this replaces is
-- returned for the caller to discard. The revision rises so every screen takes the new picture; no revision is
-- checked, because a picture never conflicts with a name or memo draft (the owner's last paste wins).
create function moti.picture_paste(p_owner uuid, p_product_id uuid, p_object text) returns jsonb
language plpgsql set search_path = '' as $$
declare
  v_product moti.products;
  v_version text;
  v_replaced text;
begin
  if p_object is null then
    raise exception using errcode = 'M0002', message = 'invalid paste';
  end if;
  v_product := moti.product_for_change(p_owner, p_product_id);
  if moti.paste_reservation(v_product) is distinct from p_object then
    return jsonb_build_object('kind', 'stale');
  end if;
  v_version := moti.stored_picture_version(p_object);
  if v_version is null then
    raise exception using errcode = 'M0002', message = 'picture not stored';
  end if;
  v_replaced := moti.pasted_picture(v_product);
  update moti.products p
  set pasted_picture_id = p.paste_reserved_id, pasted_picture_version = v_version, pasted_at = now(),
      paste_reserved_id = null, paste_reserved_until = null, revision = p.revision + 1, updated_at = now()
  where p.id = v_product.id
  returning * into v_product;
  return jsonb_build_object('kind', 'applied', 'product', moti.product_json(v_product), 'replaced_picture', v_replaced);
end
$$;

-- Back to the collected copy, if any. Clearing nothing returns the product unchanged.
create function moti.picture_paste_clear(p_owner uuid, p_product_id uuid) returns jsonb
language plpgsql set search_path = '' as $$
declare
  v_product moti.products;
  v_replaced text;
begin
  v_product := moti.product_for_change(p_owner, p_product_id);
  v_replaced := moti.pasted_picture(v_product);
  if v_replaced is not null then
    update moti.products p
    set pasted_picture_id = null, pasted_picture_version = null, pasted_at = null,
        revision = p.revision + 1, updated_at = now()
    where p.id = v_product.id
    returning * into v_product;
  end if;
  return jsonb_build_object('product', moti.product_json(v_product), 'replaced_picture', v_replaced);
end
$$;

revoke all on function moti.pasted_picture(moti.products), moti.paste_reservation(moti.products),
  moti.picture_paste_reserve(uuid, uuid), moti.picture_paste(uuid, uuid, text), moti.picture_paste_clear(uuid, uuid)
  from public;
grant execute on function moti.pasted_picture(moti.products), moti.paste_reservation(moti.products),
  moti.picture_paste_reserve(uuid, uuid), moti.picture_paste(uuid, uuid, text), moti.picture_paste_clear(uuid, uuid)
  to moti_rpc;

create function public.moti_picture_paste_reserve(p_product_id uuid) returns text
language sql security definer set search_path = '' as $$
  select moti.picture_paste_reserve(moti.require_owner(), p_product_id)
$$;

create function public.moti_picture_paste(p_product_id uuid, p_object text) returns jsonb
language sql security definer set search_path = '' as $$
  select moti.picture_paste(moti.require_owner(), p_product_id, p_object)
$$;

create function public.moti_picture_paste_clear(p_product_id uuid) returns jsonb
language sql security definer set search_path = '' as $$
  select moti.picture_paste_clear(moti.require_owner(), p_product_id)
$$;

grant usage, create on schema public to moti_rpc;
alter function public.moti_picture_paste_reserve(uuid) owner to moti_rpc;
alter function public.moti_picture_paste(uuid, text) owner to moti_rpc;
alter function public.moti_picture_paste_clear(uuid) owner to moti_rpc;
revoke create on schema public from moti_rpc;

revoke all on function public.moti_picture_paste_reserve(uuid), public.moti_picture_paste(uuid, text),
  public.moti_picture_paste_clear(uuid) from public, anon, authenticated, service_role;
grant execute on function public.moti_picture_paste_reserve(uuid), public.moti_picture_paste(uuid, text),
  public.moti_picture_paste_clear(uuid) to authenticated;

-- Write: a running job's reserved attempt, as before, or a product's live paste reservation.
create or replace function moti_storage.may_write(p_name text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from moti.metadata_jobs j
    where j.owner_id = moti.owner_or_null() and j.status = 'running' and j.lease_until > now()
      and moti.picture_object(j.owner_id, j.product_id, j.id, j.attempts) = p_name
  ) or exists (
    select 1 from moti.products p
    where p.owner_id = moti.owner_or_null() and moti.paste_reservation(p) = p_name
  )
$$;

-- Delete: as before, and never a product's pasted picture or a live paste reservation. picture_orphans repeats these
-- conditions; change them together.
create or replace function moti_storage.may_discard(p_name text) returns boolean
language sql stable security definer set search_path = '' as $$
  select moti_storage.may_read(p_name)
    and not exists (
      select 1 from moti.products p
      where (p.picture_job_id is not null
          and moti.picture_object(p.owner_id, p.id, p.picture_job_id, p.picture_attempt) = p_name)
        or moti.pasted_picture(p) = p_name
        or moti.paste_reservation(p) = p_name
    )
    and not exists (
      select 1 from moti.metadata_jobs j
      where j.status = 'running' and moti.picture_object(j.owner_id, j.product_id, j.id, j.attempts) = p_name
    )
$$;

-- As 20261119000000_picture_sweep.sql, with may_discard's two new references. A replaced or cleared paste and a lapsed
-- reservation's upload are unreferenced and come back here after the ten-minute margin.
create or replace function moti.picture_orphans(p_owner uuid, p_limit integer) returns jsonb
language plpgsql stable set search_path = '' as $$
begin
  if p_limit is null or p_limit not between 1 and 200 then
    raise exception using errcode = 'M0002', message = 'invalid orphan limit';
  end if;
  return coalesce((
    select jsonb_agg(o.name order by o.name)
    from (
      select s.name from moti.stored_pictures(p_owner, now() - interval '10 minutes') s(name)
      where s.name ~ '^([0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}/){2}[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}-[1-3]\.webp$'
        and not exists (
          select 1 from moti.products p
          where (p.picture_job_id is not null
              and moti.picture_object(p.owner_id, p.id, p.picture_job_id, p.picture_attempt) = s.name)
            or moti.pasted_picture(p) = s.name
            or moti.paste_reservation(p) = s.name
        )
        and not exists (
          select 1 from moti.metadata_jobs j
          where j.status = 'running' and moti.picture_object(j.owner_id, j.product_id, j.id, j.attempts) = s.name
        )
      order by s.name
      limit p_limit
    ) o
  ), '[]'::jsonb);
end
$$;
