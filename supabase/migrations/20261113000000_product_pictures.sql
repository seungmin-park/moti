-- Private product pictures: a collection run copies the page's picture into a private bucket under a name the
-- database reserved for that attempt, and settles the copy's outcome together with the name and price.

create function moti.is_image_error(p_code text) returns boolean
language sql immutable set search_path = '' as $$
  select p_code in (
    'invalid_url', 'blocked_address', 'dns_failed', 'connect_failed', 'timeout', 'too_many_redirects',
    'blocked_by_site', 'http_status', 'unsupported_content', 'too_large', 'decode_failed',
    'unreadable_image', 'upload_failed', 'internal'
  )
$$;

-- The only place an object name is made. Code receives it from claim and never builds one. The attempt is part of
-- the name, so a writer whose lease expired can never touch the next attempt's object.
create function moti.picture_object(p_owner uuid, p_product uuid, p_job uuid, p_attempt integer) returns text
language sql immutable set search_path = '' as $$
  select p_owner::text || '/' || p_product::text || '/' || p_job::text || '-' || p_attempt::text || '.webp'
$$;

-- The stored object's version, or null when there is none. Storage gives an overwritten object a new version.
-- moti_rpc cannot read the storage schema, so this narrow read runs as the migration owner.
create function moti.stored_picture_version(p_name text) returns text
language sql stable security definer set search_path = '' as $$
  select o.version from storage.objects o where o.bucket_id = 'product-pictures' and o.name = p_name
$$;

-- require_owner without raising: a policy that raises turns Storage's refusal into a server error.
create function moti.owner_or_null() returns uuid
language sql stable set search_path = '' as $$
  select c.owner_id from moti.owner_config c
  where c.owner_id = moti.current_user_id() and moti.has_google_identity(c.owner_id, c.google_subject)
$$;

alter table moti.products
  add column metadata_image text check (metadata_image in ('copied', 'absent', 'failed')),
  add column metadata_image_error_code text
    check (metadata_image_error_code is null or moti.is_image_error(metadata_image_error_code)),
  add column picture_job_id uuid,
  add column picture_attempt integer check (picture_attempt between 1 and 3),
  add column picture_copied_at timestamptz,
  -- The version of the object complete saw; a copy with any other version is never shown.
  add column picture_object_version text;

-- Runs settled before pictures existed did not look for one.
update moti.products set metadata_image = 'absent' where metadata_phase = 'ready';

alter table moti.products
  add check ((metadata_phase = 'ready') = (metadata_image is not null)),
  add check ((metadata_image is not distinct from 'failed') = (metadata_image_error_code is not null)),
  add check (
    (picture_job_id is null and picture_attempt is null and picture_copied_at is null and picture_object_version is null)
    or (picture_job_id is not null and picture_attempt is not null and picture_copied_at is not null
      and picture_object_version is not null)
  );

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
    'metadata_image', p.metadata_image, 'metadata_image_error_code', p.metadata_image_error_code,
    'last_success_amount_minor', p.last_success_amount_minor,
    'last_success_currency', p.last_success_currency, 'last_success_at', p.last_success_at,
    -- The job that made the current copy: a version for caches, never the object name.
    'picture_version', p.picture_job_id
  )
$$;

create or replace function moti.metadata_claim(p_owner uuid, p_product_id uuid, p_generation integer) returns jsonb
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
      'attempts', v_job.attempts, 'source_url', v_product.source_url,
      'picture', moti.picture_object(v_job.owner_id, v_job.product_id, v_job.id, v_job.attempts)
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

drop function public.moti_metadata_complete(uuid, uuid, text, bigint, text, text);
drop function moti.metadata_complete(uuid, uuid, uuid, text, bigint, text, text);

create function moti.metadata_complete(
  p_owner uuid, p_job_id uuid, p_lease uuid, p_title text, p_amount_minor bigint, p_currency text,
  p_image_source_url text, p_image text, p_image_error_code text
) returns jsonb
language plpgsql set search_path = '' as $$
declare
  v_product moti.products;
  v_job moti.metadata_jobs;
  v_price boolean;
  v_copied boolean := p_image = 'copied';
  v_version text;
  v_replaced text;
