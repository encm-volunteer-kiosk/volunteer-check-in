// The model test for the Hours refresh's write rule. Each entry point (setupReports, the
// menu, nightly and on-open refreshes) is played as a list of steps on one model sheet:
// reads outside the lock, holds serialised by one lock, and inside a hold exactly the
// state-cell writes and table changes hoursNextState (Logic.js) lists, in its order. Every
// write lands the moment it is made, which is the worst case for a flush that lands a
// prefix. The test plays every path alone and every interleaving of two of them, with a
// kill after any one step, and checks (a read inside another path's hold is played just
// after that hold: it writes nothing and compares the same against every table time):
//   I1 after every step: B1 says the tables are whole ("As of <time>") only when Q1 is
//      built and Hours data and row 3 hold exactly the table read at that time;
//   I2 at the end of every hold that finishes: B1 is hoursLine of the cells and N1 is the
//      last note written under the lock;
//   I3 at every table write: a whole table is never replaced by one read earlier.
// The Reports.js write path runs the same step lists; its own stand-in tests check that.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const root = new URL("../", import.meta.url);
const L = {};
vm.runInNewContext(readFileSync(new URL("apps-script/Logic.js", root), "utf8"), L);

const fmt = (ms) => "T" + ms;
const CELLS = ["L1", "M1", "N1", "O1", "P1", "Q1"];
const INJECTED = new Error("injected");

/** The digest of the Log as read at t: with taps, every read sees new taps. */
const digests = {
  taps: (t) => "sha256:" + t.toString(16).padStart(64, "0"),
  still: () => "sha256:" + "0".repeat(63) + "1",
};

/** Starting sheets. Times in them are below the clock's start, 1000. */
function initial(name, dig) {
  const base = {
    cells: { L1: "", M1: "", N1: "", O1: "", P1: "", Q1: "" },
    B1: "",
    data: { digest: null, trimmed: true, row3: null },
    hoursExists: true,
    monthly: "kept",
  };
  if (name === "whole") {
    base.cells = {
      L1: "100",
      M1: "complete",
      N1: "refreshed|menu|100|101|",
      O1: "1|1|10|3",
      P1: dig(100),
      Q1: "built 50",
    };
    base.data = { digest: dig(100), trimmed: true, row3: dig(100) };
  } else if (name === "killed-write") {
    base.cells = {
      L1: "80",
      M1: "writing 90",
      N1: "refreshed|nightly|80|81|",
      O1: "1|1|10|3",
      P1: dig(80),
      Q1: "built 50",
    };
    base.data = { digest: dig(90), trimmed: false, row3: dig(80) };
  } else if (name === "setup-killed") {
    base.cells = { L1: "100", M1: "writing 60", N1: "", O1: "", P1: dig(100), Q1: "building 60" };
    base.data = { digest: dig(100), trimmed: true, row3: null };
  } else if (name === "fresh") {
    base.hoursExists = false;
    base.data = { digest: null, trimmed: true, row3: null };
  }
  const env = {
    sheet: base,
    now: 1000,
    dig,
    lastNote: base.cells.N1,
    tick() {
      this.now += 1;
      return this.now;
    },
    state() {
      return L.hoursState(CELLS.map((c) => this.sheet.cells[c]));
    },
    render() {
      if (this.sheet.hoursExists) this.sheet.B1 = L.hoursLine(this.state(), fmt);
    },
  };
  env.render();
  return env;
}

/** Runs one listed step on the model sheet. */
function apply(env, run, step) {
  const sheet = env.sheet;
  if (step.op === "set") {
    if (step.cell === "M1" && /^writing /.test(step.value)) {
      const s = env.state();
      if (L.hoursWhole(s)) run.displaced = s.tableTime;
      run.markWritten = true;
    }
    sheet.cells[step.cell] = step.timing
      ? L.hoursTimingCell({ readMs: 1, workMs: 1, writeMs: 10, rows: run.rows })
      : step.value;
    if (step.cell === "N1") env.lastNote = step.value;
  } else if (step.op === "render") env.render();
  else if (step.op === "values") {
    if (run.displaced !== undefined && run.t < run.displaced) {
      throw new Error(
        "I3: a whole table read at " + run.displaced + " was replaced by one read at " + run.t,
      );
    }
    sheet.data.digest = run.digest;
    sheet.data.trimmed = false;
  } else if (step.op === "trim") sheet.data.trimmed = true;
  else if (step.op === "counts") sheet.data.row3 = run.digest;
  // flush, grow and clear change nothing the invariants read.
}

