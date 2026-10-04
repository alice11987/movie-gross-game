/* Movie Gross Showdown - game logic. Data lives in movies.js. */

const MATCH_COUNT = 32; // 32 matches, so 64 movies in play per run
const IMG_BASE = 'https://image.tmdb.org/t/p/w500/';
const BEST_KEY = 'movieGrossBestStreak';

// Target ratio of smaller gross to larger gross, per match. Match 1 is a
// comfortable gap; match 32 lands within a few percent.
const EASIEST_RATIO = 0.45;
const HARDEST_RATIO = 0.97;

// How many near-best pairs to choose randomly between, so runs differ.
const CANDIDATE_SHORTLIST = 12;

const el = (id) => document.getElementById(id);

const state = {
  matches: [],
  index: 0,
  streak: 0,
  locked: false,
  best: 0,
  pending: null, // id of the scheduled advance / end-of-run timer
};

// Any pending timer belongs to the match that scheduled it. Advancing by
// hand must cancel it, or a fast player who clicks Next and answers again
// within the delay gets skipped past a match by the stale timer.
function clearPending() {
  if (state.pending !== null) {
    window.clearTimeout(state.pending);
    state.pending = null;
  }
}

/* ---------- Best streak, with a safe fallback ---------- */

// Private browsing and some embedded webviews throw on localStorage access,
// so fall back to a session-only value rather than breaking the game.
let memoryBest = 0;

function loadBest() {
  try {
    return parseInt(localStorage.getItem(BEST_KEY), 10) || 0;
  } catch (err) {
    return memoryBest;
  }
}

function saveBest(value) {
  memoryBest = value;
  try {
    localStorage.setItem(BEST_KEY, String(value));
  } catch (err) {
    /* session-only is fine */
  }
}

/* ---------- Helpers ---------- */

function formatGross(amount) {
  if (amount >= 1e9) return '$' + (amount / 1e9).toFixed(2) + 'B';
  return '$' + (amount / 1e6).toFixed(1) + 'M';
}

// Result copy always carries the year: the pool holds both The Lion King
// (1994) and The Lion King (2019), so a bare title can be ambiguous.
function label(movie) {
  return movie.title + ' (' + movie.year + ')';
}

function targetRatio(matchIndex) {
  const t = matchIndex / (MATCH_COUNT - 1);
  return EASIEST_RATIO + (HARDEST_RATIO - EASIEST_RATIO) * t;
}

/* ---------- Pairing ---------- */

/**
 * Build 32 matches with a difficulty ramp, consuming 64 of the pool.
 *
 * Two things matter here:
 *
 * 1. Matches are built hardest-first, because near-identical pairs are the
 *    scarce resource. Claiming them before the loose pairs keeps the late
 *    matches genuinely tight.
 * 2. Candidates are drawn from the *whole* pool, not a pre-cut 64. Cutting
 *    to 64 first leaves the final (easiest) match with two movies and no
 *    choice at all, which flattens the ramp completely.
 *
 * For variety, each match picks at random among the closest few candidates
 * rather than always taking the single best fit. Returns matches in play
 * order, easiest first.
 */
function buildMatches() {
  const pool = MOVIES.slice().sort((a, b) => b.gross - a.gross);
  const available = pool.map((_, i) => i);
  const matches = new Array(MATCH_COUNT);

  for (let m = MATCH_COUNT - 1; m >= 0; m--) {
    const target = targetRatio(m);
    const candidates = [];

    for (let a = 0; a < available.length; a++) {
      for (let b = a + 1; b < available.length; b++) {
        const hi = pool[available[a]];
        const lo = pool[available[b]]; // pool is sorted, so hi.gross >= lo.gross
        candidates.push({ a, b, cost: Math.abs(lo.gross / hi.gross - target) });
      }
    }

    candidates.sort((x, y) => x.cost - y.cost);
    const shortlist = candidates.slice(0, CANDIDATE_SHORTLIST);
    const chosen = shortlist[Math.floor(Math.random() * shortlist.length)];

    const pair = [pool[available[chosen.a]], pool[available[chosen.b]]];
    available.splice(chosen.b, 1); // drop the later index first
    available.splice(chosen.a, 1);
    matches[m] = Math.random() < 0.5 ? pair : [pair[1], pair[0]];
  }

  return matches;
}

/* ---------- Screens ---------- */

function showScreen(name) {
  ['start', 'game', 'over'].forEach((key) => {
    el('screen-' + key).hidden = key !== name;
  });
}

/* ---------- Rendering a match ---------- */

