// The Time zone row: how a cell reads as a zone, what a missing, blank or unknown row
// does on the tablet, in the Kiosk admin windows and in the daily jobs, and that a run
// reads every time in the row's zone.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { FakeSpreadsheet, server, sheetWith } from "./fakeSpreadsheet.mjs";

const read = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");
const plain = (x) => JSON.parse(JSON.stringify(x));
const L = {};
vm.runInNewContext(read("apps-script/Brand.js") + "\n" + read("apps-script/Logic.js"), L);

const CODE = "lettersonlylettersonly";
const STEP = "Type your time zone in Settings, then run setupSheets.";

/** Logic.js under a stand-in brand whose Time zone default is blank. */
function blankZoneBrand() {
  const B = {};
  vm.runInNewContext(
    read("apps-script/Logic.js") +
      '\nfunction brandSettingsDefaults() { return { "Time zone": "" }; }',
    B,
  );
  return B;
}

/**
 * A server context on a spreadsheet whose Settings hold the access code and rows (an
 * object of name to value), with Api.js, Jobs.js and Admin.js loaded, ScriptApp's
 * triggers recorded in triggers and the script lock always free.
 */
function kiosk(rows, opts = {}) {
  const ss = new FakeSpreadsheet();
  if (opts.spreadsheetZone) ss.timeZone = opts.spreadsheetZone;
  sheetWith(ss, "Settings", [
    ["Setting", "Value"],
    ["Kiosk access code", CODE],
    ...Object.entries(rows),
  ]);
  const cache = new Map();
  const ctx = server(ss, { cache, code: opts.code });
  const triggers = [];
  ctx.ScriptApp = {
    getProjectTriggers: () => triggers,
    deleteTrigger: (t) => triggers.splice(triggers.indexOf(t), 1),
  };
  ctx.LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) };
  ctx.Utilities.sleep = () => {};
  ctx.HtmlService = {};
  for (const file of ["Api.js", "Jobs.js", "Admin.js"]) {
    vm.runInContext(read("apps-script/" + file), ctx, { filename: file });
  }
  return { ss, ctx, cache, triggers };
}

// ---------------------------------------------------------------------------
// Reading the row

test("a Time zone cell reads as the zone it names, and blank or anything else as none", () => {
  assert.equal(L.parseTimeZone("America/Chicago"), "America/Chicago");
  assert.equal(L.parseTimeZone("  Europe/London "), "Europe/London");
  // Wrong capitals read as the zone's proper spelling, an alias as the zone it names.
  assert.equal(L.parseTimeZone("america/chicago"), "America/Chicago");
  assert.equal(L.parseTimeZone("US/Central"), "America/Chicago");
  assert.equal(L.parseTimeZone("UTC"), "UTC");
  for (const text of [
    "",
    "   ",
    "Central",
    "Mars/Olympus",
    "+05:30",
    "UTC+5",
    "America/ Chicago",
  ]) {
    assert.equal(L.parseTimeZone(text), "", JSON.stringify(text));
  }
  assert.equal(L.parseTimeZone(undefined), "");
});

test("a missing Time zone row reads as the brand's default, and the code's is America/Chicago", () => {
  assert.equal(L.defaultTimeZone(), "America/Chicago");
  assert.equal(L.kioskZoneOf({}), "America/Chicago");
  assert.equal(L.kioskZoneOf(undefined), "America/Chicago");
  assert.equal(L.kioskZoneOf({ "Time zone": "Asia/Kolkata" }), L.parseTimeZone("Asia/Kolkata"));
  assert.equal(L.kioskZoneOf({ "Time zone": "" }), "");
  assert.equal(L.kioskZoneOf({ "Time zone": "nowhere" }), "");
});

test("under a brand whose Time zone default is blank, a missing row reads as none", () => {
  const B = blankZoneBrand();
  assert.equal(B.kioskZoneOf({}), "");
  assert.equal(B.kioskZoneOf({ "Time zone": "Europe/London" }), "Europe/London");
  assert.equal(Object.fromEntries(plain(B.settingsDefaults("2026-11-18")))["Time zone"], "");
  assert.equal(B.zoneRefusal({}).refusal, "ZONE_NOT_SET");
});

test("the refusals: ZONE_NOT_SET sends the person to staff in the staff word, and staff get the step", () => {
  assert.equal(L.zoneRefusal({}), null);
  assert.deepEqual(plain(L.zoneRefusal({ "Time zone": " " })), {
    ok: false,
    refusal: "ZONE_NOT_SET",
    message: "This kiosk isn't set up yet. Please see a board member.",
  });
  L.useSettings({ "Time zone": "", "Word for staff": "staff member" });
  try {
    assert.equal(
      L.refusal("ZONE_NOT_SET").message,
      "This kiosk isn't set up yet. Please see a staff member.",
    );
  } finally {
    L.useSettings(null);
  }
  assert.equal(L.timeZoneStepMessage(), STEP);
});

