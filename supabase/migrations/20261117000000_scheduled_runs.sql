-- The scheduled worker. GitHub Actions calls moti three times a day with the owner's worker key, a key that can run
-- the worker's own steps and nothing else. Unfinished collections are collected without the owner opening moti.

-- The owner's worker key. Only its SHA-256 is stored; the secret is shown once when it is made. One key is active per
-- owner, and revoked keys stay so the screen can say when a key stopped working.
create table moti.worker_keys (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  token_hash bytea not null unique check (octet_length(token_hash) = 32),
  hint text not null check (hint ~ '^[A-Za-z0-9_-]{4}$'),
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz check (revoked_at is null or revoked_at >= created_at)
);
create unique index worker_keys_one_active on moti.worker_keys (owner_id) where revoked_at is null;

-- One row per scheduled run. An open run (finished_at null) holds the run lease, and an owner has at most one. Each
-- settled item moves the counters, so a run cut short keeps accurate partial counts. failures maps closed-list codes to
-- counts and never holds a link, a name or a key. The price counters stay 0 until the daily price check exists.
create table moti.worker_runs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  key_id uuid not null references moti.worker_keys(id) on delete cascade,
  started_at timestamptz not null default now(),
  lease_token uuid,
  lease_until timestamptz,
  finished_at timestamptz,
  stop_reason text check (stop_reason in ('done', 'deadline', 'cut', 'revoked')),
  collected integer not null default 0 check (collected >= 0),
  collect_failed integer not null default 0 check (collect_failed >= 0),
  prices_confirmed integer not null default 0 check (prices_confirmed >= 0),
  prices_kept integer not null default 0 check (prices_kept >= 0),
  failures jsonb not null default '{}'::jsonb check (jsonb_typeof(failures) = 'object'),
  check ((finished_at is null) = (lease_token is not null)),
  check ((lease_token is null) = (lease_until is null)),
  check ((finished_at is null) = (stop_reason is null)),
  check (finished_at is null or finished_at >= started_at)
);
create unique index worker_runs_one_open on moti.worker_runs (owner_id) where finished_at is null;
create index worker_runs_recent on moti.worker_runs (owner_id, started_at desc);

alter table moti.worker_keys enable row level security;
alter table moti.worker_keys force row level security;
alter table moti.worker_runs enable row level security;
alter table moti.worker_runs force row level security;
revoke all on moti.worker_keys, moti.worker_runs from public, anon, authenticated, service_role;
-- The owner's functions never read a key's hash or a run's lease token. They stop a run by closing its lease.
grant select (id, owner_id, hint, created_at, last_used_at, revoked_at), insert (owner_id, token_hash, hint),
  update (revoked_at) on moti.worker_keys to moti_rpc;
grant select (id, owner_id, key_id, started_at, lease_until, finished_at, stop_reason, collected, collect_failed,
  prices_confirmed, prices_kept, failures), update (lease_token, lease_until, finished_at, stop_reason)
  on moti.worker_runs to moti_rpc;
create policy owner_manages_worker_keys on moti.worker_keys
  for all to moti_rpc using (owner_id = (select moti.current_user_id())) with check (owner_id = (select moti.current_user_id()));
create policy owner_reads_worker_runs on moti.worker_runs
  for select to moti_rpc using (owner_id = (select moti.current_user_id()));
create policy owner_stops_worker_runs on moti.worker_runs
  for update to moti_rpc using (owner_id = (select moti.current_user_id())) with check (owner_id = (select moti.current_user_id()));

create function moti.worker_key_json(p_id uuid) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', k.id, 'hint', k.hint, 'created_at', k.created_at, 'last_used_at', k.last_used_at, 'revoked_at', k.revoked_at
  )
  from moti.worker_keys k where k.id = p_id
$$;

