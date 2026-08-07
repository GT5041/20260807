#!/usr/bin/env node
/*
 * Generates a new day's worth of CCAR-F practice exam questions by calling
 * the Claude API with a forced tool_use call so the response is guaranteed
 * to be schema-valid JSON (Domain 4 of the exam itself: structured output
 * via tool_use + JSON schema, chosen deliberately over free-text parsing).
 *
 * Requires: ANTHROPIC_API_KEY in the environment.
 * Optional: GENERATION_MODEL (defaults to claude-opus-5), FORCE=true to
 * regenerate even if today's file already exists.
 */

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const QUESTIONS_DIR = path.join(ROOT, "data", "questions");
const MANIFEST_PATH = path.join(ROOT, "data", "manifest.json");

const MODEL = process.env.GENERATION_MODEL || "claude-opus-5";
const API_KEY = process.env.ANTHROPIC_API_KEY;
const MAX_ATTEMPTS = 3;
const LOOKBACK_DAYS = 14;

if (!API_KEY) {
  console.error("ANTHROPIC_API_KEY is not set. Add it as a repository secret.");
  process.exit(1);
}

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

const DOMAINS = [
  {
    n: 1,
    en: "Agentic Architecture & Orchestration",
    ja: "エージェント・アーキテクチャとオーケストレーション",
    tasks: [
      "1.1 Agentic loops: stop_reason-driven control flow, appending tool results to context, avoiding text-parsing/iteration-cap-as-success anti-patterns",
      "1.2 Coordinator-subagent orchestration: hub-and-spoke routing, dynamic subagent selection, iterative refinement loops, avoiding overly narrow task decomposition",
      "1.3 Subagent invocation: Task tool + allowedTools, explicit context passing (no auto-inheritance), AgentDefinition config, parallel Task calls in one turn, fork-based sessions",
      "1.4 Multi-step workflow enforcement: programmatic prerequisite gates vs. prompt-based guidance, structured handoff summaries for escalation",
      "1.5 Agent SDK hooks: PostToolUse for data normalization, tool-call interception for compliance rules, hooks vs. prompt-based enforcement",
      "1.6 Task decomposition strategy: fixed prompt chaining vs. dynamic adaptive decomposition, per-file plus cross-file review passes",
      "1.7 Session state: --resume <name>, fork_session, informing resumed sessions about file changes, fresh session + structured summary vs. stale resume",
    ],
  },
  {
    n: 2,
    en: "Tool Design & MCP Integration",
    ja: "ツール設計とMCP統合",
    tasks: [
      "2.1 Tool interface design: descriptions as the primary tool-selection signal, eliminating overlap/ambiguity, splitting vs. consolidating tools",
      "2.2 Structured MCP error responses: isError flag, errorCategory (transient/validation/business/permission), isRetryable, distinguishing access failures from valid empty results",
      "2.3 Tool distribution and tool_choice: scoped access per agent role, risks of oversized toolsets, tool_choice auto/any/forced",
      "2.4 MCP server integration: .mcp.json (project) vs. ~/.claude.json (user), environment variable expansion for secrets, MCP resources for content catalogs",
      "2.5 Built-in tools: Grep for content search, Glob for path patterns, Read/Write vs. Edit, Read+Write fallback when Edit anchor text isn't unique",
    ],
  },
  {
    n: 3,
    en: "Claude Code Configuration & Workflows",
    ja: "Claude Code設定とワークフロー",
    tasks: [
      "3.1 CLAUDE.md hierarchy: user (~/.claude/CLAUDE.md, not shared) vs. project vs. directory scope, @import, .claude/rules/ for modular organization, /memory",
      "3.2 Custom slash commands and skills: .claude/commands/ (project, shared) vs. ~/.claude/commands/ (personal), SKILL.md frontmatter (context: fork, allowed-tools, argument-hint)",
      "3.3 Path-specific rules: .claude/rules/ YAML frontmatter glob paths, conditional loading vs. directory-level CLAUDE.md",
      "3.4 Plan mode vs. direct execution: architectural/multi-file/multiple-valid-approach tasks vs. simple well-scoped changes, Explore subagent for verbose discovery",
      "3.5 Iterative refinement: concrete input/output examples, test-driven iteration, the interview pattern for underspecified domains, single message for interacting issues vs. sequential for independent ones",
      "3.6 CI/CD integration: -p/--print for non-interactive mode, --output-format json + --json-schema, CLAUDE.md for CI context, independent review session vs. self-review bias, prior findings context to avoid duplicate comments",
    ],
  },
  {
    n: 4,
    en: "Prompt Engineering & Structured Output",
    ja: "プロンプトエンジニアリングと構造化出力",
    tasks: [
      "4.1 Explicit criteria: categorical report/skip criteria beat vague 'be conservative' or confidence-based filtering for reducing false positives",
      "4.2 Few-shot prompting: targeted examples for ambiguous-case reasoning, format consistency, generalization beyond the exact examples shown",
      "4.3 Structured output via tool_use + JSON schema: tool_choice auto/any/forced, schemas eliminate syntax errors but not semantic errors, nullable fields to prevent hallucination",
      "4.4 Validation/retry/feedback loops: retry-with-error-feedback works for format errors, not for information genuinely absent from the source",
      "4.5 Batch processing: Message Batches API (50% cost savings, up to 24h window, no latency SLA, no multi-turn tool calling), custom_id correlation, matching API to latency tolerance",
      "4.6 Multi-instance/multi-pass review: self-review limitations vs. independent review instances, per-file plus cross-file integration passes",
    ],
  },
  {
    n: 5,
    en: "Context Management & Reliability",
    ja: "コンテキスト管理と信頼性",
    tasks: [
      "5.1 Context preservation: progressive summarization risk for numbers/dates/expectations, lost-in-the-middle effect, persistent 'case facts' blocks, trimming verbose tool output",
      "5.2 Escalation and ambiguity resolution: explicit customer request, policy gaps/exceptions, unreliable sentiment/self-confidence proxies, requesting identifiers on multiple matches",
      "5.3 Error propagation in multi-agent systems: structured failure context vs. generic statuses, access failure vs. valid empty result, local recovery before escalation",
      "5.4 Context management in large codebase exploration: context degradation over long sessions, scratchpad files, subagent delegation for verbose discovery, /compact",
      "5.5 Human review workflows: aggregate accuracy masking segment-level weakness, stratified sampling, field-level confidence calibration by document type/field",
      "5.6 Information provenance: claim-source mappings, annotating conflicting statistics rather than blending them, requiring publication/collection dates for temporal context",
    ],
  },
];

