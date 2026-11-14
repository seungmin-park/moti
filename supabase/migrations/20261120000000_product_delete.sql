-- The owner deletes a product. Its collection memberships and metadata jobs go with it through the products foreign
-- keys' on delete cascade. Its picture copy stays in Storage: once no product or running job refers to it,
-- picture_orphans returns it after its ten-minute margin and the owner's next wake discards it.

-- Locks the product's jobs in id order (as restore_library does), then the product, the order settling_product and metadata_retry use, so a running
-- collection either settles first or finds its job gone and answers stale. A delete is never a no-op, so an old
-- revision is always a conflict: the owner deletes what the screen showed or sees the newer product first.
create function moti.delete_product(p_owner uuid, p_product_id uuid, p_revision integer) returns jsonb
language plpgsql set search_path = '' as $$
declare
  v_product moti.products;
begin
  if p_revision is null or p_revision < 1 then
    raise exception using errcode = 'M0002', message = 'invalid revision';
  end if;
  perform 1 from moti.metadata_jobs j where j.owner_id = p_owner and j.product_id = p_product_id
    order by j.id for update;
  v_product := moti.product_for_change(p_owner, p_product_id);
  perform moti.require_revision(v_product.revision, p_revision);
  delete from moti.products p where p.id = v_product.id;
  return jsonb_build_object('id', v_product.id);
end
$$;

revoke all on function moti.delete_product(uuid, uuid, integer) from public;
grant execute on function moti.delete_product(uuid, uuid, integer) to moti_rpc;

create function public.moti_delete_product(p_product_id uuid, p_revision integer) returns jsonb
language sql security definer set search_path = '' as $$
  select moti.delete_product(moti.require_owner(), p_product_id, p_revision)
$$;

grant usage, create on schema public to moti_rpc;
alter function public.moti_delete_product(uuid, integer) owner to moti_rpc;
revoke create on schema public from moti_rpc;

revoke all on function public.moti_delete_product(uuid, integer) from public, anon, authenticated, service_role;
grant execute on function public.moti_delete_product(uuid, integer) to authenticated;
