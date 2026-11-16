# Quizbowldle

A daily, Wordle-style quizbowl game built from [QB Reader](https://www.qbreader.org) tossups.

## How it works

- Each day a random category is chosen, and an answer is picked from that category's 50 most-asked tossup answers.
- Tossups with that answer are pulled from QB Reader (tossups only, no bonuses) and split into clues.
- Each clue gets a hardness score: earlier in the question = harder, clues before the power mark `(*)` get a boost, and the "for 10 points" giveaway is easiest.
- Players pick a difficulty. Each one draws on different question sets:
  - **Easy**: middle school and easy high school (QB Reader levels 1–2)
  - **Medium**: regular high school (level 3)
  - **Hard**: hard high school and HS nationals (levels 4–5)
- You start with 1000 points. Each new clue costs 100 and each wrong answer costs 250. Three wrong answers and you lose. There are 10 clues going from hardest to easiest, and the last clue gets one attempt.
- Answers are checked with QB Reader's answer checker, which handles prompts and alternate answers.
- If a rejected answer looks like a misspelling of a known quizbowl answer, the game asks "Did you mean …?" before counting it as a strike. The answer list (`answers.json`) comes from QB Reader's most-asked answers in every category and is rebuilt daily by `scripts/build-vocab.mjs`.

## Generating puzzles

Puzzles are static JSON files in `puzzles/`. A GitHub Action (`.github/workflows/generate.yml`) runs daily and generates the coming week's puzzles.

To generate puzzles manually (Node 18+):

```sh
node scripts/generate.mjs                  # yesterday through the next week (UTC)
node scripts/generate.mjs 2026-12-01       # one date
node scripts/generate.mjs 2026-12-01 30    # 30 days starting on a date
node scripts/generate.mjs 2026-12-01 --force  # regenerate an existing puzzle
```

## Running locally

```sh
python3 -m http.server
```

Then open http://localhost:8000.
