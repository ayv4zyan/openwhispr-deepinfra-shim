#!/usr/bin/env node
/**
 * Apply openwhispr-settings.json into OpenWhispr Chromium localStorage LevelDB.
 * Requires: OpenWhispr fully quit. Runs `npm install classic-level` in a temp dir.
 */
import { readFileSync, mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = dirname(fileURLToPath(import.meta.url));
const settingsPath = join(ROOT, "openwhispr-settings.json");

function findLevelDb() {
  const candidates = [
    process.env.OPENWHISPR_USER_DATA &&
      join(process.env.OPENWHISPR_USER_DATA, "Local Storage", "leveldb"),
    join(homedir(), "Library/Application Support/open-whispr/Local Storage/leveldb"),
    join(homedir(), ".config/open-whispr/Local Storage/leveldb"),
    join(homedir(), ".config/OpenWhispr/Local Storage/leveldb"),
  ].filter(Boolean);
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

function isOpenWhisprRunning() {
  const r = spawnSync("pgrep", ["-x", "OpenWhispr"], { encoding: "utf8" });
  return r.status === 0;
}

if (isOpenWhisprRunning()) {
  console.error("Quit OpenWhispr first (LevelDB is locked while it runs).");
  process.exit(1);
}

const leveldb = findLevelDb();
if (!leveldb) {
  console.error("OpenWhispr localStorage LevelDB not found. Launch OpenWhispr once, quit, retry.");
  process.exit(1);
}

const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
const flat = { ...settings.speechToText, ...settings.cleanup };
if (flat.openAiEndpointPreference && typeof flat.openAiEndpointPreference === "object") {
  flat.openAiEndpointPreference = JSON.stringify(flat.openAiEndpointPreference);
}

const work = mkdtempSync(join(tmpdir(), "ow-apply-"));
try {
  writeFileSync(
    join(work, "package.json"),
    JSON.stringify({ type: "commonjs", dependencies: { "classic-level": "^3.0.0" } })
  );
  const npm = spawnSync("npm", ["install", "--silent", "--no-fund", "--no-audit"], {
    cwd: work,
    encoding: "utf8",
  });
  if (npm.status !== 0) {
    console.error(npm.stderr || npm.stdout);
    process.exit(1);
  }

  const { createRequire } = await import("node:module");
  const require = createRequire(join(work, "package.json"));
  const { ClassicLevel } = require("classic-level");

  const lsKey = (name) => Buffer.from(`_file://\x00\x01${name}`, "binary");
  const lsVal = (value) => Buffer.from(`\x01${value}`, "binary");

  const db = new ClassicLevel(leveldb, { keyEncoding: "buffer", valueEncoding: "buffer" });
  await db.open({ createIfMissing: false });
  for (const [k, v] of Object.entries(flat)) {
    if (String(k).startsWith("_")) continue;
    await db.put(lsKey(k), lsVal(String(v)));
    const s = String(v);
    console.log("set", k, "=", s.length > 90 ? s.slice(0, 90) + "…" : s);
  }
  await db.close();
  console.log("Applied", settingsPath, "→", leveldb);
} finally {
  rmSync(work, { recursive: true, force: true });
}

// Ensure OW .env has cleanup placeholder
const owData = dirname(dirname(leveldb)); // .../Local Storage -> userData
const envPath = join(owData, ".env");
if (existsSync(dirname(envPath))) {
  let env = existsSync(envPath) ? readFileSync(envPath, "utf8") : "# OpenWhispr Environment Variables\n";
  if (!/^CUSTOM_CLEANUP_API_KEY=/m.test(env)) {
    env = env.trimEnd() + "\nCUSTOM_CLEANUP_API_KEY=local-shim\n";
    writeFileSync(envPath, env, { mode: 0o600 });
    console.log("Ensured CUSTOM_CLEANUP_API_KEY=local-shim in", envPath);
  }
}
