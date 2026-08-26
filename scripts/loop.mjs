#!/usr/bin/env node
/**
 * Hourly loop for the global todo skill (run by launchd: com.piagent.pi-todo-loop).
 *
 * Every run:
 *   1. takes a loop lock (one loop run at a time)
 *   2. reaps in-progress tasks:
 *        - worker alive but over PI_TODO_MAX_RUNTIME_H (default 6) → kill pgid, fail, notify
 *        - worker dead  + summary file exists            → complete, notify
 *        - worker dead  + newest summaries/<id>*.md     → complete (with that summary), notify
 *        - worker dead  + no summary                    → fail (with log tail), notify
 *   3. busy gate (the local 27B serves one request at a time):
 *        PRIMARY   MTPLX GET /admin/sessions — busy if any session has in_flight
 *                              or last_access within PI_TODO_ACTIVE_WINDOW_S (120)
 *        FALLBACK  server unreachable → skip (a worker would have no model)
 *        ESCAPE    --force / PI_TODO_SKIP_BUSY_CHECK=1
 *   4. if tasks are pending: taskctl claim → build prompt → spawn
 *        `pi -p --offline --no-approve --no-extensions -e mtplx-request-policy
 *          -e mtplx-session-reset --name todo-<id> -- <prompt>`
 *        detached (own pgid, stdio → logs/<file>) → taskctl start <id> --pid.
 *
 * The worker is fire-and-forget: it completes its own bookkeeping (taskctl
 * complete/fail + taskctl notify). This loop exits after launching.
 *
 * Env: PI_TODO_HOME, PI_TODO_PI_BIN, PI_TODO_PI_EXTENSIONS (comma list of
 * extension file basenames or absolute paths), PI_TODO_MAX_RUNTIME_H,
 * PI_TODO_ACTIVE_WINDOW_S, PI_TODO_SKIP_BUSY_CHECK, PI_TODO_MTPLX_ADMIN,
 * PI_TODO_MTPLX_KEY.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TASKCTL = path.join(HERE, "taskctl.mjs");
const TODO_HOME = process.env.PI_TODO_HOME || path.join(os.homedir(), ".pi", "agent", "todos");
const TASKS_FILE = path.join(TODO_HOME, "tasks.json");
const LOCK_DIR = path.join(TODO_HOME, "loop.lock");
const LOG_FILE = path.join(TODO_HOME, "loop.log");

const MAX_RUNTIME_H = Number(process.env.PI_TODO_MAX_RUNTIME_H || "6");
const ACTIVE_WINDOW_S = Number(process.env.PI_TODO_ACTIVE_WINDOW_S || "120");
const SKIP_BUSY = process.env.PI_TODO_SKIP_BUSY_CHECK === "1";

const EXT_DIR = path.join(os.homedir(), ".pi", "agent", "extensions");
const DEFAULT_EXTS = ["mtplx-request-policy.ts", "mtplx-session-reset.ts"];
const PI_BIN =
  process.env.PI_TODO_PI_BIN ||
  ["/opt/homebrew/bin/pi", "/usr/local/bin/pi", "/usr/bin/pi"].find((p) => {
    try { fs.accessSync(p); return true; } catch { return false; }
  }) || "pi";

const sleeper = new Int32Array(new SharedArrayBuffer(4).buffer);
const sleep = (ms) => Atomics.wait(sleeper, 0, 0, ms);

function log(msg) {
  try {
    fs.mkdirSync(TODO_HOME, { recursive: true });
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`);
    const st = fs.statSync(LOG_FILE);
    if (st.size > 2 * 1024 * 1024) fs.writeFileSync(LOG_FILE, fs.readFileSync(LOG_FILE, "utf8").slice(-1024 * 1024));
  } catch { /* best effort */ }
  console.log(msg);
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

function runTaskctl(args) {
  const raw = execFileSync(process.execPath, [TASKCTL, ...args, "--json"], {
    timeout: 60_000,
    encoding: "utf8",
  });
  return JSON.parse(raw);
}

