#!/usr/bin/env node
/**
 * OpenWhispr → DeepInfra bridge (STT + cleanup LLM).
 *
 * STT:  OpenWhispr WebM → ffmpeg WAV → lead/trail silence trim → DeepInfra Voxtral
 * LLM:  OpenWhispr cleanup chat/completions → DeepInfra Gemma (etc.)
 *
 * Zero npm dependencies (Node 18+).
 */

import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  unlinkSync,
  existsSync,
  mkdtempSync,
  rmSync,
  mkdirSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const ROOT = dirname(fileURLToPath(import.meta.url));
const STT_UPSTREAM =
  "https://api.deepinfra.com/v1/openai/audio/transcriptions";
const CHAT_UPSTREAM =
  "https://api.deepinfra.com/v1/openai/chat/completions";
const LOGS_DIR = join(ROOT, "logs");
const BENCH_LOG = join(LOGS_DIR, "cleanup-bench.jsonl");
const MAX_BODY_BYTES = 25 * 1024 * 1024;

function parseEnvFile(path) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const i = trimmed.indexOf("=");
    const key = trimmed.slice(0, i).trim();
    let value = trimmed.slice(i + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function loadDotEnv() {
  for (const path of [
    join(ROOT, ".env"),
    join(homedir(), ".openwhispr", "deepinfra.env"),
  ]) {
    const parsed = parseEnvFile(path);
    for (const [key, value] of Object.entries(parsed)) {
      if (process.env[key] === undefined || process.env[key] === "") {
        process.env[key] = value;
      }
    }
  }
}

function envOn(name, defaultWhenUnset = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return defaultWhenUnset;
  return /^(1|true|yes|on)$/i.test(String(raw).trim());
}

/** Default on; set 0/false/no/off to disable. */
function envEnabled(name, defaultWhenUnset = true) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return defaultWhenUnset;
  return !/^(0|false|no|off)$/i.test(String(raw).trim());
}

function loadPromptFile(filename, fallback) {
  const path = join(ROOT, filename);
  if (existsSync(path)) {
    return readFileSync(path, "utf8").trim();
  }
  return fallback;
}

function loadShortCleanupPrompt() {
  return loadPromptFile(
    "cleanup-prompt-short.txt",
    "You clean one dictation transcript for a document. The speaker is not talking to you. " +
      "Input is between <transcript> tags. Output only the cleaned text. " +
      "Remove fillers and false starts; light punctuation; keep wording; do not answer questions."
  );
}

// Load .env before reading config so CLEANUP_BENCH / CLEANUP_PROMPT_MODE work.
loadDotEnv();

const PORT = Number(process.env.SHIM_PORT || 8765);
const DEFAULT_STT_MODEL =
  process.env.DEEPINFRA_MODEL || "mistralai/Voxtral-Mini-3B-2507";
const DEFAULT_CLEANUP_MODEL =
  process.env.DEEPINFRA_CLEANUP_MODEL || "google/gemma-4-E4B-it";

// Lead/trail silence only (never compress mid-utterance pauses).
const TRIM_EDGE_SILENCE = envEnabled("TRIM_EDGE_SILENCE", true);
const TRIM_PAD_SEC = Math.min(
  1,
  Math.max(0.05, Number(process.env.TRIM_SILENCE_PAD_SEC) || 0.25)
);
// dB under full scale. More negative = less aggressive (default -50).
// Peak -40 was too hot and could wipe quiet speech.
const TRIM_THRESHOLD_DB = Number(process.env.TRIM_SILENCE_DB) || -50;

// Production cleanup system prompt: short (default) | stock (OpenWhispr as-sent).
const CLEANUP_PROMPT_MODE = (() => {
  const m = String(process.env.CLEANUP_PROMPT_MODE ?? "short")
    .trim()
    .toLowerCase();
  if (m === "stock" || m === "openwhispr" || m === "passthrough") return "stock";
  return "short";
})();

// Cleanup A/B (off): stock vs short on every cleanup — ~2× API cost when enabled.
// CLEANUP_BENCH=1 to re-enable. CLEANUP_BENCH_RETURN=stock|short picks what OpenWhispr pastes.
const CLEANUP_BENCH = envOn("CLEANUP_BENCH", false);
const CLEANUP_BENCH_RETURN = /^(short)$/i.test(
  String(process.env.CLEANUP_BENCH_RETURN ?? "stock").trim()
)
  ? "short"
  : "stock";
