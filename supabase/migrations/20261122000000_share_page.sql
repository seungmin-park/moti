-- Naver Smartstore, Coupang and Gmarket refuse the server's page reads, but the owner's Safari is already showing the
-- page. The Safari Shortcut runs a small script there and sends the page's head data with the link. The share route
-- reads it with the collection's own reader and rules, and the result waits on the new product's first job: the owner's
-- next collection settles the job with it instead of reading the shop, and copies the picture as for any page. The
-- picture is still fetched by the server. Nothing here changes a product that was already saved.

-- The read page, on the job: a name, the page's one price or none, and the picture's address, under the same checks as
-- a collection's result (moti_metadata_complete). It lives only while its job is queued or running; settling the job
-- clears it (the trigger below), so a retry's new job and the scheduled price checks read the shop as before.
alter table moti.metadata_jobs
  add column shared_title text check (shared_title is null or moti.is_clean_title(shared_title)),
  add column shared_amount_minor bigint,
  add column shared_currency text,
  add column shared_image_url text check (shared_image_url is null or moti.is_web_url(shared_image_url, 4096)),
  add constraint metadata_jobs_shared_page check (
    (shared_title is not null or (shared_amount_minor is null and shared_currency is null and shared_image_url is null))
    and (shared_amount_minor is null) = (shared_currency is null)
    and (shared_amount_minor is null or shared_amount_minor between 1 and 9007199254740991)
    and (shared_currency is null or shared_currency ~ '^[A-Z]{3}$')
    and (shared_title is null or status in ('queued', 'running'))
  );

comment on column moti.metadata_jobs.shared_title is
  'The Safari Shortcut''s read page for a share key''s add: its name. With shared_amount_minor, shared_currency and shared_image_url it replaces the page read for this job only, and is cleared when the job settles.';

-- Settling a job (succeeded or failed, superseded and exhausted included) forgets its read page, whichever role and
-- function settles it. It only edits the row being written, so it needs no privilege of its own.
create function moti.forget_shared_page() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.shared_title := null;
  new.shared_amount_minor := null;
  new.shared_currency := null;
  new.shared_image_url := null;
  return new;
end
$$;

revoke all on function moti.forget_shared_page() from public;

create trigger metadata_jobs_forget_shared_page
  before update of status on moti.metadata_jobs
  for each row when (new.status not in ('queued', 'running') and new.shared_title is not null)
  execute function moti.forget_shared_page();

-- Same as before, with the read page for the new product's first job. A page the job's checks would refuse is dropped
-- and the link is still added: the page is a hint, the link is the save. A duplicate never takes it. The arguments
-- default to null, so moti_save_link's five-argument call and the six-argument call keep their meaning.
drop function moti.add_link(uuid, text, text, text, text, text);
create function moti.add_link(
  p_owner uuid, p_source_url text, p_identity_url text, p_option text, p_shop text, p_title text default null,
  p_shared_title text default null, p_shared_amount_minor bigint default null, p_shared_currency text default null,
  p_shared_image_url text default null
)
returns table (kind text, product_id uuid)
language plpgsql set search_path = '' as $$
declare
  v_id uuid;
  v_generation integer;
  v_identity_url text;
  v_option text;
  v_shared boolean := coalesce(
    moti.is_clean_title(p_shared_title)
      and (p_shared_amount_minor is null) = (p_shared_currency is null)
      and (p_shared_amount_minor is null
        or (p_shared_amount_minor between 1 and 9007199254740991 and p_shared_currency ~ '^[A-Z]{3}$'))
      and (p_shared_image_url is null or moti.is_web_url(p_shared_image_url, 4096)),
    false
  );
begin
  if not moti.is_link_input(p_source_url, p_identity_url, p_option, p_shop) then
    raise exception using errcode = 'M0002', message = 'invalid link input';
  end if;

  insert into moti.products (owner_id, source_url, identity_url, option, shop, title)
  values (
    p_owner, p_source_url, p_identity_url, p_option, p_shop,
    case when moti.is_clean_title(p_title) then p_title else '새로 담은 상품' end
  )
  on conflict (owner_id, identity_hash) do nothing
  returning id, metadata_generation into v_id, v_generation;

  if v_id is not null then
    insert into moti.metadata_jobs (
      owner_id, product_id, generation, shared_title, shared_amount_minor, shared_currency, shared_image_url
    )
    values (
      p_owner, v_id, v_generation,
      case when v_shared then p_shared_title end,
      case when v_shared then p_shared_amount_minor end,
      case when v_shared then p_shared_currency end,
      case when v_shared then p_shared_image_url end
    );
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