/* --- MTPLX busy check ------------------------------------------------- */

function mtplxAdmin() {
  if (process.env.PI_TODO_MTPLX_ADMIN) {
    return { base: process.env.PI_TODO_MTPLX_ADMIN, key: process.env.PI_TODO_MTPLX_KEY || "1313" };
  }
  try {
    const mj = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".pi", "agent", "models.json"), "utf8"));
    const provs = mj.providers || {};
    const p = Object.entries(provs).find(([k, v]) => k === "mtplx" || /mtplx/.test(v?.baseUrl || ""))?.[1];
    if (!p?.baseUrl) return null;
    return { base: new URL(p.baseUrl).origin, key: p.apiKey || "1313" };
  } catch {
    return null;
  }
}

/**
 * @returns {{state:"ok", busy:boolean, reason:string, inflight:number} |
 *           {state:"unreachable"} | {state:"unconfigured"}}
 */
async function mtplxBusy() {
  const a = mtplxAdmin();
  if (!a) return { state: "unconfigured" };
  try {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 4000);
    const res = await fetch(a.base + "/admin/sessions", {
      headers: { authorization: `Bearer ${a.key}`, "x-mtplx-client": "pi" },
      signal: ctl.signal,
    });
    clearTimeout(to);
    if (!res.ok) return { state: "unreachable" };
    const body = await res.json();
    const sessions = body.sessions || [];
    const inflight = sessions.filter((s) => s.in_flight);
    const recent = sessions.filter((s) => !s.in_flight && s.last_access_s && Date.now() / 1000 - s.last_access_s < ACTIVE_WINDOW_S);
    if (inflight.length) return { state: "ok", busy: true, reason: `${inflight.length} session(s) in-flight`, inflight: inflight.length };
    if (recent.length) return { state: "ok", busy: true, reason: `${recent.length} session(s) active within ${ACTIVE_WINDOW_S}s`, inflight: 0 };
    return { state: "ok", busy: false, reason: "all sessions idle", inflight: 0 };
  } catch {
    return { state: "unreachable" };
  }
}

/* --- reap ------------------------------------------------------------- */

function newestSummaryFor(id) {
  const dir = path.join(TODO_HOME, "summaries");
  let names;
  try { names = fs.readdirSync(dir); } catch { return null; }
  const cand = names
    .filter((n) => n.startsWith(`${id}-r`) && n.endsWith(".md"))
    .sort()
    .reverse();
  return cand.length ? path.join(dir, cand[0]) : null;
}

function logTail(file, maxBytes = 300) {
  try {
    const st = fs.statSync(file);
    const start = Math.max(0, st.size - maxBytes);
    const buf = Buffer.alloc(st.size - start);
    const fd = fs.openSync(file, "r");
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return buf.toString("utf8").replace(/\s+/g, " ").trim().slice(-250);
  } catch { return null; }
}

function notifyPeer(t, ok, extra) {
  try {
    runTaskctl(["notify", t.source_peer || "self", `${ok ? "✅" : "⚠️"} Todo ${t.id} "${t.title}" ${ok ? "done" : "failed"} — ${extra}`]);
  } catch (e) {
    log(`T ${t.id} notify failed: ${e.message?.slice(0, 120)}`);
  }
}

/**
 * Reap in-progress tasks (crashed workers, runtime overruns).
 * Returns how many tasks were resolved.
 */
