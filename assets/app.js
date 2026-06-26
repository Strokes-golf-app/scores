'use strict';

/* ===========================================================
   app.js — wires up DOM events to the functions defined in
   core.js, auth.js, setup.js, lobby.js, and round.js, and
   handles initial page load (resuming a session, deep links,
   password-recovery links).

   This file should stay short. If you find yourself adding
   real logic here instead of an addEventListener call, it
   probably belongs in one of the other files instead.
=========================================================== */

function init() {
  setAuthMode('login');

  document.getElementById('btn-new-round').addEventListener('click', async () => {
    await resetSetupScreen();
    showScreen('screen-setup');
  });

  document.getElementById('form-join').addEventListener('submit', e => {
    e.preventDefault();
    joinRound(document.getElementById('join-code').value);
  });

  document.getElementById('btn-setup-back').addEventListener('click', () => showScreen('screen-home'));

  document.getElementById('hole-count').addEventListener('change', renderParGrid);

  document.getElementById('btn-add-player').addEventListener('click', () => {
    state.setupPlayers.push({ id: uid('p'), name: '', handicap: 0 });
    renderSetupPlayerList();
  });

  document.querySelectorAll('#mode-grid input[name="mode"]').forEach(cb => {
    cb.addEventListener('change', () => {
      document.getElementById('match-players-field').hidden = !document.getElementById('mode-grid').querySelector('input[value="match"]').checked;
      cb.closest('.mode-card').classList.toggle('checked', cb.checked);
    });
  });

  document.getElementById('btn-create-round').addEventListener('click', createRound);

  document.getElementById('btn-lobby-leave').addEventListener('click', goHome);
  document.getElementById('btn-copy-code').addEventListener('click', async () => {
    const link = makeJoinLink(state.roundCode);
    try {
      await navigator.clipboard.writeText(link);
      showToast('Join link copied');
    } catch (e) {
      showToast(`Your code: ${state.roundCode}`);
    }
  });
  document.getElementById('btn-lobby-add-player').addEventListener('click', () => {
    addPlayerToRound(state.roundId);
  });
  document.getElementById('btn-start-round').addEventListener('click', async () => {
    if (!state.round || state.round.players.length === 0) {
      showToast('Add at least one player before starting');
      return;
    }
    if (!state.myPlayerId) {
      showToast('Tap a player below to identify yourself first');
      renderIdentifyList(state.round);
      showScreen('screen-identify');
      return;
    }
    const { error } = await supabaseClient.from('rounds').update({ started: true }).eq('id', state.roundId);
    if (error) {
      showToast('Could not start round — check your connection');
      return;
    }
    await loadRound(state.roundId);
    enterRound();
  });

  document.getElementById('btn-identify-back').addEventListener('click', goHome);
  document.getElementById('btn-identify-add-self').addEventListener('click', async () => {
    const id = await addPlayerToRound(state.roundId);
    if (id) selectIdentity(id);
  });

  document.getElementById('btn-round-leave').addEventListener('click', goHome);
  document.getElementById('btn-round-share').addEventListener('click', async () => {
    const link = makeJoinLink(state.roundCode);
    try {
      await navigator.clipboard.writeText(link);
      showToast('Join link copied');
    } catch (e) {
      showToast('Round code: ' + state.roundCode);
    }
  });

  document.querySelectorAll('.tab').forEach(t => {
    t.addEventListener('click', () => setTab(t.dataset.tab));
  });

  document.getElementById('btn-hole-prev').addEventListener('click', () => {
    state.currentHole = Math.max(1, state.currentHole - 1);
    document.getElementById('par-editor').hidden = true;
    renderScorecardTab();
  });
  document.getElementById('btn-hole-next').addEventListener('click', () => {
    state.currentHole = Math.min(state.round.holeCount, state.currentHole + 1);
    document.getElementById('par-editor').hidden = true;
    renderScorecardTab();
  });

  document.getElementById('btn-par-toggle').addEventListener('click', () => {
    const el = document.getElementById('par-editor');
    el.hidden = !el.hidden;
  });
  document.getElementById('btn-par-save').addEventListener('click', savePar);

  document.getElementById('scoring-for-select').addEventListener('change', e => {
    state.scoringPlayerId = e.target.value;
    state.currentHole = nextUnplayedHole(scoringPlayer(), state.round.holeCount);
    document.getElementById('par-editor').hidden = true;
    renderScorecardTab();
  });

  document.getElementById('btn-stroke-minus').addEventListener('click', () => setStroke(-1));
  document.getElementById('btn-stroke-plus').addEventListener('click', () => setStroke(1));

  document.getElementById('auth-tab-login').addEventListener('click', () => setAuthMode('login'));
  document.getElementById('auth-tab-signup').addEventListener('click', () => setAuthMode('signup'));
  document.getElementById('form-auth').addEventListener('submit', handleAuthSubmit);
  document.getElementById('btn-logout').addEventListener('click', handleLogout);

  document.getElementById('btn-resend-verify').addEventListener('click', handleResendVerify);
  document.getElementById('btn-verify-back').addEventListener('click', () => showScreen('screen-auth'));

  document.getElementById('btn-forgot-password').addEventListener('click', () => showScreen('screen-forgot'));
  document.getElementById('btn-forgot-back').addEventListener('click', () => showScreen('screen-auth'));
  document.getElementById('form-forgot').addEventListener('submit', handleForgotSubmit);

  document.getElementById('form-reset-password').addEventListener('submit', handleResetPasswordSubmit);

  // If this load is from a password-reset email link, Supabase fires this
  // event once the recovery token in the URL has been processed.
  supabaseClient.auth.onAuthStateChange((event) => {
    if (event === 'PASSWORD_RECOVERY') {
      showScreen('screen-reset-password');
    }
  });

  // Pull a round code out of a deep link like ?code=AB3K7, if present.
  const urlParams = new URLSearchParams(window.location.search);
  const codeFromUrl = urlParams.get('code');

  // If this is a password-recovery link, the URL hash will contain
  // "type=recovery". Catch this BEFORE normal login routing runs, so
  // it always wins over the home/resume logic below.
  const isRecoveryLink = window.location.hash.includes('type=recovery');

  checkAuthOnLoad().then(async isLoggedIn => {
    if (isRecoveryLink) {
      showScreen('screen-reset-password');
      return;
    }
    if (!isLoggedIn) {
      if (codeFromUrl) {
        const { error } = await supabaseClient.auth.signInAnonymously();
        if (error) {
          showToast('Could not start a guest session — check your connection');
          showScreen('screen-auth');
          return;
        }
        showScreen('screen-home');
        joinRound(codeFromUrl);
        return;
      }
      showScreen('screen-auth');
      return;
    }

    if (codeFromUrl) {
      showScreen('screen-home');
      joinRound(codeFromUrl);
      return;
    }

    const session = loadSession();
    if (session && session.roundCode) {
      resumeSession(session);
    } else {
      await resetSetupScreen();
      showScreen('screen-home');
    }
  });
}

document.addEventListener('DOMContentLoaded', init);
