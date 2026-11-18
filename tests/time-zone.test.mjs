// The Time zone row: how a cell reads as a zone, what a missing, blank or unknown row
// does on the tablet, in the Kiosk admin windows and in the daily jobs, and that a run
// reads every time in the row's zone.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { FakeSpreadsheet, server, sheetWith } from "./fakeSpreadsheet.mjs";
import { formatInZone } from "./zoneFormat.mjs";

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
  opts.docProps = opts.docProps || new Map();
  const ctx = server(ss, { cache, code: opts.code, docProps: opts.docProps, errors: opts.errors });
  const triggers = [];
  let uid = 0;
  ctx.ScriptApp = {
    getProjectTriggers: () => [...triggers],
    deleteTrigger: (t) => triggers.splice(triggers.indexOf(t), 1),
    newTrigger: (handler) => {
      const t = { handler, uid: "new-" + ++uid };
      t.getHandlerFunction = () => handler;
      t.getUniqueId = () => t.uid;
      const create = { create: () => triggers.push(t) };
      return {
        timeBased: () => ({
          everyHours: (n) => ((t.everyHours = n), create),
          atHour: (h) => ({
            everyDays: () => ({ inTimezone: (zone) => ((t.atHour = h), (t.zone = zone), create) }),
          }),
        }),
      };
    },
  };
  if (opts.storesAs) {
    // The name the spreadsheet stores for a zone it is set to, as Sheets may for an alias.
    ss.setSpreadsheetTimeZone = (zone) => (ss.timeZone = opts.storesAs[zone] || zone);
  }
  ctx.LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) };
  ctx.Utilities.sleep = () => {};
  ctx.Utilities.parseDate = (text, zone, format) => {
    assert.equal(format, "yyyy-MM-dd HH:mm:ss");
    return new Date(zoneMs(text, zone));
  };
  ctx.HtmlService = {};
  for (const file of ["Api.js", "Jobs.js", "Admin.js"]) {
    vm.runInContext(read("apps-script/" + file), ctx, { filename: file });
  }
  return { ss, ctx, cache, triggers, docProps: opts.docProps };
}

/** The instant a wall-clock "yyyy-MM-dd HH:mm:ss" names in zone. */
function zoneMs(text, zone) {
  const want = Date.parse(text.replace(" ", "T") + "Z");
  let ms = want;
  for (let i = 0; i < 3; i++) {
    const got = Date.parse(formatInZone(new Date(ms), zone, "yyyy-MM-ddTHH:mm:ss") + "Z");
    ms += want - got;
  }
  return ms;
}

/** Runs fn with the process's local zone, which Date.parse reads text in, set to zone. */
function inLocalZone(zone, fn) {
  const was = process.env.TZ;
  process.env.TZ = zone;
  try {
    return fn();
  } finally {
    if (was === undefined) delete process.env.TZ;
    else process.env.TZ = was;
  }
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
    assert.equal(ctx.kioskDate_(at), day, zone);
    assert.equal(ctx.kioskTimeZone(), L.parseTimeZone(zone), zone);
  }
});

