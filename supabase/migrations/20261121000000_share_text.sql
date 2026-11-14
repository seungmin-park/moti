-- A shopping app may hand the Shortcut text instead of a bare link: the Coupang app sends a greeting, the product's
-- name and a short link, and Coupang refuses page reads, so that name is the only one moti can get. The route finds
-- the link and the line above it. The name seeds title, the collected-name column: a successful collection replaces
-- it, a failed one leaves it, and the owner's owner_title still wins in product_json. Backups already carry title as
-- collectedTitle, so format v1 is unchanged.

-- p_title defaults to null so moti_save_link's five-argument call keeps its meaning. A name the column would refuse
-- falls back to the column's default rather than costing the link: the name is a hint, the link is the save.
drop function moti.add_link(uuid, text, text, text, text);
create function moti.add_link(
  p_owner uuid, p_source_url text, p_identity_url text, p_option text, p_shop text, p_title text default null
)
returns table (kind text, product_id uuid)
language plpgsql set search_path = '' as $$
declare
  v_id uuid;
  v_generation integer;
  v_identity_url text;
  v_option text;
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
    insert into moti.metadata_jobs (owner_id, product_id, generation) values (p_owner, v_id, v_generation);
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

revoke all on function moti.add_link(uuid, text, text, text, text, text) from public;
grant execute on function moti.add_link(uuid, text, text, text, text, text) to moti_rpc, moti_share;
grant insert (title) on moti.products to moti_share;

comment on column moti.products.title is
  'Collected name. Collection writes it; a share key''s add may seed it with the shared text''s name. product_json shows coalesce(owner_title, title).';

-- Same body as before with the name passed through. p_title defaults to null so a caller that does not send it (an app
-- deployed before this migration) still adds the link.
drop function public.moti_share_add(text, text, text, text, text);
create function public.moti_share_add(
  p_key text, p_source_url text, p_identity_url text, p_option text, p_shop text, p_title text default null
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

  select a.kind into v_kind from moti.add_link(v_owner, p_source_url, p_identity_url, p_option, p_shop, p_title) a;
  return jsonb_build_object('kind', v_kind);
exception
  -- A value the checks let through but a column refuses: the error's detail would show the row, owner included.
  when data_exception or integrity_constraint_violation then
    raise exception using errcode = 'M0002', message = 'invalid link input';
end
$$;

grant usage, create on schema public to moti_share;
alter function public.moti_share_add(text, text, text, text, text, text) owner to moti_share;
revoke usage, create on schema public from moti_share;

revoke all on function public.moti_share_add(text, text, text, text, text, text) from public, anon, authenticated, service_role;
grant execute on function public.moti_share_add(text, text, text, text, text, text) to anon;
