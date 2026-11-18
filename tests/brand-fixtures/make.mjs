// Writes this brand's parity goldens from the release before the general settings, read
// from git at that commit. Run once, from the repo root:
//
//   node tests/brand-fixtures/make.mjs [rev]
//
// rev defaults to 0d32655. It writes, in tests/brand-fixtures/:
// - sheet-before.json: a spreadsheet that rev's setupSheets set up, with shifts on the Log,
//   a separate Profiles file named, staff columns, staff notes and a staff Settings value,
//   and the Kiosk admin menu that rev's onOpen showed on it (tests/setup-parity.test.mjs);
// - default-words.json: every call textCalls.mjs lists, with its arguments and rev's
//   output, or the error it threw, and the screen strings in rev's page sources
//   (tests/brand-default-words.test.mjs);
// - roster-before.json: rev's sample Profiles header and rows, and what rev read from them:
//   the list with its problem lines, each volunteer's email (with and without an Email
//   column), the error for each missing column, and the Profiles cache key (tests/brand-roster.test.mjs).
//
// and tests/stored-before.json: a save queue and a volunteer list as rev's page stored them,
// with invented people, and what they hold (tests/stored-parity.test.mjs). That file names
// no brand: it holds the stored text only, not the storage keys.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { FakeSpreadsheet, dumpSpreadsheet, menuOf, server } from "../fakeSpreadsheet.mjs";
import { textCalls } from "./textCalls.mjs";
import { isPageSource, screenStrings } from "./pageStrings.mjs";

