'use strict';

const TOTAL_CLUES = 10;
const START_POINTS = 1000;
const CLUE_COST = 100;
const WRONG_COST = 250;
const MAX_STRIKES = 3;
const TIER_NAMES = { easy: 'Easy', medium: 'Medium', hard: 'Hard' };

const $ = (id) => document.getElementById(id);

let puzzle = null;
let tier = null;
let game = null; // { status, revealed, guesses: [{ text, clue, correct }], score }

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

// ---------- theme ----------

function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem('qbd:theme', next);
  } catch {}
}

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

// ---------- scoring ----------

const strikes = (g) => g.guesses.filter((x) => !x.correct).length;

function pointsFor(g) {
  return Math.max(0, START_POINTS - CLUE_COST * (g.revealed - 1) - WRONG_COST * strikes(g));
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

function finishedGames() {
  return Object.keys(TIER_NAMES)
    .map((t) => [t, load(gameKey(t), null)])
    .filter(([, g]) => g && g.status !== 'playing');
}

function renderHome() {
  $('today-date').textContent = prettyDate(puzzle.date);
  $('category').textContent = puzzle.category;
  $('home-feedback').textContent = '';
  for (const row of document.querySelectorAll('.diff')) {
    const g = load(gameKey(row.dataset.tier), null);
    const status = row.querySelector('.diff-status');
    status.className = 'diff-status';
    if (g?.status === 'won') {
      status.textContent = `${g.score} pts`;
      status.classList.add('won');
    } else if (g?.status === 'lost') {
      status.textContent = 'Missed';
      status.classList.add('lost');
    } else if (g?.status === 'playing') {
      status.textContent = 'In progress';
      status.classList.add('playing');
    } else {
      status.textContent = '';
    }
    row.querySelector('.diff-share').hidden = !g || g.status === 'playing';
  }
  $('share-all-btn').hidden = finishedGames().length < 2;
  show('home');
}

function renderGame() {
  const clues = puzzle.tiers[tier].clues;
  const points = pointsFor(game);
  $('game-tier').textContent = TIER_NAMES[tier];
  $('clue-count').textContent = `${game.revealed}/${TOTAL_CLUES}`;
  $('points').textContent = points;
  $('meter-fill').style.width = `${(points / START_POINTS) * 100}%`;
  const s = strikes(game);
  $('strikes').querySelectorAll('i').forEach((dot, i) => dot.classList.toggle('on', i < s));

  const list = $('clues');
  list.replaceChildren(
    ...clues.slice(0, game.revealed).map((c, i) => clueItem(c, i + 1, { latest: i === game.revealed - 1 })),
  );

  $('guess-log').replaceChildren(
    ...game.guesses.filter((g) => !g.correct).map((g) => {
      const span = document.createElement('span');
      span.textContent = g.text;
      return span;
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

function shareGrid(g) {
  const cells = [];
  for (let i = 1; i <= TOTAL_CLUES; i++) {
    const at = g.guesses.filter((x) => x.clue === i);
    if (at.some((x) => x.correct)) cells.push('🟩');
    else if (at.length) cells.push('🟥');
    else if (i <= g.revealed) cells.push('⬛');
    else cells.push('⬜');
  }
  return cells.join('');
}

function resultLine(t, g) {
  const s = strikes(g);
  const outcome = g.status === 'won' ? `🔔 ${g.score}/1000` : '❌ 0/1000';
  return `${TIER_NAMES[t]}: ${outcome}${s ? ` · ${s} strike${s > 1 ? 's' : ''}` : ''}\n${shareGrid(g)}`;
}

function siteUrl() {
  return `${location.origin}${location.pathname}`;
}

function renderResult() {
  const won = game.status === 'won';
  const badge = $('result-badge');
  badge.textContent = `${TIER_NAMES[tier]} · ${won ? 'Solved' : 'Missed'}`;
  badge.className = `result-badge ${won ? 'won' : 'lost'}`;
  let title;
  if (won) title = game.revealed === 1 ? 'First-clue buzz!' : `Got it on clue ${game.revealed}`;
  else title = strikes(game) >= MAX_STRIKES ? 'Out of strikes' : 'Missed the final clue';
  $('result-title').textContent = title;
  $('result-score').textContent = game.score;
  $('result-answer').textContent = puzzle.answer;
  $('result-grid').textContent = shareGrid(game);
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
  game.score = won ? pointsFor(game) : 0;
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

function signalWrong() {
  const form = $('answer-form');
  form.classList.remove('shake');
  void form.offsetWidth; // restart the animation
  form.classList.add('shake');
  const points = $('points');
  points.classList.remove('bump');
  void points.offsetWidth;
  points.classList.add('bump');
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
  if (strikes(game) >= MAX_STRIKES || game.revealed >= TOTAL_CLUES) {
    finish(false);
    return;
  }
  save(gameKey(tier), game);
  const left = MAX_STRIKES - strikes(game);
  setFeedback(`"${given}" is incorrect. −${WRONG_COST} · ${left} strike${left > 1 ? 's' : ''} left`, 'bad');
  renderGame();
  signalWrong();
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

async function shareText(text, feedbackEl) {
  try {
    if (navigator.share && matchMedia('(pointer: coarse)').matches) {
      await navigator.share({ text });
      return;
    }
    await navigator.clipboard.writeText(text);
    feedbackEl.textContent = 'Copied to clipboard!';
  } catch (err) {
    if (err?.name !== 'AbortError') feedbackEl.textContent = 'Could not copy.';
  }
}

function header() {
  return `Quizbowldle ${puzzle.date} · ${puzzle.category}`;
}

function shareTier(t, feedbackEl) {
  const g = load(gameKey(t), null);
  if (!g) return;
  shareText(`${header()}\n${resultLine(t, g)}\n${siteUrl()}`, feedbackEl);
}

function shareAll() {
  const lines = finishedGames().map(([t, g]) => resultLine(t, g));
  shareText(`${header()}\n\n${lines.join('\n\n')}\n\n${siteUrl()}`, $('home-feedback'));
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

document.querySelectorAll('.diff').forEach((row) => {
  row.querySelector('.diff-main').addEventListener('click', () => startTier(row.dataset.tier));
  row.querySelector('.diff-share').addEventListener('click', () => shareTier(row.dataset.tier, $('home-feedback')));
});
$('share-all-btn').addEventListener('click', shareAll);
$('answer-form').addEventListener('submit', submitGuess);
$('next-btn').addEventListener('click', () => {
  setFeedback('');
  nextClue();
});
$('share-btn').addEventListener('click', () => shareTier(tier, $('share-feedback')));
$('back-btn').addEventListener('click', renderHome);
$('home-link').addEventListener('click', (e) => {
  if (!puzzle) return;
  e.preventDefault();
  renderHome();
});
$('theme-btn').addEventListener('click', toggleTheme);
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
    document.querySelectorAll('.diff-main').forEach((b) => (b.disabled = true));
  });