begin
  if p_job_id is null or p_lease is null
    or p_title is null or char_length(p_title) not between 1 and 120 or p_title <> btrim(p_title)
    or p_title ~ '[[:cntrl:]]' or not (p_title is nfc normalized)
    or (p_amount_minor is null) <> (p_currency is null)
    or (p_amount_minor is not null and (p_amount_minor not between 1 and 9007199254740991 or p_currency !~ '^[A-Z]{3}$'))
    or (p_image_source_url is not null and not moti.is_web_url(p_image_source_url, 4096))
    or p_image is null or p_image not in ('copied', 'absent', 'failed')
    or (p_image = 'failed') <> (p_image_error_code is not null)
    or (p_image_error_code is not null and not moti.is_image_error(p_image_error_code))
    -- A page without a picture has nothing to copy, and a picture address always ends in a copy or a reason.
    or (p_image = 'absent') <> (p_image_source_url is null)
  then
    raise exception using errcode = 'M0002', message = 'invalid collection result';
  end if;

  v_product := moti.settling_product(p_owner, p_job_id, p_lease);
  if v_product.id is null then
    return jsonb_build_object('kind', 'stale');
  end if;

  select * into v_job from moti.metadata_jobs j where j.id = p_job_id;
  if v_copied then
    v_version := moti.stored_picture_version(moti.picture_object(v_job.owner_id, v_job.product_id, v_job.id, v_job.attempts));
    if v_version is null then
      raise exception using errcode = 'M0002', message = 'picture not stored';
    end if;
    if v_product.picture_job_id is not null then
      v_replaced := moti.picture_object(v_product.owner_id, v_product.id, v_product.picture_job_id, v_product.picture_attempt);
    end if;
  end if;

  update moti.metadata_jobs j
  set status = 'succeeded', lease_token = null, lease_until = null, finished_at = now(), updated_at = now(),
      image_source_url = p_image_source_url
  where j.id = p_job_id;

  -- A price in another currency is not comparable with the stored one, so it never replaces it.
  v_price := p_amount_minor is not null
    and (v_product.last_success_currency is null or v_product.last_success_currency = p_currency);
  -- Only a new copy replaces the shown picture; a failed or absent one keeps the last good copy.
  update moti.products p
  set title = p_title, metadata_phase = 'ready', metadata_error_code = null, metadata_completed_at = now(),
      metadata_image = p_image, metadata_image_error_code = p_image_error_code,
      picture_job_id = case when v_copied then v_job.id else p.picture_job_id end,
      picture_attempt = case when v_copied then v_job.attempts else p.picture_attempt end,
      picture_copied_at = case when v_copied then now() else p.picture_copied_at end,
      picture_object_version = case when v_copied then v_version else p.picture_object_version end,
      last_success_amount_minor = case when v_price then p_amount_minor else p.last_success_amount_minor end,
      last_success_currency = case when v_price then p_currency else p.last_success_currency end,
      last_success_at = case when v_price then now() else p.last_success_at end
  where p.id = v_product.id
  returning * into v_product;
  return jsonb_build_object('kind', 'applied', 'product', moti.product_json(v_product), 'replaced_picture', v_replaced);
end
$$;

create or replace function moti.metadata_retry(p_owner uuid, p_product_id uuid, p_expected_generation integer) returns jsonb
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
    -- Back in the queue rather than left stalled, so every read until the next claim shows it waiting.
    update moti.metadata_jobs j
    set status = 'queued', lease_token = null, lease_until = null, updated_at = now()
    where j.id = v_job.id;
    update moti.products p set metadata_phase = 'queued'
    where p.id = p_product_id
    returning * into v_product;
    return jsonb_build_object('kind', 'resumed', 'product', moti.product_json(v_product));
  end if;

  -- A picture that could not be copied is retried by reading the page again as a new generation.
  if v_product.metadata_phase = 'failed'
    or (v_product.metadata_phase = 'ready' and v_product.metadata_image = 'failed')
    or (v_product.metadata_phase in ('queued', 'running') and (v_job.id is null or moti.is_stalled(v_job))) then
    update moti.metadata_jobs j
    set status = 'failed', error_code = 'superseded', lease_token = null, lease_until = null,
        finished_at = now(), updated_at = now()
    where j.product_id = p_product_id and j.status in ('queued', 'running');
    update moti.products p
    set metadata_generation = p.metadata_generation + 1, metadata_phase = 'queued', metadata_attempts = 0,
        metadata_error_code = null, metadata_completed_at = null, metadata_image = null, metadata_image_error_code = null
    where p.id = p_product_id
    returning * into v_product;
    insert into moti.metadata_jobs (owner_id, product_id, generation)
    values (p_owner, p_product_id, v_product.metadata_generation);
    return jsonb_build_object('kind', 'requeued', 'product', moti.product_json(v_product));
  end if;

  raise exception using errcode = 'M0007', message = 'metadata not retryable';
end
$$;

create function moti.picture_locate(p_owner uuid, p_product_id uuid) returns text
language plpgsql stable set search_path = '' as $$
declare
  v_product moti.products;
  v_name text;
begin
  select * into v_product from moti.products p where p.id = p_product_id and p.owner_id = p_owner;
  if v_product.id is null then
    raise exception using errcode = 'M0006', message = 'product missing';
  end if;
  if v_product.picture_job_id is null then
    return null;
  end if;
  v_name := moti.picture_object(v_product.owner_id, v_product.id, v_product.picture_job_id, v_product.picture_attempt);
  -- An object changed after complete, or gone, is not the copy complete recorded: no new link is signed for it.
  if moti.stored_picture_version(v_name) is distinct from v_product.picture_object_version then
    return null;
  end if;
  return v_name;
end
$$;