const STYLE_GUIDELINES = `
Write every item to the difficulty and style of the CCAR-F exam's own published sample questions:
- Ground every stem in a concrete, realistic production scenario (a named system, a metric, a percentage, a specific tool or file count, a customer-facing or investigative context). Use precise professional register and vocabulary a native English-speaking solutions architect would use; do not simplify or write for language learners.
- All four answer choices must be plausible to someone who has only skimmed the topic. Do NOT include an obviously-wrong "anti-pattern" distractor that a test-taker can eliminate without real domain knowledge. Every distractor should reflect a real, tempting misconception (over-engineering, treating a symptom instead of a root cause, a mechanism that sounds relevant but solves the wrong problem, a prompt-based fix where a deterministic one is required, etc.).
- The correct answer must require genuinely knowing CCAR-F content (Claude Agent SDK, MCP, Claude Code, the Claude API, or the Message Batches API) to identify — not general software-engineering common sense alone.
- Each item must be answerable from the stem plus general CCAR-F knowledge; do not require information you haven't stated.
- Vary which letter (A-D) holds the correct answer roughly evenly across the 30 items in this set; do not default to always putting the correct answer first.
- explanationEn: 3-5 sentences. State why the correct choice is right, then briefly say why EACH of the other three is wrong (not just "the others are wrong"), referencing the specific mechanism or misconception each represents. Do not refer to choices by letter (a shuffle may be applied after generation) — refer to them by their content, e.g. "the retry-based approach" or "the confidence-threshold option".
- explanationJa: a faithful, natural Japanese translation of explanationEn (not a summary) — same content, same structure, written for a Japanese-speaking engineer, not a literal word-for-word gloss.
- context: a short 3-8 word freeform label for the scenario (e.g. "Invoice-processing extraction pipeline").
- taskStatement: the task statement code you targeted, e.g. "2.3".
`.trim();

async function loadRecentStems() {
  let files = [];
  try {
    files = await readdir(QUESTIONS_DIR);
  } catch {
    return [];
  }
  const dated = files.filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().slice(-LOOKBACK_DAYS);
  const stems = [];
  for (const f of dated) {
    try {
      const data = JSON.parse(await readFile(path.join(QUESTIONS_DIR, f), "utf8"));
      for (const q of data.questions || []) {
        stems.push(`[domain ${q.domain}] ${q.stem.slice(0, 220)}`);
      }
    } catch {
      // ignore unreadable/legacy files
    }
  }
  return stems;
}

const QUESTION_TOOL = {
  name: "submit_exam",
  description: "Submit the generated set of 30 CCAR-F practice exam questions.",
  input_schema: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        minItems: 30,
        maxItems: 30,
        items: {
          type: "object",
          properties: {
            domain: { type: "integer", enum: [1, 2, 3, 4, 5] },
            taskStatement: { type: "string" },
            context: { type: "string" },
            stem: { type: "string" },
            choices: {
              type: "array",
              minItems: 4,
              maxItems: 4,
              items: {
                type: "object",
                properties: {
                  key: { type: "string", enum: ["A", "B", "C", "D"] },
                  text: { type: "string" },
                },
                required: ["key", "text"],
              },
            },
            correctAnswer: { type: "string", enum: ["A", "B", "C", "D"] },
            explanationEn: { type: "string" },
            explanationJa: { type: "string" },
          },
          required: [
            "domain",
            "taskStatement",
            "context",
            "stem",
            "choices",
            "correctAnswer",
            "explanationEn",
            "explanationJa",
          ],
        },
      },
    },
    required: ["questions"],
  },
};

