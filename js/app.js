/* CCAR-F Practice Exam — shared client logic
   No build step: plain ES module loaded via <script type="module"> in each page. */

export const DOMAIN_META = {
  1: {
    en: "Agentic Architecture & Orchestration",
    ja: "エージェント・アーキテクチャとオーケストレーション",
    descEn: "Designing agentic loops, coordinator-subagent orchestration, subagent invocation and context passing, multi-step workflow enforcement and handoff, Agent SDK hooks, task decomposition strategy, and session state management.",
    descJa: "エージェンティックループの設計、コーディネーター・サブエージェント構成によるオーケストレーション、サブエージェントの起動とコンテキスト受け渡し、複数ステップワークフローの強制と引き継ぎ、Agent SDKフックの適用、タスク分解戦略、セッション状態の管理を扱うドメインです。",
  },
  2: {
    en: "Tool Design & MCP Integration",
    ja: "ツール設計とMCP統合",
    descEn: "Designing effective tool interfaces and boundaries, structured MCP error responses, distributing tools across agents and configuring tool_choice, integrating MCP servers into Claude Code and agent workflows, and selecting built-in tools (Read, Write, Edit, Bash, Grep, Glob).",
    descJa: "効果的なツールインターフェースと境界の設計、MCPの構造化エラー応答、エージェント間でのツール配分とtool_choiceの設定、Claude CodeおよびエージェントワークフローへのMCPサーバー統合、組み込みツール（Read、Write、Edit、Bash、Grep、Glob）の選択を扱うドメインです。",
  },
  3: {
    en: "Claude Code Configuration & Workflows",
    ja: "Claude Code設定とワークフロー",
    descEn: "Configuring the CLAUDE.md hierarchy and modular organization, custom slash commands and skills, path-specific rules, choosing plan mode vs. direct execution, iterative refinement techniques, and integrating Claude Code into CI/CD pipelines.",
    descJa: "CLAUDE.mdの階層構造とモジュール構成、カスタムスラッシュコマンドとスキルの作成、パス指定ルール、プランモードと直接実行の使い分け、反復的な改善手法、CI/CDパイプラインへのClaude Code統合を扱うドメインです。",
  },
  4: {
    en: "Prompt Engineering & Structured Output",
    ja: "プロンプトエンジニアリングと構造化出力",
    descEn: "Designing prompts with explicit criteria to reduce false positives, applying few-shot prompting, enforcing structured output via tool_use and JSON schemas, validation/retry/feedback loops, batch processing strategy, and multi-instance/multi-pass review architectures.",
    descJa: "誤検知を減らすための明示的な基準を用いたプロンプト設計、few-shotプロンプティングの適用、tool_useとJSONスキーマによる構造化出力の強制、検証・リトライ・フィードバックループ、バッチ処理戦略、マルチインスタンス／マルチパスレビュー構成を扱うドメインです。",
  },
  5: {
    en: "Context Management & Reliability",
    ja: "コンテキスト管理と信頼性",
    descEn: "Managing conversation context across long interactions, designing escalation and ambiguity resolution patterns, error propagation across multi-agent systems, managing context during large codebase exploration, human review workflow and confidence calibration, and preserving provenance in multi-source synthesis.",
    descJa: "長時間の対話にわたるコンテキスト管理、エスカレーションと曖昧性解決パターンの設計、マルチエージェントシステムにおけるエラー伝播、大規模コードベース探索時のコンテキスト管理、人によるレビューワークフローと信頼度較正、複数情報源統合における出典管理を扱うドメインです。",
  },
};

const STATE_PREFIX = "ccarf:state:";

