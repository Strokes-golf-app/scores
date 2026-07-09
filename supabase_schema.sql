-- ===========================================================
-- Fairway Live — Supabase schema
-- ---------------------------------------------------------
-- Run this once in the Supabase SQL Editor (see SETUP.md for
-- exact steps). It creates three tables and turns on realtime
-- sync for them, which is what makes the live leaderboard work
-- across everyone's devices.
-- ===========================================================

-- ---------- rounds ----------
-- One row per round. "code" is the short, human-typeable code
-- players use to join (e.g. "K7F2P"). It's the public identifier;
-- "id" is an internal uuid used for foreign keys.
create table if not exists rounds (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  course_name text not null,
  hole_count int not null check (hole_count in (9, 18)),
  pars int[] not null,
  modes text[] not null default array['gross'],
  match_player_a uuid,
  match_player_b uuid,
  host_player_id uuid,
  started boolean not null default false,
  ended boolean not null default false,
  created_at timestamptz not null default now()
);

-- ---------- players ----------
-- One row per player in a round.
create table if not exists players (
  id uuid primary key default gen_random_uuid(),
  round_id uuid not null references rounds(id) on delete cascade,
  name text not null,
  handicap numeric(4,1) not null default 0,
  created_at timestamptz not null default now()
);

-- ---------- scores ----------
-- One row per (player, hole). Updating a single hole only touches
-- one small row, which is what makes live entry fast and avoids
-- conflicts between players entering scores at the same time.
create table if not exists scores (
  id uuid primary key default gen_random_uuid(),
  player_id uuid not null references players(id) on delete cascade,
  hole int not null,
  strokes int not null check (strokes between 1 and 15),
  updated_at timestamptz not null default now(),
  unique (player_id, hole)
);

-- ---------- indexes ----------
-- Speeds up the lookups the app does constantly: "give me all
-- players for this round" and "give me all scores for this player."
create index if not exists idx_players_round_id on players(round_id);
create index if not exists idx_scores_player_id on scores(player_id);

-- ---------- api usage ----------
-- One row per app-wide daily usage bucket. The edge functions share
-- this counter so the app stops calling the third-party API after
-- the 50-call daily limit is reached.
create table if not exists api_usage (
  id uuid primary key default gen_random_uuid(),
  usage_key text not null default 'app-wide',
  date text not null,
  call_count int not null default 0,
  updated_at timestamptz not null default now(),
  unique (usage_key, date)
);

create index if not exists idx_api_usage_usage_date on api_usage(usage_key, date);

-- For existing Supabase projects that already have an api_usage table,
-- run this block to align it with the app-wide daily counter design.
alter table if exists api_usage
  add column if not exists usage_key text not null default 'app-wide',
  add column if not exists call_count int not null default 0,
  add column if not exists updated_at timestamptz not null default now();

-- Older versions of the table may still require a user_id value even though
-- the new app-wide design no longer uses it.
do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_name = 'api_usage' and column_name = 'user_id'
  ) then
    alter table api_usage alter column user_id drop not null;
  end if;
end $$;

update api_usage
set usage_key = coalesce(usage_key, 'app-wide'),
    call_count = coalesce(call_count, 0),
    updated_at = coalesce(updated_at, now())
where usage_key is null or call_count is null or updated_at is null;

-- Collapse duplicate rows for the same usage scope and day so the
-- new uniqueness constraint can be created safely.
with ranked as (
  select id,
         row_number() over (
           partition by usage_key, date
           order by updated_at desc, id desc
         ) as rn
  from api_usage
)
delete from api_usage
where id in (
  select id from ranked where rn > 1
);

-- Add the unique constraint first, then use it for upserts.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'api_usage_usage_key_date_key'
  ) then
    alter table api_usage
      add constraint api_usage_usage_key_date_key unique (usage_key, date);
  end if;
end $$;

-- Rebuild the daily usage row so the app-wide counter remains a single row per day.
insert into api_usage (usage_key, date, call_count, updated_at)
select usage_key, date, sum(call_count) as call_count, max(updated_at) as updated_at
from api_usage
group by usage_key, date
on conflict (usage_key, date) do update
set call_count = api_usage.call_count + excluded.call_count,
    updated_at = greatest(api_usage.updated_at, excluded.updated_at);

-- ---------- realtime ----------
-- Tells Supabase to broadcast row-level changes on these tables
-- to any connected client subscribed to them. This is the
-- mechanism that makes the leaderboard update live on everyone's
-- screen without anyone refreshing.
alter publication supabase_realtime add table rounds;
alter publication supabase_realtime add table players;
alter publication supabase_realtime add table scores;

-- ---------- row-level security ----------
-- Supabase requires RLS to be explicitly enabled and given policies,
-- or the table is unreadable/unwritable by the public anon key the
-- browser uses. Since this app has no login system (anyone with a
-- round code can read/write that round, matching how the Firebase
-- version worked), we open these tables to anyone holding the
-- public anon key. That key is meant to be public — it's not a
-- secret — so this is equivalent in spirit to the Firebase rules
-- used before.
alter table rounds enable row level security;
alter table players enable row level security;
alter table scores enable row level security;

create policy "anyone can read rounds" on rounds for select using (true);
create policy "anyone can create rounds" on rounds for insert with check (true);
create policy "anyone can update rounds" on rounds for update using (true);

create policy "anyone can read players" on players for select using (true);
create policy "anyone can create players" on players for insert with check (true);
create policy "anyone can update players" on players for update using (true);

create policy "anyone can read scores" on scores for select using (true);
create policy "anyone can create scores" on scores for insert with check (true);
create policy "anyone can update scores" on scores for update using (true);
