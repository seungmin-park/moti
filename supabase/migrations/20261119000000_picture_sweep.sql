-- Leftover picture copies. A run that died after its upload, a settle that threw, a write through a signed upload link
-- and a discard that failed after a restore leave copies no product refers to. The scheduled worker cannot reach
-- Storage, so the owner's wake asks for them by name and discards them with the owner's token.

-- The owner's object names in the picture bucket created before p_before. moti_rpc cannot read the storage schema, so
-- this narrow read runs as the migration owner, like stored_picture_version. It applies no limit: the copies products
-- show are permanent and the oldest, so a limit here would let them fill every answer.
create function moti.stored_pictures(p_owner uuid, p_before timestamptz) returns setof text
language sql stable security definer set search_path = '' as $$
  select o.name from storage.objects o
  where o.bucket_id = 'product-pictures' and starts_with(o.name, p_owner::text || '/') and o.created_at < p_before
$$;

-- Copies Storage would let the owner discard, ten minutes after they were made. The two conditions are may_discard's,
-- with the owner's prefix from stored_pictures, written as one anti-join: calling may_discard per name rescans the
-- products for every object. Change them together; a name Storage refuses would hold its place in every answer.
-- may_discard has no age; the margin keeps a copy made moments ago out of the answer. Only names picture_object makes
-- count: a folder placeholder the dashboard leaves under the prefix is not a copy, and the server refuses an answer
-- that holds one.
create function moti.picture_orphans(p_owner uuid, p_limit integer) returns jsonb
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
          where p.picture_job_id is not null
            and moti.picture_object(p.owner_id, p.id, p.picture_job_id, p.picture_attempt) = s.name
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

revoke all on function moti.stored_pictures(uuid, timestamptz), moti.picture_orphans(uuid, integer) from public;
grant execute on function moti.stored_pictures(uuid, timestamptz), moti.picture_orphans(uuid, integer) to moti_rpc;

create function public.moti_picture_orphans(p_limit integer) returns jsonb
language sql stable security definer set search_path = '' as $$
  select moti.picture_orphans(moti.require_owner(), p_limit)
$$;

grant usage, create on schema public to moti_rpc;
alter function public.moti_picture_orphans(integer) owner to moti_rpc;
revoke create on schema public from moti_rpc;

revoke all on function public.moti_picture_orphans(integer) from public, anon, authenticated, service_role;
grant execute on function public.moti_picture_orphans(integer) to authenticated;
