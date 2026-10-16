# Account deletion rollout

The account deletion flow is implemented in the app, Supabase SQL, and the
`delete-account` Edge Function. Do not enable it in production until the SQL
change and Edge Function are both deployed and the complete flow has passed
against a staging Supabase project.

## Deletion behavior

- Hosted active rounds and their players and scores are deleted.
- A non-host's active-round player and score rows are deleted. Their IDs are
  removed from team, match, and tournament configuration.
- Completed rounds remain, but the deleted account is removed from participant
  IDs and identity-bearing snapshots. Their player and score snapshots are
  removed, leaving other participants' results available.
- The profile and friendship relationships are deleted.
- User-created courses remain in the shared library with `user_id` set to null.
- User-linked course API usage and round lookup attempts are deleted.
- The Supabase Auth user is deleted after the database cleanup succeeds.
- The cleanup RPC is callable only with the server-side service role; the Edge
  Function verifies the signed-in caller and supplies the verified user ID.

## Deployment

1. Back up the staging database and apply
   [`../sql-scripts/account-deletion.sql`](../sql-scripts/account-deletion.sql)
   to staging. This is a migration; do not drop/recreate production tables or
   rerun the complete schema to deploy this change.
2. Deploy `edge-functions/delete-account/index.ts` as the Supabase Edge
   Function named `delete-account`.
3. Confirm the function has `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and
   `SUPABASE_SERVICE_ROLE_KEY` configured as server-side secrets. Configure
   `APP_ORIGIN` (or `SITE_URL` / `WEBAPP_URL`) for the production web origin.
   Never expose the service-role key to the app.
4. Publish the updated web app and synchronize the iOS web assets through the
   existing `npm run sync:ios` workflow.

## Staging verification

Use disposable accounts and courses. Verify each scenario with direct database
queries as well as the app:

1. Deleting a host removes their live round and all associated players/scores.
2. Deleting a non-host removes only their live player/scores and references
   from match and tournament configuration; other players' round data remains.
3. Deleting a participant removes their identity, player snapshot, scoreline,
   and participant ID from completed history while preserving the round and
   other players' results.
4. Deleting an account clears profile and friendships and leaves their courses
   available with no owner.
5. Missing/invalid tokens and anonymous sessions cannot delete accounts; a
   direct client call to the cleanup RPC is denied for both anon and
   authenticated roles.
6. A cleanup failure does not delete the Auth user; an Auth deletion failure is
   reported as incomplete and can be retried by the still-authenticated user.
7. The app requires explicit confirmation, reports failures, clears the local
   session after success, and returns to the sign-in screen.

## Remaining compliance work

Account deletion code does not by itself complete App Store compliance. Before
submission, deploy the static `privacy.html` page and confirm its production
URL (the App Store Privacy Policy URL should be
`https://<production-domain>/privacy.html`). The policy's retention and
deletion statements must match the behavior above and the hosting provider's
backup-retention practices. Terms of Use are not planned for the current
United States launch. Complete App Privacy disclosures from actual production
data flows before submitting.
