-- Collection job lifecycle: claim with a lease, complete or fail under that lease, and owner retry.

create function moti.is_collection_error(p_code text) returns boolean
language sql immutable set search_path = '' as $$
  select p_code in (
    'invalid_url', 'blocked_address', 'dns_failed', 'connect_failed', 'timeout', 'too_many_redirects',
    'blocked_by_site', 'http_status', 'unsupported_content', 'too_large', 'decode_failed', 'no_product_data',
    'attempts_exhausted', 'internal'
  )
$$;

alter table moti.metadata_jobs
  add column attempts integer not null default 0 check (attempts between 0 and 3),
  add column lease_token uuid,
  add column lease_until timestamptz,
  add column started_at timestamptz,
  add column finished_at timestamptz,
  add column updated_at timestamptz not null default now(),
  add column error_code text,
  add column image_source_url text check (image_source_url is null or moti.is_web_url(image_source_url, 4096)),
  add check (
    (status = 'running' and lease_token is not null and lease_until is not null)
    or (status <> 'running' and lease_token is null and lease_until is null)
  ),
  add check ((status = 'failed') = (error_code is not null)),
  add check (error_code is null or error_code = 'superseded' or moti.is_collection_error(error_code));

alter table moti.products
  add check (metadata_error_code is null or moti.is_collection_error(metadata_error_code));

create index metadata_jobs_pending on moti.metadata_jobs (status, lease_until) where status in ('queued', 'running');

-- A job nobody is working on: queued for longer than a request takes to start it, or running past its lease.
create function moti.is_stalled(j moti.metadata_jobs) returns boolean
language sql stable set search_path = '' as $$
  select (j.status = 'queued' and j.created_at < now() - interval '60 seconds')
      or (j.status = 'running' and j.lease_until < now())
$$;

create or replace function moti.product_json(p moti.products) returns jsonb
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
    'metadata_stalled', p.metadata_phase in ('queued', 'running') and exists (
      select 1 from moti.metadata_jobs j
      where j.product_id = p.id and j.generation = p.metadata_generation and moti.is_stalled(j)
    ),
    'last_success_amount_minor', p.last_success_amount_minor,
    'last_success_currency', p.last_success_currency, 'last_success_at', p.last_success_at
  )
$$;

-- The internal functions run as the caller (moti_rpc through the wrappers below), so RLS still applies.
create function moti.metadata_claim(p_owner uuid, p_product_id uuid, p_generation integer) returns jsonb
language plpgsql set search_path = '' as $$
declare
  v_product moti.products;
  v_job moti.metadata_jobs;
begin
  select * into v_product from moti.products p where p.id = p_product_id and p.owner_id = p_owner;
  if v_product.id is null or v_product.metadata_generation is distinct from p_generation then
    return jsonb_build_object('kind', 'skipped', 'reason', 'stale');
  end if;

  -- One conditional update: a concurrent claim re-checks the row after the first commits and matches nothing.
  update moti.metadata_jobs j
  set status = 'running', attempts = j.attempts + 1, lease_token = gen_random_uuid(),
      lease_until = now() + interval '60 seconds', started_at = now(), updated_at = now()
  where j.owner_id = p_owner and j.product_id = p_product_id and j.generation = p_generation
    and j.attempts < 3 and (j.status = 'queued' or (j.status = 'running' and j.lease_until < now()))
  returning * into v_job;
  if v_job.id is not null then
    update moti.products p set metadata_phase = 'running', metadata_attempts = v_job.attempts
    where p.id = p_product_id and p.metadata_generation = p_generation;
    return jsonb_build_object('kind', 'claimed', 'job', jsonb_build_object(
      'id', v_job.id, 'lease_token', v_job.lease_token, 'generation', v_job.generation,
      'attempts', v_job.attempts, 'source_url', v_product.source_url
    ));
  end if;

  update moti.metadata_jobs j
  set status = 'failed', error_code = 'attempts_exhausted', lease_token = null, lease_until = null,
      finished_at = now(), updated_at = now()
  where j.owner_id = p_owner and j.product_id = p_product_id and j.generation = p_generation
    and j.attempts >= 3 and (j.status = 'queued' or (j.status = 'running' and j.lease_until < now()))
  returning * into v_job;
  if v_job.id is not null then
    update moti.products p
    set metadata_phase = 'failed', metadata_error_code = 'attempts_exhausted', metadata_completed_at = null,
        metadata_attempts = v_job.attempts
    where p.id = p_product_id and p.metadata_generation = p_generation
    returning * into v_product;
    return jsonb_build_object('kind', 'exhausted', 'product', moti.product_json(v_product));
  end if;

  select * into v_job from moti.metadata_jobs j
  where j.owner_id = p_owner and j.product_id = p_product_id and j.generation = p_generation;
  if v_job.id is null then
    return jsonb_build_object('kind', 'skipped', 'reason', 'stale');
  end if;
  return jsonb_build_object('kind', 'skipped', 'reason', case when v_job.status = 'running' then 'busy' else 'settled' end);
