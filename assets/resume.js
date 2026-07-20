'use strict';

/* ===========================================================
   resume.js — "resume an in-progress round" flow, triggered
   from the home screen's "Start a round" button. Checks for
   the signed-in user's non-ended rounds from the last 30 days,
   shows a Yes/No prompt, then a list of matching rounds to
   jump back into.

   Depends on: core.js (state, showToast, showScreen, saveSession,
   escapeHtml), history.js (formatHistoryDate), round.js (loadRound,
   subscribeToRound, enterRound), lobby.js (renderLobby)
=========================================================== */

const RESUME_WINDOW_DAYS = 30;

// Finds every round the signed-in user is a player in that hasn't
// ended yet and was created within the last 30 days.
async function getInProgressRounds() {
    const { data: { user } } = await supabaseClient.auth.getUser();
    if (!user) return [];

    const cutoff = new Date(Date.now() - RESUME_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

    const { data, error } = await supabaseClient
        .from('players')
        .select('round_id, rounds!inner(id, code, course_name, course_location, created_at, started, ended)')
        .eq('user_id', user.id)
        .eq('rounds.ended', false)
        .gte('rounds.created_at', cutoff);

    if (error) {
        console.error(error);
        return [];
    }

    const rounds = (data || [])
        .map(row => row.rounds)
        .filter(Boolean);

    rounds.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    return rounds;
}

function showResumePrompt(rounds) {
    state.pendingResumeRounds = rounds;
    document.getElementById('resume-prompt-modal').hidden = false;
}

function hideResumePrompt() {
    document.getElementById('resume-prompt-modal').hidden = true;
}

function renderResumeRoundsList(rounds) {
    const list = document.getElementById('resume-rounds-list');
    list.innerHTML = '';

    if (!rounds || rounds.length === 0) {
        list.innerHTML = '<div class="history-empty">No in-progress rounds found.</div>';
        return;
    }

    rounds.forEach(round => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'resume-round-card';
        btn.innerHTML = `
      <span class="resume-round-course">${escapeHtml(round.course_name)}</span>
      ${round.course_location ? `<span class="resume-round-location">${escapeHtml(round.course_location)}</span>` : ''}
      <span class="resume-round-date">${formatHistoryDate(round.created_at)}</span>
    `;
        btn.addEventListener('click', () => resumeInProgressRound(round));
        list.appendChild(btn);
    });
}

// Jumps the user straight back into a chosen round — the lobby if it
// hasn't started yet, or the live scorecard/leaderboard if it has.
// Mirrors resumeSession() in lobby.js.
async function resumeInProgressRound(round) {
    const { data: { user } } = await supabaseClient.auth.getUser();
    if (!user) {
        showToast('You need to be logged in to resume a round');
        return;
    }

    const { data: playerRow, error: playerErr } = await supabaseClient
        .from('players')
        .select('id')
        .eq('round_id', round.id)
        .eq('user_id', user.id)
        .single();

    if (playerErr || !playerRow) {
        showToast('Could not resume that round — check your connection');
        return;
    }

    state.roundId = round.id;
    state.roundCode = round.code;
    state.myPlayerId = playerRow.id;
    saveSession();

    const loaded = await loadRound(round.id);
    if (!loaded) return;

    subscribeToRound(round.id);

    if (state.round.started) {
        enterRound();
    } else {
        document.getElementById('lobby-course-name').textContent = state.round.courseName;
        document.getElementById('lobby-code').textContent = state.round.code;
        showScreen('screen-lobby');
        renderLobby();
    }
}