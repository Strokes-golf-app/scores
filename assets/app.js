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

  if (typeof initializeSetupCourseSearch === 'function') {
    initializeSetupCourseSearch();
  }

  document.getElementById('btn-new-round').addEventListener('click', async () => {
    await resetSetupScreen();
    showScreen('screen-setup');
  });

  document.getElementById('btn-course-upload-back').addEventListener('click', () => showScreen('screen-home'));
  document.getElementById('course-hole-count').addEventListener('change', renderCourseHoleGrid);
  document.getElementById('btn-save-course').addEventListener('click', saveCourse);
  document.getElementById('btn-save-course-start-round').addEventListener('click', saveCourseAndStartRound);

  document.getElementById('btn-manage-courses').addEventListener('click', async () => {
    await renderCourseManageList();
    showScreen('screen-course-manage');
  });
  document.getElementById('btn-course-manage-back').addEventListener('click', () => showScreen('screen-home'));

  document.getElementById('btn-manage-profile').addEventListener('click', openProfileScreen);
  document.getElementById('btn-profile-back').addEventListener('click', () => showScreen('screen-home'));
  document.getElementById('form-profile').addEventListener('submit', saveProfile);
  document.getElementById('btn-manage-add-course').addEventListener('click', async () => {
    await resetCourseUploadScreen();
    showScreen('screen-course-upload');
  });
  document.getElementById('btn-course-detail-back').addEventListener('click', () => showScreen('screen-course-manage'));

  document.getElementById('form-join').addEventListener('submit', e => {
    e.preventDefault();
    joinRound(document.getElementById('join-code').value);
  });

  document.getElementById('btn-setup-back').addEventListener('click', () => showScreen('screen-home'));

  document.getElementById('hole-count').addEventListener('change', () => {
    const course = state.selectedFullCourse;
    const isSavedCourse = course && (state.myCourses || []).some(c => c.id === course.id);
    if (isSavedCourse) {
      applySelectedCourse(course.id);
    } else {
      renderParGrid();
    }
  });

  document.getElementById('btn-nine-front').addEventListener('click', () => selectCourseNine('front'));
  document.getElementById('btn-nine-back').addEventListener('click', () => selectCourseNine('back'));

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

  document.getElementById('bets-enabled').addEventListener('change', e => {
    state.setupBetsEnabled = e.target.checked;
    document.getElementById('set-stakes-field').hidden = !e.target.checked;
  });
  document.getElementById('btn-set-stakes').addEventListener('click', () => openStakesScreen('setup'));
  document.getElementById('btn-stakes-back').addEventListener('click', () => {
    showScreen(state.stakesContext === 'lobby' ? 'screen-lobby' : 'screen-setup');
  });
  document.getElementById('btn-stakes-save').addEventListener('click', saveStakesScreen);

  // Stakes rows are rebuilt on each open, so delegate the info-link taps
  // to the stable container.
  document.getElementById('stakes-list').addEventListener('click', (e) => {
    const link = e.target.closest('.stakes-info-link');
    if (link) openBetInfo(link.dataset.mode);
  });
  document.getElementById('btn-bet-info-close').addEventListener('click', closeBetInfo);
  document.getElementById('bet-info-modal').addEventListener('click', (e) => {
    if (e.target.id === 'bet-info-modal') closeBetInfo();
  });

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
  document.getElementById('btn-edit-stakes').addEventListener('click', () => openStakesScreen('lobby'));
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
  document.getElementById('btn-close-hole15-reminder').addEventListener('click', hideFifteenthHoleReminder);

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
  document.getElementById('btn-end-round').addEventListener('click', endRound);

  document.getElementById('auth-tab-login').addEventListener('click', () => setAuthMode('login'));
  document.getElementById('auth-tab-signup').addEventListener('click', () => setAuthMode('signup'));
  document.getElementById('form-auth').addEventListener('submit', handleAuthSubmit);
  document.getElementById('btn-logout').addEventListener('click', handleLogout);

  // ----- Home sidebar drawer -----
  const appDrawer = document.getElementById('app-drawer');
  const drawerOverlay = document.getElementById('drawer-overlay');
  function openDrawer() {
    appDrawer.classList.add('open');
    drawerOverlay.classList.add('open');
    appDrawer.setAttribute('aria-hidden', 'false');
  }
  function closeDrawer() {
    appDrawer.classList.remove('open');
    drawerOverlay.classList.remove('open');
    appDrawer.setAttribute('aria-hidden', 'true');
  }
  document.getElementById('btn-open-drawer').addEventListener('click', openDrawer);
  drawerOverlay.addEventListener('click', closeDrawer);
  // Any drawer item closes the drawer; its own handler still fires.
  appDrawer.addEventListener('click', (e) => {
    if (e.target.closest('.drawer-item')) closeDrawer();
  });

  document.getElementById('btn-round-history').addEventListener('click', openRoundHistory);
  document.getElementById('btn-history-back').addEventListener('click', () => showScreen('screen-home'));
  document.getElementById('btn-history-detail-back').addEventListener('click', () => showScreen('screen-history'));

  document.getElementById('btn-resend-verify').addEventListener('click', handleResendVerify);
  document.getElementById('btn-verify-back').addEventListener('click', () => showScreen('screen-auth'));

  document.getElementById('btn-forgot-password').addEventListener('click', () => showScreen('screen-forgot'));
  document.getElementById('btn-forgot-back').addEventListener('click', () => showScreen('screen-auth'));
  document.getElementById('form-forgot').addEventListener('submit', handleForgotSubmit);

  document.getElementById('btn-join-signup').addEventListener('click', () => {
    setAuthMode('signup');
    showScreen('screen-auth');
  });
  document.getElementById('btn-join-login').addEventListener('click', () => {
    setAuthMode('login');
    showScreen('screen-auth');
  });
  document.getElementById('btn-join-guest').addEventListener('click', playAsGuest);

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
        state.pendingJoinCode = codeFromUrl.toUpperCase();
        showScreen('screen-join-options');
        return;
      }
      showScreen('screen-auth');
      return;
    }

    // If we're already a member of a round on this device, resume it —
    // even though the URL still carries the ?code= we joined through.
    // Without this, a mid-round refresh re-runs the join flow and dumps us
    // on the identify screen, where our own name reads "Already joined" and
    // can't be re-selected. Resume wins unless the URL code is for a
    // *different* round, and unless a pending email-invite join is waiting.
    const resumable = loadSession();
    if (!loadPendingJoin() && resumable && resumable.roundCode &&
        (!codeFromUrl || codeFromUrl.toUpperCase() === resumable.roundCode)) {
      resumeSession(resumable);
      return;
    }

    if (codeFromUrl) {
      showScreen('screen-home');
      joinRound(codeFromUrl);
      return;
    }

    // Returning from email verification after signing up via an invite:
    // the round code was stashed before the email round-trip. Consume it
    // and drop them straight into that round.
    const pendingJoin = loadPendingJoin();
    if (pendingJoin) {
      clearPendingJoin();
      showScreen('screen-home');
      joinRound(pendingJoin);
      return;
    }

    // A non-invited user who just verified their email: send them to the
    // profile screen to finish setup (name pre-filled from signup). The
    // invite branch above already returned, so this never fires for anyone
    // who signed up from a round code.
    const pendingProfile = loadPendingProfileSetup();
    if (pendingProfile !== null) {
      clearPendingProfileSetup();
      await beginProfileOnboarding(pendingProfile);
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
