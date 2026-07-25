#!/usr/bin/env node
/**
 * OpenWhispr → DeepInfra Voxtral Small bridge.
 *
 * OpenWhispr records WebM/Opus. DeepInfra Voxtral returns HTTP 500 on WebM.
 * This shim accepts OpenAI-compatible POST /audio/transcriptions, converts the
 * audio to WAV with ffmpeg, and forwards it to DeepInfra.
 *
 * Zero npm dependencies (Node 18+).
 */

import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  unlinkSync,
  existsSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.SHIM_PORT || 8765);
const MAX_BODY_BYTES = 25 * 1024 * 1024;
const DEFAULT_MODEL =
  process.env.DEEPINFRA_MODEL || "mistralai/Voxtral-Mini-3B-2507";
const UPSTREAM =
  "https://api.deepinfra.com/v1/openai/audio/transcriptions";

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

function loadToken() {
  const fromEnv = (process.env.DEEPINFRA_TOKEN || "").trim();
  if (fromEnv) return fromEnv;

  for (const path of [
    join(ROOT, ".env"),
    join(homedir(), ".openwhispr", "deepinfra.env"),
  ]) {
    const token = (parseEnvFile(path).DEEPINFRA_TOKEN || "").trim();
    if (token) return token;
  }

  console.error(
    "DEEPINFRA_TOKEN not set. Copy .env.example to .env and add your token."
  );
  process.exit(1);
}

const TOKEN = loadToken();

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
    if (body[partStart] === 0x2d && body[partStart + 1] === 0x2d) break; // --
    if (body[partStart] === 0x0d && body[partStart + 1] === 0x0a) partStart += 2;

    const next = body.indexOf(delim, partStart);
    let part = next === -1 ? body.subarray(partStart) : body.subarray(partStart, next);
    start = next === -1 ? body.length : next;

    // strip trailing CRLF before next boundary
    if (part.length >= 2 && part[part.length - 2] === 0x0d && part[part.length - 1] === 0x0a) {
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

function convertToWav(inputPath) {
  return new Promise((resolve, reject) => {
    const outPath = join(
      tmpdir(),
      `ow-voxtral-${randomBytes(8).toString("hex")}.wav`
    );
    const child = spawn(
      "ffmpeg",
      ["-y", "-i", inputPath, "-ar", "16000", "-ac", "1", "-f", "wav", outPath],
      { stdio: "ignore" }
    );
    child.on("error", (err) => {
      try {
        unlinkSync(outPath);
      } catch {
        /* ignore */
      }
      if (err.code === "ENOENT") {
        reject(new Error("ffmpeg not found on PATH"));
      } else {
        reject(err);
      }
    });
    child.on("close", (code) => {
      if (code === 0) resolve(outPath);
      else {
        try {
          unlinkSync(outPath);
        } catch {
          /* ignore */
        }
        reject(new Error("ffmpeg failed to transcode audio"));
      }
    });
  });
}

async function deepinfraTranscribe(wavPath, model, language, prompt) {
  const audio = readFileSync(wavPath);
  const form = new FormData();
  form.append(
    "file",
    new Blob([audio], { type: "audio/wav" }),
    "audio.wav"
  );
  form.append("model", model || DEFAULT_MODEL);
  if (language) form.append("language", language);
  if (prompt) form.append("prompt", prompt);

  const res = await fetch(UPSTREAM, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}` },
    body: form,
    signal: AbortSignal.timeout(120_000),
  });

  const textBody = await res.text();
  if (!res.ok) {
    throw new Error(`DeepInfra HTTP ${res.status}: ${textBody}`);
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

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error("request body too large"), { status: 413 }));
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
  let model = fields.model || DEFAULT_MODEL;
  let language = fields.language || null;
  const prompt = fields.prompt || null;
  if (language === "" || language === "auto") language = null;

  const suffix = extname(filename || "") || ".webm";
  const workDir = mkdtempSync(join(tmpdir(), "ow-voxtral-"));
  const inPath = join(workDir, `input${suffix}`);
  let wavPath = null;

  try {
    writeFileSync(inPath, fileBytes);
    wavPath = await convertToWav(inPath);
    const text = await deepinfraTranscribe(wavPath, model, language, prompt);
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
        "Access-Control-Allow-Methods": "POST, OPTIONS",
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
        console.error("[shim] unhandled", err);
        if (!res.headersSent) {
          sendJson(res, 500, { error: "internal error" });
        }
      });
      return;
    }

    sendJson(res, 404, { error: "not found" });
  });

  server.listen(PORT, "127.0.0.1", () => {
    console.log(`DeepInfra Voxtral shim on http://127.0.0.1:${PORT}`);
    console.log(`Default model: ${DEFAULT_MODEL}`);
    console.log(`Project root: ${ROOT}`);
  });
}

main();