revoke all on function moti.is_image_error(text), moti.picture_object(uuid, uuid, uuid, integer),
  moti.stored_picture_version(text), moti.owner_or_null(),
  moti.metadata_complete(uuid, uuid, uuid, text, bigint, text, text, text, text),
  moti.picture_locate(uuid, uuid) from public;
grant execute on function moti.is_image_error(text), moti.picture_object(uuid, uuid, uuid, integer),
  moti.stored_picture_version(text), moti.owner_or_null(),
  moti.metadata_complete(uuid, uuid, uuid, text, bigint, text, text, text, text),
  moti.picture_locate(uuid, uuid) to moti_rpc;

create function public.moti_metadata_complete(
  p_job_id uuid, p_lease uuid, p_title text, p_amount_minor bigint, p_currency text, p_image_source_url text,
  p_image text, p_image_error_code text
) returns jsonb
language sql security definer set search_path = '' as $$
  select moti.metadata_complete(moti.require_owner(), p_job_id, p_lease, p_title, p_amount_minor, p_currency,
    p_image_source_url, p_image, p_image_error_code)
$$;

create function public.moti_picture_locate(p_product_id uuid) returns text
language sql stable security definer set search_path = '' as $$
  select moti.picture_locate(moti.require_owner(), p_product_id)
$$;

grant usage, create on schema public to moti_rpc;
alter function public.moti_metadata_complete(uuid, uuid, text, bigint, text, text, text, text) owner to moti_rpc;
alter function public.moti_picture_locate(uuid) owner to moti_rpc;
revoke create on schema public from moti_rpc;

revoke all on function public.moti_metadata_complete(uuid, uuid, text, bigint, text, text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.moti_picture_locate(uuid) from public, anon, authenticated, service_role;
grant execute on function public.moti_metadata_complete(uuid, uuid, text, bigint, text, text, text, text) to authenticated;
grant execute on function public.moti_picture_locate(uuid) to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('product-pictures', 'product-pictures', false, 1048576, array['image/webp'])
on conflict (id) do update
set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- Storage evaluates its policies as the caller's role. These predicates run as moti_rpc, so they see only the
-- owner's rows through the existing RLS. The schema is not in [api].schemas, so REST never exposes them.
create schema moti_storage;
revoke all on schema moti_storage from public;
grant usage on schema moti_storage to authenticated, moti_rpc;

-- Write: only the name a running job reserved for this attempt, while its lease lasts.
create function moti_storage.may_write(p_name text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from moti.metadata_jobs j
    where j.owner_id = moti.owner_or_null() and j.status = 'running' and j.lease_until > now()
      and moti.picture_object(j.owner_id, j.product_id, j.id, j.attempts) = p_name
  )
$$;

create function moti_storage.may_read(p_name text) returns boolean
language sql stable security definer set search_path = '' as $$
  select split_part(p_name, '/', 1) = moti.owner_or_null()::text
$$;

-- Delete: the owner's objects that no product shows and that no unsettled job may still record. The runner removes
-- only the copy its stale settlement left or the copy a new one replaced. complete accepts an expired lease until the
-- job is claimed again, so the current attempt's name stays protected regardless of the lease.
create function moti_storage.may_discard(p_name text) returns boolean
language sql stable security definer set search_path = '' as $$
  select moti_storage.may_read(p_name)
    and not exists (
      select 1 from moti.products p
      where p.picture_job_id is not null
        and moti.picture_object(p.owner_id, p.id, p.picture_job_id, p.picture_attempt) = p_name
    )
    and not exists (
      select 1 from moti.metadata_jobs j
      where j.status = 'running' and moti.picture_object(j.owner_id, j.product_id, j.id, j.attempts) = p_name
    )
$$;

grant create on schema moti_storage to moti_rpc;
alter function moti_storage.may_write(text) owner to moti_rpc;
alter function moti_storage.may_read(text) owner to moti_rpc;
alter function moti_storage.may_discard(text) owner to moti_rpc;
revoke create on schema moti_storage from moti_rpc;

revoke all on function moti_storage.may_write(text), moti_storage.may_read(text), moti_storage.may_discard(text)
  from public, anon, service_role;
grant execute on function moti_storage.may_write(text), moti_storage.may_read(text), moti_storage.may_discard(text)
  to authenticated;

-- No update policy, so an upsert with the owner's token is refused. A signed upload link is different: Storage checks
-- only the insert policy when it issues one (there is no object yet, so the upsert probe never reaches an update) and
-- then writes as its own role. A link issued during the lease can create or overwrite the reserved name for its two
-- hours. complete records the object's version and picture_locate signs no other, so a copy changed after complete is
-- never signed again; the most it costs is the picture. Unit 5 sweeps the unreferenced objects.
create policy moti_pictures_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'product-pictures' and moti_storage.may_write(name));
create policy moti_pictures_select on storage.objects for select to authenticated
  using (bucket_id = 'product-pictures' and moti_storage.may_read(name));
create policy moti_pictures_delete on storage.objects for delete to authenticated
  using (bucket_id = 'product-pictures' and moti_storage.may_discard(name));