function reap() {
  let s;
  try { s = JSON.parse(fs.readFileSync(TASKS_FILE, "utf8")); } catch { return 0; }
  let resolved = 0;
  for (const t of s.tasks.filter((t) => t.status === "in-progress")) {
    const alive = t.worker_pid ? pidAlive(t.worker_pid) : false;
    const ageH = t.started_at ? (Date.now() - Date.parse(t.started_at)) / 3.6e6 : 0;

    if (alive && ageH > MAX_RUNTIME_H) {
      log(`T ${t.id} exceeded max runtime (${ageH.toFixed(1)}h) — killing worker pid ${t.worker_pid}`);
      try { process.kill(-t.worker_pid, "SIGTERM"); } catch { try { process.kill(t.worker_pid, "SIGTERM"); } catch {} }
      sleep(5000);
      if (pidAlive(t.worker_pid)) { try { process.kill(-t.worker_pid, "SIGKILL"); } catch { try { process.kill(t.worker_pid, "SIGKILL"); } catch {} } }
      try { runTaskctl(["fail", t.id, "--error", `runtime exceeded ${MAX_RUNTIME_H}h (worker killed)`]); } catch (e) { log(`fail after kill failed: ${e.message?.slice(0, 120)}`); }
      notifyPeer(t, false, `runtime exceeded ${MAX_RUNTIME_H}h — killed`);
      resolved++;
      continue;
    }

    if (!alive) {
      const summary = fs.existsSync(t.summary_file || "") ? t.summary_file : newestSummaryFor(t.id);
      if (summary) {
        try { runTaskctl(["complete", t.id, "--summary", summary]); } catch (e) { log(`complete failed: ${e.message?.slice(0, 120)}`); }
        notifyPeer(t, true, "worker finished");
        resolved++;
      } else {
        const tail = logTail(t.log_file);
        const err = `worker exited without a summary${tail ? ` (log tail: ${tail})` : ""}`;
        try { runTaskctl(["fail", t.id, "--error", err]); } catch (e) { log(`fail bookkeeping failed: ${e.message?.slice(0, 120)}`); }
        notifyPeer(t, false, err.slice(0, 160));
        resolved++;
      }
    }
    // alive and under max runtime → leave running
  }
  return resolved;
}

/* --- launch ----------------------------------------------------------- */

function buildPrompt(t) {
  const sum = t.summary_file;
  return [
    "You are a headless pi worker dispatched by the hourly global-todo loop. The local 27B model serves one request at a time; no other agent is running right now.",
    "",
    `Task id: ${t.id}`,
    `Task title: ${t.title}`,
    "",
    "Task body:",
    t.body,
    "",
    `Working directory: ${t.workdir} (your session state lives here; previous runs may have left files and a state.md — read them first if present)`,
    t.cwd ? `The task points at project: ${t.cwd} — do the work there (cd via bash) but keep session state in the working directory.` : "",
    "",
    "Completion protocol (follow exactly):",
    "1. Work incrementally; verify with tests or commands whenever possible.",
    "2. Keep context lean: use targeted commands (rg, sed -n, git diff, tail) — never dump large files or full logs into context.",
    `3. Write a completion summary to EXACTLY this path: ${sum}`,
    "   Sections: '## What was done', '## Files changed', '## Verification', '## Follow-ups / blockers'.",
    `4. Then run: node ${TASKCTL} complete ${t.id} --summary ${sum}`,
    `5. Then run: node ${TASKCTL} notify ${t.source_peer || "self"} "✅ Todo ${t.id} \\"${t.title}\\" done — <one-line result>"`,
    "6. Stop. Do not start unrelated work, do not message people, do not modify the todo store or this skill except via the taskctl commands above.",
    "",
    "If the task turns out infeasible or blocked: write the summary explaining what you tried and what is needed, run the fail command with a short reason, then notify with a one-line blocked message, then stop.",
    "",
    "Model context is limited (~50k). Make progress in small verified steps; never one giant pass.",
  ]
    .filter((l) => l !== null)
    .join("\n");
}

