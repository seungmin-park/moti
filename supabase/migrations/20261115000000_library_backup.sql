-- Backup and restore of the owner's library. A backup holds what the owner can see or set; ids, revisions, collection
-- jobs and picture copies stay server state.

-- The library as the screen reads it. moti_snapshot returns it, and a restore returns it after replacing the rows.
create function moti.library_json(p_owner uuid) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'products', coalesce((
      select jsonb_agg(moti.product_json(p) order by p.created_at desc, p.id)
      from moti.products p where p.owner_id = p_owner
    ), '[]'::jsonb),
    'collections', coalesce((
      select jsonb_agg(moti.collection_json(c) order by c.created_at, c.id)
      from moti.collections c where c.owner_id = p_owner
    ), '[]'::jsonb)
  )
$$;

create or replace function public.moti_snapshot() returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  return moti.library_json(moti.require_owner());
end
$$;

-- One statement, so collections and products come from one snapshot. The collected title and the owner's name stay
-- apart (product_json merges them). A file keeps milliseconds, so rows are ordered by the millisecond and then by
-- values the file carries: a library restored from a file exports in the same order.
create function moti.backup_json(p_owner uuid) returns jsonb
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
        'last_success_currency', p.last_success_currency, 'last_success_at', p.last_success_at
      ) order by date_trunc('milliseconds', p.created_at) desc, p.identity_url, p.option)
      from moti.products p where p.owner_id = p_owner
    ), '[]'::jsonb)
  )
$$;

revoke all on function moti.library_json(uuid), moti.backup_json(uuid) from public;
grant execute on function moti.library_json(uuid), moti.backup_json(uuid) to moti_rpc;

create function public.moti_backup() returns jsonb
language sql stable security definer set search_path = '' as $$
  select moti.backup_json(moti.require_owner())
$$;

grant usage, create on schema public to moti_rpc;
alter function public.moti_backup() owner to moti_rpc;
revoke create on schema public from moti_rpc;

revoke all on function public.moti_backup() from public, anon, authenticated, service_role;
grant execute on function public.moti_backup() to authenticated;

-- The file's rows as the restore reads them. identity_hash is computed the way the products column is.
create function moti.restore_collections(p_collections jsonb)
returns table (name text, created_at timestamptz)
language sql stable set search_path = '' as $$
  select f.name, f.created_at from jsonb_to_recordset(p_collections) as f(name text, created_at timestamptz)
$$;

create function moti.restore_products(p_products jsonb)
returns table (
  source_url text, identity_url text, option text, shop text, title text, owner_title text, note text,
  collection_names jsonb, created_at timestamptz, purchase_status text, purchased_on date,
  purchased_amount_minor bigint, purchased_currency text,
  last_success_amount_minor bigint, last_success_currency text, last_success_at timestamptz, identity_hash bytea
)
language sql stable set search_path = '' as $$
  select f.*, extensions.digest(char_length(f.identity_url)::text || ':' || f.identity_url || f.option, 'sha256')
  from jsonb_to_recordset(p_products) as f(
    source_url text, identity_url text, option text, shop text, title text, owner_title text, note text,
    collection_names jsonb, created_at timestamptz, purchase_status text, purchased_on date,
    purchased_amount_minor bigint, purchased_currency text,
    last_success_amount_minor bigint, last_success_currency text, last_success_at timestamptz
  )
$$;

-- Replaces the owner's library with a backup in one transaction. The whole input is checked first with the writers'
-- own rules; any failure changes nothing. Products are matched by link identity and collections by name ignoring
-- case: a matched row keeps its id, collection state, collected title, last price and picture, takes the file's owner
-- values and gets a higher revision, so a stale tab can never overwrite it at an equal revision. Rows the file does not
-- have are deleted (a stale tab then gets the existing missing-row errors) and file rows without a match are inserted
-- as new saves with a queued collection. The copies the deleted products showed are returned for the caller to
-- discard after commit; SQL cannot delete Storage objects.
create function moti.restore_library(p_owner uuid, p_collections jsonb, p_products jsonb) returns jsonb
language plpgsql set search_path = '' set lock_timeout = '5s' as $$
declare
  v_replaced text[];
  v_expected integer;
  v_count integer;
