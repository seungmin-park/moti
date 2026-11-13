-- The daily price check. After the collections, the scheduled worker reads each wish product's page once per Seoul day
-- and compares its price with the stored one. A check that cannot compare keeps the previous price and says why. It
-- never touches a name, a picture or a purchased product.

-- price_checked_at is the latest daily attempt and the fence of the check in flight: a pick sets it, and only a settle
-- that shows that value writes. price_check_code says why the latest settled check kept the previous price; it is null
-- when the check confirmed a price or has not settled. The checks are inline: a check that calls a function needs
-- EXECUTE for every role that inserts products.
alter table moti.products
  add column price_checked_at timestamptz,
  add column price_check_code text check (price_check_code is null or price_check_code in (
    'invalid_url', 'blocked_address', 'dns_failed', 'connect_failed', 'timeout', 'too_many_redirects',
    'blocked_by_site', 'http_status', 'unsupported_content', 'too_large', 'decode_failed', 'no_product_data',
    'no_single_price', 'other_currency', 'internal'
  )),
  add constraint products_price_check_time check (price_check_code is null or price_checked_at is not null);

comment on column moti.products.price_checked_at is 'Latest daily price check, and the fence its settle must show. Only the worker''s functions write it; moti_rpc could, and no owner function does.';
comment on column moti.products.price_check_code is 'Why the latest settled daily check kept the previous price; null when it confirmed one.';

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
    -- The job that made the current copy: a version for caches, never the object name.
    'picture_version', p.picture_job_id
  )
$$;

-- What the check adds to the worker's fence: which products are due (collection ready, last check and last price), its
-- own two columns, and the run's price counters. Still never a name, owner_title, a purchase or a picture column.
grant select (metadata_phase, last_success_at, price_checked_at), update (price_checked_at, price_check_code)
  on moti.products to moti_worker;
grant update (prices_confirmed, prices_kept) on moti.worker_runs to moti_worker;

