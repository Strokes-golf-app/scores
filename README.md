# Fairway Live

A live scorecard and leaderboard for golf rounds with friends. Each
player enters their own scores on their phone as they play; everyone
sees the leaderboard update in real time across Gross, Net (handicap),
Stableford, Skins, and Match play.

**New to this?** Start with [SETUP.md](./SETUP.md) — a step-by-step guide
written for zero prior coding experience, covering GitHub, Supabase, and
Vercel from scratch.

## How it works

- Plain HTML/CSS/JS — no build tools, nothing to compile.
- Hosted for free on **Vercel**, deployed straight from this **GitHub**
  repo.
- Live sync powered by **Supabase** (a Postgres database with built-in
  realtime updates) — see `supabase_schema.sql` for the data structure.

## Files

- `index.html` — page structure
- `assets/styles.css` — all visual design
- `assets/golf.js` — scoring math (gross, net, Stableford, skins, match
  play), kept separate from everything else
- `assets/app.js` — screen logic and Supabase calls
- `assets/supabase-config.js` — your project's connection details (see
  SETUP.md)
- `supabase_schema.sql` — run once in Supabase to create the database
  tables
