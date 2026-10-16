-- Account deletion data cleanup.
-- Apply after supabase_schema.sql and keep this function in sync with the
-- equivalent definition in supabase_schema.sql for new installations.

create or replace function public.redact_jsonb_identifiers(p_value jsonb, p_ids uuid[])
returns jsonb
language plpgsql
immutable
strict
set search_path to 'pg_catalog'
as $$
declare
  v_key text;
  v_item jsonb;
  v_result jsonb;
begin
  if jsonb_typeof(p_value) = 'object' then
    v_result := '{}'::jsonb;
    for v_key, v_item in select key, value from jsonb_each(p_value)
    loop
      if not exists (select 1 from unnest(p_ids) as target(id) where target.id::text = v_key) then
        v_result := v_result || jsonb_build_object(v_key, public.redact_jsonb_identifiers(v_item, p_ids));
      end if;
    end loop;
    return v_result;
  elsif jsonb_typeof(p_value) = 'array' then
    v_result := '[]'::jsonb;
    for v_item in select value from jsonb_array_elements(p_value)
    loop
      if jsonb_typeof(v_item) <> 'string'
         or not exists (
           select 1 from unnest(p_ids) as target(id)
           where target.id::text = v_item #>> '{}'
         ) then
        v_result := v_result || jsonb_build_array(public.redact_jsonb_identifiers(v_item, p_ids));
      end if;
    end loop;
    return v_result;
  elsif jsonb_typeof(p_value) = 'string'
        and exists (
          select 1 from unnest(p_ids) as target(id)
          where target.id::text = p_value #>> '{}'
        ) then
    return 'null'::jsonb;
  end if;

  return p_value;
end;
$$;

drop function if exists public.delete_my_account_data();

create or replace function public.delete_account_data(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_user_id uuid := p_user_id;
  v_live_player_ids uuid[] := '{}'::uuid[];
  v_live_round_ids uuid[] := '{}'::uuid[];
  v_archived_player_ids uuid[] := '{}'::uuid[];
  v_redacted_ids uuid[] := '{}'::uuid[];
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Not authorized';
  end if;

  if v_user_id is null then
    raise exception 'User is required';
  end if;

  if exists (
    select 1 from auth.users
    where id = v_user_id and is_anonymous is true
  ) then
    raise exception 'Anonymous accounts cannot use this operation';
  end if;

  delete from public.scores s
  using public.players p, public.rounds r
  where s.player_id = p.id
    and p.round_id = r.id
    and r.host_user_id = v_user_id;

  delete from public.players p
  using public.rounds r
  where p.round_id = r.id
    and r.host_user_id = v_user_id;

  delete from public.rounds where host_user_id = v_user_id;

  select
    coalesce(array_agg(p.id), '{}'::uuid[]),
    coalesce(array_agg(distinct p.round_id), '{}'::uuid[])
  into v_live_player_ids, v_live_round_ids
  from public.players p
  join public.rounds r on r.id = p.round_id
  where p.user_id = v_user_id
    and r.host_user_id is distinct from v_user_id;

  if cardinality(v_live_player_ids) > 0 then
    delete from public.scores where player_id = any(v_live_player_ids);
    delete from public.players where id = any(v_live_player_ids);

    update public.rounds r
    set host_player_id = case
          when r.host_player_id = any(v_live_player_ids) then null
          else r.host_player_id
        end,
        match_team_a = case when r.match_team_a is null then null else
          nullif((select array_agg(id) from unnest(r.match_team_a) as team(id)
                  where not (team.id = any(v_live_player_ids))), '{}'::uuid[]) end,
        match_team_b = case when r.match_team_b is null then null else
          nullif((select array_agg(id) from unnest(r.match_team_b) as team(id)
                  where not (team.id = any(v_live_player_ids))), '{}'::uuid[]) end,
        sidematch_team_c = case when r.sidematch_team_c is null then null else
          nullif((select array_agg(id) from unnest(r.sidematch_team_c) as team(id)
                  where not (team.id = any(v_live_player_ids))), '{}'::uuid[]) end,
        sidematch_team_d = case when r.sidematch_team_d is null then null else
          nullif((select array_agg(id) from unnest(r.sidematch_team_d) as team(id)
                  where not (team.id = any(v_live_player_ids))), '{}'::uuid[]) end,
        sixes_players = case when r.sixes_players is null then null else
          nullif((select array_agg(id) from unnest(r.sixes_players) as team(id)
                  where not (team.id = any(v_live_player_ids))), '{}'::uuid[]) end,
        tournament_matches = public.redact_jsonb_identifiers(r.tournament_matches, v_live_player_ids)
    where r.id = any(v_live_round_ids);
  end if;

  select coalesce(array_agg(distinct (player_entry.value->>'id')::uuid), '{}'::uuid[])
  into v_archived_player_ids
  from public.completed_rounds cr
  cross join lateral jsonb_array_elements(
    case when jsonb_typeof(cr.players_snapshot) = 'array'
      then cr.players_snapshot else '[]'::jsonb end
  ) as player_entry(value)
  where player_entry.value->>'user_id' = v_user_id::text
    and player_entry.value->>'id' ~*
      '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

  select coalesce(array_agg(distinct identifier), '{}'::uuid[])
  into v_redacted_ids
  from unnest(v_live_player_ids || v_archived_player_ids || array[v_user_id]) as ids(identifier);

  update public.completed_rounds cr
  set host_user_id = case when cr.host_user_id = v_user_id then null else cr.host_user_id end,
      participant_user_ids = array(
        select participant_id
        from unnest(cr.participant_user_ids) as participants(participant_id)
        where participant_id <> v_user_id
      ),
      round_snapshot = public.redact_jsonb_identifiers(cr.round_snapshot, v_redacted_ids),
      players_snapshot = case
        when jsonb_typeof(cr.players_snapshot) = 'array' then (
          select coalesce(jsonb_agg(player_entry.value), '[]'::jsonb)
          from jsonb_array_elements(cr.players_snapshot) as player_entry(value)
          where player_entry.value->>'user_id' is distinct from v_user_id::text
            and case
              when player_entry.value->>'id' ~*
                '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              then not ((player_entry.value->>'id')::uuid = any(v_archived_player_ids))
              else true
            end
        )
        else cr.players_snapshot
      end,
      scores_snapshot = case
        when jsonb_typeof(cr.scores_snapshot) = 'array' then (
          select coalesce(jsonb_agg(score_entry.value), '[]'::jsonb)
          from jsonb_array_elements(cr.scores_snapshot) as score_entry(value)
          where not exists (
            select 1 from unnest(v_archived_player_ids) as ids(player_id)
            where score_entry.value->>'player_id' = ids.player_id::text
          )
        )
        else cr.scores_snapshot
      end
  where v_user_id = any(cr.participant_user_ids)
     or cr.host_user_id = v_user_id
     or cr.round_snapshot @> jsonb_build_object('host_user_id', v_user_id::text)
     or cr.players_snapshot @> jsonb_build_array(jsonb_build_object('user_id', v_user_id::text));

  delete from public.friendships
  where requester_id = v_user_id or addressee_id = v_user_id;
  delete from public.user_profiles where id = v_user_id;
  update public.courses set user_id = null where user_id = v_user_id;
  delete from public.api_usage where user_id = v_user_id;
  delete from public.round_lookup_attempts where user_id = v_user_id;
end;
$$;

revoke all on function public.redact_jsonb_identifiers(jsonb, uuid[]) from public, anon, authenticated;
revoke all on function public.delete_account_data(uuid) from public, anon, authenticated;
grant execute on function public.delete_account_data(uuid) to service_role;