function launch(t) {
  const prompt = buildPrompt(t);
  const exts = (process.env.PI_TODO_PI_EXTENSIONS ? process.env.PI_TODO_PI_EXTENSIONS.split(",") : DEFAULT_EXTS)
    .map((f) => (f.trim().startsWith("/") ? f.trim() : path.join(EXT_DIR, f.trim())))
    .filter((f) => fs.existsSync(f));
  if (!exts.length) log("warning: no mtplx extensions found; worker will run without model policy");
  const logPath = t.log_file || path.join(TODO_HOME, "logs", `${t.id}-manual.log`);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const logFd = fs.openSync(logPath, "a");
  const args = [
    "-p", "--offline", "--no-approve", "--no-extensions",
    ...exts.flatMap((f) => ["-e", f]),
    "--name", `todo-${t.id}`,
    "--", prompt,
  ];
  const child = spawn(PI_BIN, args, {
    cwd: t.workdir,
    detached: true, // own process group → killable as a unit
    stdio: ["ignore", logFd, logFd],
    env: {
      ...process.env,
      PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      NO_COLOR: "1",
      TERM: "dumb",
    },
  });
  child.unref();
  try {
    runTaskctl(["start", t.id, "--pid", String(child.pid), "--log", logPath]);
  } catch (e) {
    log(`start bookkeeping failed: ${e.message?.slice(0, 150)}`);
  }
  log(`T ${t.id} launched: pi worker pid ${child.pid} (run ${t.runs}) → ${logPath}`);
}

/* --- main ------------------------------------------------------------- */

function loopLock() {
  fs.mkdirSync(TODO_HOME, { recursive: true });
  try {
    fs.mkdirSync(LOCK_DIR);
    fs.writeFileSync(path.join(LOCK_DIR, "info.json"), JSON.stringify({ pid: process.pid, ts: Date.now() }));
    return true;
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    let stale = false;
    try {
      const info = JSON.parse(fs.readFileSync(path.join(LOCK_DIR, "info.json"), "utf8"));
      stale = Date.now() - info.ts > 10 * 60 * 1000 || !pidAlive(info.pid);
    } catch { stale = true; }
    if (stale) {
      fs.rmSync(LOCK_DIR, { recursive: true, force: true });
      return loopLock();
    }
    return false;
  }
}

function releaseLoopLock() {
  fs.rmSync(LOCK_DIR, { recursive: true, force: true });
}

async function main() {
  if (process.argv.includes("--status")) {
    const st = JSON.parse(execFileSync(process.execPath, [TASKCTL, "status", "--json"], { encoding: "utf8" }));
    const busy = await mtplxBusy();
    console.log(JSON.stringify({ ...st, model: busy }, null, 2));
    return;
  }
  if (!loopLock()) {
    log("another loop run in progress — exiting");
    return;
  }
  try {
    fs.mkdirSync(TODO_HOME, { recursive: true });
    const reaped = reap();
    if (reaped) log(`reaped ${reaped} finished/stale in-progress task(s)`);

    if (!SKIP_BUSY && !process.argv.includes("--force")) {
      const b = await mtplxBusy();
      if (b.state === "unreachable") {
        log("MTPLX server unreachable — skipping (a worker would have no model)");
        return;
      }
      if (b.state === "unconfigured") {
        log("warning: MTPLX admin config not found — proceeding without busy check");
      } else if (b.busy) {
        log(`MTPLX busy (${b.reason}) — skipping launch`);
        return;
      }
    } else {
      log("busy check skipped (--force / PI_TODO_SKIP_BUSY_CHECK)");
    }

    let s;
    try { s = JSON.parse(fs.readFileSync(TASKS_FILE, "utf8")); } catch { s = { tasks: [] }; }
    if (!s.tasks.some((t) => t.status === "pending")) {
      log("no pending tasks — done");
      return;
    }
    let t;
    try {
      t = runTaskctl(["claim"]).task;
    } catch (e) {
      log(`claim failed: ${e.message?.slice(0, 150)}`);
      return;
    }
    launch(t);
  } finally {
    releaseLoopLock();
  }
}

main().catch((e) => {
  log(`FATAL: ${e?.stack || e}`);
  releaseLoopLock();
  process.exit(1);
});