-- The active key (else the latest revoked one, else null) and the latest five runs. An open run past its lease can no
-- longer settle anything, so it reads as cut at the time its lease ended.
create function moti.worker_read(p_owner uuid) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'key', (
      select moti.worker_key_json(k.id) from moti.worker_keys k
      where k.owner_id = p_owner
      order by k.revoked_at is null desc, k.created_at desc, k.id
      limit 1
    ),
    'runs', coalesce((
      select jsonb_agg(latest.run order by latest.started_at desc, latest.id)
      from (
        select r.id, r.started_at, jsonb_build_object(
          'id', r.id,
          'started_at', r.started_at,
          'finished_at', case when r.finished_at is null and r.lease_until <= now() then r.lease_until else r.finished_at end,
          'state', case
            when r.finished_at is not null then r.stop_reason
            when r.lease_until <= now() then 'cut'
            else 'running'
          end,
          'collected', r.collected, 'collect_failed', r.collect_failed,
          'prices_confirmed', r.prices_confirmed, 'prices_kept', r.prices_kept,
          'failures', r.failures
        ) as run
        from moti.worker_runs r
        where r.owner_id = p_owner
        order by r.started_at desc, r.id
        limit 5
      ) latest
    ), '[]'::jsonb)
  )
$$;

-- Closes the key's open run. A run whose lease already ended is cut at that time; a live one stops as revoked, so its
-- next step finds no lease. A run that began after this transaction did never ends before it started.
create function moti.worker_run_stop(p_key_id uuid) returns void
language sql set search_path = '' as $$
  update moti.worker_runs r
  set finished_at = case when r.lease_until <= now() then r.lease_until else greatest(now(), r.started_at) end,
      stop_reason = case when r.lease_until <= now() then 'cut' else 'revoked' end,
      lease_token = null, lease_until = null
  where r.key_id = p_key_id and r.finished_at is null
$$;

-- Replaces the active key only when it is the one the owner's screen showed (null when it showed none), so a stale tab
-- never kills a key that was just put into GitHub. The secret is 256 random bits after a fixed prefix that differs from
-- the share key's, so neither route mistakes one for the other.
create function moti.worker_key_issue(p_owner uuid, p_replaces uuid) returns jsonb
language plpgsql set search_path = '' as $$
declare
  v_active uuid;
  v_secret text;
  v_id uuid;
begin
  select k.id into v_active from moti.worker_keys k where k.owner_id = p_owner and k.revoked_at is null for update;
  if v_active is distinct from p_replaces then
    raise exception using errcode = 'M0008', message = 'revision conflict';
  end if;
  if v_active is not null then
    update moti.worker_keys k set revoked_at = now() where k.id = v_active;
    perform moti.worker_run_stop(v_active);
  end if;
  v_secret := 'moti_wk_' || rtrim(translate(encode(extensions.gen_random_bytes(32), 'base64'), '+/', '-_'), '=');
  insert into moti.worker_keys (owner_id, token_hash, hint)
  values (p_owner, extensions.digest(v_secret, 'sha256'), right(v_secret, 4))
  returning id into v_id;
  return jsonb_build_object('key', moti.worker_key_json(v_id), 'secret', v_secret);
exception when unique_violation then
  -- Another issue committed first while this one saw no active key.
  raise exception using errcode = 'M0008', message = 'revision conflict';
end
$$;

-- Idempotent: a revoked key keeps the time it was first revoked. Revoking stops the key's open run at once.
create function moti.worker_key_revoke(p_owner uuid, p_key_id uuid) returns jsonb
language plpgsql set search_path = '' as $$
declare
  v_id uuid;
begin
  update moti.worker_keys k set revoked_at = coalesce(k.revoked_at, now())
  where k.id = p_key_id and k.owner_id = p_owner
  returning k.id into v_id;
  if v_id is null then
    raise exception using errcode = 'M0016', message = 'worker key missing';
  end if;
  perform moti.worker_run_stop(v_id);
  return moti.worker_key_json(v_id);
end
$$;

revoke all on function moti.worker_key_json(uuid), moti.worker_read(uuid), moti.worker_run_stop(uuid),
  moti.worker_key_issue(uuid, uuid), moti.worker_key_revoke(uuid, uuid) from public;
