#!/usr/bin/env node
/**
 * Feedback loop: is the *first* of two sequential DeepInfra chat calls faster
 * even when both requests are byte-identical?
 *
 * RED (symptom holds): first is faster in a majority of identical-pair trials.
 * GREEN (no position bias): ~50/50 within noise.
 *
 * Usage:
 *   node scripts/diag-first-faster.mjs
 *   TRIALS=8 GAP_MS=0 node scripts/diag-first-faster.mjs
 *   GAP_MS=2000 node scripts/diag-first-faster.mjs   # pause between calls
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHAT = "https://api.deepinfra.com/v1/openai/chat/completions";
const TRIALS = Math.max(1, Number(process.env.TRIALS) || 6);
const GAP_MS = Math.max(0, Number(process.env.GAP_MS) || 0);
const MODEL =
  process.env.DEEPINFRA_CLEANUP_MODEL || "google/gemma-4-E4B-it";

function parseEnvFile(path) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const i = t.indexOf("=");
    let v = t.slice(i + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    out[t.slice(0, i).trim()] = v;
  }
  return out;
}

function loadToken() {
  if (process.env.DEEPINFRA_TOKEN?.trim()) return process.env.DEEPINFRA_TOKEN.trim();
  for (const p of [
    join(ROOT, ".env"),
    join(homedir(), ".openwhispr", "deepinfra.env"),
  ]) {
    const t = parseEnvFile(p).DEEPINFRA_TOKEN?.trim();
    if (t) return t;
  }
  throw new Error("DEEPINFRA_TOKEN not set");
}

const TOKEN = loadToken();

// Fixed cleanup-shaped payload (identical for call A and B).
const PAYLOAD = {
  model: MODEL,
  max_tokens: 64,
  temperature: 0,
  messages: [
    {
      role: "system",
      content:
        "You clean dictation. Output only cleaned text. No answers, no labels.",
    },
    {
      role: "user",
      content:
        "<transcript> um so please send the report by friday period </transcript>",
    },
  ],
};

async function oneCall(label) {
  const body = JSON.stringify(PAYLOAD);
  const t0 = performance.now();
  const res = await fetch(CHAT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      Connection: "keep-alive",
    },
    body,
    signal: AbortSignal.timeout(120_000),
  });
  const text = await res.text();
  const ms = Math.round(performance.now() - t0);
  let usage = null;
  let out = "";
  try {
    const j = JSON.parse(text);
    usage = j.usage || null;
    out = j.choices?.[0]?.message?.content || "";
  } catch {
    /* ignore */
  }
  if (!res.ok) {
    throw new Error(`${label} HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return {
    label,
    ms,
    promptTokens: usage?.prompt_tokens ?? null,
    completionTokens: usage?.completion_tokens ?? null,
    out: out.slice(0, 80),
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function median(arr) {
  const a = [...arr].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

async function main() {
  console.log(
    `diag-first-faster model=${MODEL} trials=${TRIALS} gapMs=${GAP_MS}`
  );
  console.log("Both sequential calls use IDENTICAL payload (position-only test).\n");

  // Discard first call (TLS / connection setup) so pairs start warm.
  console.log("warmup...");
  await oneCall("warmup");
  if (GAP_MS) await sleep(GAP_MS);

  const rows = [];
  let firstFaster = 0;
  let secondFaster = 0;
  let ties = 0;

  for (let i = 1; i <= TRIALS; i++) {
    const a = await oneCall("first");
    if (GAP_MS) await sleep(GAP_MS);
    const b = await oneCall("second");
    const delta = b.ms - a.ms; // positive => second slower
    if (delta > 50) firstFaster++;
    else if (delta < -50) secondFaster++;
    else ties++;
    rows.push({ trial: i, firstMs: a.ms, secondMs: b.ms, delta, a, b });
    console.log(
      `trial ${i}: first=${a.ms}ms second=${b.ms}ms delta=${delta > 0 ? "+" : ""}${delta}ms ` +
        `(tok ${a.promptTokens}/${a.completionTokens} then ${b.promptTokens}/${b.completionTokens})`
    );
  }

  const firstMs = rows.map((r) => r.firstMs);
  const secondMs = rows.map((r) => r.secondMs);
  const deltas = rows.map((r) => r.delta);

  console.log("\n--- summary (identical payload pairs) ---");
  console.log(
    `first  median=${median(firstMs)}ms  mean=${Math.round(firstMs.reduce((s, x) => s + x, 0) / firstMs.length)}ms`
  );
  console.log(
    `second median=${median(secondMs)}ms  mean=${Math.round(secondMs.reduce((s, x) => s + x, 0) / secondMs.length)}ms`
  );
  console.log(
    `delta  median=${median(deltas)}ms  (second - first; >0 means first faster)`
  );
  console.log(
    `counts (margin 50ms): firstFaster=${firstFaster} secondFaster=${secondFaster} ties=${ties}`
  );

  // RED if first is faster in a clear majority of trials.
  const red = firstFaster >= Math.ceil(TRIALS * 0.6) && firstFaster > secondFaster;
  console.log(
    `\nVERDICT: ${red ? "RED — position bias (first faster) reproduces" : "GREEN — no clear first-faster position bias"}`
  );
  console.log(
    red
      ? "Cause is not short-vs-stock content alone; sequential slot matters."
      : "Earlier dictation pattern may have been noise or prompt-mix confounded."
  );

  process.exit(red ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
