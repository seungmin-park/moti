-- The owner's wish price ("내가 살 가격"): what the owner expects to pay for a wish product, set by hand. A page's
-- structured data can name a per-unit or base price (a Smartstore switch page shows "10개 / 3,000원" but its data says
-- 300), and some shops block reading altogether. Collection and the daily check keep writing last_success_*; only
-- moti_set_wish_price writes wish_*, so the collected price stays as the reference and nothing automatic erases the
-- owner's. The checks are inline, so roles that insert products (moti_share) need no new privilege.
alter table moti.products
  add column wish_amount_minor bigint check (wish_amount_minor between 0 and 9007199254740991),
  add column wish_currency text check (wish_currency = 'KRW'),
  add constraint products_wish_price_pair check ((wish_amount_minor is null) = (wish_currency is null));

comment on column moti.products.wish_amount_minor is 'The owner''s wish price in minor units. Only moti_set_wish_price and a restore write it.';
comment on column moti.products.wish_currency is 'Currency of the owner''s wish price; KRW only, like a recorded purchase price.';

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
    -- The job that made the current copy: a version for caches, never the object name.
    'picture_version', p.picture_job_id
  )
$$;

-- The organize RPCs' order: input (M0002), missing (M0006), same value, stale revision (M0008), then state. A client
-- that saw this revision saw a purchased product, so a wish price for it is malformed rather than late. Purchase and
-- return to wish leave these columns alone: the price comes back with the wish.
create function moti.set_wish_price(
  p_owner uuid, p_product_id uuid, p_revision integer, p_amount_minor bigint, p_currency text
) returns jsonb
language plpgsql set search_path = '' as $$
declare
  v_product moti.products;
begin
  if p_revision is null or p_revision < 1
    or (p_amount_minor is null) <> (p_currency is null)
    or (p_amount_minor is not null and (p_amount_minor not between 0 and 9007199254740991 or p_currency <> 'KRW'))
  then
    raise exception using errcode = 'M0002', message = 'invalid wish price';
  end if;
  v_product := moti.product_for_change(p_owner, p_product_id);
  if v_product.wish_amount_minor is not distinct from p_amount_minor and v_product.wish_currency is not distinct from p_currency then
    return moti.product_json(v_product);
  end if;
  perform moti.require_revision(v_product.revision, p_revision);
  if v_product.purchase_status <> 'wish' then
    raise exception using errcode = 'M0002', message = 'not a wish';
  end if;
  update moti.products p
  set wish_amount_minor = p_amount_minor, wish_currency = p_currency, revision = p.revision + 1, updated_at = now()
  where p.id = v_product.id
  returning * into v_product;
  return moti.product_json(v_product);
end
$$;

-- The backup gains wish_amount_minor and wish_currency; everything else is as 20261115000000_library_backup.sql.
create or replace function moti.backup_json(p_owner uuid) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'collections', coalesce((
      select jsonb_agg(jsonb_build_object('name', c.name, 'created_at', c.created_at)
        order by date_trunc('milliseconds', c.created_at), c.name)
      from moti.collections c where c.owner_id = p_owner
    ), '[]'::jsonb),
    'products', coalesce((
      select jsonb_agg(jsonb_build_object(
        'source_url', p.source_url, 'identity_url', p.identity_url, 'option', p.option, 'shop', p.shop,
        'title', p.title, 'owner_title', p.owner_title, 'note', p.note,
        'collection_names', coalesce((
          select jsonb_agg(c.name order by date_trunc('milliseconds', c.created_at), c.name)
          from moti.product_collections m join moti.collections c on c.id = m.collection_id
          where m.product_id = p.id
        ), '[]'::jsonb),
        'created_at', p.created_at,
        'purchase_status', p.purchase_status, 'purchased_on', p.purchased_on,
        'purchased_amount_minor', p.purchased_amount_minor, 'purchased_currency', p.purchased_currency,
        'last_success_amount_minor', p.last_success_amount_minor,
        'last_success_currency', p.last_success_currency, 'last_success_at', p.last_success_at,
        'wish_amount_minor', p.wish_amount_minor, 'wish_currency', p.wish_currency
      ) order by date_trunc('milliseconds', p.created_at) desc, p.identity_url, p.option)
      from moti.products p where p.owner_id = p_owner
    ), '[]'::jsonb)
  )
$$;

-- Runs inside the restore's transaction, after moti.restore_library replaced the rows and while it still holds the
-- owner's restore lock and every product row. Every restored product takes the file's wish price; a file without one
-- (every backup made before this migration) leaves none. A bad value raises M0002, which rolls the whole restore back.
create function moti.restore_wish_prices(p_owner uuid, p_products jsonb) returns void
language plpgsql set search_path = '' as $$
begin
  if exists (
    select 1 from jsonb_to_recordset(p_products) as f(wish_amount_minor bigint, wish_currency text)
    where (f.wish_amount_minor is null) <> (f.wish_currency is null)
      or (f.wish_amount_minor is not null and (f.wish_amount_minor not between 0 and 9007199254740991 or f.wish_currency <> 'KRW'))
  ) then
    raise exception using errcode = 'M0002', message = 'invalid backup wish price';
  end if;
  update moti.products p
  set wish_amount_minor = f.wish_amount_minor, wish_currency = f.wish_currency
  from (
    select extensions.digest(char_length(f.identity_url)::text || ':' || f.identity_url || f.option, 'sha256') as identity_hash,
      f.wish_amount_minor, f.wish_currency
    from jsonb_to_recordset(p_products) as f(identity_url text, option text, wish_amount_minor bigint, wish_currency text)
  ) f
  where p.owner_id = p_owner and p.identity_hash = f.identity_hash;
exception
  when data_exception or integrity_constraint_violation then
    raise exception using errcode = 'M0002', message = 'invalid backup wish price';
end
$$;

revoke all on function moti.set_wish_price(uuid, uuid, integer, bigint, text), moti.restore_wish_prices(uuid, jsonb) from public;
grant execute on function moti.set_wish_price(uuid, uuid, integer, bigint, text), moti.restore_wish_prices(uuid, jsonb) to moti_rpc;

create function public.moti_set_wish_price(p_product_id uuid, p_revision integer, p_amount_minor bigint, p_currency text)
returns jsonb
language sql security definer set search_path = '' as $$
  select moti.set_wish_price(moti.require_owner(), p_product_id, p_revision, p_amount_minor, p_currency)
$$;

-- Same signature, owner and grants as before; a caller that sends no wish prices (the app before this change) restores
-- products without one, as it did. The library is read again because restore_library returned it before the prices.
create or replace function public.moti_restore_library(p_collections jsonb, p_products jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid := moti.require_owner();
  v_result jsonb;
begin
  v_result := moti.restore_library(v_owner, p_collections, p_products);
  perform moti.restore_wish_prices(v_owner, p_products);
  return jsonb_set(v_result, '{library}', moti.library_json(v_owner));
end
$$;

grant usage, create on schema public to moti_rpc;
alter function public.moti_set_wish_price(uuid, integer, bigint, text) owner to moti_rpc;
revoke create on schema public from moti_rpc;

revoke all on function public.moti_set_wish_price(uuid, integer, bigint, text) from public, anon, authenticated, service_role;
grant execute on function public.moti_set_wish_price(uuid, integer, bigint, text) to authenticated;
