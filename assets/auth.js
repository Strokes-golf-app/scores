'use strict';

/* ===========================================================
   auth.js — login, signup, email verification, password reset.
   Depends on: core.js (state, showToast, showScreen)
   Calls into: setup.js (resetSetupScreen), lobby.js (joinRound)
   when continuing a flow after auth succeeds.
=========================================================== */

function setAuthMode(mode) {
  state.authMode = mode;
  document.getElementById('auth-tab-login').classList.toggle('active', mode === 'login');
  document.getElementById('auth-tab-signup').classList.toggle('active', mode === 'signup');
  document.getElementById('auth-name-field').hidden = mode !== 'signup';
  document.getElementById('btn-auth-submit').querySelector('.btn-label').textContent =
    mode === 'signup' ? 'Create account' : 'Log in';
  document.getElementById('auth-error').hidden = true;
}

async function handleAuthSubmit(e) {
  e.preventDefault();
  const email = document.getElementById('auth-email').value.trim();
  const password = document.getElementById('auth-password').value;
  const errorEl = document.getElementById('auth-error');
  errorEl.hidden = true;

  if (state.authMode === 'signup') {
    const name = document.getElementById('auth-name-field').value.trim();
    if (!name) {
      errorEl.textContent = 'Please enter your name.';
      errorEl.hidden = false;
      return;
    }
   const { data, error } = await supabaseClient.auth.signUp({ email, password });
    if (error) {
      errorEl.textContent = error.message;
      errorEl.hidden = false;
      return;
    }
    // Stash the name so we can create the profile row after they verify
    // and log in for the first time (no session exists yet to do it now).
    state.pendingSignupName = name;
    // If they're signing up from a round invite, remember the code across
    // the email verification round-trip so we can rejoin them afterward.
    if (state.pendingJoinCode) savePendingJoin(state.pendingJoinCode);
    document.getElementById('verify-email-display').textContent = email;
    state.pendingVerifyEmail = email;
    document.getElementById('form-auth').reset();
    showScreen('screen-verify');
  } else {
    const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
    if (error) {
      if (error.message.toLowerCase().includes('email not confirmed')) {
        document.getElementById('verify-email-display').textContent = email;
        state.pendingVerifyEmail = email;
        showScreen('screen-verify');
        return;
      }
      errorEl.textContent = error.message;
      errorEl.hidden = false;
      return;
    }
    await afterAuthSuccess();
  }
}

async function afterAuthSuccess() {
  const { data: { user } } = await supabaseClient.auth.getUser();
  document.getElementById('auth-user-email').textContent = user ? user.email : '';
  document.getElementById('form-auth').reset();

  if (user) {
    const { data: existingProfile } = await supabaseClient
      .from('user_profiles')
      .select('id')
      .eq('id', user.id)
      .single();

    if (!existingProfile) {
      await supabaseClient.from('user_profiles').insert({
        id: user.id,
        display_name: state.pendingSignupName || user.email,
      });
    }
    state.pendingSignupName = null;
  }

  if (state.pendingJoinCode) {
    const code = state.pendingJoinCode;
    state.pendingJoinCode = null;
    showScreen('screen-home');
    joinRound(code);
    return;
  }

  await resetSetupScreen();
  showScreen('screen-home');
}

async function playAsGuest() {
  if (!state.pendingJoinCode) return;
  const code = state.pendingJoinCode;
  state.pendingJoinCode = null;
  const { error } = await supabaseClient.auth.signInAnonymously();
  if (error) {
    showToast('Could not start a guest session — check your connection');
    state.pendingJoinCode = code; // restore so they can try again
    return;
  }
  showScreen('screen-home');
  joinRound(code);
}

async function handleLogout() {
  await supabaseClient.auth.signOut();
  goHome();
  showScreen('screen-auth');
}

async function checkAuthOnLoad() {
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (session && session.user) {
    document.getElementById('auth-user-email').textContent = session.user.email;
    return true;
  }
  return false;
}
 async function handleResendVerify() {
  if (!state.pendingVerifyEmail) return;
  const { error } = await supabaseClient.auth.resend({
    type: 'signup',
    email: state.pendingVerifyEmail,
  });
  if (error) {
    showToast('Could not resend — try again shortly');
  } else {
    showToast('Verification email resent');
  }
}

async function handleForgotSubmit(e) {
  e.preventDefault();
  const email = document.getElementById('forgot-email').value.trim();
  const errorEl = document.getElementById('forgot-error');
  errorEl.hidden = true;

  const { error } = await supabaseClient.auth.resetPasswordForEmail(email, {
    redirectTo: window.location.origin,
  });

  if (error) {
    errorEl.textContent = error.message;
    errorEl.hidden = false;
    return;
  }
  document.getElementById('form-forgot').reset();
  showToast('Reset link sent — check your email');
  showScreen('screen-auth');
}

async function handleResetPasswordSubmit(e) {
  e.preventDefault();
  const newPassword = document.getElementById('reset-password-new').value;
  const errorEl = document.getElementById('reset-password-error');
  errorEl.hidden = true;

  const { error } = await supabaseClient.auth.updateUser({ password: newPassword });

  if (error) {
    errorEl.textContent = error.message;
    errorEl.hidden = false;
    return;
  }
  document.getElementById('form-reset-password').reset();
  showToast('Password updated — you can log in now');
  await supabaseClient.auth.signOut();
  showScreen('screen-auth');
}
