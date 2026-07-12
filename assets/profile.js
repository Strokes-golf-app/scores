'use strict';

/* ===========================================================
   profile.js — the "Manage profile" screen: lets a signed-in
   user edit the profile saved to their account (name, default
   handicap, and home city/state).

   Name and handicap reuse the SAME user_profiles columns the
   round-setup and lobby flows already read (display_name,
   default_handicap), so editing them here also changes what
   pre-fills when you start or join a round. City and state are
   stored in their own columns (added in the Stage 1 migration).

   Loads after history.js, before app.js. Functions stay global.
   Depends on: core.js (showScreen, showToast, parseHandicap),
   Supabase client.
=========================================================== */

// value = 2-letter code stored in user_profiles.state; label = shown text.
const US_STATES = [
  ['AL','Alabama'],['AK','Alaska'],['AZ','Arizona'],['AR','Arkansas'],
  ['CA','California'],['CO','Colorado'],['CT','Connecticut'],['DE','Delaware'],
  ['DC','District of Columbia'],['FL','Florida'],['GA','Georgia'],['HI','Hawaii'],
  ['ID','Idaho'],['IL','Illinois'],['IN','Indiana'],['IA','Iowa'],
  ['KS','Kansas'],['KY','Kentucky'],['LA','Louisiana'],['ME','Maine'],
  ['MD','Maryland'],['MA','Massachusetts'],['MI','Michigan'],['MN','Minnesota'],
  ['MS','Mississippi'],['MO','Missouri'],['MT','Montana'],['NE','Nebraska'],
  ['NV','Nevada'],['NH','New Hampshire'],['NJ','New Jersey'],['NM','New Mexico'],
  ['NY','New York'],['NC','North Carolina'],['ND','North Dakota'],['OH','Ohio'],
  ['OK','Oklahoma'],['OR','Oregon'],['PA','Pennsylvania'],['RI','Rhode Island'],
  ['SC','South Carolina'],['SD','South Dakota'],['TN','Tennessee'],['TX','Texas'],
  ['UT','Utah'],['VT','Vermont'],['VA','Virginia'],['WA','Washington'],
  ['WV','West Virginia'],['WI','Wisconsin'],['WY','Wyoming']
];

// Fills the state <select> once. Idempotent — the data-filled guard
// means calling it on every screen open never duplicates the options.
function populateProfileStateOptions() {
  const sel = document.getElementById('profile-state');
  if (!sel || sel.dataset.filled === 'true') return;
  US_STATES.forEach(([code, name]) => {
    const opt = document.createElement('option');
    opt.value = code;
    opt.textContent = name;
    sel.appendChild(opt);
  });
  sel.dataset.filled = 'true';
}

// Opens the profile screen, loading current values from user_profiles.
// Guests (anonymous sessions) have nothing durable to attach a profile
// to, so we send them back with a nudge to make an account.
async function openProfileScreen() {
  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user || user.is_anonymous) {
    showToast('Create an account to set up a profile');
    return;
  }

  populateProfileStateOptions();
  document.getElementById('profile-error').hidden = true;

  const { data: profile } = await supabaseClient
    .from('user_profiles')
    .select('display_name, default_handicap, city, state')
    .eq('id', user.id)
    .maybeSingle();

  document.getElementById('profile-name').value = profile?.display_name || '';
  document.getElementById('profile-handicap').value =
    (profile && profile.default_handicap != null) ? profile.default_handicap : '';
  document.getElementById('profile-city').value = profile?.city || '';
  document.getElementById('profile-state').value = profile?.state || '';

  showScreen('screen-profile');
}

// Saves the form back to user_profiles. Upsert (not update) so a row
// is created if one doesn't already exist — e.g. an older account from
// before profiles were introduced.
async function saveProfile(e) {
  e.preventDefault();
  const errorEl = document.getElementById('profile-error');
  errorEl.hidden = true;

  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user || user.is_anonymous) {
    showToast('Create an account to set up a profile');
    return;
  }

  const name = document.getElementById('profile-name').value.trim();
  if (!name) {
    errorEl.textContent = 'Please enter your name.';
    errorEl.hidden = false;
    return;
  }

  const hcpRaw = document.getElementById('profile-handicap').value;
  const handicap = hcpRaw === '' ? 0 : parseHandicap(hcpRaw);

  const city = document.getElementById('profile-city').value.trim() || null;
  const state = document.getElementById('profile-state').value || null;

  const { error } = await supabaseClient
    .from('user_profiles')
    .upsert({
      id: user.id,
      display_name: name,
      default_handicap: handicap,
      city,
      state,
    });

  if (error) {
    console.error(error);
    errorEl.textContent = 'Could not save — check your connection and try again.';
    errorEl.hidden = false;
    return;
  }

  showToast('Profile saved');
  await refreshDrawerName();
  showScreen('screen-home');
}

// Updates the name shown at the top of the home drawer (above the
// separator) to the signed-in user's display_name. Hidden for guests
// or before a name has been set.
async function refreshDrawerName() {
  const el = document.getElementById('drawer-user-name');
  if (!el) return;

  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user || user.is_anonymous) {
    el.textContent = '';
    el.hidden = true;
    return;
  }

  const { data: profile } = await supabaseClient
    .from('user_profiles')
    .select('display_name')
    .eq('id', user.id)
    .maybeSingle();

  const name = profile?.display_name || '';
  el.textContent = name;
  el.hidden = !name;
}