test("with no Time zone, kioskTimeZone throws the staff step", () => {
  const { ctx } = kiosk({ "Time zone": "" });
  assert.throws(() => ctx.kioskDate_(new Date()), { message: STEP });
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

test("the script's own zone is appsscript.json's", () => {
  const manifest = JSON.parse(read("apps-script/appsscript.json"));
  assert.equal(L.scriptTimeZone(), manifest.timeZone);
});

test("a time typed as text is read in the kiosk's zone, as Date.parse reads it in the script's", () => {
  inLocalZone("America/Chicago", () => {
    const text = "Nov 5, 2026 9:00 AM";
    const chicago = kiosk({ "Time zone": "America/Chicago" }).ctx;
    assert.equal(chicago.cellTime_(text).ms, Date.parse("2026-11-05T09:00:00-06:00"));
    for (const [zone, iso] of [
      ["Europe/London", "2026-11-05T09:00:00Z"],
      ["Asia/Kolkata", "2026-11-05T09:00:00+05:30"],
    ]) {
      const { ctx } = kiosk({ "Time zone": zone });
      const t = ctx.cellTime_(text);
      assert.equal(t.ms, Date.parse(iso), zone);
      assert.equal(t.date, "2026-11-05", zone);
    }
    // A text that names its offset, or a bare date, is read as Date.parse reads it.
    const { ctx } = kiosk({ "Time zone": "Europe/London" });
    for (const named of [
      "2026-11-05T09:00:00Z",
      "2026-11-05T09:00:00-06:00",
      "Nov 5, 2026 9:00 AM GMT",
      "2026-11-05",
    ]) {
      assert.equal(ctx.cellTime_(named).ms, Date.parse(named), named);
    }
  });
});

test("the daily jobs' log line names the kiosk's zone", () => {
  const { ctx } = kiosk({ "Time zone": "Europe/London" });
  assert.equal(
    ctx.jobLabel_({ handler: "runAutoClockOut", atHour: 4 }),
    "runAutoClockOut daily at 4:00 Europe/London",
  );
});

// ---------------------------------------------------------------------------
// setupSheets' time zone step

/** A trigger as this account had it installed: handler, at an hour or every few hours. */
function installed(handler, spec = {}) {
  return {
    handler,
    getHandlerFunction: () => handler,
    getUniqueId: () => "old-" + handler,
    ...spec,
  };
}

/** The Settings tab's value for name, or undefined with no such row. */
function settingOf(ss, name) {
  const row = ss
    .getSheetByName("Settings")
    .getDataRange()
    .getValues()
    .find((r) => r[0] === name);
  return row ? row[1] : undefined;
}

test("setupSheets sets the spreadsheet's zone from the Time zone row and keeps the name it stored", () => {
  const { ss, ctx, docProps } = kiosk({ "Time zone": "Europe/London" });
  assert.equal(ss.timeZone, "America/Chicago");
  ctx.setupSheets();
  assert.equal(ss.timeZone, "Europe/London");
  assert.deepEqual(JSON.parse(docProps.get("zoneSetAs")), {
    row: "Europe/London",
    stored: "Europe/London",
  });
});

test("setupSheets remakes the installed daily triggers that run at an hour on the row's zone", () => {
  const { ctx, triggers } = kiosk({ "Time zone": "Asia/Kolkata" });
  const hourly = installed("runFlagsEmail", { everyHours: 1 });
  const other = installed("onSheetChange");
  triggers.push(hourly, installed("runAutoClockOut", { atHour: 4, zone: "America/Chicago" }));
  triggers.push(other);
  ctx.setupSheets();
  // The hourly and other triggers are kept; the auto clock-out's is made again, then deleted.
  assert.deepEqual(
    triggers.map((t) => t.getUniqueId()),
    ["old-runFlagsEmail", "old-onSheetChange", "new-1"],
  );
  assert.ok(triggers.includes(hourly) && triggers.includes(other));
  const made = triggers[2];
  assert.deepEqual(
    [made.handler, made.atHour, made.zone],
    ["runAutoClockOut", 4, L.parseTimeZone("Asia/Kolkata")],
  );
});

test("setupSheets installs no daily trigger that wasn't installed", () => {
  const { ctx, triggers } = kiosk({ "Time zone": "Europe/London" });
  ctx.setupSheets();
  assert.deepEqual(triggers, []);
});

test("an alias the spreadsheet stores by another name: setupSheets keeps the pair and sets it once", () => {
  const storesAs = { "US/Central": "America/Chicago" };
  const { ss, ctx, docProps } = kiosk(
    { "Time zone": "US/Central" },
    {
      spreadsheetZone: "Europe/London",
      storesAs,
    },
  );
  let sets = 0;
  const set = ss.setSpreadsheetTimeZone;
  ss.setSpreadsheetTimeZone = (zone) => (sets++, set(zone));
  ctx.setupSheets();
  assert.equal(ss.timeZone, "America/Chicago");
  assert.deepEqual(JSON.parse(docProps.get("zoneSetAs")), {
    row: "US/Central",
    stored: "America/Chicago",
  });
  ctx.setupSheets();
  assert.equal(sets, 1);
});

test("with a blank Time zone row setupSheets leaves the zone, the triggers and the launch date", () => {
  const { ss, ctx, triggers, docProps } = kiosk(
    { "Time zone": "", "Kiosk launch date": "" },
    { spreadsheetZone: "Europe/London" },
  );
  const auto = installed("runAutoClockOut", { atHour: 4, zone: "America/Chicago" });
  triggers.push(auto);
  ctx.setupSheets();
  assert.equal(ss.timeZone, "Europe/London");
  assert.deepEqual(triggers, [auto]);
  assert.equal(docProps.size, 0);
  // The rest is set up: every Settings row is there, the launch date still blank.
  for (const [name] of plain(L.settingsDefaults(""))) {
    assert.notEqual(settingOf(ss, name), undefined, name);
  }
  assert.equal(settingOf(ss, "Kiosk launch date"), "");
  assert.ok(ss.getSheetByName("Log") && ss.getSheetByName("Flags"));

  // Once a zone is typed, the next run fills the launch date with today there.
  const settings = ss.getSheetByName("Settings");
  const row =
    settings
      .getDataRange()
      .getValues()
      .findIndex((r) => r[0] === "Time zone") + 1;
  settings.getRange(row, 2).setValue("Asia/Kolkata");
  const fresh = server(ss, { docProps });
  fresh.ScriptApp = { getProjectTriggers: () => [] };
  fresh.setupSheets();
  assert.equal(
    settingOf(ss, "Kiosk launch date"),
    new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date()),
  );
  assert.equal(ss.timeZone, "Asia/Kolkata");
});

test("a missing Time zone row: setupSheets sets America/Chicago and adds the row with it", () => {
  const { ss, ctx } = kiosk({}, { spreadsheetZone: "Europe/London" });
  ctx.setupSheets();
  assert.equal(ss.timeZone, "America/Chicago");
  assert.equal(settingOf(ss, "Time zone"), "America/Chicago");
  assert.equal(settingOf(ss, "Time zone problem"), "");
});

test("under a brand whose Time zone default is blank, setupSheets adds the row blank and sets no zone", () => {
  const brand = 'function brandSettingsDefaults() { return { "Time zone": "" }; }';
  const code = [
    read("apps-script/Brand.js") + "\n" + read("apps-script/Logic.js") + "\n" + brand,
    read("apps-script/Sheets.js"),
  ];
  const { ss, ctx } = kiosk(
    { "Kiosk launch date": "" },
    { code, spreadsheetZone: "Europe/London" },
  );
  ctx.setupSheets();
  assert.equal(ss.timeZone, "Europe/London");
  assert.equal(settingOf(ss, "Time zone"), "");
  assert.equal(settingOf(ss, "Kiosk launch date"), "");
});

// ---------------------------------------------------------------------------
// The Time zone problem row

const PROBLEM = (row, sheet) =>
  "Settings says " +
  row +
  ", the spreadsheet is on " +
  sheet +
  "; times shown on the sheet and times typed into it are off until they match. Correct the" +
  " Time zone row if it's wrong, then run setupSheets.";

test("the problem text names both zones while they differ, and is blank while they match", () => {
  const none = () => null;
  const chicago = { "Time zone": "America/Chicago" };
  assert.equal(L.timeZoneProblemText(chicago, "America/Chicago", none), "");
  assert.equal(
    L.timeZoneProblemText(chicago, "America/New_York", none),
    PROBLEM("America/Chicago", "America/New_York"),
  );
  // A missing row is the brand's default, never the spreadsheet's zone.
  assert.equal(
    L.timeZoneProblemText({}, "Europe/London", none),
    PROBLEM("America/Chicago", "Europe/London"),
  );
  // A blank or unknown row: blank, as the refusal speaks for it.
  assert.equal(L.timeZoneProblemText({ "Time zone": "" }, "Europe/London", none), "");
  assert.equal(L.timeZoneProblemText({ "Time zone": "nowhere" }, "Europe/London", none), "");
  // Two names for one zone match through the pair setupSheets kept.
  const pair = () => ({ row: "US/Central", stored: "America/Chicago" });
  assert.equal(L.timeZoneProblemText({ "Time zone": "US/Central" }, "America/Chicago", pair), "");
  assert.equal(
    L.timeZoneProblemText({ "Time zone": "US/Central" }, "America/Denver", pair),
    PROBLEM("US/Central", "America/Denver"),
  );
});

test("zonesMatch reads the pair only when the names differ", () => {
  let reads = 0;
  const pair = () => (reads++, { row: "US/Central", stored: "America/Chicago" });
  assert.equal(L.zonesMatch("Europe/London", "Europe/London", pair), true);
  assert.equal(reads, 0);
  assert.equal(L.zonesMatch("US/Central", "America/Chicago", pair), true);
  assert.equal(L.zonesMatch("America/Chicago", "US/Central", pair), false);
  assert.equal(reads, 2);
  assert.equal(
    L.parseZoneSetAs(L.zoneSetAsText(" US/Central ", "America/Chicago")).row,
    "US/Central",
  );
  for (const bad of [null, "", "not json", "{}", '{"row":1,"stored":"x"}']) {
    assert.equal(L.parseZoneSetAs(bad), null, String(bad));
  }
});

test("the flags email: the problem line first, the subject's mismatch before the counts, the counts without it", () => {
  const input = {
    summary: { recent: [], unreviewed: 0 },
    autoClockOut: { stale: false, lastRun: "2026-11-16 04:02" },
    flagsUrl: "https://example.org/flags",
    skipped: [],
  };
  assert.equal(L.flagsEmailMessage(input), null);
  assert.equal(L.flagsEmailMessage({ ...input, zoneProblem: "" }), null);
  const zoned = L.flagsEmailMessage({ ...input, zoneProblem: "  Settings says X  " });
  assert.equal(
    zoned.subject,
    "Volunteer kiosk: time zone mismatch, 0 new flags this week, 0 unreviewed",
  );
  assert.deepEqual(zoned.body.split("\n\n").slice(0, 3), [
    "Time zone problem: Settings says X",
    "Flags raised in the last 7 days: 0",
    "Flags still unreviewed: 0",
  ]);
  const both = L.flagsEmailMessage({
    ...input,
    autoClockOut: { stale: true, lastRun: "" },
    zoneProblem: "Settings says X",
  });
  assert.equal(
    both.subject,
    "Volunteer kiosk: time zone mismatch, auto clock-out not running, 0 new flags this week, 0 unreviewed",
  );
  const body = both.body.split("\n\n");
  assert.equal(body[0], "Time zone problem: Settings says X");
  assert.ok(body[1].startsWith("The auto clock-out has never run."));
});

/** setSetting_ in ctx, wrapped to record each call as [name, value]. */
function spySettings(ctx) {
  const calls = [];
  const real = ctx.setSetting_;
  ctx.setSetting_ = (name, value) => (calls.push([name, value]), real(name, value));
  return calls;
}

test("setupSheets clears the problem row in its own run, and leaves a blank one alone", () => {
  const { ss, ctx } = kiosk(
    {
      "Time zone": "Europe/London",
      "Time zone problem": PROBLEM("Europe/London", "America/Chicago"),
    },
    { spreadsheetZone: "America/Chicago" },
  );
  const calls = spySettings(ctx);
  ctx.setupSheets();
  assert.equal(settingOf(ss, "Time zone problem"), "");
  assert.deepEqual(
    calls.filter(([name]) => name === "Time zone problem"),
    [["Time zone problem", ""]],
  );
  calls.length = 0;
  ctx.setupSheets();
  assert.deepEqual(
    calls.filter(([name]) => name === "Time zone problem"),
    [],
  );
});

test("an alias: once setupSheets keeps the pair, the compare writes nothing", () => {
  const { ss, ctx } = kiosk(
    { "Time zone": "US/Central", "Time zone problem": "" },
    { spreadsheetZone: "Europe/London", storesAs: { "US/Central": "America/Chicago" } },
  );
  ctx.setupSheets();
  assert.equal(ss.timeZone, "America/Chicago");
  assert.equal(settingOf(ss, "Time zone problem"), "");
  const calls = spySettings(ctx);
  assert.equal(ctx.compareTimeZones_(ctx.readSettings_()), "");
  assert.deepEqual(calls, []);
});

test("a blank or unknown Time zone row: the compare blanks a problem row once, then writes nothing", () => {
  for (const zone of ["", "nowhere"]) {
    const { ss, ctx } = kiosk(
      { "Time zone": zone, "Time zone problem": PROBLEM("Europe/London", "America/Chicago") },
      { spreadsheetZone: "America/Chicago" },
    );
    const calls = spySettings(ctx);
    ctx.setupSheets();
    assert.equal(settingOf(ss, "Time zone problem"), "", JSON.stringify(zone));
    assert.deepEqual(
      calls.filter(([name]) => name === "Time zone problem"),
      [["Time zone problem", ""]],
    );
    calls.length = 0;
    ctx.setupSheets();
    assert.equal(ctx.compareTimeZones_(ctx.readSettings_()), "");
    assert.deepEqual(
      calls.filter(([name]) => name === "Time zone problem"),
      [],
    );
  }
});

test("a compare that can't write is logged and returns the text", () => {
  const errors = [];
  const { ctx } = kiosk({ "Time zone": "Europe/London" }, { errors });
  ctx.setSetting_ = () => {
    throw new Error("Service Spreadsheets timed out");
  };
  assert.equal(
    ctx.compareTimeZones_(ctx.readSettings_()),
    PROBLEM("Europe/London", "America/Chicago"),
  );
  assert.deepEqual(errors, ["Time zone problem not written: Service Spreadsheets timed out"]);
});