grant execute on function moti.worker_key_json(uuid), moti.worker_read(uuid), moti.worker_run_stop(uuid),
  moti.worker_key_issue(uuid, uuid), moti.worker_key_revoke(uuid, uuid) to moti_rpc;

create function public.moti_worker_read() returns jsonb
language sql stable security definer set search_path = '' as $$
  select moti.worker_read(moti.require_owner())
$$;

create function public.moti_worker_key_issue(p_replaces uuid) returns jsonb
language sql security definer set search_path = '' as $$
  select moti.worker_key_issue(moti.require_owner(), p_replaces)
$$;

create function public.moti_worker_key_revoke(p_key_id uuid) returns jsonb
language sql security definer set search_path = '' as $$
  select moti.worker_key_revoke(moti.require_owner(), p_key_id)
$$;

grant usage, create on schema public to moti_rpc;
alter function public.moti_worker_read() owner to moti_rpc;
alter function public.moti_worker_key_issue(uuid) owner to moti_rpc;
alter function public.moti_worker_key_revoke(uuid) owner to moti_rpc;
revoke create on schema public from moti_rpc;

revoke all on function public.moti_worker_read() from public, anon, authenticated, service_role;
revoke all on function public.moti_worker_key_issue(uuid) from public, anon, authenticated, service_role;
revoke all on function public.moti_worker_key_revoke(uuid) from public, anon, authenticated, service_role;
grant execute on function public.moti_worker_read() to authenticated;
grant execute on function public.moti_worker_key_issue(uuid) to authenticated;
grant execute on function public.moti_worker_key_revoke(uuid) to authenticated;

-- The worker's role. It owns the functions anon may run with a worker key, and its grants are all it can do: read the
-- configured owner, find and mark its own active key, and keep its own run rows. A catalog test pins the list.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'moti_worker') then
    create role moti_worker nologin noinherit nosuperuser nobypassrls;
  end if;
end
$$;

grant moti_worker to postgres;
grant usage on schema moti, extensions to moti_worker;
grant select (owner_id, google_subject) on moti.owner_config to moti_worker;
grant select (id, owner_id, token_hash, revoked_at), update (last_used_at) on moti.worker_keys to moti_worker;
grant select, insert (owner_id, key_id, lease_token, lease_until),
  update (lease_token, lease_until, finished_at, stop_reason, collected, collect_failed, failures), delete
  on moti.worker_runs to moti_worker;
grant execute on function moti.has_google_identity(uuid, text) to moti_worker;

create policy worker_reads_owner on moti.owner_config for select to moti_worker using (true);
create policy worker_finds_active_key on moti.worker_keys for select to moti_worker using (revoked_at is null);
create policy worker_marks_use on moti.worker_keys for update to moti_worker
  using (revoked_at is null) with check (revoked_at is null);
create policy worker_keeps_runs on moti.worker_runs for all to moti_worker
  using (owner_id = (select c.owner_id from moti.owner_config c))
  with check (owner_id = (select c.owner_id from moti.owner_config c));

-- Every worker step after begin starts here. It checks, in order, the key's format, an active key of the configured
-- owner, then the run: that key's, still open, the same lease and the lease not yet over. A key failure is M0012 and a
-- run failure M0013, so a revoke mid-run stops the next step. It locks the run row, so a revoke waits for the step in
-- progress and the worker's steps take the same order as revoke (key, then run) and settle (run, then job, then product).
create function moti.worker_run_owner(p_key text, p_run uuid, p_lease uuid) returns uuid
language plpgsql set search_path = '' as $$
declare
  v_key uuid;
  v_owner uuid;
