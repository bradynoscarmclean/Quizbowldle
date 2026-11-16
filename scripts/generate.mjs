// Generates daily Quizbowldle puzzles from the QB Reader database.
//
// Usage:
//   node scripts/generate.mjs                 -> today (UTC) plus the next 7 days
//   node scripts/generate.mjs 2026-11-20      -> one specific date
//   node scripts/generate.mjs 2026-11-20 30   -> 30 days starting at a date
//   add --force to overwrite existing puzzles
//
// Each puzzle is written to puzzles/YYYY-MM-DD.json.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const API = 'https://www.qbreader.org/api';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'puzzles');

const CATEGORIES = [
  'Literature', 'History', 'Science', 'Fine Arts', 'Religion',
  'Mythology', 'Philosophy', 'Social Science', 'Geography',
];

// QB Reader difficulties: 1 = middle school, 2 = easy HS, 3 = regular HS,
// 4 = hard HS, 5 = HS nationals.
const TIERS = {
  easy: { difficulties: [1, 2], fallback: [1, 2, 3] },
  medium: { difficulties: [3], fallback: [2, 3, 4] },
  hard: { difficulties: [4, 5], fallback: [3, 4, 5] },
};

const CLUES_PER_PUZZLE = 10;
const TOP_N = 50;

// ---------- seeded randomness ----------