const SHORT_CLEANUP_PROMPT = loadShortCleanupPrompt();

function activeCleanupSystemPrompt() {
  if (CLEANUP_PROMPT_MODE === "short") return SHORT_CLEANUP_PROMPT;
  return null; // stock: leave OpenWhispr messages unchanged
}

const TOKEN = (() => {
  const fromEnv = (process.env.DEEPINFRA_TOKEN || "").trim();
  if (fromEnv) return fromEnv;
  console.error(
    "DEEPINFRA_TOKEN not set. Copy .env.example to .env and add your token."
  );
  process.exit(1);
})();

function parseMultipartForm(body, contentType) {
  const m = /boundary="?([^";]+)"?/i.exec(contentType || "");
  if (!m) throw new Error("missing multipart boundary");

  const delim = Buffer.from(`--${m[1].trim()}`);
  const fields = {};
  const files = {};

  let start = 0;
  while (start < body.length) {
    const idx = body.indexOf(delim, start);
    if (idx === -1) break;
    let partStart = idx + delim.length;
    if (body[partStart] === 0x2d && body[partStart + 1] === 0x2d) break;
    if (body[partStart] === 0x0d && body[partStart + 1] === 0x0a) partStart += 2;

    const next = body.indexOf(delim, partStart);
    let part =
      next === -1 ? body.subarray(partStart) : body.subarray(partStart, next);
    start = next === -1 ? body.length : next;

    if (
      part.length >= 2 &&
      part[part.length - 2] === 0x0d &&
      part[part.length - 1] === 0x0a
    ) {
      part = part.subarray(0, part.length - 2);
    }

    const sep = part.indexOf(Buffer.from("\r\n\r\n"));
    if (sep === -1) continue;
    const rawHeaders = part.subarray(0, sep).toString("utf8");
    const content = part.subarray(sep + 4);

    let disposition = "";
    for (const line of rawHeaders.split("\r\n")) {
      if (line.toLowerCase().startsWith("content-disposition:")) {
        disposition = line;
      }
    }
    const nameMatch = /name="([^"]*)"/.exec(disposition);
    if (!nameMatch) continue;
    const name = nameMatch[1];
    const fileMatch = /filename="([^"]*)"/.exec(disposition);
    if (fileMatch) {
      files[name] = { filename: fileMatch[1], data: content };
    } else {
      fields[name] = content.toString("utf8");
    }
  }

  return { fields, files };
}

function tmpWavPath(prefix = "ow-voxtral") {
  return join(tmpdir(), `${prefix}-${randomBytes(8).toString("hex")}.wav`);
}

function runFfmpeg(args, failMessage) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: "ignore" });
    child.on("error", (err) => {
      if (err.code === "ENOENT") {
        reject(new Error("ffmpeg not found on PATH"));
      } else {
        reject(err);
      }
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(failMessage || `ffmpeg exited ${code}`));
    });
  });
}

function wavDurationSec(wavPath) {
  const result = spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      wavPath,
    ],
    { encoding: "utf8" }
  );
  if (result.status !== 0) return null;
  const n = Number(String(result.stdout || "").trim());
  return Number.isFinite(n) ? n : null;
}

function convertToWav(inputPath) {
  const outPath = tmpWavPath("ow-voxtral");
  return runFfmpeg(
    ["-y", "-i", inputPath, "-ar", "16000", "-ac", "1", "-f", "wav", outPath],
    "ffmpeg failed to transcode audio"
  )
    .then(() => outPath)
    .catch((err) => {
      try {
        unlinkSync(outPath);
      } catch {
        /* ignore */
      }
      throw err;
    });
}

/**
 * Trim leading + trailing silence only. Interior pauses are left intact.
 *
 * Uses areverse so we only ever run start_periods=1 (ffmpeg stop_periods +
 * aggressive peak thresholds were wiping quiet speech → empty STT).
 * On failure / over-trim, returns the original path unchanged.
 */