begin
  if p_key is null or char_length(p_key) <> 51 or p_key !~ '^moti_wk_[A-Za-z0-9_-]{43}$' then
    raise exception using errcode = 'M0012', message = 'worker key rejected';
  end if;
  select k.id, k.owner_id into v_key, v_owner from moti.worker_keys k
  where k.token_hash = extensions.digest(p_key, 'sha256') and k.revoked_at is null
    and exists (
      select 1 from moti.owner_config c
      where c.owner_id = k.owner_id and moti.has_google_identity(c.owner_id, c.google_subject)
    );
  if v_key is null then
    raise exception using errcode = 'M0012', message = 'worker key rejected';
  end if;
  perform 1 from moti.worker_runs r
  where r.id = p_run and r.key_id = v_key and r.finished_at is null and r.lease_token = p_lease and r.lease_until > now()
  for update;
  if not found then
    raise exception using errcode = 'M0013', message = 'worker run lost';
  end if;
  return v_owner;
end
$$;

revoke all on function moti.worker_run_owner(text, uuid, uuid) from public;
grant execute on function moti.worker_run_owner(text, uuid, uuid) to moti_worker;

-- Starts a run. Unknown, malformed and revoked keys, and keys of an owner who is no longer configured, take the same
-- path to the same error. A run whose lease ended without finish is closed as cut at that time, runs older than 30 days
-- are deleted, at most 8 runs start in 24 hours, and an open run with a live lease makes this one wait (M0014). The
-- 90 s lease outlasts the route's 60 s, so a run never loses it while its request lives. A refused begin rolls back,
-- so it neither records a run nor moves last_used_at.
create function public.moti_worker_begin(p_key text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_key uuid;
  v_owner uuid;
  v_run uuid;
  v_lease uuid := gen_random_uuid();
begin
  if p_key is null or char_length(p_key) <> 51 or p_key !~ '^moti_wk_[A-Za-z0-9_-]{43}$' then
    raise exception using errcode = 'M0012', message = 'worker key rejected';
  end if;
  update moti.worker_keys k set last_used_at = now()
  where k.token_hash = extensions.digest(p_key, 'sha256') and k.revoked_at is null
    and exists (
      select 1 from moti.owner_config c
      where c.owner_id = k.owner_id and moti.has_google_identity(c.owner_id, c.google_subject)
    )
  returning k.id, k.owner_id into v_key, v_owner;
  if v_key is null then
    raise exception using errcode = 'M0012', message = 'worker key rejected';
  end if;

  update moti.worker_runs r
  set finished_at = r.lease_until, stop_reason = 'cut', lease_token = null, lease_until = null
  where r.owner_id = v_owner and r.finished_at is null and r.lease_until <= now();
  delete from moti.worker_runs r where r.owner_id = v_owner and r.started_at < now() - interval '30 days';
  if (select count(*) from moti.worker_runs r where r.owner_id = v_owner and r.started_at > now() - interval '24 hours') >= 8 then
    raise exception using errcode = 'M0015', message = 'worker run limit';
  end if;

  insert into moti.worker_runs (owner_id, key_id, lease_token, lease_until)
  values (v_owner, v_key, v_lease, now() + interval '90 seconds')
  returning id into v_run;
  return jsonb_build_object('run', v_run, 'lease', v_lease);
exception when unique_violation then
  raise exception using errcode = 'M0014', message = 'worker run busy';
end
$$;

-- Closes the run as done (nothing was left to pick) or deadline (the run stopped picking first) and returns its counts.
create function public.moti_worker_finish(p_key text, p_run uuid, p_lease uuid, p_stop text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid := moti.worker_run_owner(p_key, p_run, p_lease);
  v_counts jsonb;
begin
  if p_stop is null or p_stop not in ('done', 'deadline') then
    raise exception using errcode = 'M0002', message = 'invalid run stop';
  end if;
  update moti.worker_runs r
  set finished_at = now(), stop_reason = p_stop, lease_token = null, lease_until = null
  where r.id = p_run and r.owner_id = v_owner
  returning jsonb_build_object(
    'stop', r.stop_reason, 'collected', r.collected, 'collect_failed', r.collect_failed,
    'prices_confirmed', r.prices_confirmed, 'prices_kept', r.prices_kept, 'failures', r.failures
  ) into v_counts;
  return v_counts;
end
$$;

grant usage, create on schema public to moti_worker;
alter function public.moti_worker_begin(text) owner to moti_worker;
alter function public.moti_worker_finish(text, uuid, uuid, text) owner to moti_worker;
revoke usage, create on schema public from moti_worker;

revoke all on function public.moti_worker_begin(text) from public, anon, authenticated, service_role;
revoke all on function public.moti_worker_finish(text, uuid, uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.moti_worker_begin(text) to anon;
grant execute on function public.moti_worker_finish(text, uuid, uuid, text) to anon;

-- The worker cannot reach Storage: Storage authorises only the owner's JWT, and minting one needs the project secret.
-- A worker collection stores the name and price and marks the picture as waiting; the owner's screen copies it.
alter table moti.products
  drop constraint products_metadata_image_check,
  add constraint products_metadata_image_check check (metadata_image in ('copied', 'absent', 'failed', 'waiting'));

-- What the worker may read and write to collect. It reads the link, the purchase status and the stored price's currency,
-- and writes only collection columns: never owner_title, note, option, revision, purchases or picture copies.
grant select (id, owner_id, product_id, generation, status, attempts, lease_token, lease_until, finished_at, error_code),
  update (status, attempts, lease_token, lease_until, started_at, finished_at, updated_at, error_code, image_source_url)
  on moti.metadata_jobs to moti_worker;
grant select (id, owner_id, source_url, created_at, purchase_status, metadata_generation, last_success_currency),
  update (title, metadata_phase, metadata_attempts, metadata_error_code, metadata_completed_at, metadata_image,
    metadata_image_error_code, last_success_amount_minor, last_success_currency, last_success_at)
  on moti.products to moti_worker;
-- The predicates the products and jobs check constraints call: a constraint runs its functions with the writing role's
-- privileges.
grant execute on function moti.is_web_url(text, integer), moti.is_clean_title(text), moti.is_collection_error(text),
  moti.is_image_error(text) to moti_worker;

create policy worker_reads_jobs on moti.metadata_jobs for select to moti_worker
  using (owner_id = (select c.owner_id from moti.owner_config c));
create policy worker_settles_jobs on moti.metadata_jobs for update to moti_worker
  using (owner_id = (select c.owner_id from moti.owner_config c))
  with check (owner_id = (select c.owner_id from moti.owner_config c));
create policy worker_reads_products on moti.products for select to moti_worker
  using (owner_id = (select c.owner_id from moti.owner_config c));
create policy worker_settles_products on moti.products for update to moti_worker
  using (owner_id = (select c.owner_id from moti.owner_config c))
  with check (owner_id = (select c.owner_id from moti.owner_config c));

-- settling_product for the worker: it names its columns, since the worker cannot read whole rows. It locks the job,
-- then its product, checks the job's lease and closes a superseded job. Returns the product only when the result may
-- still be written.
create function moti.worker_settling_product(p_owner uuid, p_job uuid, p_job_lease uuid) returns uuid
language plpgsql set search_path = '' as $$
declare
  v_product uuid;
  v_generation integer;
  v_status text;
  v_lease uuid;
  v_current integer;
begin
  select j.product_id, j.generation, j.status, j.lease_token into v_product, v_generation, v_status, v_lease
  from moti.metadata_jobs j where j.id = p_job and j.owner_id = p_owner for update;
  if v_product is null or v_status <> 'running' or v_lease is distinct from p_job_lease then
    return null;
  end if;
  select p.metadata_generation into v_current from moti.products p where p.id = v_product for update;
  if v_current <> v_generation then
    update moti.metadata_jobs j
    set status = 'failed', error_code = 'superseded', lease_token = null, lease_until = null,
        finished_at = now(), updated_at = now()
    where j.id = p_job;
    return null;
  end if;
  return v_product;
end
$$;

revoke all on function moti.worker_settling_product(uuid, uuid, uuid) from public;
grant execute on function moti.worker_settling_product(uuid, uuid, uuid) to moti_worker;

-- Picks one due collection and claims it like metadata_claim: a current-generation job of a wish product with fewer
-- than 3 attempts that is queued, running past its lease, or failed more than an hour ago for a reason a later attempt
-- may fix. Queued jobs come first, then the newest product. A job another request holds is skipped, and the claim
-- shares the owner's 3 attempts. The answer carries the link only, never the picture name.
create function public.moti_worker_next(p_key text, p_run uuid, p_lease uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid := moti.worker_run_owner(p_key, p_run, p_lease);
  v_job uuid;
  v_product uuid;
  v_source text;
  v_attempts integer;
  v_job_lease uuid := gen_random_uuid();
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
  if v_job is null then
    return jsonb_build_object('kind', 'none');
  end if;

  update moti.metadata_jobs j
  set status = 'running', attempts = j.attempts + 1, lease_token = v_job_lease, lease_until = now() + interval '60 seconds',
      started_at = now(), updated_at = now(), finished_at = null, error_code = null
  where j.id = v_job
  returning j.attempts into v_attempts;
  update moti.products p
  set metadata_phase = 'running', metadata_attempts = v_attempts, metadata_error_code = null, metadata_completed_at = null
  where p.id = v_product;
  return jsonb_build_object('kind', 'collection', 'job', v_job, 'job_lease', v_job_lease, 'source_url', v_source);
end
$$;

-- Settles a claimed job with the page's name and price. The collected name goes to title, never owner_title, so the
-- owner's own name stays on screen. The price is written only for a wish whose stored price has the same currency or
-- none. The picture is marked waiting when the page had one: only the owner's session can copy it.
create function public.moti_worker_complete(
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
  update moti.worker_runs r set collected = r.collected + 1 where r.id = p_run;
  return jsonb_build_object('kind', 'applied');
end
$$;

-- Settles a claimed job as failed with a reason from the closed list. The run counts the reason, never the link.
create function public.moti_worker_fail(p_key text, p_run uuid, p_lease uuid, p_job uuid, p_job_lease uuid, p_error_code text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid := moti.worker_run_owner(p_key, p_run, p_lease);
  v_product uuid;
begin
  if p_job is null or p_job_lease is null or p_error_code is null or p_error_code = 'attempts_exhausted'
    or not moti.is_collection_error(p_error_code) then
    raise exception using errcode = 'M0002', message = 'invalid collection error';
  end if;

  v_product := moti.worker_settling_product(v_owner, p_job, p_job_lease);
  if v_product is null then
    return jsonb_build_object('kind', 'stale');
  end if;

  update moti.metadata_jobs j
  set status = 'failed', error_code = p_error_code, lease_token = null, lease_until = null,
      finished_at = now(), updated_at = now()
  where j.id = p_job;
  update moti.products p
  set metadata_phase = 'failed', metadata_error_code = p_error_code, metadata_completed_at = null
  where p.id = v_product;
  update moti.worker_runs r
  set collect_failed = r.collect_failed + 1,
      failures = r.failures || jsonb_build_object(p_error_code, coalesce((r.failures ->> p_error_code)::integer, 0) + 1)
  where r.id = p_run;
  return jsonb_build_object('kind', 'applied');
end
$$;

grant usage, create on schema public to moti_worker;
alter function public.moti_worker_next(text, uuid, uuid) owner to moti_worker;
alter function public.moti_worker_complete(text, uuid, uuid, uuid, uuid, text, bigint, text, text) owner to moti_worker;
alter function public.moti_worker_fail(text, uuid, uuid, uuid, uuid, text) owner to moti_worker;
revoke usage, create on schema public from moti_worker;

revoke all on function public.moti_worker_next(text, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.moti_worker_complete(text, uuid, uuid, uuid, uuid, text, bigint, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.moti_worker_fail(text, uuid, uuid, uuid, uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.moti_worker_next(text, uuid, uuid) to anon;
grant execute on function public.moti_worker_complete(text, uuid, uuid, uuid, uuid, text, bigint, text, text) to anon;
grant execute on function public.moti_worker_fail(text, uuid, uuid, uuid, uuid, text) to anon;
