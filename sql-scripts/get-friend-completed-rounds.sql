-- ===========================================================
-- get_friend_completed_rounds — let an accepted friend read
-- another friend's full completed-round history.
-- ---------------------------------------------------------
-- Run this once in the Supabase SQL Editor. Safe to re-run.
--
-- Powers the friend-rounds screen (assets/friend-rounds.js).
-- The `completed_rounds` RLS SELECT policy is
-- `auth.uid() = ANY(participant_user_ids)`, so a plain client
-- query only ever returns rounds the caller played in. That
-- covers "Rounds with me" but not "All rounds" — rounds the
-- friend played that the caller wasn't in.
--
-- This SECURITY DEFINER function bypasses that policy, but only
-- returns rows when the caller and p_friend_id are accepted
-- friends (mirroring get_my_friends' friendship check). A
-- non-friend id returns nothing.
-- ===========================================================

create or replace function public.get_friend_completed_rounds(p_friend_id uuid)
returns setof public.completed_rounds
language sql
security definer
set search_path to 'public'
as $$
  select cr.*
  from public.completed_rounds cr
  where exists (
    select 1 from public.friendships f
    where f.status = 'accepted'
      and ((f.requester_id = auth.uid() and f.addressee_id = p_friend_id)
        or (f.requester_id = p_friend_id and f.addressee_id = auth.uid()))
  )
    and p_friend_id = any(cr.participant_user_ids)
  order by cr.ended_at desc;
$$;

grant execute on function public.get_friend_completed_rounds(uuid) to authenticated;