async function trimEdgeSilence(wavPath) {
  if (!TRIM_EDGE_SILENCE) return wavPath;

  const before = wavDurationSec(wavPath);
  const outPath = tmpWavPath("ow-trim");
  // Min continuous silence before we start cutting (avoids chopping soft speech).
  const minSilence = 0.15;
  // Lead: remove opening silence, keep pad. Reverse, same for trail, reverse back.
  const lead =
    `silenceremove=` +
    `start_periods=1:` +
    `start_duration=${minSilence}:` +
    `start_silence=${TRIM_PAD_SEC}:` +
    `start_threshold=${TRIM_THRESHOLD_DB}dB:` +
    `detection=rms`;
  const filter = `${lead},areverse,${lead},areverse`;

  try {
    await runFfmpeg(
      [
        "-y",
        "-i",
        wavPath,
        "-af",
        filter,
        "-ar",
        "16000",
        "-ac",
        "1",
        "-f",
        "wav",
        outPath,
      ],
      "ffmpeg failed to trim silence"
    );
  } catch (err) {
    try {
      unlinkSync(outPath);
    } catch {
      /* ignore */
    }
    console.warn(
      `[shim] edge silence trim failed, using untrimmed audio: ${err?.message || err}`
    );
    return wavPath;
  }

  const after = wavDurationSec(outPath);
  const outBytes = existsSync(outPath) ? readFileSync(outPath).length : 0;

  const reject = (why) => {
    try {
      unlinkSync(outPath);
    } catch {
      /* ignore */
    }
    console.log(
      `[shim] edge silence trim rejected (${why}); ` +
        `before=${before?.toFixed(2) ?? "?"}s after=${after?.toFixed(2) ?? "?"}s — using original`
    );
    return wavPath;
  };

  // WAV header alone ~44 bytes; need real audio left.
  if (outBytes < 3200 || after == null || after < 0.35) {
    return reject("too short after trim");
  }
  // Guard: if we removed most of the clip, the threshold ate speech — keep original.
  if (before != null && before > 1.0 && after / before < 0.45) {
    return reject(`over-trim kept ${((after / before) * 100).toFixed(0)}%`);
  }

  if (before != null && after != null) {
    const saved = before - after;
    if (saved > 0.05) {
      console.log(
        `[shim] edge silence trim ${before.toFixed(2)}s → ${after.toFixed(2)}s (−${saved.toFixed(2)}s)`
      );
    }
  }

  try {
    unlinkSync(wavPath);
  } catch {
    /* ignore */
  }
  return outPath;
}