const rev = process.argv[2] || "0d32655";
const root = new URL("../../", import.meta.url);
const atRev = (path) =>
  execFileSync("git", ["show", rev + ":" + path], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
const write = (name, json) =>
  writeFileSync(new URL("tests/brand-fixtures/" + name, root), JSON.stringify(json) + "\n");

// ---------------------------------------------------------------------------
// sheet-before.json

function sheetBefore() {
  const ss = new FakeSpreadsheet();
  const code = [atRev("apps-script/Logic.js"), atRev("apps-script/Sheets.js")];
  server(ss, { code }).setupSheets();

  const log = ss.getSheetByName("Log");
  const flags = ss.getSheetByName("Flags");
  const settings = ss.getSheetByName("Settings");
  const at = (h, d) => new Date("2026-11-" + d + "T" + h + ":00-06:00");
  const shifts = [
    ["Ada Example", "Pantry", at("09:00", "10"), at("12:30", "10"), "Done", "row-1"],
    ["Ben Sample", "Front desk", at("13:00", "11"), at("16:00", "11"), "Done", "row-2"],
    ["Cy Invented", "Pantry", at("08:45", "12"), "", "Open", "row-3"],
  ];
  const header = log.row(1);
  const col = (h) => header.indexOf(h) + 1;
  shifts.forEach(([name, role, inAt, outAt, status, id], i) => {
    const r = i + 2;
    log.set(r, col("Date"), inAt);
    log.set(r, col("Volunteer\nName"), name);
    log.set(r, col("Volunteer\nRole/Type"), role);
    log.set(r, col("Check-In\nRecorded\n(timestamp)"), inAt);
    if (outAt) log.set(r, col("Check-Out\nRecorded\n(timestamp)"), outAt);
    log.set(r, col("User Token"), "tok-" + (i + 1));
    log.set(r, col("Status"), status);
    log.set(r, col("Check-In\nEntered By"), "kiosk");
    log.set(r, col("Shift ID"), id);
  });
  // A staff column after the kiosk's, with its own note, and a staff note on a kiosk header.
  const staffCol = log.getLastColumn() + 1;
  log.set(1, staffCol, "Follow-up");
  log.set(2, staffCol, "call back");
  log.getRange(1, staffCol).setNote("Staff: who to call back.");
  log.getRange(1, col("Activity")).setNote("Staff: the activity codes are on the wall.");
  const flagCol = flags.getLastColumn() + 1;
  flags.set(1, flagCol, "Board follow-up");

  const setValue = (name, value) => {
    const names = settings
      .getRange(1, 1, settings.getLastRow(), 1)
      .getValues()
      .map((r) => r[0]);
    settings.set(names.indexOf(name) + 1, 2, value);
  };
  setValue("Volunteer Profiles file ID", "profiles-file-1");
  setValue("Arrival flag minutes", "20");
  setValue("Kiosk contact", "Front desk, 555-0100");
  setValue("Kiosk access code", "4321");

  const ctx = server(ss, { code });
  ctx.setupSheets();
  const sheet = dumpSpreadsheet(ss);
  return { sheet, menu: menuOf(ctx, atRev("apps-script/Admin.js")) };
}

// ---------------------------------------------------------------------------
// default-words.json

function defaultWords() {
  const L = {};
  vm.runInNewContext(atRev("apps-script/Logic.js"), L);
  return textCalls(L).map(([fn, args]) => {
    try {
      return { fn, args, out: JSON.parse(JSON.stringify(L[fn](...args)) ?? "null") };
    } catch (err) {
      console.log("threw: " + fn + " " + err.message);
      return { fn, args, threw: err.message };
    }
  });
}

// ---------------------------------------------------------------------------
// roster-before.json

const profileHash = (t) => createHash("sha256").update(t, "utf8").digest("hex");

function rosterBefore() {
  const L = {};
  vm.runInNewContext(atRev("apps-script/Logic.js") + "\n" + atRev("apps-script/SampleData.js"), L);
  const [header, ...rows] = JSON.parse(JSON.stringify(L.sampleProfileRows_()));
  const list = JSON.parse(JSON.stringify(L.parseProfiles(header, rows, profileHash)));
  const emails = JSON.parse(JSON.stringify(L.profileEmailsFrom(header, rows, list.volunteers)));
  const noEmail = header.map((h) => (h === "Email" ? "Other" : h));
  const emailsNoColumn = JSON.parse(
    JSON.stringify(L.profileEmailsFrom(noEmail, rows, list.volunteers)),
  );
  const missing = header.map((h, at) => {
    const without = header.map((x, i) => (i === at ? "Other" : x));
    try {
      L.parseProfiles(without, rows, profileHash);
      return [h, null];
    } catch (err) {
      return [h, err.message];
    }
  });
  const cacheKeys = [
    ["profiles-file-1", "Volunteer Profiles"],
    ["profiles-file-1", "Roster"],
  ].map(([fileId, tab]) => [fileId, tab, L.profilesCacheKey(fileId, tab)]);
  return { header, rows, list, emails, emailsNoColumn, missing, cacheKeys };
}

// ---------------------------------------------------------------------------
// tests/stored-before.json

async function storedBefore() {
  const dir = mkdtempSync(join(tmpdir(), "stored-before-"));
  try {
    execFileSync("sh", ["-c", "git archive " + rev + " src | tar -x -C " + JSON.stringify(dir)], {
      cwd: root,
    });
    const at = (f) => pathToFileURL(join(dir, "src", f)).href;
    const Q = await import(at("saveQueue.ts"));
    const S = await import(at("listStore.ts"));
    const stored = new Map();
    const storage = {
      getItem: (k) => (stored.has(k) ? stored.get(k) : null),
      setItem: (k, v) => void stored.set(k, String(v)),
      removeItem: (k) => void stored.delete(k),
    };

    // 10:00 in Central on 2026-11-18.
    const savedAt = Date.UTC(2026, 10, 18, 16, 0);
    const steps = [
      { fromMinutes: 0, id: null },
      { fromMinutes: 120, id: "hours-2" },
    ];
    const people = [
      {
        id: "v-ada",
        firstName: "Ada",
        lastName: "Example",
        currentCheckIn: null,
        missedSignOut: true,
      },
      {
        id: "v-ben",
        firstName: "Ben",
        lastName: "Sample",
        checkedIn: true,
        currentCheckIn: new Date(savedAt - 3 * 3_600_000).toISOString(),
        openShiftId: "shift-ben",
        openUntil: new Date(savedAt + 9 * 3_600_000).toISOString(),
        checkOutMilestones: steps,
      },
      { id: "v-cy", firstName: "Cy", lastName: "Invented", currentCheckIn: null },
      {
        id: "v-di",
        firstName: "Di",
        lastName: "Madeup",
        currentCheckIn: null,
        needsPhoneCheck: true,
      },
    ];
    const key = (n) => "0000000" + n + "-0000-4000-8000-00000000000" + n;
    const apply = (queue, change) => {
      const next = change(queue);
      if ("refused" in next) throw new Error("refused: " + next.refused);
      return next;
    };
    let queue = Q.freshQueue("epoch-before");
    const stamp = { epoch: "epoch-before", seq: 0, requestedAt: savedAt - 120_000 };
    queue = apply(queue, Q.enqueue(Q.newSave("in", people[0], savedAt - 60_000, key(1)), stamp));
    queue = apply(queue, Q.enqueue(Q.newSave("out", people[1], savedAt - 50_000, key(2)), stamp));
    queue = apply(queue, Q.enqueue(Q.newSave("in", people[2], savedAt - 40_000, key(3)), stamp));
    queue = apply(queue, Q.enqueue(Q.newSave("in", people[3], savedAt - 30_000, key(4)), stamp));
    queue = apply(queue, Q.markSent(key(1), savedAt - 59_000));
    queue = apply(queue, Q.markSent(key(3), savedAt - 39_000));
    queue = apply(
      queue,
      Q.afterAttempt(
        key(3),
        { outcome: "refused", replied: true, reason: "Already checked in." },
        savedAt - 38_000,
      ),
    );
    queue = apply(queue, Q.markSent(key(4), savedAt - 29_000));
    queue = apply(
      queue,
      Q.afterAttempt(key(4), { outcome: "landed", replied: true }, savedAt - 28_000),
    );
    queue = { ...queue, seq: 2 };
    Q.writeQueue(storage, queue);

    const volunteers = people.map((p) => ({
      active: true,
      expectedToday: false,
      completedShiftCount: 3,
      totalVolunteerMinutes: 600,
      ...p,
    }));
    const milestones = [{ id: "hours-2", title: "Two hours", message: "Two hours today." }];
    const listStamp = { epoch: "epoch-before", seq: 2, requestedAt: savedAt - 500 };
    S.storeList(storage, "code-before", savedAt, volunteers, 8, {
      milestones,
      clockOffsetMs: 1200,
      listStamp,
    });

    const after = (k) => stored.get(k);
    return {
      queue: after(Q.SAVE_QUEUE_KEY),
      list: after(S.LIST_STORE_KEY),
      code: "code-before",
      savedAt,
      saves: queue.saves.map((s) => s.key),
      failed: queue.failed.map((f) => f.key),
      marks: queue.marks.map((m) => m.key),
      volunteers: volunteers.map((v) => v.id),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

write("sheet-before.json", { rev, ...sheetBefore() });
write("roster-before.json", { rev, ...rosterBefore() });
writeFileSync(
  new URL("tests/stored-before.json", root),
  JSON.stringify(await storedBefore(), null, 1) + "\n",
);
function pageText() {
  const files = execFileSync("git", ["ls-tree", "-r", "--name-only", rev, "src"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\n")
    .filter(isPageSource);
  return [...new Set(files.flatMap((f) => screenStrings(f, atRev(f))))].sort();
}

write("default-words.json", { rev, calls: defaultWords(), page: pageText() });
console.log("wrote the goldens from " + rev);
