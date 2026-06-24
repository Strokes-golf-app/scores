'use strict';

/* ===========================================================
   core.js — shared state, session helpers, small utilities.

   Every other file in this app (auth.js, setup.js, lobby.js,
   round.js, app.js) reads or writes the `state` object defined
   here, so this file must load BEFORE all of them. It depends
   on nothing itself, so it loads right after golf.js.
=========================================================== */

const state = {
  roundId: null,
  roundCode: null,
  round: null,
  myPlayerId: null,
  currentHole: 1,
  activeTab: 'card',
  activeModeTab: null,
  setupPlayers: [],
  realtimeChannel: null,
  authMode: 'login',     // 'login' or 'signup'
  pendingJoinCode: null, // round code from a ?code= deep link, applied after auth
  pendingVerifyEmail: null, // email awaiting verification, for the resend button
  pendingSignupName: null,  // name captured at signup, written to profile on first real login
};

const LS_KEY = 'fairwaylive_session';

// ---------------------------------------------------------
// Utilities
// ---------------------------------------------------------
function uid(prefix) {
  return prefix + '_' + Math.random().toString(36).slice(2, 10);
}

function makeRoundCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I ambiguity
  let code = '';
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove('show'), 2200);
}

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function saveSession() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({
      roundCode: state.roundCode,
      myPlayerId: state.myPlayerId,
    }));
  } catch (e) { /* storage unavailable, ignore */ }
}

function loadSession() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function clearSession() {
  try { localStorage.removeItem(LS_KEY); } catch (e) { /* ignore */ }
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str == null ? '' : String(str);
  return d.innerHTML;
}
function escapeAttr(str) {
  return escapeHtml(str).replace(/"/g, '&quot;');
}

// Parse a handicap string, allowing one decimal place (e.g. 10.2).
// Returns a number rounded to 1 decimal place, clamped 0–54.
function parseHandicap(val) {
  const n = parseFloat(val);
  if (isNaN(n)) return 0;
  return Math.min(54, Math.max(0, Math.round(n * 10) / 10));
}
