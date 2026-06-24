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