end
$$;

-- Locks the job, then its product (the order every writer here uses), and checks the lease and generation.
-- Returns the product only when the result may still be written; a superseded job is closed on the way.
create function moti.settling_product(p_owner uuid, p_job_id uuid, p_lease uuid) returns moti.products
language plpgsql set search_path = '' as $$
declare
  v_job moti.metadata_jobs;
  v_product moti.products;
begin
  select * into v_job from moti.metadata_jobs j where j.id = p_job_id and j.owner_id = p_owner for update;
  if v_job.id is null or v_job.status <> 'running' or v_job.lease_token is distinct from p_lease then
    return null;
  end if;
  select * into v_product from moti.products p where p.id = v_job.product_id for update;
  if v_product.metadata_generation <> v_job.generation then
    update moti.metadata_jobs j
    set status = 'failed', error_code = 'superseded', lease_token = null, lease_until = null,
        finished_at = now(), updated_at = now()
    where j.id = v_job.id;
    return null;
  end if;
  return v_product;
end
$$;

create function moti.metadata_complete(
  p_owner uuid, p_job_id uuid, p_lease uuid, p_title text, p_amount_minor bigint, p_currency text, p_image_source_url text
) returns jsonb
language plpgsql set search_path = '' as $$
declare
  v_product moti.products;
  v_price boolean;
begin
  if p_job_id is null or p_lease is null
    or p_title is null or char_length(p_title) not between 1 and 120 or p_title <> btrim(p_title)
    or p_title ~ '[[:cntrl:]]' or not (p_title is nfc normalized)
    or (p_amount_minor is null) <> (p_currency is null)
    or (p_amount_minor is not null and (p_amount_minor not between 1 and 9007199254740991 or p_currency !~ '^[A-Z]{3}$'))
    or (p_image_source_url is not null and not moti.is_web_url(p_image_source_url, 4096))
  then
    raise exception using errcode = 'M0002', message = 'invalid collection result';
  end if;

  v_product := moti.settling_product(p_owner, p_job_id, p_lease);
  if v_product.id is null then
    return jsonb_build_object('kind', 'stale');
  end if;

  update moti.metadata_jobs j
  set status = 'succeeded', lease_token = null, lease_until = null, finished_at = now(), updated_at = now(),
      image_source_url = p_image_source_url
  where j.id = p_job_id;

  -- A price in another currency is not comparable with the stored one, so it never replaces it.
  v_price := p_amount_minor is not null
    and (v_product.last_success_currency is null or v_product.last_success_currency = p_currency);
  update moti.products p
  set title = p_title, metadata_phase = 'ready', metadata_error_code = null, metadata_completed_at = now(),
      last_success_amount_minor = case when v_price then p_amount_minor else p.last_success_amount_minor end,
      last_success_currency = case when v_price then p_currency else p.last_success_currency end,
      last_success_at = case when v_price then now() else p.last_success_at end
  where p.id = v_product.id
  returning * into v_product;
  return jsonb_build_object('kind', 'applied', 'product', moti.product_json(v_product));
end
$$;

create function moti.metadata_fail(p_owner uuid, p_job_id uuid, p_lease uuid, p_error_code text) returns jsonb
language plpgsql set search_path = '' as $$
declare
  v_product moti.products;
begin
  if p_job_id is null or p_lease is null or p_error_code is null or not moti.is_collection_error(p_error_code) then
    raise exception using errcode = 'M0002', message = 'invalid collection error';
  end if;

  v_product := moti.settling_product(p_owner, p_job_id, p_lease);
  if v_product.id is null then
    return jsonb_build_object('kind', 'stale');
  end if;

  update moti.metadata_jobs j
  set status = 'failed', error_code = p_error_code, lease_token = null, lease_until = null,
      finished_at = now(), updated_at = now()
  where j.id = p_job_id;
  update moti.products p
  set metadata_phase = 'failed', metadata_error_code = p_error_code, metadata_completed_at = null
  where p.id = v_product.id
  returning * into v_product;
  return jsonb_build_object('kind', 'applied', 'product', moti.product_json(v_product));
end
$$;

create function moti.metadata_retry(p_owner uuid, p_product_id uuid, p_expected_generation integer) returns jsonb
language plpgsql set search_path = '' as $$
declare
  v_product moti.products;
  v_job moti.metadata_jobs;