async function deepinfraTranscribe(wavPath, model, language, prompt) {
  const audio = readFileSync(wavPath);
  const form = new FormData();
  form.append(
    "file",
    new Blob([audio], { type: "audio/wav" }),
    "audio.wav"
  );
  form.append("model", model || DEFAULT_STT_MODEL);
  if (language) form.append("language", language);
  if (prompt) form.append("prompt", prompt);

  const res = await fetch(STT_UPSTREAM, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}` },
    body: form,
    signal: AbortSignal.timeout(120_000),
  });

  const textBody = await res.text();
  if (!res.ok) {
    throw new Error(`DeepInfra STT HTTP ${res.status}: ${textBody}`);
  }
  const data = JSON.parse(textBody);
  return data.text || "";
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
}

function sendRaw(res, status, contentType, bodyBuf) {
  res.writeHead(status, {
    "Content-Type": contentType || "application/json",
    "Content-Length": bodyBuf.length,
    "Access-Control-Allow-Origin": "*",
  });
  res.end(bodyBuf);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(
          Object.assign(new Error("request body too large"), { status: 413 })
        );
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function handleTranscribe(req, res) {
  let body;
  try {
    body = await readBody(req, MAX_BODY_BYTES);
  } catch (err) {
    sendJson(res, err.status || 400, { error: err.message });
    return;
  }
  if (!body.length) {
    sendJson(res, 400, { error: "empty body" });
    return;
  }

  let fields;
  let files;
  try {
    ({ fields, files } = parseMultipartForm(
      body,
      req.headers["content-type"] || ""
    ));
  } catch (err) {
    sendJson(res, 400, { error: `bad multipart: ${err.message}` });
    return;
  }

  if (!files.file) {
    sendJson(res, 400, { error: "missing 'file' field" });
    return;
  }

  const { filename, data: fileBytes } = files.file;
  let model = fields.model || DEFAULT_STT_MODEL;
  let language = fields.language || null;
  const prompt = fields.prompt || null;
  if (language === "" || language === "auto") language = null;

  const suffix = extname(filename || "") || ".webm";
  const workDir = mkdtempSync(join(tmpdir(), "ow-voxtral-"));
  const inPath = join(workDir, `input${suffix}`);
  let wavPath = null;

  try {
    writeFileSync(inPath, fileBytes);
    const tPipe = performance.now();
    wavPath = await convertToWav(inPath);
    const tWav = performance.now();
    wavPath = await trimEdgeSilence(wavPath);
    const tTrim = performance.now();
    const text = await deepinfraTranscribe(wavPath, model, language, prompt);
    const tStt = performance.now();
    console.log(
      `[shim] STT wav=${Math.round(tWav - tPipe)}ms trim=${Math.round(tTrim - tWav)}ms ` +
        `deepinfra=${Math.round(tStt - tTrim)}ms total=${Math.round(tStt - tPipe)}ms ` +
        `chars=${(text || "").length}`
    );
    sendJson(res, 200, { text, object: "transcription" });
  } catch (err) {
    const msg = err?.message || String(err);
    if (msg.includes("ffmpeg not found")) {
      sendJson(res, 500, { error: "ffmpeg not found on PATH" });
    } else if (msg.includes("ffmpeg failed")) {
      sendJson(res, 500, { error: "ffmpeg failed to transcode audio" });
    } else {
      sendJson(res, 500, { error: `transcription failed: ${msg}` });
    }
  } finally {
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    if (wavPath) {
      try {
        unlinkSync(wavPath);
      } catch {
        /* ignore */
      }
    }
  }
}

function normalizeChatPayload(payload) {
  if (!payload.model || !String(payload.model).trim()) {
    payload.model = DEFAULT_CLEANUP_MODEL;
  }
  // OpenWhispr may send max_completion_tokens; DeepInfra accepts max_tokens too.
  if (payload.max_completion_tokens != null && payload.max_tokens == null) {
    payload.max_tokens = payload.max_completion_tokens;
  }
  return payload;
}

function estimateChars(messages) {
  if (!Array.isArray(messages)) return 0;
  let n = 0;
  for (const m of messages) {
    const c = m?.content;
    if (typeof c === "string") n += c.length;
    else if (Array.isArray(c)) {
      for (const part of c) {
        if (typeof part?.text === "string") n += part.text.length;
      }
    }
  }
  return n;
}

function withSystemPrompt(messages, systemText) {
  const list = Array.isArray(messages) ? messages.map((m) => ({ ...m })) : [];
  const sysIdx = list.findIndex((m) => m.role === "system");
  if (sysIdx >= 0) {
    list[sysIdx] = { ...list[sysIdx], content: systemText };
  } else {
    list.unshift({ role: "system", content: systemText });
  }
  return list;
}

function parseChatResult(status, textBody) {
  let data = null;
  try {
    data = textBody ? JSON.parse(textBody) : null;
  } catch {
    /* ignore */
  }
  const choice = data?.choices?.[0];
  const content =
    choice?.message?.content ??
    choice?.text ??
    (typeof choice?.message === "string" ? choice.message : "");
  const usage = data?.usage || {};
  const cached =
    usage.prompt_tokens_details?.cached_tokens ??
    usage.prompt_tokens_details?.cachedTokens ??
    null;
  return {
    status,
    ok: status >= 200 && status < 300,
    content: typeof content === "string" ? content : String(content || ""),
    promptTokens: usage.prompt_tokens ?? null,
    completionTokens: usage.completion_tokens ?? null,
    totalTokens: usage.total_tokens ?? null,
    cachedTokens: cached,
    raw: textBody,
  };
}

async function deepinfraChat(payload) {
  const t0 = performance.now();
  const upstream = await fetch(CHAT_UPSTREAM, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await upstream.text();
  const ms = Math.round(performance.now() - t0);
  const parsed = parseChatResult(upstream.status, text);
  return {
    ...parsed,
    ms,
    contentType: upstream.headers.get("content-type") || "application/json",
  };
}

function appendBenchLog(row) {
  try {
    mkdirSync(LOGS_DIR, { recursive: true });
    appendFileSync(BENCH_LOG, JSON.stringify(row) + "\n", "utf8");
  } catch (err) {
    console.warn(`[shim] bench log write failed: ${err?.message || err}`);
  }
}

/**
 * Proxy OpenAI-compatible chat completions to DeepInfra.
 * OpenWhispr cleanup hits {base}/chat/completions after normalizing base to …/v1.
 *
 * CLEANUP_BENCH=1 → run stock system prompt and short prompt back-to-back on the
 * same request, log timings, return CLEANUP_BENCH_RETURN (stock|short).
 */
async function handleChatCompletions(req, res) {
  let bodyBuf;
  try {
    bodyBuf = await readBody(req, MAX_BODY_BYTES);
  } catch (err) {
    sendJson(res, err.status || 400, { error: err.message });
    return;
  }

  let payload;
  try {
    payload = bodyBuf.length ? JSON.parse(bodyBuf.toString("utf8")) : {};
  } catch {
    sendJson(res, 400, { error: "invalid JSON body" });
    return;
  }

  normalizeChatPayload(payload);

  const msgCount = payload.messages?.length ?? 0;
  console.log(
    `[shim] chat/completions model=${payload.model} messages=${msgCount}` +
      ` prompt=${CLEANUP_PROMPT_MODE}` +
      (CLEANUP_BENCH ? ` bench=on return=${CLEANUP_BENCH_RETURN}` : "")
  );

  try {
    if (!CLEANUP_BENCH) {
      const sys = activeCleanupSystemPrompt();
      const outPayload = sys
        ? {
            ...payload,
            messages: withSystemPrompt(payload.messages, sys),
          }
        : payload;
      const result = await deepinfraChat(outPayload);
      if (!result.ok) {
        console.error(
          `[shim] DeepInfra chat HTTP ${result.status}: ${result.raw.slice(0, 300)}`
        );
      } else {
        console.log(
          `[shim] cleanup ${result.ms}ms tokens=${result.promptTokens ?? "?"}/${result.completionTokens ?? "?"}` +
            (result.cachedTokens != null ? ` cached=${result.cachedTokens}` : "") +
            ` mode=${CLEANUP_PROMPT_MODE}`
        );
      }
      sendRaw(res, result.status, result.contentType, Buffer.from(result.raw, "utf8"));
      return;
    }

    // --- A/B bench path ---
    const stockPayload = {
      ...payload,
      messages: Array.isArray(payload.messages)
        ? payload.messages.map((m) => ({ ...m }))
        : payload.messages,
    };
    const shortPayload = {
      ...payload,
      messages: withSystemPrompt(payload.messages, SHORT_CLEANUP_PROMPT),
    };

    // Sequential (short first, then stock) so order bias can be compared across runs.
    // Second call may look slower due to queue / no concurrent GPU fight.
    const short = await deepinfraChat(shortPayload);
    const stock = await deepinfraChat(stockPayload);

    const stockSysChars = estimateChars(
      (stockPayload.messages || []).filter((m) => m.role === "system")
    );
    const shortSysChars = estimateChars(
      (shortPayload.messages || []).filter((m) => m.role === "system")
    );

    const row = {
      ts: new Date().toISOString(),
      model: payload.model,
      returnVariant: CLEANUP_BENCH_RETURN,
      stock: {
        ms: stock.ms,
        ok: stock.ok,
        status: stock.status,
        promptTokens: stock.promptTokens,
        completionTokens: stock.completionTokens,
        cachedTokens: stock.cachedTokens,
        systemChars: stockSysChars,
        outChars: stock.content.length,
        outPreview: stock.content.slice(0, 160),
      },
      short: {
        ms: short.ms,
        ok: short.ok,
        status: short.status,
        promptTokens: short.promptTokens,
        completionTokens: short.completionTokens,
        cachedTokens: short.cachedTokens,
        systemChars: shortSysChars,
        outChars: short.content.length,
        outPreview: short.content.slice(0, 160),
      },
      deltaMs: stock.ms != null && short.ms != null ? short.ms - stock.ms : null,
    };
    appendBenchLog(row);

    const faster =
      stock.ok && short.ok
        ? short.ms < stock.ms
          ? "short"
          : stock.ms < short.ms
            ? "stock"
            : "tie"
        : "n/a";

    console.log(
      `[shim] CLEANUP BENCH stock=${stock.ms}ms (prompt_tok=${stock.promptTokens ?? "?"}) ` +
        `short=${short.ms}ms (prompt_tok=${short.promptTokens ?? "?"}) ` +
        `faster=${faster} return=${CLEANUP_BENCH_RETURN}`
    );
    console.log(
      `[shim]   stock out: ${JSON.stringify(stock.content.slice(0, 120))}`
    );
    console.log(
      `[shim]   short out: ${JSON.stringify(short.content.slice(0, 120))}`
    );
    console.log(`[shim]   logged → ${BENCH_LOG}`);

    const chosen = CLEANUP_BENCH_RETURN === "short" ? short : stock;
    if (!chosen.ok) {
      console.error(
        `[shim] DeepInfra chat HTTP ${chosen.status}: ${chosen.raw.slice(0, 300)}`
      );
    }
    sendRaw(
      res,
      chosen.status,
      chosen.contentType,
      Buffer.from(chosen.raw, "utf8")
    );
  } catch (err) {
    console.error("[shim] chat proxy error", err);
    sendJson(res, 502, {
      error: `cleanup proxy failed: ${err?.message || String(err)}`,
    });
  }
}

function handleModels(_req, res) {
  // Minimal OpenAI-compatible catalog so pickers / probes don't 404.
  sendJson(res, 200, {
    object: "list",
    data: [
      {
        id: DEFAULT_CLEANUP_MODEL,
        object: "model",
        owned_by: "deepinfra",
      },
      {
        id: DEFAULT_STT_MODEL,
        object: "model",
        owned_by: "deepinfra",
      },
    ],
  });
}

function ensureFfmpeg() {
  const result = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
  if (result.error?.code === "ENOENT" || result.status !== 0) {
    console.error("ffmpeg is required (e.g. brew install ffmpeg)");
    process.exit(1);
  }
}

function main() {
  ensureFfmpeg();

  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
      });
      res.end();
      return;
    }

    if (
      req.method === "POST" &&
      (path === "/audio/transcriptions" || path === "/v1/audio/transcriptions")
    ) {
      handleTranscribe(req, res).catch((err) => {
        console.error("[shim] unhandled STT", err);
        if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
      });
      return;
    }

    if (
      req.method === "POST" &&
      (path === "/chat/completions" || path === "/v1/chat/completions")
    ) {
      handleChatCompletions(req, res).catch((err) => {
        console.error("[shim] unhandled chat", err);
        if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
      });
      return;
    }

    if (
      req.method === "GET" &&
      (path === "/models" || path === "/v1/models")
    ) {
      handleModels(req, res);
      return;
    }

    // Health for quick checks
    if (req.method === "GET" && (path === "/" || path === "/health")) {
      sendJson(res, 200, {
        ok: true,
        sttDefault: DEFAULT_STT_MODEL,
        cleanupDefault: DEFAULT_CLEANUP_MODEL,
        cleanupPromptMode: CLEANUP_PROMPT_MODE,
        cleanupBench: CLEANUP_BENCH,
        cleanupBenchReturn: CLEANUP_BENCH_RETURN,
        edgeSilenceTrim: TRIM_EDGE_SILENCE,
        benchLog: CLEANUP_BENCH ? BENCH_LOG : null,
      });
      return;
    }

    sendJson(res, 404, { error: "not found", path });
  });

  server.listen(PORT, "127.0.0.1", () => {
    console.log(`DeepInfra OpenWhispr shim on http://127.0.0.1:${PORT}`);
    console.log(`  STT default:     ${DEFAULT_STT_MODEL}`);
    console.log(`  Cleanup default: ${DEFAULT_CLEANUP_MODEL}`);
    console.log(
      `  Edge silence:    ${TRIM_EDGE_SILENCE ? `on (pad ${TRIM_PAD_SEC}s, ${TRIM_THRESHOLD_DB}dB)` : "off"}`
    );
    console.log(`  Cleanup prompt:  ${CLEANUP_PROMPT_MODE}`);
    console.log(
      `  Cleanup bench:   ${CLEANUP_BENCH ? `ON → return ${CLEANUP_BENCH_RETURN}; log ${BENCH_LOG}` : "off (set CLEANUP_BENCH=1 to re-enable)"}`
    );
    console.log(`  Project root:    ${ROOT}`);
  });
}

main();
