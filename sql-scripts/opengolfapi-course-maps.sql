-- ===========================================================
-- GPS yardages + course-layout maps (OpenGolfAPI integration)
-- ---------------------------------------------------------
-- Run this once in the Supabase SQL Editor. Safe to re-run.
--
-- Adds two new, independent tables:
--   - golf_courses: one row per OpenGolfAPI course we've imported
--   - golf_course_features: the GeoJSON geometry (greens, bunkers,
--     fairways, etc.) for an imported course
-- This does NOT touch the existing `courses` table (the scoring
-- library, sourced from golfcourseapi.com) or `api_usage` — quota
-- tracking reuses the existing consume_course_api_quota RPC unchanged,
-- with a new usage_key value ("opengolfapi") passed in from the edge
-- functions at call time. No schema change needed for quota itself.
-- ===========================================================

-- ---------- golf_courses (OpenGolfAPI import cache) ----------
-- Independent of `courses`: `courses` is the shared scoring library
-- (manual entry or golfcourseapi.com import) used to run a round's
-- scorecard. `golf_courses` is a separate cache, keyed by OpenGolfAPI's
-- own opaque UUID, backing the GPS/map feature only. The two are
-- intentionally not the same row — different third-party APIs,
-- different ID namespaces.
create table if not exists public.golf_courses (
  id uuid primary key default gen_random_uuid(),
  external_id text not null unique,
  linked_course_id uuid references public.courses(id) on delete set null,
  course_name text,
  club_name text,
  city text,
  state text,
  country_iso text,
  lat double precision check (lat is null or lat between -90 and 90),
  lng double precision check (lng is null or lng between -180 and 180),
  type text,
  par int,
  holes int,
  yardage int,
  timezone text,
  architect text,
  year_built int,
  description text,
  description_source jsonb, -- {name, url, title, license} object, not plain text
  fairway_grass text,
  green_grass text,
  phone text,
  website text,
  address text,
  postal_code text,
  facilities jsonb,
  ratings jsonb,
  sources jsonb,
  tees jsonb,
  holes_data jsonb,
  climate jsonb,
  nearby jsonb,
  pricing jsonb,
  booking_link text,
  insights jsonb,
  fetched_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists idx_golf_courses_fetched_at on public.golf_courses(fetched_at);

-- ---------- golf_course_features (OpenGolfAPI /features geometry) ----------
create table if not exists public.golf_course_features (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.golf_courses(id) on delete cascade,
  external_feature_id text,
  feature_type text not null check (feature_type in (
    'bunker', 'tee', 'cart_path', 'green', 'rough', 'fairway', 'creek', 'tree',
    'tree_cluster', 'hole_line', 'water_hazard', 'driving_range', 'pin'
    -- 'bridge' intentionally omitted — a confirmed OSM-classifier false
    -- positive, swept in a real public road bridge, not golf infrastructure.
  )),
  hole int check (hole is null or hole between 1 and 36),
  geometry jsonb not null,
  center jsonb,
  tags text[],
  confidence numeric,
  source text,
  license text,
  is_approximate boolean not null default false,
  fetched_at timestamptz not null default now()
);
create index if not exists idx_golf_course_features_course_id on public.golf_course_features(course_id);
create index if not exists idx_golf_course_features_course_hole on public.golf_course_features(course_id, hole);

-- ===========================================================
-- Atomic "replace all features for a course" RPC
-- ---------------------------------------------------------
-- Called only from import-course.ts, with the service_role key.
-- ===========================================================
create or replace function public.replace_golf_course_features(p_course_id uuid, p_features jsonb)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $$
begin
  delete from public.golf_course_features where course_id = p_course_id;

  insert into public.golf_course_features (
    course_id, external_feature_id, feature_type, hole, geometry, center,
    tags, confidence, source, license, is_approximate
  )
  select
    p_course_id,
    f->>'external_feature_id',
    f->>'feature_type',
    (f->>'hole')::int,
    f->'geometry',
    f->'center',
    case when jsonb_typeof(f->'tags') = 'array'
      then array(select jsonb_array_elements_text(f->'tags')) else null end,
    (f->>'confidence')::numeric,
    f->>'source',
    f->>'license',
    coalesce((f->>'is_approximate')::boolean, false)
  from jsonb_array_elements(p_features) as f;
end;
$$;

revoke execute on function public.replace_golf_course_features(uuid, jsonb) from anon, authenticated;

-- ===========================================================
-- Row-level security
-- ---------------------------------------------------------
-- Clients get read-only SELECT (the local-cache-first search tier and
-- the map renderer both query these tables directly). No write
-- policies at all — only the import-course Edge Function writes, using
-- the service_role key, which bypasses RLS entirely. RLS is still
-- enabled as a deny-by-default safety net either way.
-- ===========================================================
alter table public.golf_courses enable row level security;
alter table public.golf_course_features enable row level security;

drop policy if exists "any logged-in user can read golf_courses" on public.golf_courses;
drop policy if exists "any logged-in user can read golf_course_features" on public.golf_course_features;

create policy "any logged-in user can read golf_courses" on golf_courses
  for select using (auth.role() = 'authenticated');
create policy "any logged-in user can read golf_course_features" on golf_course_features
  for select using (auth.role() = 'authenticated');
