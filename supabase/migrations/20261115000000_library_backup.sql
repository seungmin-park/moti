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