begin
  if jsonb_typeof(p_collections) is distinct from 'array' or jsonb_array_length(p_collections) > 500
    or jsonb_typeof(p_products) is distinct from 'array' or jsonb_array_length(p_products) > 5000
    or exists (select 1 from jsonb_array_elements(p_collections) e where jsonb_typeof(e) <> 'object')
    or exists (select 1 from jsonb_array_elements(p_products) e where jsonb_typeof(e) <> 'object')
  then
    raise exception using errcode = 'M0002', message = 'invalid backup';
  end if;

  if exists (
    select 1 from moti.restore_collections(p_collections) c
    where c.name is null or c.name <> btrim(c.name) or char_length(c.name) not between 1 and 40
      or not (c.name is nfc normalized) or c.created_at is null or c.created_at > now()
  ) or (select count(*) <> count(distinct lower(c.name)) from moti.restore_collections(p_collections) c) then
    raise exception using errcode = 'M0002', message = 'invalid backup collections';
  end if;

  if exists (
    select 1 from moti.restore_products(p_products) f
    where not moti.is_web_url(f.source_url, 4096) or not moti.is_web_url(f.identity_url, 49152)
      or f.option is null or char_length(f.option) > 120 or f.option <> btrim(f.option) or not (f.option is nfc normalized)
      or f.shop is null or char_length(f.shop) not between 1 and 255
      or not moti.is_clean_title(f.title)
      or (f.owner_title is not null and not moti.is_clean_title(f.owner_title))
      or f.note is null or char_length(f.note) > 3000
      or jsonb_typeof(f.collection_names) is distinct from 'array' or jsonb_array_length(f.collection_names) > 100
      or f.created_at is null or f.created_at > now()
      or f.purchase_status is null or f.purchase_status not in ('wish', 'purchased')
      or (f.purchase_status = 'wish'
        and (f.purchased_on is not null or f.purchased_amount_minor is not null or f.purchased_currency is not null))
      or (f.purchased_on is not null
        and f.purchased_on not between date '1900-01-01' and (now() at time zone 'Asia/Seoul')::date)
      or (f.purchased_amount_minor is null) <> (f.purchased_currency is null)
      or (f.purchased_amount_minor is not null
        and (f.purchased_amount_minor not between 0 and 9007199254740991 or f.purchased_currency <> 'KRW'))
      or (f.last_success_amount_minor is null) <> (f.last_success_currency is null)
      or (f.last_success_amount_minor is null) <> (f.last_success_at is null)
      or (f.last_success_amount_minor is not null and (f.last_success_amount_minor not between 1 and 9007199254740991
        or f.last_success_currency !~ '^[A-Z]{3}$' or f.last_success_at > now()))
  ) or (select count(*) <> count(distinct f.identity_hash) from moti.restore_products(p_products) f) then
    raise exception using errcode = 'M0002', message = 'invalid backup products';
  end if;

  -- Membership by name: each name a string the file defines, once per product.
  if exists (
    select 1 from moti.restore_products(p_products) f
    where exists (
      select 1 from jsonb_array_elements(f.collection_names) e
      where jsonb_typeof(e) <> 'string'
        or not exists (select 1 from moti.restore_collections(p_collections) c where c.name = e #>> '{}')
    ) or (select count(*) <> count(distinct e) from jsonb_array_elements(f.collection_names) e)
  ) then
    raise exception using errcode = 'M0002', message = 'invalid backup membership';
  end if;

  -- One restore at a time per owner, then the rows in the order the collection writers lock them (job, then product),
  -- with collections last. A running settlement or owner change finishes first; later ones find their rows gone.
  perform pg_advisory_xact_lock(hashtextextended('moti.restore:' || p_owner::text, 0));
  perform 1 from moti.metadata_jobs j where j.owner_id = p_owner order by j.id for update;
  perform 1 from moti.products p where p.owner_id = p_owner order by p.id for update;
  perform 1 from moti.collections c where c.owner_id = p_owner order by c.id for update;

  delete from moti.collections c
  where c.owner_id = p_owner
    and not exists (select 1 from moti.restore_collections(p_collections) f where lower(f.name) = c.name_key);
  update moti.collections c
  set name = f.name, created_at = f.created_at, revision = c.revision + 1, updated_at = now()
  from moti.restore_collections(p_collections) f
  where c.owner_id = p_owner and c.name_key = lower(f.name);
  insert into moti.collections (owner_id, name, created_at)
  select p_owner, f.name, f.created_at from moti.restore_collections(p_collections) f
  where not exists (select 1 from moti.collections c where c.owner_id = p_owner and c.name_key = lower(f.name));

  select coalesce(array_agg(moti.picture_object(p.owner_id, p.id, p.picture_job_id, p.picture_attempt) order by p.id), '{}')
  into v_replaced
  from moti.products p
  where p.owner_id = p_owner and p.picture_job_id is not null
    and not exists (select 1 from moti.restore_products(p_products) f where f.identity_hash = p.identity_hash);
  delete from moti.products p
  where p.owner_id = p_owner
    and not exists (select 1 from moti.restore_products(p_products) f where f.identity_hash = p.identity_hash);
  update moti.products p
  set source_url = f.source_url, shop = f.shop, owner_title = f.owner_title, note = f.note, created_at = f.created_at,
      purchase_status = f.purchase_status, purchased_on = f.purchased_on,
      purchased_amount_minor = f.purchased_amount_minor, purchased_currency = f.purchased_currency,
      revision = p.revision + 1, updated_at = now()
  from moti.restore_products(p_products) f
  where p.owner_id = p_owner and p.identity_hash = f.identity_hash;
  -- Defaults make a new save: revision 1, collection queued at generation 1, no picture.
  with inserted as (
    insert into moti.products (owner_id, source_url, identity_url, option, shop, title, owner_title, note, created_at,
      purchase_status, purchased_on, purchased_amount_minor, purchased_currency,
      last_success_amount_minor, last_success_currency, last_success_at)
    select p_owner, f.source_url, f.identity_url, f.option, f.shop, f.title, f.owner_title, f.note, f.created_at,
      f.purchase_status, f.purchased_on, f.purchased_amount_minor, f.purchased_currency,
      f.last_success_amount_minor, f.last_success_currency, f.last_success_at
    from moti.restore_products(p_products) f
    where not exists (select 1 from moti.products p where p.owner_id = p_owner and p.identity_hash = f.identity_hash)
    returning id, metadata_generation
  )
  insert into moti.metadata_jobs (owner_id, product_id, generation)
  select p_owner, i.id, i.metadata_generation from inserted i;

  delete from moti.product_collections m where m.owner_id = p_owner;
  insert into moti.product_collections (owner_id, product_id, collection_id)
  select p_owner, p.id, c.id
  from moti.restore_products(p_products) f
  join moti.products p on p.owner_id = p_owner and p.identity_hash = f.identity_hash
  cross join lateral jsonb_array_elements_text(f.collection_names) as n(name)
  join moti.collections c on c.owner_id = p_owner and c.name = n.name;
  get diagnostics v_count = row_count;
  select coalesce(sum(jsonb_array_length(f.collection_names)), 0) into v_expected from moti.restore_products(p_products) f;
  if v_count <> v_expected then
    raise exception using errcode = 'M0002', message = 'invalid backup membership';
  end if;

  return jsonb_build_object('library', moti.library_json(p_owner), 'replaced_pictures', to_jsonb(v_replaced));
exception
  -- Values the checks above let through but a column refuses (a cast, or lower() under the database's collation).
  when data_exception or integrity_constraint_violation then
    raise exception using errcode = 'M0002', message = 'invalid backup';
end
$$;

revoke all on function moti.restore_collections(jsonb), moti.restore_products(jsonb),
  moti.restore_library(uuid, jsonb, jsonb) from public;
grant execute on function moti.restore_collections(jsonb), moti.restore_products(jsonb),
  moti.restore_library(uuid, jsonb, jsonb) to moti_rpc;

create function public.moti_restore_library(p_collections jsonb, p_products jsonb) returns jsonb
language sql security definer set search_path = '' as $$
  select moti.restore_library(moti.require_owner(), p_collections, p_products)
$$;

grant usage, create on schema public to moti_rpc;
alter function public.moti_restore_library(jsonb, jsonb) owner to moti_rpc;
revoke create on schema public from moti_rpc;

revoke all on function public.moti_restore_library(jsonb, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.moti_restore_library(jsonb, jsonb) to authenticated;
