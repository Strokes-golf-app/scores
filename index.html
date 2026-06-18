<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1, user-scalable=no">
<title>Fairway Live — round tracker</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Oswald:wght@400;500;600;700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@500;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="assets/styles.css">
</head>
<body>

<div id="toast" class="toast" role="status" aria-live="polite"></div>

<!-- ============ SCREEN: HOME ============ -->
<section id="screen-home" class="screen active">
  <div class="home-wrap">
    <div class="brand">
      <span class="brand-mark">⛳</span>
      <h1 class="brand-name">Fairway Live</h1>
      <p class="brand-tag">Live scoring for your group</p>
    </div>

    <div class="home-actions">
      <button class="btn btn-primary btn-lg" id="btn-new-round">
        <span class="btn-label">Start a round</span>
        <span class="btn-sub">Set the course, invite your group</span>
      </button>

      <div class="divider"><span>or</span></div>

      <form id="form-join" class="join-form">
        <label class="field-label" for="join-code">Join an existing round</label>
        <div class="join-row">
          <input type="text" id="join-code" maxlength="5" placeholder="ROUND CODE" autocomplete="off" autocapitalize="characters" spellcheck="false">
          <button type="submit" class="btn btn-secondary">Join</button>
        </div>
      </form>
    </div>

    <p class="home-footnote">No accounts. No app store. Just share the code.</p>
  </div>
</section>

<!-- ============ SCREEN: NEW ROUND SETUP ============ -->
<section id="screen-setup" class="screen">
  <header class="topbar">
    <button class="icon-btn" id="btn-setup-back" aria-label="Back">←</button>
    <h2 class="topbar-title">New round</h2>
    <span class="topbar-spacer"></span>
  </header>

  <div class="screen-body">
    <div class="field">
      <label class="field-label" for="course-name">Course name</label>
      <input type="text" id="course-name" placeholder="e.g. Bobby Jones Golf Course">
    </div>

    <div class="field-row">
      <div class="field">
        <label class="field-label" for="hole-count">Holes</label>
        <select id="hole-count">
          <option value="18">18 holes</option>
          <option value="9">9 holes</option>
        </select>
      </div>
    </div>

    <div class="field">
      <label class="field-label">Hole pars (optional)</label>
      <p class="field-hint">Leave blank to default every hole to par 4. You can fix this later from the scorecard.</p>
      <div id="par-grid" class="par-grid"></div>
    </div>

    <div class="field">
      <span class="field-label">Game modes for this round</span>
      <p class="field-hint">Pick as many as you're playing. The leaderboard will show a tab for each.</p>
      <div class="mode-grid" id="mode-grid">
        <label class="mode-card checked">
          <input type="checkbox" name="mode" value="gross" checked disabled>
          <span class="mode-name">Gross</span>
          <span class="mode-desc">Raw strokes. Always on.</span>
        </label>
        <label class="mode-card">
          <input type="checkbox" name="mode" value="net">
          <span class="mode-name">Net (handicap)</span>
          <span class="mode-desc">Strokes minus handicap, allocated by hole difficulty.</span>
        </label>
        <label class="mode-card">
          <input type="checkbox" name="mode" value="stableford">
          <span class="mode-name">Stableford</span>
          <span class="mode-desc">Points per hole based on net score vs par.</span>
        </label>
        <label class="mode-card">
          <input type="checkbox" name="mode" value="skins">
          <span class="mode-name">Skins</span>
          <span class="mode-desc">Lowest net score wins the hole outright.</span>
        </label>
        <label class="mode-card">
          <input type="checkbox" name="mode" value="match">
          <span class="mode-name">Match play</span>
          <span class="mode-desc">Head-to-head holes won, for 2 players.</span>
        </label>
      </div>
    </div>

    <div class="field" id="match-players-field" hidden>
      <label class="field-label">Match play: pick the two players</label>
      <div class="field-row">
        <select id="match-p1"></select>
        <select id="match-p2"></select>
      </div>
    </div>

    <div class="field">
      <label class="field-label">Players</label>
      <p class="field-hint">Add everyone now, or just yourself — others can join with the round code and add themselves.</p>
      <div id="player-list" class="player-list"></div>
      <button class="btn btn-secondary btn-block" id="btn-add-player" type="button">+ Add a player</button>
    </div>

    <button class="btn btn-primary btn-lg btn-block" id="btn-create-round">Create round &amp; get code</button>
  </div>
</section>

