// Builds answers.json: the most-asked tossup answers on QB Reader across every
// category, used by the site's "Did you mean …?" spelling suggestions.
//
// Usage: node scripts/build-vocab.mjs

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const API = 'https://www.qbreader.org/api';
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'answers.json');
const PER_CATEGORY = 600;

const CATEGORIES = [
  'Literature', 'History', 'Science', 'Fine Arts', 'Religion', 'Mythology',
  'Philosophy', 'Social Science', 'Geography', 'Current Events', 'Other Academic', 'Pop Culture',
];

const counts = new Map();
for (const category of CATEGORIES) {
  const params = new URLSearchParams({ category, questionType: 'tossup', limit: PER_CATEGORY });
  const res = await fetch(`${API}/frequency-list?${params}`);
  if (!res.ok) throw new Error(`Failed to fetch ${category}`);
  for (const { answer, count } of (await res.json()).frequencyList) {
    const clean = answer.replace(/^["“'‘]+|["”'’]+$/g, '').replace(/\s+/g, ' ').trim();
    if (clean.length < 3) continue;
    counts.set(clean, (counts.get(clean) ?? 0) + count);
  }
  await new Promise((r) => setTimeout(r, 200));
}

const answers = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([a]) => a);
writeFileSync(OUT, `${JSON.stringify(answers)}\n`);
console.log(`Wrote ${answers.length} answers to answers.json`);
