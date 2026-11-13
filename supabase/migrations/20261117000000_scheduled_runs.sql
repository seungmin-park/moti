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