<!-- ============ SCREEN: LOBBY ============ -->
<section id="screen-lobby" class="screen">
  <header class="topbar">
    <button class="icon-btn" id="btn-lobby-leave" aria-label="Leave">←</button>
    <h2 class="topbar-title" id="lobby-course-name">Round lobby</h2>
    <span class="topbar-spacer"></span>
  </header>

  <div class="screen-body">
    <div class="code-card">
      <p class="code-label">Round code</p>
      <p class="code-display" id="lobby-code">—</p>
      <button class="btn btn-secondary" id="btn-copy-code">Copy code</button>
      <p class="code-hint">Share this with your group. They tap "Join an existing round" and enter it.</p>
    </div>

    <div class="field">
      <div class="field-label-row">
        <span class="field-label">Players in this round</span>
        <span class="pill" id="lobby-player-count">0</span>
      </div>
      <div id="lobby-player-list" class="lobby-player-list"></div>
      <button class="btn btn-secondary btn-block" id="btn-lobby-add-player" type="button">+ Add a player</button>
    </div>

    <div class="field">
      <span class="field-label">Game modes</span>
      <div class="chip-row" id="lobby-modes"></div>
    </div>

    <button class="btn btn-primary btn-lg btn-block" id="btn-start-round">Start round</button>
  </div>
</section>

<!-- ============ SCREEN: JOIN — pick yourself ============ -->
<section id="screen-identify" class="screen">
  <header class="topbar">
    <button class="icon-btn" id="btn-identify-back" aria-label="Back">←</button>
    <h2 class="topbar-title" id="identify-course-name">Join round</h2>
    <span class="topbar-spacer"></span>
  </header>

  <div class="screen-body">
    <p class="field-hint">Which player are you? Or add yourself if you're not listed yet.</p>
    <div id="identify-player-list" class="identify-player-list"></div>
    <button class="btn btn-secondary btn-block" id="btn-identify-add-self" type="button">+ Add myself</button>
  </div>
</section>

<!-- ============ SCREEN: ROUND ============ -->
<section id="screen-round" class="screen">
  <header class="topbar">
    <button class="icon-btn" id="btn-round-leave" aria-label="Leave round">←</button>
    <div class="topbar-title-wrap">
      <h2 class="topbar-title" id="round-course-name">Round</h2>
      <p class="topbar-sub" id="round-meta">—</p>
    </div>
    <button class="icon-btn" id="btn-round-share" aria-label="Share code">⤴</button>
  </header>

  <nav class="tabbar" id="round-tabbar">
    <button class="tab active" data-tab="card">Scorecard</button>
    <button class="tab" data-tab="board">Leaderboard</button>
  </nav>

  <!-- SCORECARD TAB -->
  <div class="tabpanel active" id="tab-card">
    <div class="scorecard-controls">
      <p class="field-label" id="scoring-for-label">Entering for you</p>
    </div>

    <div class="hole-nav">
      <button class="icon-btn" id="btn-hole-prev" aria-label="Previous hole">←</button>
      <div class="hole-nav-center">
        <p class="hole-nav-label">Hole</p>
        <p class="hole-nav-number" id="hole-number">1</p>
        <p class="hole-nav-par" id="hole-par">Par 4</p>
      </div>
      <button class="icon-btn" id="btn-hole-next" aria-label="Next hole">→</button>
    </div>

    <div class="par-editor" id="par-editor" hidden>
      <label class="field-label" for="par-editor-input">Set par for this hole</label>
      <div class="join-row">
        <input type="number" id="par-editor-input" inputmode="numeric" min="2" max="6">
        <button class="btn btn-secondary" id="btn-par-save">Save</button>
      </div>
    </div>
    <button class="link-btn" id="btn-par-toggle" type="button">Edit hole par</button>

    <div class="stroke-entry">
      <button class="stroke-btn stroke-minus" id="btn-stroke-minus" aria-label="Decrease strokes">−</button>
      <div class="stroke-display">
        <span class="stroke-number" id="stroke-number">—</span>
        <span class="stroke-caption" id="stroke-caption">Tap + to enter score</span>
      </div>
      <button class="stroke-btn stroke-plus" id="btn-stroke-plus" aria-label="Increase strokes">+</button>
    </div>

    <div class="my-progress">
      <p class="field-label">Your round so far</p>
      <div class="mini-holes" id="mini-holes"></div>
    </div>
  </div>

  <!-- LEADERBOARD TAB -->
  <div class="tabpanel" id="tab-board">
    <nav class="modetab-row" id="modetab-row"></nav>
    <div class="board-meta" id="board-meta"></div>
    <div class="leaderboard" id="leaderboard"></div>
  </div>
</section>

<!-- Supabase client library (loaded from their CDN) -->
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js"></script>
<script src="assets/supabase-config.js"></script>
<script src="assets/golf.js"></script>
<script src="assets/app.js"></script>
</body>
</html>