function buildSystemPrompt() {
  const domainBlock = DOMAINS.map(
    (d) => `Domain ${d.n}: ${d.en} (${d.ja})\n${d.tasks.map((t) => "  - " + t).join("\n")}`
  ).join("\n\n");

  return `You are writing today's item bank for a practice exam modeled on the "Claude Certified Architect - Foundations" (CCAR-F) exam guide. Generate exactly 30 new multiple-choice questions: exactly 6 from each of the 5 domains below, covering a broad spread of the listed task statements within each domain (don't concentrate on just one or two per domain). Each question has exactly 4 answer choices with exactly one correct answer.

${domainBlock}

${STYLE_GUIDELINES}

Call the submit_exam tool with the complete set of 30 questions. Do not include any commentary outside the tool call.`;
}

function validate(questions) {
  const errors = [];
  if (!Array.isArray(questions) || questions.length !== 30) {
    errors.push(`Expected exactly 30 questions, got ${Array.isArray(questions) ? questions.length : typeof questions}.`);
    return errors;
  }
  const counts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  questions.forEach((q, i) => {
    if (!counts.hasOwnProperty(q.domain)) {
      errors.push(`Question ${i + 1}: invalid domain ${q.domain}.`);
      return;
    }
    counts[q.domain]++;
    const keys = (q.choices || []).map((c) => c.key);
    if (JSON.stringify([...keys].sort()) !== JSON.stringify(["A", "B", "C", "D"])) {
      errors.push(`Question ${i + 1}: choices must have exactly keys A-D, got ${keys.join(",")}.`);
    }
    if (!["A", "B", "C", "D"].includes(q.correctAnswer)) {
      errors.push(`Question ${i + 1}: correctAnswer must be one of A-D.`);
    } else if (!keys.includes(q.correctAnswer)) {
      errors.push(`Question ${i + 1}: correctAnswer ${q.correctAnswer} not among its own choices.`);
    }
    if (!q.stem || q.stem.length < 40) {
      errors.push(`Question ${i + 1}: stem missing or too short.`);
    }
    if (!q.explanationEn || q.explanationEn.length < 40) {
      errors.push(`Question ${i + 1}: explanationEn missing or too short.`);
    }
    if (!q.explanationJa || q.explanationJa.length < 20) {
      errors.push(`Question ${i + 1}: explanationJa missing or too short.`);
    }
  });
  for (const [domain, count] of Object.entries(counts)) {
    if (count !== 6) {
      errors.push(`Domain ${domain}: expected 6 questions, got ${count}.`);
    }
  }
  return errors;
}

async function callClaude(messages) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 16000,
      system: buildSystemPrompt(),
      tools: [QUESTION_TOOL],
      tool_choice: { type: "tool", name: "submit_exam" },
      messages,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${text.slice(0, 500)}`);
  }
  const body = await res.json();
  const toolUse = body.content?.find((block) => block.type === "tool_use" && block.name === "submit_exam");
  if (!toolUse) {
    throw new Error(`No submit_exam tool call in response: ${JSON.stringify(body).slice(0, 500)}`);
  }
  return toolUse.input.questions;
}

async function generate(date, recentStems) {
  const avoidBlock =
    recentStems.length > 0
      ? `\n\nAvoid closely repeating the scenarios, wording, or specific numeric setups of these questions from the past ${LOOKBACK_DAYS} days:\n${recentStems
          .slice(0, 200)
          .map((s) => "- " + s)
          .join("\n")}`
      : "";

  const messages = [
    {
      role: "user",
      content: `Generate today's (${date}) 30-question item bank now.${avoidBlock}`,
    },
  ];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const questions = await callClaude(messages);
    const errors = validate(questions);
    if (errors.length === 0) {
      return questions;
    }
    console.warn(`Attempt ${attempt} failed validation:\n${errors.join("\n")}`);
    if (attempt === MAX_ATTEMPTS) {
      throw new Error(`Generation failed validation after ${MAX_ATTEMPTS} attempts:\n${errors.join("\n")}`);
    }
    messages.push({ role: "assistant", content: [{ type: "tool_use", id: "retry", name: "submit_exam", input: { questions } }] });
    messages.push({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "retry",
          content: `Validation failed:\n${errors.join("\n")}\nPlease call submit_exam again with a corrected, complete set of exactly 30 questions.`,
        },
      ],
    });
  }
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

  const recentStems = await loadRecentStems();
  console.log(`Generating ${date} with model ${MODEL}, using ${recentStems.length} recent stems for dedup context...`);
  const questions = await generate(date, recentStems);

  questions.forEach((q, i) => {
    q.id = `${date}-${String(i + 1).padStart(2, "0")}`;
  });

  await mkdir(QUESTIONS_DIR, { recursive: true });
  await writeFile(outPath, JSON.stringify({ date, generatedBy: "github-actions", questions }, null, 2) + "\n", "utf8");
  console.log(`Wrote ${outPath}`);

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
