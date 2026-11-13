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
