'use strict';

/* ===========================================================
   courses.js — saved course library: the upload/builder screen,
   and loading a user's saved courses for the round setup screen.
   Depends on: core.js (state, escapeHtml/escapeAttr, showToast, showScreen)
=========================================================== */

function renderCourseHoleGrid() {
  const holeCount = Number(document.getElementById('course-hole-count').value);
  const grid = document.getElementById('course-hole-grid');
  grid.innerHTML = '';
  for (let h = 1; h <= holeCount; h++) {
    const cell = document.createElement('div');
    cell.className = 'course-hole-cell';
    cell.innerHTML = `
      <span class="course-hole-label">Hole ${h}</span>
      <input type="number" class="course-par-input" data-hole="${h}" min="2" max="6" placeholder="Par" inputmode="numeric">
      <input type="number" class="course-hcp-input" data-hole="${h}" min="1" max="${holeCount}" placeholder="HCP" inputmode="numeric">
    `;
    grid.appendChild(cell);
  }
}

function resetCourseUploadScreen() {
  document.getElementById('course-upload-name').value = '';
  document.getElementById('course-hole-count').value = '18';
  renderCourseHoleGrid();
}

function collectCourseHoles() {
  const holeCount = Number(document.getElementById('course-hole-count').value);
  const pars = new Array(holeCount).fill(null);
  const strokeIndex = new Array(holeCount).fill(null);

  document.querySelectorAll('.course-par-input').forEach(inp => {
    const h = Number(inp.dataset.hole) - 1;
    pars[h] = Number(inp.value) || null;
  });
  document.querySelectorAll('.course-hcp-input').forEach(inp => {
    const h = Number(inp.dataset.hole) - 1;
    strokeIndex[h] = Number(inp.value) || null;
  });

  return { holeCount, pars, strokeIndex };
}

// Returns an error message string, or null if everything checks out.
function validateCourseHoles(holeCount, pars, strokeIndex) {
  if (pars.some(p => p == null || p < 2 || p > 6)) {
    return 'Every hole needs a par between 2 and 6.';
  }
  if (strokeIndex.some(s => s == null || s < 1 || s > holeCount)) {
    return `Every hole needs a handicap ranking between 1 and ${holeCount}.`;
  }
  if (new Set(strokeIndex).size !== holeCount) {
    return `Each handicap ranking (1–${holeCount}) should be used exactly once.`;
  }
  return null;
}

async function saveCourse() {
  const name = document.getElementById('course-upload-name').value.trim();
  if (!name) {
    showToast('Give the course a name first');
    return;
  }

  const { holeCount, pars, strokeIndex } = collectCourseHoles();
  const errorMsg = validateCourseHoles(holeCount, pars, strokeIndex);
  if (errorMsg) {
    showToast(errorMsg);
    return;
  }

  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user) {
    showToast('You need to be logged in to save a course');
    return;
  }

  const { error } = await supabaseClient.from('courses').insert({
    user_id: user.id,
    name,
    hole_count: holeCount,
    pars,
    stroke_index: strokeIndex,
  });

  if (error) {
    console.error(error);
    showToast('Could not save course — check your connection');
    return;
  }

  showToast(`${name} saved`);
  showScreen('screen-home');
}

async function loadMyCourses() {
  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user) return [];

  const { data, error } = await supabaseClient
    .from('courses')
    .select('*')
    .order('name', { ascending: true });

  if (error) {
    console.error(error);
    return [];
  }
  return data || [];
}
