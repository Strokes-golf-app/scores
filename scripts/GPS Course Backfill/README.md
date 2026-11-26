# GPS course coordinate backfill

This script links existing scoring courses in Supabase's `courses` table to
OpenGolfAPI GPS records in `golf_courses`. It fills GPS coordinates and
`linked_course_id`; it does not change your scorecard course rows.

## Before you start

- Python 3 installed (no extra Python packages).
- Run the GPS schema SQL first: `sql-scripts/opengolfapi-course-maps.sql`.
- Find your Supabase Project URL and **service_role** key in Project Settings → API.
  Keep the service-role key private. Never commit it or put it in frontend code.

## Run on a Mac

1. Download/clone your repository and open Terminal.
2. Use `cd` to enter the repository folder (the one containing `package.json`).
3. Paste these commands, replacing the example values:

```bash
export SUPABASE_URL="https://YOUR-PROJECT.supabase.co"
export SUPABASE_SERVICE_ROLE_KEY="YOUR-SERVICE-ROLE-KEY"
python3 "scripts/GPS Course Backfill/backfill_gps_courses.py"
```

The first run is **preview-only**: it searches and prints matches but does not
write anything. Review the results. Ambiguous matches are skipped rather than
guessed.

If the matches look right, run:

```bash
python3 "scripts/GPS Course Backfill/backfill_gps_courses.py" --apply
```

It skips already-linked scoring courses and will not replace a GPS record
linked to a different scoring course. Run one copy at a time. The script waits
one second between searches to avoid making requests too quickly.

## Troubleshooting

- `python3: command not found`: install Python 3, then reopen Terminal.
- Missing environment values: run both `export` commands again in the same
  Terminal window; environment values do not carry over to a new window.
- `AMBIGUOUS` or `NOT FOUND`: skipped intentionally. Check the course name
  and location in Supabase before trying again.
- HTTP 429: API limit reached; wait for the daily reset before running again.
