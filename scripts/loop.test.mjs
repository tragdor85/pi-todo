import { test } from "node:test";
import assert from "node:assert/strict";
import { scheduleNextRun } from "./loop.mjs";

/**
 * The 15-min loop must leave exactly one process alive: it spawns the next run
 * (detached, own session), unrefs it, and exits. The historical bug used
 * spawnSync, which blocks until the (long-lived) child exits, so the parent
 * never died and a process leaked every interval. These tests pin the fix.
 */
function makeRecorder() {
  const r = { sleep: 0, sleepMs: 0, spawn: 0, unref: 0, exit: 0, exitCodes: [], spawnOpts: null };
  return {
    r,
    sleepFn: (ms) => { r.sleep++; r.sleepMs = ms; },
    spawnFn: (execPath, args, opts) => {
      r.spawn++;
      r.spawnOpts = { execPath, args, opts };
      return { unref: () => r.unref++ };
    },
    exitFn: (code) => { r.exit++; r.exitCodes.push(code); },
    setTimeoutFn: (fn) => fn(), // fire the settle timer synchronously
    logFn: () => {},
  };
}

test("manual runs do not reschedule", () => {
  const { r, ...fns } = makeRecorder();
  scheduleNextRun({ manual: true, ...fns });
  assert.equal(r.sleep, 0);
  assert.equal(r.spawn, 0);
  assert.equal(r.unref, 0);
  assert.equal(r.exit, 0);
});

test("does not reschedule once the interval has already elapsed", () => {
  const { r, ...fns } = makeRecorder();
  scheduleNextRun({ intervalS: 900, t0: Date.now() - 1000 * 1000, manual: false, ...fns });
  assert.equal(r.sleep, 0);
  assert.equal(r.spawn, 0);
  assert.equal(r.unref, 0);
  assert.equal(r.exit, 0);
});

test("sleeps for the remainder, spawns a detached child, unrefs it, then exits", () => {
  const { r, ...fns } = makeRecorder();
  scheduleNextRun({ intervalS: 900, t0: Date.now() - 100 * 1000, manual: false, ...fns });

  assert.equal(r.sleep, 1, "should sleep for the remaining interval");
  assert.ok(r.sleepMs > 0 && r.sleepMs <= 900 * 1000, `sleep within the interval (got ${r.sleepMs}ms)`);

  assert.equal(r.spawn, 1, "should spawn the next run");
  assert.equal(r.spawnOpts.args.length, 1, "spawns this script");
  assert.equal(r.spawnOpts.opts.detached, true, "child must be detached (own session)");
  assert.deepEqual(r.spawnOpts.opts.stdio, "ignore", "child stdio ignored");

  assert.equal(r.unref, 1, "child must be unref'd so the parent can exit");
  assert.equal(r.exit, 1, "parent must exit after spawning (leaves exactly one loop)");
  assert.deepEqual(r.exitCodes, [0]);
});