// ---------------------------------------------------------------------------
// The tablet

for (const [label, rows] of [
  ["blank", { "Time zone": "" }],
  ["unknown", { "Time zone": "Central Time" }],
]) {
  test(
    "a " + label + " Time zone row refuses every tablet call ZONE_NOT_SET, after the code",
    () => {
      const { ctx } = kiosk(rows);
      const zone = { ok: false, refusal: "ZONE_NOT_SET" };
      const pick = (r) => ({ ok: r.ok, refusal: r.refusal });
      assert.deepEqual(pick(ctx.apiCheckAccess(CODE)), zone);
      assert.deepEqual(pick(ctx.apiListVolunteers(CODE)), zone);
      assert.deepEqual(pick(ctx.apiCheckIn(CODE, "v1", null, "")), zone);
      assert.deepEqual(pick(ctx.apiCheckOut(CODE, "v1", "", null)), zone);
      assert.deepEqual(pick(ctx.apiChangeArrival(CODE, "v1", "", "s1", null, null)), zone);
      assert.deepEqual(pick(ctx.apiRequestHours(CODE, "v1", "")), zone);
      // A wrong code is still refused ACCESS first.
      assert.equal(ctx.apiCheckAccess("wrongwrongwrongwrong").refusal, "ACCESS");
      assert.equal(ctx.apiCheckIn("wrongwrongwrongwrong", "v1", null, "").refusal, "ACCESS");
    },
  );
}

test("a missing Time zone row lets the tablet in on America/Chicago, whatever the spreadsheet's zone", () => {
  const { ctx } = kiosk({}, { spreadsheetZone: "Europe/London" });
  assert.deepEqual(plain(ctx.apiCheckAccess(CODE)), { ok: true });
  assert.equal(ctx.kioskTimeZone(), "America/Chicago");
});

test("under a brand whose Time zone default is blank, a missing row refuses the tablet", () => {
  const brand = 'function brandSettingsDefaults() { return { "Time zone": "" }; }';
  const code = [
    read("apps-script/Brand.js") + "\n" + read("apps-script/Logic.js") + "\n" + brand,
    read("apps-script/Sheets.js"),
  ];
  const { ctx } = kiosk({}, { code });
  assert.equal(ctx.apiCheckAccess(CODE).refusal, "ZONE_NOT_SET");
});

// ---------------------------------------------------------------------------
// The server's clock

test("a run reads its times in the Time zone row's zone, reading Settings first when it hasn't", () => {
  const at = new Date("2026-07-01T23:30:00Z");
  const expect = {
    "America/Chicago": "2026-07-01",
    "Europe/London": "2026-07-02",
    "Asia/Kolkata": "2026-07-02",
    "Pacific/Honolulu": "2026-07-01",
  };
  for (const [zone, day] of Object.entries(expect)) {
    const { ctx } = kiosk({ "Time zone": zone }, { spreadsheetZone: "America/Chicago" });
    assert.equal(ctx.centralDate_(at), day, zone);
    assert.equal(ctx.kioskTimeZone(), L.parseTimeZone(zone), zone);
  }
});

test("with no Time zone, kioskTimeZone throws the staff step", () => {
  const { ctx } = kiosk({ "Time zone": "" });
  assert.throws(() => ctx.centralDate_(new Date()), { message: STEP });
});

test("a Kiosk admin window with no Time zone says the staff step", () => {
  const { ctx, cache } = kiosk({ "Time zone": "nowhere" });
  cache.set(ctx.adminKeyCacheKey("k1"), "1");
  assert.throws(() => ctx.adminRoster("k1"), { message: STEP });
});

// ---------------------------------------------------------------------------
// The daily jobs

test("setupDailyJobs with no Time zone throws the staff step and changes no trigger", () => {
  const { ctx, triggers } = kiosk({ "Time zone": "" });
  const old = { getHandlerFunction: () => "runAutoClockOut", getUniqueId: () => "t1" };
  triggers.push(old);
  assert.throws(() => ctx.setupDailyJobs(), { message: STEP });
  assert.deepEqual(triggers, [old]);
});

test("each daily job with no Time zone throws the staff step", () => {
  for (const handler of [
    "runFlagsEmail",
    "runAutoClockOut",
    "runHoursRefresh",
    "runHoursRequests",
  ]) {
    const { ctx, triggers } = kiosk({ "Time zone": "" });
    triggers.push({ getHandlerFunction: () => handler, getUniqueId: () => "t1" });
    assert.throws(() => ctx[handler]({ triggerUid: "t1" }), { message: STEP }, handler);
  }
});