export function getTodayDateString() {
  // Anchor the exam day to JST so the daily rotation lines up with the
  // audience's calendar day rather than UTC's.
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function basePath() {
  // Resolve data/ relative to the page regardless of subdirectory depth.
  return new URL(".", document.baseURI).pathname.endsWith("/")
    ? "."
    : ".";
}

async function fetchJSON(path) {
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to fetch ${path}: ${res.status}`);
  return res.json();
}

let manifestCache = null;
export async function loadManifest() {
  if (manifestCache) return manifestCache;
  manifestCache = await fetchJSON("data/manifest.json");
  return manifestCache;
}

function resolveDate(manifest, today) {
  const dates = [...manifest.dates].sort();
  if (dates.includes(today)) return today;
  const earlier = dates.filter((d) => d <= today);
  if (earlier.length) return earlier[earlier.length - 1];
  return dates[dates.length - 1];
}

const CUSTOM_EXAM_KEY = "ccarf:custom-exam";

function loadStoredCustomExam() {
  try {
    const raw = localStorage.getItem(CUSTOM_EXAM_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

let examCache = null;
export async function loadTodaysExam() {
  if (examCache) return examCache;
  const custom = loadStoredCustomExam();
  if (custom) {
    examCache = { requestedDate: custom.date, ...custom };
    return examCache;
  }
  const today = getTodayDateString();
  const manifest = await loadManifest();
  const date = resolveDate(manifest, today);
  const data = await fetchJSON(`data/questions/${date}.json`);
  examCache = { requestedDate: today, ...data };
  return examCache;
}

function shuffleArray(items) {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Pulls every question generated so far (across all daily files listed in
// the manifest) so the swap feature has more than just today's 30 to draw
// from once several days' worth of files have accumulated.
async function loadQuestionPool() {
  const manifest = await loadManifest();
  const dates = [...manifest.dates].sort();
  const files = await Promise.all(
    dates.map((date) => fetchJSON(`data/questions/${date}.json`).catch(() => null))
  );
  const seen = new Set();
  const pool = [];
  files.forEach((file) => {
    if (!file) return;
    file.questions.forEach((q) => {
      if (seen.has(q.id)) return;
      seen.add(q.id);
      pool.push(q);
    });
  });
  return pool;
}

// Resets progress and picks a fresh set of 30 questions (six per domain,
// where available) drawn at random from every question generated so far.
export async function reshuffleExam(targetTotal = 30, perDomain = 6) {
  const pool = await loadQuestionPool();

  const selected = [];
  for (let domain = 1; domain <= 5; domain++) {
    const domainPool = shuffleArray(pool.filter((q) => q.domain === domain));
    selected.push(...domainPool.slice(0, perDomain));
  }

  if (selected.length < targetTotal) {
    const chosenIds = new Set(selected.map((q) => q.id));
    const remaining = shuffleArray(pool.filter((q) => !chosenIds.has(q.id)));
    selected.push(...remaining.slice(0, targetTotal - selected.length));
  }

  const questions = shuffleArray(selected).slice(0, targetTotal);

  const exam = {
    date: `custom-${Date.now()}`,
    label: getTodayDateString(),
    generatedBy: "shuffled",
    custom: true,
    questions,
  };

  const previous = loadStoredCustomExam();
  if (previous) localStorage.removeItem(stateKey(previous.date));

  localStorage.setItem(CUSTOM_EXAM_KEY, JSON.stringify(exam));
  examCache = { requestedDate: exam.label, ...exam };
  return examCache;
}

export function hasCustomExam() {
  return Boolean(loadStoredCustomExam());
}

export function clearCustomExam() {
  const previous = loadStoredCustomExam();
  if (previous) localStorage.removeItem(stateKey(previous.date));
  localStorage.removeItem(CUSTOM_EXAM_KEY);
  examCache = null;
}

function stateKey(date) {
  return STATE_PREFIX + date;
}

export function getState(date) {
  try {
    const raw = localStorage.getItem(stateKey(date));
    return raw ? JSON.parse(raw) : { answers: {} };
  } catch {
    return { answers: {} };
  }
}

export function saveAnswer(date, index, choiceKey) {
  const state = getState(date);
  state.answers[index] = choiceKey;
  localStorage.setItem(stateKey(date), JSON.stringify(state));
}

export function summarize(exam, state) {
  const total = exam.questions.length;
  let answered = 0;
  let correct = 0;
  const byDomain = {};
  for (let i = 1; i <= 5; i++) byDomain[i] = { total: 0, answered: 0, correct: 0 };

  exam.questions.forEach((q, idx) => {
    byDomain[q.domain].total++;
    const given = state.answers[idx];
    if (given) {
      answered++;
      byDomain[q.domain].answered++;
      if (given === q.correctAnswer) {
        correct++;
        byDomain[q.domain].correct++;
      }
    }
  });

  return { total, answered, correct, byDomain };
}

export function qs(name) {
  return new URLSearchParams(window.location.search).get(name);
}

export function formatDateLabel(dateStr) {
  const [y, m, d] = dateStr.split("-");
  return `${y}-${m}-${d} (JST)`;
}