begin
  perform 1 from moti.metadata_jobs j where j.owner_id = p_owner and j.product_id = p_product_id for update;
  select * into v_product from moti.products p where p.id = p_product_id and p.owner_id = p_owner for update;
  if v_product.id is null then
    raise exception using errcode = 'M0006', message = 'product missing';
  end if;
  if v_product.metadata_generation is distinct from p_expected_generation then
    raise exception using errcode = 'M0007', message = 'metadata not retryable';
  end if;

  select * into v_job from moti.metadata_jobs j
  where j.product_id = p_product_id and j.generation = v_product.metadata_generation;

  if v_product.metadata_phase in ('queued', 'running') and v_job.id is not null and moti.is_stalled(v_job)
    and v_job.attempts < 3 then
    return jsonb_build_object('kind', 'resumed', 'product', moti.product_json(v_product));
  end if;

  if v_product.metadata_phase = 'failed'
    or (v_product.metadata_phase in ('queued', 'running') and (v_job.id is null or moti.is_stalled(v_job))) then
    update moti.metadata_jobs j
    set status = 'failed', error_code = 'superseded', lease_token = null, lease_until = null,
        finished_at = now(), updated_at = now()
    where j.product_id = p_product_id and j.status in ('queued', 'running');
    update moti.products p
    set metadata_generation = p.metadata_generation + 1, metadata_phase = 'queued', metadata_attempts = 0,
        metadata_error_code = null, metadata_completed_at = null
    where p.id = p_product_id
    returning * into v_product;
    insert into moti.metadata_jobs (owner_id, product_id, generation)
    values (p_owner, p_product_id, v_product.metadata_generation);
    return jsonb_build_object('kind', 'requeued', 'product', moti.product_json(v_product));
  end if;

  raise exception using errcode = 'M0007', message = 'metadata not retryable';
end
$$;

revoke all on function moti.is_collection_error(text), moti.is_stalled(moti.metadata_jobs),
  moti.metadata_claim(uuid, uuid, integer), moti.settling_product(uuid, uuid, uuid),
  moti.metadata_complete(uuid, uuid, uuid, text, bigint, text, text), moti.metadata_fail(uuid, uuid, uuid, text),
  moti.metadata_retry(uuid, uuid, integer) from public;
grant execute on function moti.is_collection_error(text), moti.is_stalled(moti.metadata_jobs),
  moti.metadata_claim(uuid, uuid, integer), moti.settling_product(uuid, uuid, uuid),
  moti.metadata_complete(uuid, uuid, uuid, text, bigint, text, text), moti.metadata_fail(uuid, uuid, uuid, text),
  moti.metadata_retry(uuid, uuid, integer) to moti_rpc;

create function public.moti_metadata_claim(p_product_id uuid, p_generation integer) returns jsonb
language sql security definer set search_path = '' as $$
  select moti.metadata_claim(moti.require_owner(), p_product_id, p_generation)
$$;

create function public.moti_metadata_complete(
  p_job_id uuid, p_lease uuid, p_title text, p_amount_minor bigint, p_currency text, p_image_source_url text
) returns jsonb
language sql security definer set search_path = '' as $$
  select moti.metadata_complete(moti.require_owner(), p_job_id, p_lease, p_title, p_amount_minor, p_currency, p_image_source_url)
$$;

create function public.moti_metadata_fail(p_job_id uuid, p_lease uuid, p_error_code text) returns jsonb
language sql security definer set search_path = '' as $$
  select moti.metadata_fail(moti.require_owner(), p_job_id, p_lease, p_error_code)
$$;

create function public.moti_metadata_retry(p_product_id uuid, p_expected_generation integer) returns jsonb
language sql security definer set search_path = '' as $$
  select moti.metadata_retry(moti.require_owner(), p_product_id, p_expected_generation)
$$;

grant usage, create on schema public to moti_rpc;
alter function public.moti_metadata_claim(uuid, integer) owner to moti_rpc;
alter function public.moti_metadata_complete(uuid, uuid, text, bigint, text, text) owner to moti_rpc;
alter function public.moti_metadata_fail(uuid, uuid, text) owner to moti_rpc;
alter function public.moti_metadata_retry(uuid, integer) owner to moti_rpc;
revoke create on schema public from moti_rpc;

revoke all on function public.moti_metadata_claim(uuid, integer) from public, anon, authenticated, service_role;
revoke all on function public.moti_metadata_complete(uuid, uuid, text, bigint, text, text) from public, anon, authenticated, service_role;
revoke all on function public.moti_metadata_fail(uuid, uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.moti_metadata_retry(uuid, integer) from public, anon, authenticated, service_role;
grant execute on function public.moti_metadata_claim(uuid, integer) to authenticated;
grant execute on function public.moti_metadata_complete(uuid, uuid, text, bigint, text, text) to authenticated;
grant execute on function public.moti_metadata_fail(uuid, uuid, text) to authenticated;
grant execute on function public.moti_metadata_retry(uuid, integer) to authenticated;
