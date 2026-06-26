# Stokes Golf

A live scorecard and leaderboard for golf rounds with friends. Each
player enters their own scores on their phone as they play; everyone
sees the leaderboard update in real time across Gross, Net (handicap),
Stableford, Skins, and Match play.

**New to this?** Start with [SETUP.md](./SETUP.md) — a step-by-step guide
written for zero prior coding experience, covering GitHub, Supabase, and
Vercel from scratch.

## How it works

- Plain HTML/CSS/JS — no build tools, no bundling.
- Hosted on **Vercel** and backed by **Supabase** for Postgres storage and
  realtime updates.
- The app stores player handicaps as decimal values with one-place
  precision, so inputs like `10.2` are preserved and used consistently in
  scoring and UI display.
- `assets/golf.js` contains the scoring math, while the rest of the app
  handles screens, data syncing, and user interaction.

## Code structure

- `index.html` — application shell, screens, and markup.
- `assets/styles.css` — layout, responsive design, and visual styling.
- `assets/supabase-config.js` — Supabase client setup and project keys.
- `assets/core.js` — shared helpers, state management, and utility functions.
- `assets/auth.js` — login/signup flow, account creation, and profile handling.
- `assets/setup.js` — new round creation, player setup, pars, and game modes.
- `assets/lobby.js` — join rounds, add players, and show the pre-round lobby.
- `assets/round.js` — round state loading, realtime subscriptions, scorecard
  entry, and leaderboard rendering.
- `assets/golf.js` — pure golf scoring logic: handicap strokes, net scores,
  Stableford points, rankings, and summaries.
- `supabase_schema.sql` — defines the database tables, realtime publication,
  and row-level security for Supabase.

## Key details

- Player handicap values are parsed with `parseHandicap()` to one decimal
  place and clamped to the valid range `0–54`.
- `players.handicap` is stored as `numeric(4,1)` in the database to retain
  decimal precision.
- The app uses Supabase realtime events on `rounds`, `players`, and
  `scores` so leaderboard updates propagate without page refreshes.
- Each hole score is stored as its own row in `scores`, which keeps
  updates lightweight and conflict-free.
- On signup, user profile data is saved to `user_profiles`, including a
  default handicap for future rounds.