/** Plays hoursNextState's list for one outcome, a step at a time; may throw at failAt. */
function* play(env, run, outcome, failAt) {
  run.w = env.now;
  const plan = L.hoursNextState(env.state(), run, outcome);
  run.decisions.push(plan.decision);
  for (const step of plan.steps) {
    apply(env, run, step);
    run.held = true;
    yield step.op === "set" ? "set " + step.cell : step.op;
    const at = step.op === "set" ? "set " + step.cell : step.op;
    if (failAt && failAt === at) throw INJECTED;
  }
  run.held = true;
}

/** A refresh by the menu, nightly or on open (path i). opts: fail, budget, noteOnly. */
function refresh(cause, opts = {}) {
  return function* (env, run) {
    run.cause = cause;
    run.t = env.tick();
    run.mark = run.t;
    run.digest = env.dig(run.t);
    run.rows = 3;
    run.budget = cause === "open" ? opts.budget || "ok" : undefined;
    yield "read";
    yield { lock: true };
    if (opts.noteOnly) return yield* play(env, run, { kind: "note-only" });
    if (opts.fail === "read")
      return yield* play(env, run, { kind: "failed", message: "read failed" });
    try {
      yield* play(env, run, { kind: "read" }, opts.fail);
    } catch (e) {
      if (e !== INJECTED) throw e;
      yield* play(env, run, { kind: "failed", message: "boom" });
    }
  };
}

/** setupReports, steps 1 to 8. opts.fail: "step5" or "values". */
function setup(opts = {}) {
  return function* (env, run) {
    run.cause = "setupReports";
    yield "check";
    const S = env.tick();
    Object.assign(run, { t: S, mark: S, digest: null, rows: 3 });
    yield { lock: true };
    try {
      yield* play(env, run, { kind: "setup-start" });
      yield "data header";
      env.sheet.hoursExists = true;
      env.sheet.data.row3 = null;
      env.sheet.B1 = "";
      yield "clear Hours";
      env.render();
      yield "render";
      if (opts.fail === "step5") throw INJECTED;
      yield "layout";
      yield* play(env, run, { kind: "setup-built" });
      run.t = env.tick();
      run.digest = env.dig(run.t);
      yield "read";
      yield* play(env, run, { kind: "read" }, opts.fail);
      const s = env.state();
      const d = env.sheet.data;
      if (
        s.build &&
        s.build.kind === "built" &&
        s.build.ms === S &&
        L.hoursWhole(s) &&
        s.tableTime === run.t
      ) {
        // Destroy only after proof: the table read back whole at this run's own read.
        assert.ok(d.digest === run.digest && d.trimmed && d.row3 === run.digest, "S7");
        env.sheet.monthly = "deleted";
      } else throw INJECTED;
      yield "step 7";
    } catch (e) {
      if (e !== INJECTED) throw e;
      yield* play(env, run, { kind: "failed", message: "setup failed" });
    }
  };
}

/** I1, on the sheet as it stands. */
function checkI1(env, where) {
  const m = /^As of T(\d+)[.,]/.exec(env.sheet.B1);
  if (!m) return;
  const x = Number(m[1]);
  const s = env.state();
  const d = env.sheet.data;
  const want = env.dig(x);
  assert.ok(
    s.build && s.build.kind === "built" && d.digest === want && d.trimmed && d.row3 === want,
    "I1 at " + where + ": " + env.sheet.B1 + " " + JSON.stringify([env.sheet.cells, d]),
  );
}

function checkI2(env, where) {
  assert.equal(env.sheet.B1, L.hoursLine(env.state(), fmt), "I2 B1 at " + where);
  assert.equal(env.sheet.cells.N1, env.lastNote, "I2 N1 at " + where);
}

/**
 * Plays the paths on one sheet under a schedule. choose(options) picks among the
 * runnable moves: ["step", i] advances path i one step; ["kill", i] ends it there (its
 * lock ends with it). Returns the env and the runs.
 */
