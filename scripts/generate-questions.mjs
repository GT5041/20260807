#!/usr/bin/env node
/*
 * Publishes a new day's 30-question CCAR-F practice exam by deterministically
 * rotating through data/question-pool.json — a static, hand-authored bank of
 * questions (12+ per domain). No external API calls or API keys are used;
 * the "daily update" comes from picking a different 6-question slice per
 * domain each day, reshuffled (with a date-derived seed) every time the pool
 * is fully cycled through, so the same 30 questions don't repeat back to
 * back and the rotation order isn't identical from one cycle to the next.
 *
 * To add more variety over time, append more questions to
 * data/question-pool.json (grouped by domain) — no code changes needed.
 *
 * Optional: FORCE=true to regenerate even if today's file already exists.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const QUESTIONS_DIR = path.join(ROOT, "data", "questions");
const MANIFEST_PATH = path.join(ROOT, "data", "manifest.json");
const POOL_PATH = path.join(ROOT, "data", "question-pool.json");

const QUESTIONS_PER_DOMAIN = 6;
const DOMAINS = [1, 2, 3, 4, 5];

// Day 0 of the rotation — the pool's original seed date. Changing this
// would just re-phase the rotation; it doesn't need to track today's date.
const EPOCH_DATE = "2026-08-07";

function todayJST() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function daysBetween(fromDateStr, toDateStr) {
  const [fy, fm, fd] = fromDateStr.split("-").map(Number);
  const [ty, tm, td] = toDateStr.split("-").map(Number);
  const from = Date.UTC(fy, fm - 1, fd);
  const to = Date.UTC(ty, tm - 1, td);
  return Math.round((to - from) / 86400000);
}

// Small deterministic string hash -> 32-bit seed for mulberry32.
function hashSeed(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededShuffle(items, seed) {
  const rng = mulberry32(hashSeed(seed));
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// Picks 6 questions for one domain on a given day index, cycling through
// the domain's full pool before any question repeats, and reshuffling
// (with a cycle-specific seed) each time the pool is exhausted and restarts.
function pickForDomain(domainPool, domain, dayIndex) {
  const cycleLength = Math.ceil(domainPool.length / QUESTIONS_PER_DOMAIN);
  const cycle = Math.floor(dayIndex / cycleLength);
  const position = dayIndex % cycleLength;
  const shuffled = seededShuffle(domainPool, `domain${domain}-cycle${cycle}`);
  const start = position * QUESTIONS_PER_DOMAIN;
  const picked = [];
  for (let i = 0; i < QUESTIONS_PER_DOMAIN; i++) {
    picked.push(shuffled[(start + i) % shuffled.length]);
  }
  return picked;
}

async function main() {
  const date = todayJST();
  const outPath = path.join(QUESTIONS_DIR, `${date}.json`);

  if (process.env.FORCE !== "true") {
    try {
      await readFile(outPath, "utf8");
      console.log(`data/questions/${date}.json already exists; skipping (set FORCE=true to regenerate).`);
      return;
    } catch {
      // doesn't exist yet, proceed
    }
  }

  const pool = JSON.parse(await readFile(POOL_PATH, "utf8")).questions;
  const dayIndex = daysBetween(EPOCH_DATE, date);

  const selected = [];
  for (const domain of DOMAINS) {
    const domainPool = pool.filter((q) => q.domain === domain);
    if (domainPool.length < QUESTIONS_PER_DOMAIN) {
      throw new Error(`Domain ${domain} has only ${domainPool.length} pool questions; needs at least ${QUESTIONS_PER_DOMAIN}.`);
    }
    selected.push(...pickForDomain(domainPool, domain, dayIndex));
  }

  // Interleave in domain order (already grouped) and assign day-scoped ids;
  // poolId is kept for traceability back to data/question-pool.json.
  const questions = selected.map((q, i) => ({
    id: `${date}-${String(i + 1).padStart(2, "0")}`,
    poolId: q.id,
    domain: q.domain,
    taskStatement: q.taskStatement,
    context: q.context,
    stem: q.stem,
    choices: q.choices,
    correctAnswer: q.correctAnswer,
    explanationEn: q.explanationEn,
    explanationJa: q.explanationJa,
  }));

  await mkdir(QUESTIONS_DIR, { recursive: true });
  await writeFile(outPath, JSON.stringify({ date, generatedBy: "pool-rotation", questions }, null, 2) + "\n", "utf8");
  console.log(`Wrote ${outPath} (day index ${dayIndex}, pool size ${pool.length})`);

  let manifest = { dates: [] };
  try {
    manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
  } catch {
    // starting fresh
  }
  const dates = Array.from(new Set([...(manifest.dates || []), date])).sort();
  await writeFile(MANIFEST_PATH, JSON.stringify({ dates }, null, 2) + "\n", "utf8");
  console.log(`Updated manifest with ${dates.length} date(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
