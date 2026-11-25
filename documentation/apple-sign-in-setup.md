# Apple sign-in setup

Apple sign-in is enabled for the iOS app: `APPLE_SIGN_IN_ENABLED` is
`true` and the App target carries the Sign in with Apple entitlement
(`ios/App/App/App.entitlements`, wired up via `CODE_SIGN_ENTITLEMENTS`).
Web sign-in stays hidden until a real Services ID replaces the
placeholder. Sign-in only succeeds once the Apple provider is enabled in
Supabase (see below).

## What is already in the repository

- `assets/auth.js` requests Apple ID tokens on web and iOS, generates and
  validates a nonce through Supabase, and continues through the shared
  account/profile flow.
- `@capawesome/capacitor-apple-sign-in` is in `package.json` and the iOS
  Swift package.
- Both sign-in screens have Apple buttons. They stay hidden while
  `APPLE_SIGN_IN_ENABLED` is `false`; web also requires a real Services ID.
- The Services ID value is currently the safe placeholder
  `REPLACE_WITH_APPLE_SERVICES_ID`.

No Apple credentials, signing keys, or developer-specific identifiers should
be committed to the repository.

## Steps that require an Apple Developer account

1. Enroll in the Apple Developer Program and make sure the account can manage
   the app's identifiers and signing.
2. In Certificates, Identifiers & Profiles, open the app identifier
   `com.strokesgolf.app` and enable **Sign in with Apple**. Save the change.
3. In Xcode, open `ios/App/App.xcodeproj`, select the **App** target, and add
   **Sign in with Apple** under **Signing & Capabilities**. Use automatic
   signing with the correct developer team and let Xcode refresh the
   provisioning profile. This capability must be present in the signed iOS
   app for the native plugin flow to work.
4. For web sign-in, create a **Services ID** (for example,
   `com.strokesgolf.app.web`) and configure it for Sign in with Apple using
   the app identifier above as its primary App ID.
5. Add each actual web origin used for sign-in to the Services ID's domain
   and return URL configuration. The current web implementation sends
   `window.location.origin` as Apple's `redirectURI`, so the registered
   return URL must match the deployed app's origin exactly (scheme and host;
   this implementation does not include a path). Add staging separately if
   it will be used for testing.
6. If Supabase requires a Sign in with Apple client secret for the enabled
   provider configuration, create an Apple Sign in private key and the
   corresponding client secret as directed by the current Supabase and Apple
   setup screens. Store the key/secret only in Supabase's provider settings;
   never put them in browser code or commit them. Track the secret's expiry
   and rotate it before it expires.

The exact Apple and Supabase dashboard labels can change. Follow the current
provider setup pages and use the app identifier and Services ID above in the
appropriate fields.

## Supabase setup

1. In the Supabase Dashboard, open **Authentication → Sign In / Providers**
   (the menu label may vary) and enable **Apple**.
2. Configure the provider to accept both app audiences:
   - iOS bundle ID: `com.strokesgolf.app`
   - Web Services ID: the Services ID created above
3. Add any Apple client secret or signing-key material required by the
   dashboard. Keep it server-side in Supabase; it is not an app setting.
4. Confirm the provider is enabled for the same Supabase project used by the
   app. The current code exchanges Apple ID tokens with
   `supabaseClient.auth.signInWithIdToken()`; it does not use a Supabase OAuth
   redirect flow for Apple.

## Enable the app buttons

After Apple and Supabase are configured:

1. Replace `APPLE_SERVICES_ID` in `assets/auth.js` with the actual web
   Services ID. The native flow uses the iOS bundle ID and entitlement
   instead.
2. Set `APPLE_SIGN_IN_ENABLED` in `assets/auth.js` to `true`. The web button
   remains hidden if the Services ID is still the placeholder.
3. Run `npm run sync:ios` so the iOS `www` assets match the source, then
   build and sign the iOS app in Xcode.
4. Deploy the updated web app and submit a new iOS build before considering
   Apple sign-in available to users.

Do not enable the flag just to reveal the buttons: Apple, Supabase, and iOS
signing must all be configured first.

## Verification before release

- Test a new Apple account and an existing Apple account on both web and a
  signed iOS build.
- Test dismissing/cancelling the Apple sheet and retrying.
- Confirm Apple private-relay email addresses work for account and support
  flows. Apple may provide the user's name only on their first authorization;
  verify the existing profile onboarding fallback is usable.
- Test invited-round signup as well as ordinary signup.
- Confirm the Supabase user/profile is created once and returning sign-in
  reaches the existing account.
- Decide and test how existing Google accounts should be linked. Do not
  assume two provider identities are the same account solely because their
  email addresses look alike.
- Verify account deletion works for an Apple-authenticated account.
- Update `privacy.html` and the App Store privacy disclosures to describe
  Apple sign-in and the account information it provides before enabling
  sign-in in a public release.

Because Google sign-in is already offered, confirm the current App Store
Review Guidelines' equivalent-sign-in requirement and any applicable
exceptions before submission.