function playOnce(startName, dig, paths, choose, kills) {
  const env = initial(startName, dig);
  const runs = paths.map(() => ({ decisions: [], held: false, markWritten: false }));
  const gens = paths.map((p, i) => p(env, runs[i]));
  const st = paths.map(() => ({ started: false, done: false, last: undefined }));
  let holder = -1;
  let killsLeft = kills;
  const trace = [];
  for (;;) {
    const options = [];
    st.forEach((s, i) => {
      if (s.done) return;
      // While one path holds the lock only it steps: another path's steps outside a
      // hold are its read, which writes nothing, and a read made during the hold gets
      // the same order against every table time as one made just after it.
      if (holder !== -1 && holder !== i) return;
      const wantsLock = s.last && typeof s.last === "object" && s.last.lock;
      if (!(wantsLock && holder !== -1 && holder !== i)) options.push(["step", i]);
    });
    if (killsLeft > 0) st.forEach((s, i) => s.started && !s.done && options.push(["kill", i]));
    if (!options.length) break;
    const [move, i] = options[choose(options)];
    const s = st[i];
    trace.push(move + i);
    if (move === "kill") {
      killsLeft -= 1;
      s.done = true;
      if (holder === i) holder = -1;
      continue;
    }
    if (s.last && typeof s.last === "object" && s.last.lock) holder = i;
    s.started = true;
    const r = gens[i].next();
    const where = startName + " " + trace.join(",");
    checkI1(env, where);
    if (r.done) {
      s.done = true;
      if (holder === i) {
        checkI2(env, where);
        holder = -1;
      }
    } else s.last = r.value;
  }
  return { env, runs };
}

/** Every schedule of the paths, by replaying with each choice prefix. */
function explore(startName, dig, paths, kills) {
  let prefix = [];
  let count = 0;
  for (;;) {
    const taken = [];
    const widths = [];
    playOnce(
      startName,
      dig,
      paths,
      (options) => {
        const k = taken.length;
        const pick = k < prefix.length ? prefix[k] : 0;
        taken.push(pick);
        widths.push(options.length);
        return pick;
      },
      kills,
    );
    count += 1;
    let j = taken.length - 1;
    while (j >= 0 && taken[j] + 1 >= widths[j]) j--;
    if (j < 0) return count;
    prefix = taken.slice(0, j).concat([taken[j] + 1]);
  }
}

const PATHS = {
  setup: setup(),
  "setup fails in step 5": setup({ fail: "step5" }),
  "setup fails at setValues": setup({ fail: "values" }),
  menu: refresh("menu"),
  "menu read fails": refresh("menu", { fail: "read" }),
  "menu fails after grow": refresh("menu", { fail: "grow" }),
  "menu fails after setValues": refresh("menu", { fail: "values" }),
  "menu fails after trim": refresh("menu", { fail: "trim" }),
  "menu fails between L1 and M1": refresh("menu", { fail: "set L1" }),
  nightly: refresh("nightly"),
  "open full": refresh("open"),
  "open too big": refresh("open", { budget: "too-big" }),
  "open note only": refresh("open", { noteOnly: true }),
};
const STARTS = ["whole", "killed-write", "setup-killed", "fresh"];

test("every path alone, from every starting sheet, with a kill after any step", () => {
  let runs = 0;
  for (const [digName, dig] of Object.entries(digests)) {
    for (const start of STARTS) {
      for (const [name, path] of Object.entries(PATHS)) {
        if (start === "fresh" && !name.startsWith("setup")) continue;
        runs += explore(start, dig, [path], 1);
        // The path run whole leaves B1 rendered from the cells.
        const { env } = playOnce(start, dig, [path], () => 0, 0);
        checkI2(env, digName + " " + start + " " + name);
      }
    }
  }
  assert.ok(runs > 300, String(runs));
});

test("every interleaving of two paths, two refreshes included, with a kill after any one step", () => {
  const names = Object.keys(PATHS);
  let runs = 0;
  for (const [, dig] of Object.entries(digests)) {
    for (const start of ["whole", "killed-write"]) {
      for (let a = 0; a < names.length; a++) {
        for (let b = a; b < names.length; b++) {
          runs += explore(start, dig, [PATHS[names[a]], PATHS[names[b]]], 1);
        }
      }
    }
  }
  assert.ok(runs > 10000, String(runs));
});

/** Plays paths under a fixed schedule: a list of path indexes to step, then the rest in order. */
function scripted(start, digName, paths, order) {
  let k = 0;
  return playOnce(
    start,
    digests[digName],
    paths,
    (options) => {
      while (k < order.length) {
        const want = order[k++];
        const at = options.findIndex(([m, i]) => m === "step" && i === want);
        if (at >= 0) return at;
      }
      return options.findIndex(([m]) => m === "step");
    },
    0,
  );
}