function hashString(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(arr, rand) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------- API ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, params) {
  const url = `${API}/${path}?${new URLSearchParams(params)}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url);
    if (res.ok) {
      await sleep(150); // stay well under QB Reader's rate limit
      return res.json();
    }
    await sleep(1000 * (attempt + 1));
  }
  throw new Error(`QB Reader request failed: ${url}`);
}

async function topAnswers(category) {
  const data = await api('frequency-list', {
    category,
    questionType: 'tossup',
    difficulties: '1,2,3,4,5',
    limit: TOP_N,
  });
  return data.frequencyList;
}

async function tossupsFor(answer, difficulties, category) {
  const params = {
    queryString: answer,
    searchType: 'answer',
    questionType: 'tossup',
    exactPhrase: 'true',
    difficulties: difficulties.join(','),
    maxReturnLength: 100,
  };
  if (category) params.categories = category;
  const data = await api('query', params);
  return data.tossups.questionArray;
}

// ---------- text helpers ----------

function normalize(s) {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&[a-z]+;/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^the /, '');
}

function stripHtml(s) {
  return s.replace(/<[^>]*>/g, '');
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

// The main answer of an answerline, before any [accept ...] / (prompt ...) notes.
function primaryAnswer(tossup) {
  const text = tossup.answer_sanitized ?? stripHtml(tossup.answer);
  return normalize(text.split(/[[(]/)[0]);
}

function matchesTarget(tossup, target) {
  const primary = primaryAnswer(tossup);
  if (primary === target) return true;
  const dist = levenshtein(primary, target);
  return dist / Math.max(primary.length, target.length) <= 0.15;
}

const ABBREVIATIONS = /(?:\b(?:Mr|Mrs|Ms|Dr|St|Mt|Jr|Sr|vs|No|Gen|Col|Lt|Sgt|Capt|Rev|Prof|Fr|Ft|Gov|Pres|Sen|Rep|Co|Inc|Ltd|ca|c|e\.g|i\.e|etc|Op|op|U\.S|U\.K)|\b[A-Z])\.$/;

// Split a tossup into sentences while tracking each one's start offset in the
// plain text, so we know how early in the question the clue appears.
function splitSentences(text) {
  const sentences = [];
  const re = /[.!?]["'”’)]*\s+(?=["“'(]?[A-Z0-9])/g;
  let start = 0;
  let m;
  while ((m = re.exec(text))) {
    const end = m.index + m[0].trimEnd().length;
    const candidate = text.slice(start, end);
    if (ABBREVIATIONS.test(candidate.slice(0, m.index - start + 1))) continue;
    sentences.push({ text: candidate.trim(), start });
    start = m.index + m[0].length;
  }
  if (start < text.length) sentences.push({ text: text.slice(start).trim(), start });
  return sentences;
}

// Sentences that only make sense after the previous one ("Both of these...").
const DEPENDENT = /^(both of (these|them)|these|those|the (former|latter)|another|one of (these|them)|that|this one|in (it|that|addition)|later|also)\b/i;

const GIVEAWAY = /\b(for (10|ten|15|fifteen) points|ftp)\b/i;

function cleanClue(s) {
  return s
    .replace(/\(\*\)/g, '')
    .replace(/\[[^\]]*\]/g, '') // pronunciation guides and moderator notes
    .replace(/,?\s*\b(for (10|ten|15|fifteen) points|ftp)\b\s*,?/gi, ' ')
    .replace(/\s+([,.;:?!])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[a-z]/, (c) => c.toUpperCase());
}

// Generic words that appear in answers but don't give them away on their own.
const GENERIC_WORDS = new Set([
  'book', 'books', 'river', 'battle', 'treaty', 'king', 'queen', 'saint', 'mount',
  'lake', 'island', 'islands', 'city', 'empire', 'theory', 'effect', 'cycle',
  'house', 'state', 'states', 'united', 'north', 'south', 'east', 'west', 'great',
  'first', 'second', 'third', 'with', 'from', 'symphony', 'concerto', 'sonata',
]);

// Any significant word of the answer showing up in a clue gives it away.
function leaksAnswer(clue, target) {
  const words = target.split(' ').filter((w) => w.length >= 4 && !GENERIC_WORDS.has(w));
  const norm = ` ${normalize(clue)} `;
  if (norm.includes(` ${target} `)) return true;
  return words.some((w) => norm.includes(` ${w} `));
}

function similar(a, b) {
  const wa = new Set(normalize(a).split(' '));
  const wb = new Set(normalize(b).split(' '));
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  return inter / Math.min(wa.size, wb.size) > 0.6;
}

// ---------- clue scoring ----------

// Hardness in roughly [-0.4, 1.4]. Earlier in the question = harder, clues
// before the power mark get a boost, the "for 10 points" giveaway is easiest,
// and questions written at a harder difficulty nudge their clues upward.
function extractClues(tossup, target, tierMin) {
  const plain = stripHtml(tossup.question).replace(/\s+/g, ' ').trim();
  const powerIdx = plain.indexOf('(*)');
  const sentences = splitSentences(plain);
  const clues = [];

  for (const s of sentences) {
    const text = cleanClue(s.text);
    if (text.length < 30 || DEPENDENT.test(text) || leaksAnswer(text, target)) continue;

    const position = s.start / plain.length;
    const sentenceEnd = s.start + s.text.length;
    const inPower = powerIdx !== -1 && sentenceEnd <= powerIdx + 3;
    const giveaway = GIVEAWAY.test(s.text);

    let hardness = 1 - position;
    if (inPower) hardness += 0.15;
    if (giveaway) hardness -= 0.4;
    hardness += (tossup.difficulty - tierMin) * 0.1;

    clues.push({
      text,
      hardness: Math.round(hardness * 1000) / 1000,
      inPower,
      giveaway,
      difficulty: tossup.difficulty,
      source: `${tossup.set.name}${tossup.packet?.name ? `, Packet ${tossup.packet.name}` : ''}`,
    });
  }
  return clues;
}

function pickClues(pool) {
  const sorted = [...pool].sort((a, b) => b.hardness - a.hardness);
  const unique = [];
  for (const c of sorted) {
    if (!unique.some((u) => similar(u.text, c.text))) unique.push(c);
  }
  if (unique.length < CLUES_PER_PUZZLE) return null;

  // Spread the picks evenly from hardest to easiest.
  const picks = [];
  for (let i = 0; i < CLUES_PER_PUZZLE; i++) {
    picks.push(unique[Math.round((i * (unique.length - 1)) / (CLUES_PER_PUZZLE - 1))]);
  }
  return picks;
}

async function buildTier(answer, target, category, tier, rand) {
  // Prefer tossups from today's category at this tier's difficulty, then widen.
  const attempts = [
    [tier.difficulties, category],
    [tier.fallback, category],
    [tier.difficulties, null],
    [tier.fallback, null],
  ];
  let tossups = [];
  for (const [difficulties, cat] of attempts) {
    tossups = (await tossupsFor(answer, difficulties, cat)).filter((t) => matchesTarget(t, target));
    if (tossups.length >= 3) break;
  }
  if (tossups.length < 2) return null;

  // Cap the pool so one heavily-asked answer doesn't always use the same sets.
  tossups = shuffle(tossups, rand).slice(0, 12);
  const tierMin = Math.min(...tier.difficulties);
  const pool = tossups.flatMap((t) => extractClues(t, target, tierMin));
  const clues = pickClues(pool);
  if (!clues) return null;

  const answerlines = [...new Set(tossups.map((t) => t.answer))].slice(0, 5);
  return { answerlines, clues };
}

// ---------- main ----------

const REPEAT_WINDOW_DAYS = 120;

// Answers used recently, and yesterday's category, so puzzles don't repeat.
function recentHistory(date) {
  const answers = new Set();
  const categoryUses = {};
  let yesterdayCategory = null;
  for (let i = 1; i <= REPEAT_WINDOW_DAYS; i++) {
    const file = join(OUT_DIR, `${addDays(date, -i)}.json`);
    if (!existsSync(file)) continue;
    const p = JSON.parse(readFileSync(file, 'utf8'));
    answers.add(normalize(p.answer));
    if (i <= CATEGORIES.length) categoryUses[p.category] = (categoryUses[p.category] ?? 0) + 1;
    if (i === 1) yesterdayCategory = p.category;
  }
  return { answers, categoryUses, yesterdayCategory };
}

async function generate(date) {
  const rand = mulberry32(hashString(`quizbowldle-${date}`));
  const { answers: used, categoryUses, yesterdayCategory } = recentHistory(date);
  // Random order, but categories used least in the last stretch of days go first.
  const categories = shuffle(CATEGORIES, rand)
    .filter((c) => c !== yesterdayCategory)
    .sort((a, b) => (categoryUses[a] ?? 0) - (categoryUses[b] ?? 0));

  for (const category of categories) {
    const answers = shuffle(await topAnswers(category), rand).filter((a) => !used.has(normalize(a.answer)));
    for (const entry of answers.slice(0, 8)) {
      const target = normalize(entry.answer);
      const tiers = {};
      let ok = true;
      for (const [name, tier] of Object.entries(TIERS)) {
        const result = await buildTier(entry.answer, target, category, tier, rand);
        if (!result) {
          ok = false;
          break;
        }
        tiers[name] = result;
      }
      if (ok) return { date, category, answer: entry.answer, tiers };
      console.log(`  skipped "${entry.answer}" (not enough clues)`);
    }
  }
  throw new Error(`Could not build a puzzle for ${date}`);
}

function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const args = process.argv.slice(2).filter((a) => a !== '--force');
const force = process.argv.includes('--force');
const today = new Date().toISOString().slice(0, 10);
const start = args[0] ?? addDays(today, -1); // cover time zones behind UTC
const count = args[1] ? Number(args[1]) : args[0] ? 1 : 9;

mkdirSync(OUT_DIR, { recursive: true });
for (let i = 0; i < count; i++) {
  const date = addDays(start, i);
  const file = join(OUT_DIR, `${date}.json`);
  if (existsSync(file) && !force) {
    console.log(`${date}: exists, skipping`);
    continue;
  }
  console.log(`${date}: generating...`);
  const puzzle = await generate(date);
  writeFileSync(file, `${JSON.stringify(puzzle, null, 2)}\n`);
  console.log(`${date}: ${puzzle.category} -> ${puzzle.answer}`);
}
