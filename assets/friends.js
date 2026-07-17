'use strict';

/* ===========================================================
   friends.js — the Friends screen: search people by @username
   or name, send / accept / decline requests, and see accepted
   friends. Every read and write goes through the Stage 3a
   security-definer RPCs, so no other user's profile is ever
   exposed through broad table access.

   Loads after profile.js, before app.js. Functions stay global.
   Depends on: core.js (showScreen, showToast, escapeHtml),
   Supabase client.
=========================================================== */

let friendSearchTimer = null;
let lastFriendQuery = '';

// The @ is display-only; the stored/searched handle is bare.
// (In 3c this moves to core.js so the lobby can share it.)
function atHandle(username) {
  return username ? '@' + username : '';
}

async function openFriendsScreen() {
  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user || user.is_anonymous) {
    showToast('Create an account to add friends');
    return;
  }
  document.getElementById('friend-search').value = '';
  document.getElementById('friend-search-results').innerHTML = '';
  lastFriendQuery = '';
  showScreen('screen-friends');
  await refreshFriendsData();
}

// Loads incoming requests + accepted friends together and paints both.
async function refreshFriendsData() {
  const [reqRes, friendsRes] = await Promise.all([
    supabaseClient.rpc('get_incoming_requests'),
    supabaseClient.rpc('get_my_friends'),
  ]);
  if (reqRes.error) console.error(reqRes.error);
  if (friendsRes.error) console.error(friendsRes.error);
  renderIncomingRequests(reqRes.data || []);
  renderFriendsList(friendsRes.data || []);
}

function renderIncomingRequests(rows) {
  const section = document.getElementById('friend-requests-section');
  const list = document.getElementById('friend-requests-list');
  if (!rows.length) {
    section.hidden = true;
    list.innerHTML = '';
    return;
  }
  section.hidden = false;
  list.innerHTML = rows.map(r => `
    <div class="friend-row">
      <div class="friend-info">
        <span class="friend-name">${escapeHtml(r.display_name || '')}</span>
        <span class="friend-handle">${escapeHtml(atHandle(r.username))}</span>
      </div>
      <div class="friend-actions">
        <button class="friend-btn friend-btn-primary" data-friend-action="accept" data-friend-id="${r.requester_id}">Accept</button>
        <button class="friend-btn friend-btn-secondary" data-friend-action="decline" data-friend-id="${r.requester_id}">Decline</button>
      </div>
    </div>
  `).join('');
}

function renderFriendsList(rows) {
  const list = document.getElementById('friends-list');
  if (!rows.length) {
    list.innerHTML = '<div class="friends-empty">No friends yet. Search above to add someone.</div>';
    return;
  }
  list.innerHTML = rows.map(f => `
    <div class="friend-row">
      <div class="friend-info">
        <span class="friend-name">${escapeHtml(f.display_name || '')}</span>
        <span class="friend-handle">${escapeHtml(atHandle(f.username))}</span>
      </div>
      <div class="friend-actions">
        <button class="friend-remove" data-friend-action="remove" data-friend-id="${f.id}" aria-label="Remove friend" title="Remove friend">✕</button>
      </div>
    </div>
  `).join('');
}

// Debounced search-as-you-type. A leading @ is stripped so "@sam" and
// "sam" behave the same; the RPC also matches display names.
function handleFriendSearchInput() {
  clearTimeout(friendSearchTimer);
  const raw = document.getElementById('friend-search').value.trim().replace(/^@+/, '');
  lastFriendQuery = raw;
  const resultsEl = document.getElementById('friend-search-results');
  if (raw.length < 2) {
    resultsEl.innerHTML = '';
    return;
  }
  friendSearchTimer = setTimeout(() => runFriendSearch(raw), 300);
}

async function runFriendSearch(q) {
  const resultsEl = document.getElementById('friend-search-results');
  const { data, error } = await supabaseClient.rpc('search_users_by_username', { q });
  if (error) {
    console.error(error);
    resultsEl.innerHTML = '<div class="friends-empty">Could not search — check your connection.</div>';
    return;
  }
  // Drop a stale response if the query moved on while we were awaiting.
  if (q !== lastFriendQuery) return;

  if (!data || !data.length) {
    resultsEl.innerHTML = '<div class="friends-empty">No one found. Ask them for their exact @username.</div>';
    return;
  }

  resultsEl.innerHTML = data.map(u => {
    let action;
    switch (u.relationship) {
      case 'accepted':
        action = '<span class="friend-btn friend-btn-muted">✓ Friends</span>';
        break;
      case 'outgoing':
        action = '<span class="friend-btn friend-btn-muted">Requested</span>';
        break;
      case 'incoming':
        action = `<button class="friend-btn friend-btn-primary" data-friend-action="accept" data-friend-id="${u.id}">Accept</button>`;
        break;
      default:
        action = `<button class="friend-btn friend-btn-primary" data-friend-action="add" data-friend-id="${u.id}">Add</button>`;
    }
    const loc = [u.city, u.state].filter(Boolean).join(', ');
    return `
      <div class="friend-row">
        <div class="friend-info">
          <span class="friend-name">${escapeHtml(u.display_name || '')}</span>
          <span class="friend-handle">${escapeHtml(atHandle(u.username))}${loc ? ' · ' + escapeHtml(loc) : ''}</span>
        </div>
        <div class="friend-actions">${action}</div>
      </div>
    `;
  }).join('');
}

// One delegated handler for every action button on the screen.
async function handleFriendsClick(e) {
  const btn = e.target.closest('[data-friend-action]');
  if (!btn) return;
  const action = btn.dataset.friendAction;
  const id = btn.dataset.friendId;
  if (!id) return;

  if (action === 'add') {
    const { error } = await supabaseClient.rpc('send_friend_request', { p_target_id: id });
    if (error) { console.error(error); showToast('Could not send request'); return; }
    showToast('Request sent');
  } else if (action === 'accept') {
    const { error } = await supabaseClient.rpc('respond_friend_request', { p_requester_id: id, p_accept: true });
    if (error) { console.error(error); showToast('Could not accept'); return; }
    showToast('Friend added');
  } else if (action === 'decline') {
    const { error } = await supabaseClient.rpc('respond_friend_request', { p_requester_id: id, p_accept: false });
    if (error) { console.error(error); showToast('Could not decline'); return; }
    showToast('Request declined');
  } else if (action === 'remove') {
    if (!confirm('Remove this friend?')) return;
    const { error } = await supabaseClient.rpc('remove_friend', { p_other_id: id });
    if (error) { console.error(error); showToast('Could not remove'); return; }
    showToast('Friend removed');
  }

  await refreshFriendsData();
  if (lastFriendQuery.length >= 2) await runFriendSearch(lastFriendQuery);
}

// Wired once at startup from app.js init(). The listeners are delegated,
// so they keep working across every re-render of the lists.
function initFriends() {
  const search = document.getElementById('friend-search');
  if (search) search.addEventListener('input', handleFriendSearchInput);
  const screen = document.getElementById('screen-friends');
  if (screen) screen.addEventListener('click', handleFriendsClick);
}