test("named: an open note written during a menu refresh's read; the menu's table and note land last", () => {
  // The menu reads (T 1001); the open takes the lock and notes; the menu writes.
  const { env, runs } = scripted(
    "whole",
    "taps",
    [refresh("menu"), refresh("open", { noteOnly: true })],
    [0, 1, 1, 1, 1, 1, 1, 1, 1, 0],
  );
  assert.deepEqual(runs[1].decisions, ["note-only"]);
  assert.deepEqual(runs[0].decisions, ["d"]);
  assert.equal(env.sheet.B1, "As of T1001, refreshed from the menu.");
  // An open after that writes its note last: the tables are still as of the menu's read.
  const after = playOnce(
    "whole",
    digests.taps,
    [refresh("menu"), refresh("open", { noteOnly: true })],
    (o) => 0,
    0,
  );
  assert.match(
    after.env.sheet.B1,
    /^As of T1001\. Not refreshed on open at T\d+: use Kiosk admin > Refresh Hours for newer taps\.$/,
  );
});

test("named: an older refresh whose read fails after a newer table landed writes no note", () => {
  // Path 0 reads first (older) and fails; path 1 reads later and lands its table first.
  const { env, runs } = scripted(
    "whole",
    "taps",
    [refresh("menu", { fail: "read" }), refresh("nightly")],
    [0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  );
  assert.deepEqual(runs[1].decisions, ["d"]);
  assert.deepEqual(runs[0].decisions, ["quiet"]);
  assert.equal(env.sheet.B1, "As of T1002, refreshed nightly.");
});

test("named: an open note made after a refresh landed keeps the refresh's time and shows the note", () => {
  const { env } = scripted(
    "whole",
    "taps",
    [refresh("menu"), refresh("open", { noteOnly: true })],
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  );
  assert.match(
    env.sheet.B1,
    /^As of T1001\. Not refreshed on open at T1002: use Kiosk admin > Refresh Hours for newer taps\.$/,
  );
});

test("named: setupReports killed in step 5, then a menu refresh: B1 still says Hours isn't fully set up", () => {
  // Kill setupReports right after its "clear Hours" step.
  let steps = 0;
  const killAfter = 1 + 1 + 4 + 1 + 1 + 1; // check, lock, setup-start's four steps, header, clear
  const first = playOnce(
    "whole",
    digests.taps,
    [setup()],
    (options) => {
      if (steps >= killAfter) {
        const k = options.findIndex(([m]) => m === "kill");
        if (k >= 0) return k;
      }
      steps += 1;
      return 0;
    },
    1,
  );
  assert.equal(first.env.sheet.cells.Q1, "building 1001");
  assert.equal(first.env.sheet.monthly, "kept");
  // A menu refresh on that sheet: it settles M1 and writes a whole table, but Q1 is building.
  const env = first.env;
  const run = { decisions: [], held: false, markWritten: false };
  const gen = refresh("menu")(env, run);
  for (let r = gen.next(); !r.done; r = gen.next()) checkI1(env, "after setup kill");
  checkI2(env, "after setup kill");
  assert.deepEqual(run.decisions, ["d"]);
  assert.equal(env.sheet.cells.M1, "complete");
  assert.match(
    env.sheet.B1,
    /^Hours is being set up by setupReports since T1001; if this stays over 5 minutes, run setupReports again\. Refreshed from the menu at T1002\.$/,
  );
});

test("named: setupReports fails in step 5 or at its setValues and keeps Monthly Hours", () => {
  const five = playOnce("whole", digests.taps, [setup({ fail: "step5" })], () => 0, 0);
  assert.equal(five.env.sheet.monthly, "kept");
  assert.equal(five.env.sheet.cells.Q1, "building 1001");
  assert.equal(five.env.sheet.cells.M1, "stopped 1001");
  assert.match(
    five.env.sheet.B1,
    /^Hours is being set up .* The refresh by setupReports at T1001 failed part way: setup failed\.$/,
  );
  const six = playOnce("whole", digests.taps, [setup({ fail: "values" })], () => 0, 0);
  assert.equal(six.env.sheet.monthly, "kept");
  assert.equal(six.env.sheet.cells.Q1, "built 1001");
  assert.equal(six.env.sheet.cells.M1, "stopped 1001");
  const ok = playOnce("whole", digests.taps, [setup()], () => 0, 0);
  assert.equal(ok.env.sheet.monthly, "deleted");
  assert.equal(ok.env.sheet.B1, "As of T1002, refreshed by setupReports.");
});

test("named: an open with no new taps moves L1 forward past a whole table with no table change", () => {
  const { env, runs } = playOnce("whole", digests.still, [refresh("open")], () => 0, 0);
  assert.deepEqual(runs[0].decisions, ["c"]);
  assert.equal(env.sheet.B1, "As of T1001, refreshed on open.");
  assert.equal(env.sheet.cells.M1, "complete");
});
