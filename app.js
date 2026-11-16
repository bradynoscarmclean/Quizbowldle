'use strict';

const TOTAL_CLUES = 10;
const START_POINTS = 1000;
const CLUE_COST = 100;
const TIER_NAMES = { easy: 'Easy', medium: 'Medium', hard: 'Hard' };

const $ = (id) => document.getElementById(id);

let puzzle = null;
let tier = null;
let game = null; // { status, revealed, guesses: [{ text, clue }], score }

// ---------- storage (best effort; the game still works without it) ----------

function load(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
}

function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

const gameKey = (t) => `qbd:game:${puzzle.date}:${t}`;

// ---------- dates ----------

function localDate(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function prettyDate(iso) {
  return new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });
}

async function loadPuzzle() {
  const today = new Date();
  // Fall back a few days in case today's puzzle hasn't been generated yet.
  for (let back = 0; back < 4; back++) {
    const d = new Date(today);
    d.setDate(d.getDate() - back);
    const res = await fetch(`puzzles/${localDate(d)}.json`, { cache: 'no-cache' });
    if (res.ok) return res.json();
  }
  throw new Error('No puzzle found');
}

// ---------- answer checking ----------

function normalize(s) {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(the|a|an) /, '');
}

function levenshtein(a, b) {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

// Offline fallback: accept close matches to any underlined part of the answerline.
function localCheck(answerline, given) {
  const g = normalize(given);
  if (!g) return 'reject';
  const required = [...answerline.matchAll(/<u>(.*?)<\/u>/g)].map((m) => normalize(m[1].replace(/<[^>]*>/g, '')));
  const plain = normalize(answerline.replace(/<[^>]*>/g, '').split(/[[(]/)[0]);
  const options = [...required, plain].filter(Boolean);
  for (const opt of options) {
    if (g === opt || opt.split(' ').includes(g) && g.length >= 4) return 'accept';
    if (levenshtein(g, opt) / Math.max(g.length, opt.length) <= 0.2) return 'accept';
  }
  return 'reject';
}

async function checkAnswer(given) {
  const answerlines = puzzle.tiers[tier].answerlines;
  let sawPrompt = false;
  for (const answerline of answerlines) {
    let directive;
    try {
      const url = `https://www.qbreader.org/api/check-answer?${new URLSearchParams({ answerline, givenAnswer: given })}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error();
      directive = (await res.json()).directive;
    } catch {
      directive = localCheck(answerline, given);
    }
    if (directive === 'accept') return 'accept';
    if (directive === 'prompt') sawPrompt = true;
  }
  return sawPrompt ? 'prompt' : 'reject';
}

// ---------- rendering ----------

function show(screen) {
  for (const id of ['home', 'game', 'result']) $(id).hidden = id !== screen;
  window.scrollTo(0, 0);
}

function clueItem(clue, n, { latest = false, meta = false, unseen = false } = {}) {
  const li = document.createElement('li');
  li.dataset.n = n;
  li.textContent = clue.text;
  if (latest) li.classList.add('latest');
  if (unseen) li.classList.add('unseen');
  if (meta) {
    const m = document.createElement('span');
    m.className = 'clue-meta';
    if (clue.inPower) {
      const t = document.createElement('span');
      t.className = 'tag power';
      t.textContent = 'POWER';
      m.append(t);
    }
    m.append(clue.source);
    li.append(m);
  }
  return li;
}

function renderHome() {
  $('today-date').textContent = prettyDate(puzzle.date);
  $('category').textContent = puzzle.category;
  for (const btn of document.querySelectorAll('.diff')) {
    const g = load(gameKey(btn.dataset.tier), null);
    const status = btn.querySelector('.diff-status');
    if (g?.status === 'won') status.textContent = `✅ ${g.score}`;
    else if (g?.status === 'lost') status.textContent = '❌ 0';
    else if (g?.status === 'playing') status.textContent = 'In progress';
    else status.textContent = '';
  }
  show('home');
}

function currentPoints() {
  return START_POINTS - CLUE_COST * (game.revealed - 1);
}

function renderGame() {
  const clues = puzzle.tiers[tier].clues;
  $('game-tier').textContent = TIER_NAMES[tier];
  $('clue-count').textContent = `Clue ${game.revealed} of ${TOTAL_CLUES}`;
  $('points').textContent = currentPoints();
  $('meter-fill').style.width = `${(currentPoints() / START_POINTS) * 100}%`;

  const list = $('clues');
  list.replaceChildren(
    ...clues.slice(0, game.revealed).map((c, i) => clueItem(c, i + 1, { latest: i === game.revealed - 1 })),
  );

  $('guess-log').replaceChildren(
    ...game.guesses.filter((g) => !g.correct).map((g) => {
      const s = document.createElement('span');
      s.textContent = g.text;
      return s;
    }),
  );

  const last = game.revealed >= TOTAL_CLUES;
  $('next-btn').hidden = last;
  $('buzz-btn').textContent = last ? 'Final answer' : 'Buzz';
  if (last && !$('feedback').textContent) setFeedback('Last clue — you get one attempt.', 'warn');
  show('game');
  list.lastElementChild?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  $('answer-input').focus();
}

function setFeedback(text, kind = '') {
  const f = $('feedback');
  f.textContent = text;
  f.className = `feedback ${kind}`;
}

function shareGrid() {
  const cells = [];
  for (let i = 1; i <= TOTAL_CLUES; i++) {
    const g = game.guesses.find((x) => x.clue === i);
    if (g?.correct) cells.push('🟩');
    else if (g) cells.push('🟥');
    else if (i <= game.revealed) cells.push('⬛');
    else cells.push('⬜');
  }
  return cells.join('');
}

function renderResult() {
  const won = game.status === 'won';
  $('result-title').textContent = won
    ? game.revealed === 1 ? 'First-clue buzz! 🔔' : `Got it on clue ${game.revealed}!`
    : 'Not this time';
  $('result-score').textContent = game.score;
  $('result-answer').textContent = puzzle.answer;
  $('result-grid').textContent = shareGrid();
  $('share-feedback').textContent = '';
  $('all-clues').replaceChildren(
    ...puzzle.tiers[tier].clues.map((c, i) => clueItem(c, i + 1, { meta: true, unseen: i >= game.revealed })),
  );
  show('result');
}

// ---------- game flow ----------

function startTier(t) {
  tier = t;
  game = load(gameKey(t), null) ?? { status: 'playing', revealed: 1, guesses: [], score: 0 };
  setFeedback('');
  $('answer-input').value = '';
  if (game.status === 'playing') renderGame();
  else renderResult();
}

function finish(won) {
  game.status = won ? 'won' : 'lost';
  game.score = won ? currentPoints() : 0;
  save(gameKey(tier), game);
  recordStats();
  renderResult();
}

function nextClue() {
  if (game.revealed >= TOTAL_CLUES) return;
  game.revealed++;
  save(gameKey(tier), game);
  renderGame();
}

let checking = false;

async function submitGuess(e) {
  e.preventDefault();
  const input = $('answer-input');
  const given = input.value.trim();
  if (!given || checking) return;

  checking = true;
  $('buzz-btn').disabled = true;
  $('next-btn').disabled = true;
  setFeedback('Checking…');
  const directive = await checkAnswer(given);
  checking = false;
  $('buzz-btn').disabled = false;
  $('next-btn').disabled = false;

  if (directive === 'prompt') {
    setFeedback(`Prompt on "${given}" — be more specific.`, 'warn');
    input.select();
    return;
  }

  input.value = '';
  if (directive === 'accept') {
    game.guesses.push({ text: given, clue: game.revealed, correct: true });
    finish(true);
    return;
  }

  game.guesses.push({ text: given, clue: game.revealed, correct: false });
  if (game.revealed >= TOTAL_CLUES) {
    finish(false);
    return;
  }
  game.revealed++;
  save(gameKey(tier), game);
  setFeedback(`"${given}" is incorrect. −100`, 'bad');
  renderGame();
}

// ---------- stats ----------

function recordStats() {
  const stats = load('qbd:stats', {});
  const s = stats[tier] ?? { played: 0, wins: 0, total: 0, streak: 0, best: 0, lastWin: null };
  s.played++;
  s.total += game.score;
  if (game.status === 'won') {
    s.wins++;
    const yesterday = new Date(`${puzzle.date}T12:00:00`);
    yesterday.setDate(yesterday.getDate() - 1);
    s.streak = s.lastWin === localDate(yesterday) ? s.streak + 1 : 1;
    s.best = Math.max(s.best, s.streak);
    s.lastWin = puzzle.date;
  } else {
    s.streak = 0;
  }
  stats[tier] = s;
  save('qbd:stats', stats);
}

function renderStats() {
  const stats = load('qbd:stats', {});
  const grid = document.createElement('div');
  grid.className = 'stats-grid';
  const cell = (text, cls) => {
    const d = document.createElement('div');
    d.className = cls;
    d.textContent = text;
    grid.append(d);
  };
  ['', 'Played', 'Win %', 'Avg', 'Streak'].forEach((h) => cell(h, 'h'));
  for (const [t, name] of Object.entries(TIER_NAMES)) {
    const s = stats[t];
    cell(name, 't');
    cell(s ? s.played : 0, 'v');
    cell(s?.played ? `${Math.round((s.wins / s.played) * 100)}` : '–', 'v');
    cell(s?.played ? Math.round(s.total / s.played) : '–', 'v');
    cell(s ? s.streak : 0, 'v');
  }
  $('stats-body').replaceChildren(grid);
}

// ---------- share & countdown ----------

async function share() {
  const text = `Quizbowldle ${puzzle.date} · ${puzzle.category} (${TIER_NAMES[tier]})\n`
    + `${game.status === 'won' ? `🔔 ${game.score}/1000` : '❌ 0/1000'}\n${shareGrid()}\n${location.origin}${location.pathname}`;
  try {
    if (navigator.share && matchMedia('(pointer: coarse)').matches) {
      await navigator.share({ text });
      return;
    }
    await navigator.clipboard.writeText(text);
    $('share-feedback').textContent = 'Copied to clipboard!';
  } catch {
    $('share-feedback').textContent = 'Could not copy.';
  }
}

function tickCountdown() {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  const s = Math.floor((midnight - now) / 1000);
  const pad = (n) => String(n).padStart(2, '0');
  $('countdown').textContent = `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

// ---------- wiring ----------

document.querySelectorAll('.diff').forEach((btn) => btn.addEventListener('click', () => startTier(btn.dataset.tier)));
$('answer-form').addEventListener('submit', submitGuess);
$('next-btn').addEventListener('click', () => {
  setFeedback('');
  nextClue();
});
$('share-btn').addEventListener('click', share);
$('back-btn').addEventListener('click', renderHome);
$('home-link').addEventListener('click', (e) => {
  if (!puzzle) return;
  e.preventDefault();
  renderHome();
});
$('help-btn').addEventListener('click', () => $('help-dialog').showModal());
$('stats-btn').addEventListener('click', () => {
  renderStats();
  $('stats-dialog').showModal();
});
document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));

setInterval(tickCountdown, 1000);
tickCountdown();

loadPuzzle()
  .then((p) => {
    puzzle = p;
    renderHome();
    if (!load('qbd:seen-help', false)) {
      save('qbd:seen-help', true);
      $('help-dialog').showModal();
    }
  })
  .catch(() => {
    $('category').textContent = '—';
    const err = $('load-error');
    err.hidden = false;
    err.textContent = "Couldn't load today's puzzle. Try again later.";
    document.querySelectorAll('.diff').forEach((b) => (b.disabled = true));
  });