revoke all on function moti.add_link(uuid, text, text, text, text, text, text, bigint, text, text) from public;
grant execute on function moti.add_link(uuid, text, text, text, text, text, text, bigint, text, text) to moti_rpc, moti_share;
grant insert (shared_title, shared_amount_minor, shared_currency, shared_image_url) on moti.metadata_jobs to moti_share;

-- Same body as before with the read page passed through. The new arguments default to null, so an app deployed before
-- this migration (six arguments) still adds the link, and this migration may be applied before the deploy.
drop function public.moti_share_add(text, text, text, text, text, text);
create function public.moti_share_add(
  p_key text, p_source_url text, p_identity_url text, p_option text, p_shop text, p_title text default null,
  p_shared_title text default null, p_shared_amount_minor bigint default null, p_shared_currency text default null,
  p_shared_image_url text default null
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid;
  v_uses integer;
  v_kind text;
begin
  if p_key is null or char_length(p_key) <> 51 or p_key !~ '^moti_sk_[A-Za-z0-9_-]{43}$' then
    raise exception using errcode = 'M0009', message = 'share key rejected';
  end if;

  update moti.share_keys k
  set last_used_at = now(),
      window_started_at = case when k.window_started_at > now() - interval '1 hour' then k.window_started_at else now() end,
      window_uses = case when k.window_started_at > now() - interval '1 hour' then k.window_uses + 1 else 1 end
  where k.token_hash = extensions.digest(p_key, 'sha256') and k.revoked_at is null
    and exists (
      select 1 from moti.owner_config c
      where c.owner_id = k.owner_id and moti.has_google_identity(c.owner_id, c.google_subject)
    )
  returning k.owner_id, k.window_uses into v_owner, v_uses;
  if v_owner is null then
    raise exception using errcode = 'M0009', message = 'share key rejected';
  end if;
  if v_uses > 30 then
    raise exception using errcode = 'M0010', message = 'share key busy';
  end if;

  select a.kind into v_kind from moti.add_link(
    v_owner, p_source_url, p_identity_url, p_option, p_shop, p_title,
    p_shared_title, p_shared_amount_minor, p_shared_currency, p_shared_image_url
  ) a;
  return jsonb_build_object('kind', v_kind);
exception
  -- A value the checks let through but a column refuses: the error's detail would show the row, owner included.
  when data_exception or integrity_constraint_violation then
    raise exception using errcode = 'M0002', message = 'invalid link input';
end
$$;

grant usage, create on schema public to moti_share;
alter function public.moti_share_add(text, text, text, text, text, text, text, bigint, text, text) owner to moti_share;
revoke usage, create on schema public from moti_share;

revoke all on function public.moti_share_add(text, text, text, text, text, text, text, bigint, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.moti_share_add(text, text, text, text, text, text, text, bigint, text, text) to anon;

-- Same as before, and the claimed job carries its read page (null when it has none).
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
      'picture', moti.picture_object(v_job.owner_id, v_job.product_id, v_job.id, v_job.attempts),
      'shared_page', case when v_job.shared_title is not null then jsonb_build_object(
        'title', v_job.shared_title, 'amount_minor', v_job.shared_amount_minor,
        'currency', v_job.shared_currency, 'image_source_url', v_job.shared_image_url
      ) end
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

-- The scheduled worker cannot copy a picture, and a blocked shop would fail its read, so a job with a read page is left
-- to the owner's collection (the screen wakes it). Otherwise the same as 20261118000000_price_check. The worker reads
-- only whether a job has one.
grant select (shared_title) on moti.metadata_jobs to moti_worker;

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
  where j.owner_id = v_owner and p.purchase_status = 'wish' and j.attempts < 3 and j.shared_title is null
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