-- Picks one item. A due collection comes first, claimed as before. Otherwise one daily price check: a wish product whose
-- collection is ready and that was neither checked nor priced on today's Seoul date, never checked first, then the
-- longest unchecked. A product another request holds is skipped. The pick moves price_checked_at, which becomes the
-- check's fence, and clears the code, so a check that never settles shows no reason it did not find.
create or replace function public.moti_worker_next(p_key text, p_run uuid, p_lease uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid := moti.worker_run_owner(p_key, p_run, p_lease);
  v_today date := (now() at time zone 'Asia/Seoul')::date;
  v_job uuid;
  v_product uuid;
  v_source text;
  v_attempts integer;
  v_job_lease uuid := gen_random_uuid();
  v_checked_at timestamptz;
begin
  select j.id, j.product_id, p.source_url into v_job, v_product, v_source
  from moti.metadata_jobs j
  join moti.products p on p.id = j.product_id and p.metadata_generation = j.generation
  where j.owner_id = v_owner and p.purchase_status = 'wish' and j.attempts < 3
    and (
      j.status = 'queued'
      or (j.status = 'running' and j.lease_until < now())
      or (j.status = 'failed' and j.finished_at < now() - interval '1 hour'
        and j.error_code in ('dns_failed', 'connect_failed', 'timeout', 'blocked_by_site', 'http_status', 'internal'))
    )
  order by j.status = 'queued' desc, p.created_at desc, p.id
  limit 1
  for update of j skip locked;
  if v_job is not null then
    update moti.metadata_jobs j
    set status = 'running', attempts = j.attempts + 1, lease_token = v_job_lease, lease_until = now() + interval '60 seconds',
        started_at = now(), updated_at = now(), finished_at = null, error_code = null
    where j.id = v_job
    returning j.attempts into v_attempts;
    update moti.products p
    set metadata_phase = 'running', metadata_attempts = v_attempts, metadata_error_code = null, metadata_completed_at = null
    where p.id = v_product;
    return jsonb_build_object('kind', 'collection', 'job', v_job, 'job_lease', v_job_lease, 'source_url', v_source);
  end if;

  select p.id, p.source_url into v_product, v_source
  from moti.products p
  where p.owner_id = v_owner and p.purchase_status = 'wish' and p.metadata_phase = 'ready'
    and (p.price_checked_at is null or (p.price_checked_at at time zone 'Asia/Seoul')::date < v_today)
    and (p.last_success_at is null or (p.last_success_at at time zone 'Asia/Seoul')::date < v_today)
  order by p.price_checked_at nulls first, p.created_at, p.id
  limit 1
  for update skip locked;
  if v_product is null then
    return jsonb_build_object('kind', 'none');
  end if;
  update moti.products p set price_checked_at = now(), price_check_code = null
  where p.id = v_product
  returning p.price_checked_at into v_checked_at;
  return jsonb_build_object('kind', 'price', 'product', v_product, 'checked_at', v_checked_at, 'source_url', v_source);
end
$$;

-- Settles a picked check with the page's one price or the reason it has none. The fence is the pick's time and a wish:
-- a purchase, a later pick or an earlier settle of the same check makes it stale, and nothing is written. A price in the
-- stored currency (or with none stored) becomes the last checked price. Another currency, or a reason, keeps the
-- previous price and its time, and the run counts the reason. The settle moves price_checked_at, so a check settles once.
create function public.moti_worker_price(
  p_key text, p_run uuid, p_lease uuid, p_product uuid, p_checked_at timestamptz,
  p_amount_minor bigint, p_currency text, p_code text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid := moti.worker_run_owner(p_key, p_run, p_lease);
  v_currency text;
  v_code text;
begin
  if p_product is null or p_checked_at is null
    or (p_amount_minor is null) <> (p_currency is null)
    or (p_amount_minor is null) = (p_code is null)
    or (p_amount_minor is not null and (p_amount_minor not between 1 and 9007199254740991 or p_currency !~ '^[A-Z]{3}$'))
    or p_code not in (
      'invalid_url', 'blocked_address', 'dns_failed', 'connect_failed', 'timeout', 'too_many_redirects',
      'blocked_by_site', 'http_status', 'unsupported_content', 'too_large', 'decode_failed', 'no_product_data',
      'no_single_price', 'internal'
    )
  then
    raise exception using errcode = 'M0002', message = 'invalid price check';
  end if;

  select p.last_success_currency into v_currency
  from moti.products p
  where p.id = p_product and p.owner_id = v_owner and p.price_checked_at = p_checked_at and p.purchase_status = 'wish'
  for update;
  if not found then
    return jsonb_build_object('kind', 'stale');
  end if;

  v_code := coalesce(p_code, case when v_currency <> p_currency then 'other_currency' end);
  if v_code is null then
    update moti.products p
    set last_success_amount_minor = p_amount_minor, last_success_currency = p_currency, last_success_at = now(),
        price_checked_at = now(), price_check_code = null
    where p.id = p_product;
    update moti.worker_runs r set prices_confirmed = r.prices_confirmed + 1 where r.id = p_run;
  else
    update moti.products p set price_checked_at = now(), price_check_code = v_code where p.id = p_product;
    update moti.worker_runs r
    set prices_kept = r.prices_kept + 1,
        failures = r.failures || jsonb_build_object(v_code, coalesce((r.failures ->> v_code)::integer, 0) + 1)
    where r.id = p_run;
  end if;
  return jsonb_build_object('kind', 'applied');
end
$$;

-- Settles a claimed job with the page's name and price, as before. The page was read just now, so for a wish it also
-- counts as today's price check: confirmed when the price was written, other_currency or no_single_price when not.
create or replace function public.moti_worker_complete(
  p_key text, p_run uuid, p_lease uuid, p_job uuid, p_job_lease uuid,
  p_title text, p_amount_minor bigint, p_currency text, p_image_source_url text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid := moti.worker_run_owner(p_key, p_run, p_lease);
  v_product uuid;
begin
  if p_job is null or p_job_lease is null or not moti.is_clean_title(p_title)
    or (p_amount_minor is null) <> (p_currency is null)
    or (p_amount_minor is not null and (p_amount_minor not between 1 and 9007199254740991 or p_currency !~ '^[A-Z]{3}$'))
    or (p_image_source_url is not null and not moti.is_web_url(p_image_source_url, 4096))
  then
    raise exception using errcode = 'M0002', message = 'invalid collection result';
  end if;

  v_product := moti.worker_settling_product(v_owner, p_job, p_job_lease);
  if v_product is null then
    return jsonb_build_object('kind', 'stale');
  end if;

  update moti.metadata_jobs j
  set status = 'succeeded', lease_token = null, lease_until = null, finished_at = now(), updated_at = now(),
      image_source_url = p_image_source_url
  where j.id = p_job;
  update moti.products p
  set title = p_title, metadata_phase = 'ready', metadata_error_code = null, metadata_completed_at = now(),
      metadata_image = case when p_image_source_url is null then 'absent' else 'waiting' end,
      metadata_image_error_code = null
  where p.id = v_product;
  -- A price in another currency is not comparable with the stored one, and a purchased product keeps what it had.
  update moti.products p
  set last_success_amount_minor = p_amount_minor, last_success_currency = p_currency, last_success_at = now()
  where p.id = v_product and p_amount_minor is not null and p.purchase_status = 'wish'
    and (p.last_success_currency is null or p.last_success_currency = p_currency);
  -- Read after the write above: the stored currency equals the page's exactly when its price was written.
  update moti.products p
  set price_checked_at = now(),
      price_check_code = case
        when p_amount_minor is null then 'no_single_price'
        when p.last_success_currency <> p_currency then 'other_currency'
      end
  where p.id = v_product and p.purchase_status = 'wish';
  update moti.worker_runs r set collected = r.collected + 1 where r.id = p_run;
  return jsonb_build_object('kind', 'applied');
end
$$;

grant usage, create on schema public to moti_worker;
alter function public.moti_worker_price(text, uuid, uuid, uuid, timestamptz, bigint, text, text) owner to moti_worker;
revoke usage, create on schema public from moti_worker;

revoke all on function public.moti_worker_price(text, uuid, uuid, uuid, timestamptz, bigint, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.moti_worker_price(text, uuid, uuid, uuid, timestamptz, bigint, text, text) to anon;