function renderMatch() {
  const pair = state.matches[state.index];
  state.locked = false;

  el('hud-match').textContent = state.index + 1;
  el('hud-streak').textContent = state.streak;
  el('hud-fill').style.width = (state.index / MATCH_COUNT) * 100 + '%';
  el('verdict').textContent = '';
  el('verdict').className = 'verdict';
  el('btn-next').hidden = true;

  pair.forEach((movie, side) => {
    const card = el('card-' + side);
    card.className = 'card';
    card.disabled = false;

    el('title-' + side).textContent = movie.title;
    el('year-' + side).textContent = movie.year;
    el('gross-' + side).textContent = '';
    el('fallback-' + side).textContent = movie.title;

    const img = el('poster-' + side);
    img.alt = 'Poster for ' + movie.title;
    img.onerror = () => card.classList.add('no-art');
    img.src = IMG_BASE + movie.poster;
  });
}

function reveal(pickedSide) {
  if (state.locked) return;
  state.locked = true;

  const pair = state.matches[state.index];
  // A dead-equal gross would be unfair to punish, so count it as correct.
  const correctSide = pair[0].gross >= pair[1].gross ? 0 : 1;
  const correct = pickedSide === correctSide || pair[0].gross === pair[1].gross;

  pair.forEach((movie, side) => {
    const card = el('card-' + side);
    card.classList.add('revealed', 'locked');
    card.classList.add(side === correctSide ? 'winner' : 'loser');
    card.disabled = true;
    el('gross-' + side).textContent = formatGross(movie.gross);
  });

  const verdict = el('verdict');

  if (!correct) {
    verdict.textContent = 'Wrong — ' + label(pair[correctSide]) + ' earned more.';
    verdict.className = 'verdict bad';
    state.pending = window.setTimeout(
      () => endRun(pair[correctSide], pair[1 - correctSide]), 1600);
    return;
  }

  state.streak += 1;
  el('hud-streak').textContent = state.streak;

  const gap = Math.abs(pair[0].gross - pair[1].gross);
  verdict.textContent = 'Correct — ' + formatGross(gap) + ' apart.';
  verdict.className = 'verdict good';

  if (state.streak >= MATCH_COUNT) {
    state.pending = window.setTimeout(() => endRun(null, null), 1400);
    return;
  }

  el('btn-next').hidden = false;
  state.pending = window.setTimeout(nextMatch, 1500);
}

function nextMatch() {
  clearPending();
  el('btn-next').hidden = true;
  state.index += 1;
  renderMatch();
}

/* ---------- End of run ---------- */

function endRun(winner, loser) {
  clearPending();
  const perfect = state.streak >= MATCH_COUNT;

  if (state.streak > state.best) {
    state.best = state.streak;
    saveBest(state.best);
  }

  el('over-eyebrow').textContent = perfect ? 'Flawless' : 'Run over';
  el('over-head').textContent = perfect ? 'Perfect run!' : 'Wrong call';
  el('over-streak').textContent = state.streak;

  if (perfect) {
    el('over-detail').innerHTML =
      'All <b>32</b> matches called correctly, right down to the ones within a few percent. Nothing left to prove.';
  } else {
    el('over-detail').textContent =
      label(winner) + ' took ' + formatGross(winner.gross) + ', beating ' +
      label(loser) + ' on ' + formatGross(loser.gross) + '.';
  }

  el('over-best').innerHTML = 'Best streak: <strong>' + state.best + '</strong> / 32';
  showScreen('over');
}

/* ---------- Run lifecycle ---------- */

function startRun() {
  clearPending();
  state.matches = buildMatches();
  state.index = 0;
  state.streak = 0;
  showScreen('game');
  renderMatch();
}

/* ---------- Wiring ---------- */

function init() {
  state.best = loadBest();
  el('start-best').textContent = state.best;
  el('as-of').textContent = BOX_OFFICE_AS_OF;

  el('btn-play').addEventListener('click', startRun);
  el('btn-again').addEventListener('click', startRun);
  el('btn-next').addEventListener('click', nextMatch);
  el('card-0').addEventListener('click', () => reveal(0));
  el('card-1').addEventListener('click', () => reveal(1));

  document.addEventListener('keydown', (event) => {
    if (el('screen-game').hidden) return;
    if (event.key === 'ArrowLeft') reveal(0);
    if (event.key === 'ArrowRight') reveal(1);
    if (event.key === 'Enter' && !el('btn-next').hidden) nextMatch();
  });
}

init();
