// Tests for apps-script/Logic.js, loaded the way Apps Script loads it: one plain script
// run in its own global scope. Objects made inside that scope have its prototypes, so
// results are compared through plain().

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import vm from "node:vm";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");

const L = {};
vm.runInNewContext(read("apps-script/Logic.js"), L);
const sample = {};
vm.runInNewContext(read("apps-script/SampleData.js"), sample);

const plain = (x) => JSON.parse(JSON.stringify(x));
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const idOf = (token) => sha256(token.trim()).slice(0, 16);

const MIN = 60000;
const HOUR = 60 * MIN;
// 10:00 Central on 2026-11-12 (Central is UTC-6 in November).
const NOW = Date.parse("2026-11-12T16:00:00Z");
const TODAY = "2026-11-12";

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const csv = parseCsv(read("sample-data/volunteer-profiles-sample.csv"));
const HEADER = csv[0];

/** A data row under the real header, with the given cells by normalized header. */
function profileRow(cells) {
  const row = HEADER.map(() => "");
  for (const [name, value] of Object.entries(cells)) {
    const at = HEADER.findIndex((h) => L.normalizeHeader(h) === name);
    assert.ok(at >= 0, "no header " + name);
    row[at] = value;
  }
  return row;
}

const person = (first, last, token, phone = "615-555-0150", start = "01/15/2026") =>
  profileRow({
    "volunteer first name": first,
    "volunteer last name": last,
    "onboarding token": token,
    "volunteer phone": phone,
    "start date mm/dd/yyyy": start,
  });

const parse = (rows) => plain(L.parseProfiles(HEADER, rows, sha256));

// ---------------------------------------------------------------------------
// Text

test("normalizeHeader collapses embedded newlines and spaces", () => {
  assert.equal(L.normalizeHeader("Volunteer\nFirst Name"), "volunteer first name");
  assert.equal(L.normalizeHeader("  Start Date\r\nmm/dd/yyyy "), "start date mm/dd/yyyy");
  assert.equal(L.normalizeHeader("Onboarding\n  Token"), "onboarding token");
});

test("normalizeName trims, lower-cases and collapses spaces", () => {
  assert.equal(L.normalizeName("  Maria   ALVAREZ "), "maria alvarez");
  assert.equal(L.normalizeName(null), "");
});

test("normalizeCode keeps lower-case letters only", () => {
  assert.equal(L.normalizeCode("Purple Otter 42 Lamp-Post!"), "purpleotterlamppost");
  assert.equal(L.normalizeCode(undefined), "");
});

test("sheetText marks formula-looking text as plain text", () => {
  assert.equal(L.sheetText('=HYPERLINK("x")'), '\'=HYPERLINK("x")');
  assert.equal(L.sheetText(" Maria "), "Maria");
  assert.equal(L.sheetText("-Ann"), "-Ann");
  // Sheets drops a leading apostrophe as its plain-text mark, so one more keeps the one typed.
  assert.equal(L.sheetText("'Neil"), "''Neil");
  assert.equal(L.sheetText("''"), "'''");
  assert.equal(L.sheetText("O'Neil"), "O'Neil");
});

test("utf8Length counts UTF-8 bytes", () => {
  assert.equal(L.utf8Length("abc"), 3);
  assert.equal(L.utf8Length("é"), 2);
  assert.equal(L.utf8Length("€"), 3);
  assert.equal(L.utf8Length("😀"), 4);
});

test("bytesToHex turns signed digest bytes into lowercase hex", () => {
  assert.equal(L.bytesToHex([-1, 0, 15, 16, -128, 127]), "ff000f10807f");
  const digest = createHash("sha256").update("sample-token-01", "utf8").digest();
  const signed = Array.from(new Int8Array(digest.buffer, digest.byteOffset, digest.length));
  assert.equal(L.bytesToHex(signed), sha256("sample-token-01"));
});

test("idFromHash keeps the first 16 hex characters", () => {
  assert.equal(L.idFromHash("ABCDEF0123456789ffff"), "abcdef0123456789");
});

test("phoneLast4 takes the last four digits and drops an extension", () => {
  assert.equal(L.phoneLast4("615-555-0101"), "0101");
  assert.equal(L.phoneLast4("(615) 555-0113"), "0113");
  assert.equal(L.phoneLast4("615-555-0117 x12"), "0117");
  assert.equal(L.phoneLast4("615.555.0118 ext. 4401"), "0118");
  assert.equal(L.phoneLast4("615-555-0119 Ext 7"), "0119");
  assert.equal(L.phoneLast4("615-555-0120#33"), "0120");
  assert.equal(L.phoneLast4("6155550121"), "0121");
  assert.equal(L.phoneLast4("555"), "");
  assert.equal(L.phoneLast4(""), "");
  assert.equal(L.phoneLast4("x1234"), "");
});

test("parseStartDate accepts yyyy-MM-dd and m/d/yyyy only", () => {
  assert.equal(L.parseStartDate("2026-02-15"), "2026-02-15");
  assert.equal(L.parseStartDate("2/5/2026"), "2026-02-05");
  assert.equal(L.parseStartDate(" 02/15/2026 "), "2026-02-15");
  assert.equal(L.parseStartDate(""), "");
  assert.equal(L.parseStartDate("soon"), "");
  assert.equal(L.parseStartDate("2026-02-30"), "");
  assert.equal(L.parseStartDate("13/01/2026"), "");
  assert.equal(L.parseStartDate("2026/02/15"), "");
});

test("isRowToday on a date and on a date-time", () => {
  assert.equal(L.isRowToday("2026-11-12", TODAY), true);
  assert.equal(L.isRowToday(" 2026-11-12 ", TODAY), true);
  assert.equal(L.isRowToday("11/12/2026", TODAY), true);
  assert.equal(L.isRowToday("2026-11-12 9:30 am", TODAY), true);
  assert.equal(L.isRowToday("2026-11-12T09:30:00", TODAY), true);
  assert.equal(L.isRowToday("2026-11-11", TODAY), false);
  assert.equal(L.isRowToday("2026-11-11 23:59", TODAY), false);
  assert.equal(L.isRowToday("", TODAY), false);
  assert.equal(L.isRowToday("2026-11-12", ""), false);
});

test("parseFlagMinutes falls back to 15", () => {
  assert.equal(L.parseFlagMinutes("20"), 20);
  assert.equal(L.parseFlagMinutes("0"), 0);
  assert.equal(L.parseFlagMinutes(""), 15);
  assert.equal(L.parseFlagMinutes("soon"), 15);
  assert.equal(L.parseFlagMinutes("-5"), 15);
});

// ---------------------------------------------------------------------------
// Setup tables

// The Log header, line breaks included. Columns A to N are ENCM's "2026-11 Log" tab of
// their Volunteer Kiosk Log spreadsheet, as read live on 2026-11-12; O to R are the
// kiosk's own.
const ENCM_LOG_HEADERS = [
  "Date",
  "Day",
  "Volunteer\nName",
  "Volunteer\nRole/Type",
  "Check-In\nRecorded\n(timestamp)",
  "Check-In\nStated\n(user)",
  "Check-Out\nRecorded\n(timestamp)",
  "Check-Out\nStated (user)",
  "Hours Served\n(timestamps)",
  "Hours Served\n(stated)",
  "Admin\nAlerts?",
  "Activity",
  "Notes",
  "User Token",
];
const KIOSK_LOG_HEADERS = ["Status", "Check-In\nEntered By", "Check-Out\nEntered By", "Shift ID"];
const LOG_HEADERS = [...ENCM_LOG_HEADERS, ...KIOSK_LOG_HEADERS];

test("logHeaders is ENCM's fourteen headers exactly, then the kiosk's four", () => {
  assert.deepEqual(plain(L.logHeaders()), LOG_HEADERS);
  assert.equal(L.logHeaders().length, 18);
  const H = plain(L.logHeaderNames());
  assert.deepEqual(Object.values(H), LOG_HEADERS);
});

test("settingsDefaults", () => {
  const rows = plain(L.settingsDefaults(TODAY));
  const defaults = Object.fromEntries(rows);
  assert.equal(defaults["Kiosk access code"], "");
  assert.equal(defaults["Volunteer Profiles file ID"], "");
  assert.equal(defaults["Volunteer Profiles tab"], "Volunteer Profiles");
  assert.equal(defaults["Kiosk launch date"], TODAY);
  assert.equal(defaults["Arrival flag minutes"], "15");
  assert.equal(defaults["Check-out flag minutes"], "15");
  assert.equal(defaults["Volunteer hour value"], "");
  assert.equal(defaults["Profiles problems"], "");
  assert.equal(defaults["Closing time Monday"], undefined);
  assert.equal(defaults["Closing time Sunday"], undefined);
  assert.equal(defaults["Auto clock-out after hours"], "12");
  assert.equal(defaults["Auto clock-out last run"], "");
  assert.equal(defaults["Long shift flag hours"], "8");
  assert.equal(defaults["Flags email"], "Off");
  assert.equal(defaults["Flags email to"], "");
  assert.equal(defaults["Flags email day"], "Monday");
  assert.equal(defaults["Flags email hour"], "8");
  assert.equal(defaults["Flags email last run"], "");
  assert.equal(defaults["Daily jobs installed by"], "");
  assert.equal(defaults["Past hours file ID"], "");
  assert.equal(defaults["Past hours tab"], "Historical Hours");
  assert.equal(defaults["Kiosk contact"], "");
  assert.equal(rows.length, 20);
  const names = rows.map((r) => r[0]);
  assert.equal(new Set(names).size, names.length);
  assert.equal(names.indexOf("Check-out flag minutes"), names.indexOf("Arrival flag minutes") + 1);
  // The new rows come after every row a sheet set up earlier already has.
  assert.equal(names.indexOf("Auto clock-out after hours"), names.indexOf("Profiles problems") + 1);
  // Each default reads back as itself.
  assert.equal(L.parseAutoClockOutHours(defaults["Auto clock-out after hours"]), 12);
  assert.equal(L.parseLongShiftHours(defaults["Long shift flag hours"]), 8);
  assert.equal(L.parseFlagsEmailOn(defaults["Flags email"]), false);
  assert.equal(L.parseWeekdaySetting(defaults["Flags email day"]), "Monday");
  assert.equal(L.parseEmailHour(defaults["Flags email hour"]), 8);
});

test("Auto clock-out after hours reads 10 to 24 as given and anything else as 12", () => {
  for (const [text, want] of [
    ["10", 10],
    ["24", 24],
    ["16", 16],
    ["12.5", 12.5],
    [" 18 ", 18],
    ["9.99", 12],
    ["9.5", 12],
    ["8", 12],
    ["7.5", 12],
    ["0", 12],
    ["-12", 12],
    ["24.5", 12],
    ["25", 12],
    ["", 12],
    ["twelve", 12],
    ["Infinity", 12],
    [null, 12],
    [undefined, 12],
  ]) {
    assert.equal(L.parseAutoClockOutHours(text), want, String(text));
  }
});

test("parseLongShiftHours reads a finite number above 0 as given and anything else as 8", () => {
  for (const [text, want] of [
    ["8.5", 8.5],
    ["10", 10],
    ["0.25", 0.25],
    ["", 8],
    ["long", 8],
    ["0", 8],
    ["-1", 8],
    ["Infinity", 8],
    ["NaN", 8],
    [undefined, 8],
  ]) {
    assert.equal(L.parseLongShiftHours(text), want, String(text));
  }
});

// ---------------------------------------------------------------------------
// Volunteer Profiles

test("the sample CSV header has 22 columns with embedded newlines", () => {
  assert.equal(HEADER.length, 22);
  assert.ok(HEADER[0].includes("\n"));
  const { volunteers, problems } = parse(csv.slice(1));
  assert.equal(volunteers.length, 12);
  assert.deepEqual(problems, []);
  const maria = volunteers[0];
  assert.deepEqual(maria, {
    id: idOf("sample-token-01"),
    firstName: "Maria",
    lastName: "Alvarez",
    phoneLast4: "0101",
    startDate: "2026-02-15",
    needsPhoneCheck: false,
    token: "sample-token-01",
    row: 2,
  });
  // Kate Sullivan and Kate Sullivan-Price are different names.
  assert.ok(volunteers.every((v) => !v.needsPhoneCheck));
});

test("SampleData.js starts with the CSV header and its people", () => {
  const rows = plain(sample.sampleProfileRows_());
  assert.deepEqual(rows[0], HEADER);
  assert.deepEqual(rows.slice(1, csv.length), csv.slice(1));
  assert.ok(rows.every((r) => r.length === 22));
  const { volunteers, problems } = parse(rows.slice(1));
  const alvarez = volunteers.filter((v) => v.lastName === "Alvarez");
  assert.equal(alvarez.length, 2);
  assert.ok(alvarez.every((v) => v.needsPhoneCheck));
  assert.notEqual(alvarez[0].phoneLast4, alvarez[1].phoneLast4);
  // rows[k] is sheet row k + 1, the header being row 1.
  const anaRow = rows.findIndex((r) => r[0] === "Ana") + 1;
  assert.deepEqual(
    problems.map((p) => p.text),
    ["row " + anaRow + ": Ana Ruiz has no User Token"],
  );
  const starts = volunteers.map((v) => v.startDate);
  assert.ok(starts.some((d) => d < TODAY));
  assert.ok(starts.some((d) => d > TODAY));
  assert.ok(volunteers.some((v) => v.firstName === "Ivy" && v.phoneLast4 === "0117"));
});

test("a missing required header throws and names it", () => {
  const header = HEADER.filter((h) => L.normalizeHeader(h) !== "volunteer phone");
  assert.throws(() => L.parseProfiles(header, [], sha256), /"volunteer phone"/);
});

test("the token comes from Onboarding Token or User Token, exactly one", () => {
  const at = HEADER.findIndex((h) => L.normalizeHeader(h) === "onboarding token");
  const renamed = HEADER.map((h, i) => (i === at ? "User\nToken" : h));
  const row = person("Lena", "Park", " tok-a ");
  const { volunteers } = plain(L.parseProfiles(renamed, [row], sha256));
  assert.equal(volunteers[0].token, "tok-a");
  assert.equal(volunteers[0].id, idOf("tok-a"));

  const neither = HEADER.filter((_, i) => i !== at);
  assert.throws(
    () => L.parseProfiles(neither, [], sha256),
    /no "onboarding token" or "user token" column/,
  );
  const both = [...HEADER, "User Token"];
  assert.throws(
    () => L.parseProfiles(both, [], sha256),
    /both an "onboarding token" and a "user token" column/,
  );
});

test("parseProfiles keeps the trimmed token and the Profiles row", () => {
  const { volunteers } = parse([
    person("Lena", "Park", "tok-a"),
    person("Omar", "Haddad", " tok-b "),
  ]);
  assert.deepEqual(
    volunteers.map((v) => [v.firstName, v.token, v.row]),
    [
      ["Lena", "tok-a", 2],
      ["Omar", "tok-b", 3],
    ],
  );
});

test("email is not needed", () => {
  const header = HEADER.filter((h) => L.normalizeHeader(h) !== "email");
  assert.doesNotThrow(() => L.parseProfiles(header, [], sha256));
});

test("a blank token leaves the row out with a problem line", () => {
  const { volunteers, problems } = parse([
    person("Lena", "Park", "tok-a"),
    person("Ana", "Ruiz", "  "),
  ]);
  assert.deepEqual(
    volunteers.map((v) => v.firstName),
    ["Lena"],
  );
  assert.deepEqual(problems, [{ row: 3, text: "row 3: Ana Ruiz has no User Token" }]);
});

test("a row without both names is skipped silently", () => {
  const { volunteers, problems } = parse([
    person("", "", "tok-a"),
    person("Cher", "", "tok-b"),
    person("   ", "Lowe", "tok-c"),
    profileRow({}),
  ]);
  assert.deepEqual(volunteers, []);
  assert.deepEqual(problems, []);
});

test("rows sharing a token are all left out, each naming the others", () => {
  const { volunteers, problems } = parse([
    person("Lena", "Park", "tok-a"),
    person("Omar", "Haddad", "tok-dup"),
    person("Ruth", "Lindqvist", " tok-dup "),
    person("Dev", "Patel", "tok-dup"),
  ]);
  assert.deepEqual(
    volunteers.map((v) => v.firstName),
    ["Lena"],
  );
  assert.deepEqual(
    problems.map((p) => p.text),
    [
      "row 3: Omar Haddad has the same User Token as rows 4, 5",
      "row 4: Ruth Lindqvist has the same User Token as rows 3, 5",
      "row 5: Dev Patel has the same User Token as rows 3, 4",
    ],
  );
  const pair = parse([person("A", "B", "t1"), person("C", "D", "t1")]);
  assert.equal(pair.problems[0].text, "row 2: A B has the same User Token as row 3");
});

test("a same-name pair both need a phone check", () => {
  const { volunteers, problems } = parse([
    person("Sam", "Lee", "tok-1", "615-555-0131"),
    person("Ruth", "Okafor", "tok-2"),
    person(" sam ", "LEE", "tok-3", "615-555-0132"),
  ]);
  assert.deepEqual(problems, []);
  assert.deepEqual(
    volunteers.map((v) => [v.firstName, v.id, v.phoneLast4, v.needsPhoneCheck]),
    [
      ["Sam", idOf("tok-1"), "0131", true],
      ["Ruth", idOf("tok-2"), "0150", false],
      ["sam", idOf("tok-3"), "0132", true],
    ],
  );
});

test("a same-name member with no usable phone is listed and gets a problem line", () => {
  const { volunteers, problems } = parse([
    person("Sam", "Lee", "tok-1", "615-555-0131"),
    person("Sam", "Lee", "tok-2", "555"),
    person("Ruth", "Okafor", "tok-3", ""),
  ]);
  assert.equal(volunteers.length, 3);
  assert.equal(volunteers[1].phoneLast4, "");
  assert.equal(volunteers[1].needsPhoneCheck, true);
  // No phone is fine for someone who doesn't share a name.
  assert.deepEqual(problems, [
    { row: 3, text: "row 3: Sam Lee shares a name and has no usable phone number" },
  ]);
});

test("a same-name pair with the same last four are both refused and reported", () => {
  const { volunteers, problems } = parse([
    person("Sam", "Lee", "tok-1", "615-555-0131"),
    person("Ruth", "Okafor", "tok-2", "615-555-0131"),
    person("Sam", "Lee", "tok-3", "(615) 555-0131 x9"),
  ]);
  assert.equal(volunteers.length, 3);
  const sams = volunteers.filter((v) => v.firstName === "Sam");
  for (const sam of sams) {
    assert.equal(sam.needsPhoneCheck, true);
    assert.equal(L.checkPhone(sam, "0131"), "PHONE_MISSING");
    assert.equal(L.checkPhone(sam, null), "PHONE_MISSING");
  }
  // Ruth shares the digits but not the name, so she is unaffected.
  assert.equal(volunteers[1].phoneLast4, "0131");
  assert.deepEqual(problems, [
    { row: 2, text: "row 2: Sam Lee shares a name and the last four phone digits with row 4" },
    { row: 4, text: "row 4: Sam Lee shares a name and the last four phone digits with row 2" },
  ]);
});

test("in a same-name trio where two share a last four, the third still passes", () => {
  const { volunteers, problems } = parse([
    person("Sam", "Lee", "tok-1", "615-555-0131"),
    person("Sam", "Lee", "tok-2", "615-555-0132"),
    person("sam", "lee", "tok-3", "615-555-0131"),
  ]);
  assert.equal(volunteers.length, 3);
  assert.equal(L.checkPhone(volunteers[0], "0131"), "PHONE_MISSING");
  assert.equal(L.checkPhone(volunteers[2], "0131"), "PHONE_MISSING");
  assert.equal(L.checkPhone(volunteers[1], "0132"), null);
  assert.equal(L.checkPhone(volunteers[1], "0131"), "PHONE_WRONG");
  assert.deepEqual(
    problems.map((p) => p.text),
    [
      "row 2: Sam Lee shares a name and the last four phone digits with row 4",
      "row 4: sam lee shares a name and the last four phone digits with row 2",
    ],
  );
  const four = parse([
    person("Sam", "Lee", "tok-1", "615-555-0131"),
    person("Sam", "Lee", "tok-2", "615-555-0131"),
    person("Sam", "Lee", "tok-3", "615-555-0131"),
  ]);
  assert.equal(
    four.problems[0].text,
    "row 2: Sam Lee shares a name and the last four phone digits with rows 3, 4",
  );
});

test("a duplicate token does not count toward a same-name group", () => {
  const { volunteers } = parse([
    person("Sam", "Lee", "tok-1"),
    person("Sam", "Lee", "tok-dup"),
    person("Ann", "Ito", "tok-dup"),
  ]);
  assert.equal(volunteers.length, 1);
  assert.equal(volunteers[0].needsPhoneCheck, false);
});

test("start dates are read in either form", () => {
  const { volunteers } = parse([
    person("A", "One", "t1", "", "2026-03-04"),
    person("B", "Two", "t2", "", "3/4/2026"),
    person("C", "Three", "t3", "", ""),
    person("D", "Four", "t4", "", "TBD"),
  ]);
  assert.deepEqual(
    volunteers.map((v) => v.startDate),
    ["2026-03-04", "2026-03-04", "", ""],
  );
});

test("findVolunteer", () => {
  const list = [{ id: "abc" }, { id: "def" }];
  assert.deepEqual(plain(L.findVolunteer(list, "def")), { id: "def" });
  assert.equal(L.findVolunteer(list, "zzz"), null);
  assert.equal(L.findVolunteer(list, null), null);
});

// ---------------------------------------------------------------------------
// Access, phone and arrival

test("checkAccessCode needs a 16-letter Settings code and a match", () => {
  const code = "purple otter lamp post";
  assert.equal(L.checkAccessCode("PURPLEOTTERLAMPPOST", code), null);
  assert.equal(L.checkAccessCode("purple otter lamp post", code), null);
  assert.equal(L.checkAccessCode("purple otter lamp", code), "ACCESS");
  assert.equal(L.checkAccessCode("", code), "ACCESS");
  assert.equal(L.checkAccessCode(null, code), "ACCESS");
  // Fifteen letters counts as not set, even when the code matches.
  assert.equal(L.checkAccessCode("abcdefghijklmno", "abcdefghijklmno"), "ACCESS");
  assert.equal(L.checkAccessCode("abcdefghijklmnop", "abcdefghijklmnop"), null);
  assert.equal(L.checkAccessCode("", ""), "ACCESS");
  assert.equal(L.minCodeLetters(), 16);
});

test("checkPhone", () => {
  const plainOne = { needsPhoneCheck: false, phoneLast4: "" };
  const twin = { needsPhoneCheck: true, phoneLast4: "0131" };
  const noPhone = { needsPhoneCheck: true, phoneLast4: "" };
  assert.equal(L.checkPhone(plainOne, null), null);
  assert.equal(L.checkPhone(plainOne, "9999"), null);
  assert.equal(L.checkPhone(twin, null), "PHONE_NEEDED");
  assert.equal(L.checkPhone(twin, ""), "PHONE_NEEDED");
  assert.equal(L.checkPhone(twin, "0132"), "PHONE_WRONG");
  assert.equal(L.checkPhone(twin, "0131"), null);
  assert.equal(L.checkPhone(noPhone, "0131"), "PHONE_MISSING");
  assert.equal(L.checkPhone(noPhone, null), "PHONE_MISSING");
});

test("validateArrival clamps up to 5 minutes ahead and refuses more", () => {
  assert.deepEqual(plain(L.validateArrival(NOW, NOW - HOUR, TODAY, TODAY)), {
    arrivedMs: NOW - HOUR,
  });
  assert.deepEqual(plain(L.validateArrival(NOW, NOW + 3 * MIN, TODAY, TODAY)), { arrivedMs: NOW });
  assert.deepEqual(plain(L.validateArrival(NOW, NOW + 5 * MIN, TODAY, TODAY)), { arrivedMs: NOW });
  assert.equal(L.validateArrival(NOW, NOW + 6 * MIN, TODAY, TODAY), "ARRIVAL_FUTURE");
  assert.equal(L.arrivalGraceMinutes(), 5);
});

test("validateArrival takes no arrival as server time", () => {
  assert.deepEqual(plain(L.validateArrival(NOW, null, "", TODAY)), { arrivedMs: NOW });
  // Undefined is not "no arrival": only null is.
  assert.equal(L.validateArrival(NOW, undefined, "", TODAY), "ARRIVAL_OTHER_DAY");
});

test("arrivalMsFromIso: null or missing is null, anything else is parsed", () => {
  assert.equal(L.arrivalMsFromIso(null), null);
  assert.equal(L.arrivalMsFromIso(undefined), null);
  assert.equal(L.arrivalMsFromIso("2026-11-12T16:00:00.000Z"), NOW);
  assert.ok(Number.isNaN(L.arrivalMsFromIso("")));
  assert.ok(Number.isNaN(L.arrivalMsFromIso("garbage")));
});

test("validateArrival refuses another day", () => {
  assert.equal(L.validateArrival(NOW, NOW - 12 * HOUR, "2026-11-11", TODAY), "ARRIVAL_OTHER_DAY");
  assert.equal(L.validateArrival(NOW, NaN, "", TODAY), "ARRIVAL_OTHER_DAY");
  // Just before midnight, a fast clock's arrival is past midnight but is taken as now.
  assert.deepEqual(plain(L.validateArrival(NOW, NOW + 2 * MIN, "2026-11-13", TODAY)), {
    arrivedMs: NOW,
  });
  // Far in the future is refused as future first.
  assert.equal(L.validateArrival(NOW, NOW + 24 * HOUR, "2026-11-13", TODAY), "ARRIVAL_FUTURE");
});

test("arrivalFlag compares and prints the same rounded minutes", () => {
  assert.equal(L.arrivalFlag(NOW, NOW - 15 * MIN, 15), "");
  assert.equal(L.arrivalFlag(NOW, NOW - 16 * MIN, 15), "arrival differs by 16 min");
  assert.equal(L.arrivalFlag(NOW, NOW - 15.4 * MIN, 15), "");
  assert.equal(L.arrivalFlag(NOW, NOW - 15.6 * MIN, 15), "arrival differs by 16 min");
  assert.equal(L.arrivalFlag(NOW, NOW + 20 * MIN, 15), "arrival differs by 20 min");
  assert.equal(L.arrivalFlag(NOW, NOW - 16 * MIN, 30), "");
  assert.equal(L.arrivalFlag(NOW, NaN, 15), "");
});

test("checkStatedTime clamps up to 5 minutes ahead, refuses later, and refuses another day", () => {
  assert.deepEqual(plain(L.checkStatedTime(NOW, NOW - HOUR, TODAY, TODAY)), { ms: NOW - HOUR });
  assert.deepEqual(plain(L.checkStatedTime(NOW, NOW + 3 * MIN, TODAY, TODAY)), { ms: NOW });
  assert.deepEqual(plain(L.checkStatedTime(NOW, NOW + 6 * MIN, TODAY, TODAY)), {
    refused: "FUTURE",
  });
  assert.deepEqual(plain(L.checkStatedTime(NOW, NOW - 24 * HOUR, "2026-11-11", TODAY)), {
    refused: "OTHER_DAY",
  });
  // A past date asked for by name: a time on that date is fine.
  assert.deepEqual(plain(L.checkStatedTime(NOW, NOW - 24 * HOUR, "2026-11-11", "2026-11-11")), {
    ms: NOW - 24 * HOUR,
  });
  assert.deepEqual(plain(L.checkStatedTime(NOW, NaN, "", TODAY)), { refused: "OTHER_DAY" });
});

test("validateCheckOut", () => {
  const start = NOW - 2 * HOUR;
  // No chosen time is server time, never refused.
  assert.deepEqual(plain(L.validateCheckOut(NOW, null, "", TODAY, start)), { outMs: NOW });
  assert.deepEqual(plain(L.validateCheckOut(NOW, null, "", TODAY, NOW + HOUR)), { outMs: NOW });
  assert.equal(L.validateCheckOut(NOW, NaN, "", TODAY, start), "CHECKOUT_OTHER_DAY");
  assert.deepEqual(plain(L.validateCheckOut(NOW, NOW - HOUR, TODAY, TODAY, start)), {
    outMs: NOW - HOUR,
  });
  assert.deepEqual(plain(L.validateCheckOut(NOW, NOW + 3 * MIN, TODAY, TODAY, start)), {
    outMs: NOW,
  });
  assert.equal(L.validateCheckOut(NOW, NOW + 6 * MIN, TODAY, TODAY, start), "CHECKOUT_FUTURE");
  // With a readable start the date doesn't matter, only the place after the start: an
  // evening shift is checked out past midnight.
  assert.equal(
    L.validateCheckOut(NOW, NOW - 24 * HOUR, "2026-11-11", TODAY, start),
    "CHECKOUT_BEFORE_ARRIVAL",
  );
  const evening = NOW - 13 * HOUR; // 21:00 yesterday
  assert.deepEqual(plain(L.validateCheckOut(NOW, NOW - 9 * HOUR, TODAY, TODAY, evening)), {
    outMs: NOW - 9 * HOUR,
  });
  assert.deepEqual(plain(L.validateCheckOut(NOW, NOW - 11 * HOUR, "2026-11-11", TODAY, evening)), {
    outMs: NOW - 11 * HOUR,
  });
  // With no readable start the time is held to today.
  assert.equal(
    L.validateCheckOut(NOW, NOW - 24 * HOUR, "2026-11-11", TODAY, NaN),
    "CHECKOUT_OTHER_DAY",
  );
  assert.equal(
    L.validateCheckOut(NOW, start - MIN, TODAY, TODAY, start),
    "CHECKOUT_BEFORE_ARRIVAL",
  );
  // Equal to the arrival is accepted: a zero-hour shift.
  assert.deepEqual(plain(L.validateCheckOut(NOW, start, TODAY, TODAY, start)), { outMs: start });
  // An unreadable start skips the before-arrival check.
  assert.deepEqual(plain(L.validateCheckOut(NOW, start - HOUR, TODAY, TODAY, NaN)), {
    outMs: start - HOUR,
  });
});

test("checkOutFlag compares and prints the same rounded minutes", () => {
  assert.equal(L.checkOutFlag(NOW, NOW - 15 * MIN, 15), "");
  assert.equal(L.checkOutFlag(NOW, NOW - 16 * MIN, 15), "check-out differs by 16 min");
  assert.equal(L.checkOutFlag(NOW, NOW - 15.4 * MIN, 15), "");
  assert.equal(L.checkOutFlag(NOW, NOW - 15.6 * MIN, 15), "check-out differs by 16 min");
  assert.equal(L.checkOutFlag(NOW, NOW - 16 * MIN, 30), "");
  assert.equal(L.checkOutFlag(NOW, NaN, 15), "");
});

test("appendText keeps what the cell holds", () => {
  assert.equal(L.appendText("", "check-out differs by 20 min"), "check-out differs by 20 min");
  assert.equal(L.appendText("  ", "b"), "b");
  assert.equal(
    L.appendText("arrival differs by 20 min", "check-out differs by 30 min"),
    "arrival differs by 20 min; check-out differs by 30 min",
  );
  assert.equal(L.appendText("staff text", ""), "staff text");
  assert.equal(L.appendText(null, null), "");
});

test("weekdayName", () => {
  assert.equal(L.weekdayName("2026-11-12"), "Thursday");
  assert.equal(L.weekdayName("2026-11-15"), "Sunday");
  assert.equal(L.weekdayName("2026-11-16"), "Monday");
  assert.equal(L.weekdayName("11/14/2026"), "Saturday");
  assert.equal(L.weekdayName(""), "");
  assert.equal(L.weekdayName("junk"), "");
  assert.equal(L.weekdayName("2026-02-30"), "");
});

// ---------------------------------------------------------------------------
// Hours and milestones

test("hoursBetween rounds to 2 decimals and is never negative", () => {
  assert.equal(L.hoursBetween(NOW, NOW + 90 * MIN), 1.5);
  assert.equal(L.hoursBetween(NOW, NOW + 100 * MIN), 1.67);
  assert.equal(L.hoursBetween(NOW, NOW - HOUR), 0);
  assert.equal(L.hoursBetween(NaN, NOW), 0);
});

test("pairHours is blank, not zero, when either time is unreadable", () => {
  assert.equal(L.pairHours(NOW, NOW + 90 * MIN), 1.5);
  assert.equal(L.pairHours(NOW, NOW), 0);
  assert.equal(L.pairHours(NaN, NOW), "");
  assert.equal(L.pairHours(NOW, NaN), "");
});

test("minutesFromHours", () => {
  assert.equal(L.minutesFromHours(1.67), 100);
  assert.equal(L.minutesFromHours("2.5"), 150);
  assert.equal(L.minutesFromHours(""), 0);
  assert.equal(L.minutesFromHours(NaN), 0);
  assert.equal(L.minutesFromHours("junk"), 0);
  assert.equal(L.minutesFromHours(-1), 0);
});

test("milestones table", () => {
  const table = plain(L.milestones());
  assert.deepEqual(
    table.map((m) => m.id),
    ["shift-1", "shift-10", "shift-25", "hours-50", "hours-100"],
  );
  assert.equal(table[0].title, "First completed shift");
  assert.equal(table[4].message, "100 hours logged here, making East Nashville stronger.");
});

const LAUNCH = "2026-11-01";
const crossed = (shifts, minutes, add, start = "2026-11-05", launch = LAUNCH) => {
  const m = L.milestoneCrossed(shifts, minutes, add, start, launch);
  return m && m.id;
};

test("each milestone fires at its threshold", () => {
  assert.equal(crossed(0, 0, 60), "shift-1");
  assert.equal(crossed(1, 60, 60), null);
  assert.equal(crossed(8, 480, 60), null);
  assert.equal(crossed(9, 540, 60), "shift-10");
  assert.equal(crossed(10, 600, 60), null);
  assert.equal(crossed(24, 1440, 60), "shift-25");
  assert.equal(crossed(30, 49 * 60, 59), null);
  assert.equal(crossed(30, 49 * 60, 60), "hours-50");
  assert.equal(crossed(30, 50 * 60, 60), null);
  assert.equal(crossed(60, 99 * 60 + 30, 30), "hours-100");
  const m = plain(L.milestoneCrossed(9, 540, 60, "", LAUNCH));
  assert.deepEqual(m, {
    id: "shift-10",
    title: "10 shifts",
    message: "10 shifts checked in here. Thank you for showing up for your neighbors!",
  });
});

test("a double crossing gives the first in order", () => {
  assert.equal(crossed(9, 49 * 60, 120), "shift-10");
  assert.equal(crossed(24, 99 * 60, 120), "shift-25");
  assert.equal(crossed(30, 49 * 60, 52 * 60), "hours-50");
});

test("first completed shift depends on the start date and launch date", () => {
  assert.equal(crossed(0, 0, 60, "2026-10-31"), null);
  assert.equal(crossed(0, 0, 60, "2026-11-01"), "shift-1");
  assert.equal(crossed(0, 0, 60, "2026-11-02"), "shift-1");
  assert.equal(crossed(0, 0, 60, "11/2/2026"), "shift-1");
  assert.equal(crossed(0, 0, 60, "11/2/2026", "11/1/2026"), "shift-1");
  assert.equal(crossed(0, 0, 60, ""), null);
  assert.equal(crossed(0, 0, 60, "TBD"), null);
  assert.equal(crossed(0, 0, 60, "2026-11-02", ""), null);
  // Skipping the first shift doesn't stop an hours milestone on the same check-out.
  assert.equal(crossed(0, 0, 50 * 60, "2026-10-01"), "hours-50");
});

// ---------------------------------------------------------------------------
// The Log layout

const H = plain(L.logHeaderNames());
const norm = (h) => L.normalizeHeader(h);

/** Read functions like Sheets.js's: a Date as its Central date, a time as {ms, date}. */
const CENTRAL_DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Chicago",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const centralDate = (d) => CENTRAL_DAY.format(d);
const isDate = (v) => Object.prototype.toString.call(v) === "[object Date]";
/** A Central wall-clock time as milliseconds read as UTC, to compare wall clocks. */
const CENTRAL_MINUTE = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago",
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});
const centralWall = (ms) => {
  const p = {};
  CENTRAL_MINUTE.formatToParts(new Date(ms)).forEach((x) => (p[x.type] = x.value));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
};
/** A date's Central "HH:mm", as Utilities.formatDate(value, zone, "HH:mm") gives it. */
const centralClock = (d) => new Date(centralWall(d.getTime())).toISOString().slice(11, 16);
/**
 * Sheets.js's timeOnDate_: a Central "HH:mm" on a yyyy-MM-dd as {ms, date}. Daylight time
 * is tried before standard time; a time skipped when daylight time starts takes standard
 * time, which lands on the next valid time, as Utilities.parseDate does.
 */
const timeOnDate = (dateText, clock) => {
  const text = L.adminDateTimeText(dateText, clock);
  if (!text) return { ms: NaN, date: "" };
  const [, y, mo, d, h, mi] = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(text).map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  const ms = [5, 6].map((o) => wall + o * HOUR).find((t) => centralWall(t) === wall);
  const read = ms === undefined ? wall + 6 * HOUR : ms;
  return { ms: read, date: centralDate(new Date(read)) };
};
const READ = {
  text: (v) => (isDate(v) ? centralDate(v) : L.cellString(v)),
  time: (v) => {
    const none = { ms: NaN, date: "", clock: "" };
    if (isDate(v)) {
      const ms = v.getTime();
      return Number.isFinite(ms) ? { ms, date: centralDate(v), clock: centralClock(v) } : none;
    }
    const clock = L.clockText(v);
    if (clock) return { ms: NaN, date: "", clock };
    const ms = L.cellString(v) ? Date.parse(L.cellString(v)) : NaN;
    return Number.isFinite(ms) ? { ms, date: centralDate(new Date(ms)), clock: "" } : none;
  },
  at: timeOnDate,
};

/**
 * Runs fn with this process's time zone set to zone, as Apps Script runs Date.parse in
 * the script's zone (America/Chicago), then puts the zone back.
 */
const inZone = (zone, fn) => {
  const was = process.env.TZ;
  process.env.TZ = zone;
  try {
    return fn();
  } finally {
    if (was === undefined) delete process.env.TZ;
    else process.env.TZ = was;
  }
};

/** A Log row under header, with the given cells by header; an undefined value is left out. */
const logRow = (header, byHeader) => {
  const cells = header.map(() => "");
  for (const [h, value] of Object.entries(byHeader)) {
    if (value === undefined) continue;
    const at = header.findIndex((x) => norm(x) === norm(h));
    assert.ok(at >= 0, "no header " + h);
    cells[at] = value;
  }
  return cells;
};

// Staff moved columns about and put their own between them.
const SHUFFLED = [
  "Staff column",
  "Shift ID",
  "User Token",
  "Status",
  "Date",
  "Day",
  "Volunteer Name",
  "Notes",
  "Check-Out Stated (user)",
  "Check-Out Recorded (timestamp)",
  "Check-In Stated (user)",
  "Check-In Recorded (timestamp)",
  "Hours Served (stated)",
  "Hours Served (timestamps)",
  "Admin Alerts?",
  "Check-Out Entered By",
  "Another staff column",
  "Check-In Entered By",
];

test("logColumns maps the exact header", () => {
  const cols = plain(L.logColumns(LOG_HEADERS));
  LOG_HEADERS.forEach((h, i) => assert.equal(cols[h], i));
});

test("logColumns ignores line breaks, spaces and case", () => {
  const flat = LOG_HEADERS.map((h) => "  " + h.replace(/\n/g, " ").toUpperCase());
  const cols = plain(L.logColumns(flat));
  LOG_HEADERS.forEach((h, i) => assert.equal(cols[h], i));
});

test("logColumns finds reordered columns with others between, and no Role/Type, Activity or Notes", () => {
  const cols = plain(L.logColumns(SHUFFLED));
  assert.equal(cols[H.shiftId], 1);
  assert.equal(cols[H.date], 4);
  assert.equal(cols[H.statedOut], 8);
  assert.equal(cols[H.inBy], 17);
  assert.equal(cols[H.notes], 7);
  assert.equal(cols[H.role], -1);
  assert.equal(cols[H.activity], -1);
  const noNotes = plain(L.logColumns(SHUFFLED.filter((h) => h !== "Notes")));
  assert.equal(noNotes[H.notes], -1);
});

test("logColumns throws on a missing required header, naming it", () => {
  for (const h of plain(L.requiredLogHeaders())) {
    const header = LOG_HEADERS.filter((x) => x !== h);
    assert.throws(
      () => L.logColumns(header),
      (e) => e.message === 'The Log has no "' + norm(h) + '" column. Run setupSheets().',
    );
  }
  assert.deepEqual(
    plain(L.requiredLogHeaders()),
    LOG_HEADERS.filter((h) => !["Volunteer\nRole/Type", "Activity", "Notes"].includes(h)),
  );
});

test("logColumns throws on a repeated required header; repeated optional ones map leftmost", () => {
  assert.throws(() => L.logColumns([...LOG_HEADERS, "date"]), /more than one "date" column/);
  const twoNotes = [...LOG_HEADERS, "Notes", "Activity", "Activity"];
  assert.equal(L.logColumns(twoNotes)[H.notes], 12);
  assert.equal(L.logColumns(twoNotes)[H.activity], 11);
});

test("isOldLogLayout and missingLogHeaders", () => {
  assert.equal(L.isOldLogLayout(plain(L.oldLogHeaders())), true);
  assert.equal(L.isOldLogLayout([...plain(L.oldLogHeaders()), "Extra"]), true);
  assert.equal(L.isOldLogLayout(LOG_HEADERS), false);
  assert.equal(L.isOldLogLayout(ENCM_LOG_HEADERS), false);
  assert.equal(L.isOldLogLayout([]), false);
  assert.deepEqual(plain(L.missingLogHeaders(ENCM_LOG_HEADERS)), KIOSK_LOG_HEADERS);
  assert.deepEqual(plain(L.missingLogHeaders(LOG_HEADERS)), []);
  assert.deepEqual(plain(L.missingLogHeaders(SHUFFLED)), []);
  assert.equal(L.missingLogHeaders([]).length, 15);
});

test("logColumnKinds", () => {
  const kinds = plain(L.logColumnKinds());
  assert.deepEqual(Object.keys(kinds), LOG_HEADERS);
  const of = (kind) => LOG_HEADERS.filter((h) => kinds[h] === kind);
  assert.deepEqual(of("time"), [H.recordedIn, H.statedIn, H.recordedOut, H.statedOut]);
  assert.deepEqual(of("hours"), [H.recordedHours, H.statedHours]);
  assert.equal(of("text").length, 12);
});

// A closed kiosk shift: tapped in 8:00, chose 7:45, chose out 9:30, tapped out 10:00.
const T = (hhmm) => new Date("2026-11-12T" + hhmm + ":00-06:00");
const closedRow = (header, extra = {}) =>
  logRow(header, {
    Date: "2026-11-12",
    Day: "Thursday",
    "Volunteer Name": "Sam Lee",
    "Check-In Recorded (timestamp)": T("08:00"),
    "Check-In Stated (user)": T("07:45"),
    "Check-Out Recorded (timestamp)": T("10:00"),
    "Check-Out Stated (user)": T("09:30"),
    "Hours Served (timestamps)": 2,
    "Hours Served (stated)": 1.75,
    "Admin Alerts?": "check-out differs by 30 min",
    Notes: "left early",
    "User Token": "tok-1",
    Status: "closed",
    "Check-In Entered By": "kiosk",
    "Check-Out Entered By": "kiosk",
    "Shift ID": "shift-1",
    ...extra,
  });

test("logEntry reads a row under a reordered header with extra columns", () => {
  const cells = closedRow(SHUFFLED, { "Staff column": "x" });
  const e = plain(L.logEntry(cells, 7, L.logColumns(SHUFFLED), READ));
  assert.deepEqual(e, {
    row: 7,
    shiftId: "shift-1",
    token: "tok-1",
    name: "Sam Lee",
    dateText: "2026-11-12",
    recordedInMs: T("08:00").getTime(),
    statedInMs: T("07:45").getTime(),
    recordedOutMs: T("10:00").getTime(),
    statedOutMs: T("09:30").getTime(),
    recordedHours: 2,
    statedHours: 1.75,
    alerts: "check-out differs by 30 min",
    notes: "left early",
    status: "closed",
    outBy: "kiosk",
  });
  // The same row under the exact header reads the same.
  const exact = plain(L.logEntry(closedRow(LOG_HEADERS), 7, L.logColumns(LOG_HEADERS), READ));
  assert.deepEqual(exact, e);
});

test("clockText reads a typed time of day as HH:mm", () => {
  const cases = {
    "9:00 AM": "09:00",
    "9:00am": "09:00",
    " 9:00 p.m. ": "21:00",
    "9:00PM": "21:00",
    "21:15": "21:15",
    "0:05": "00:05",
    "12:00 AM": "00:00",
    "12:30 PM": "12:30",
    "9:00:45": "09:00",
    "9:00:45 pm": "21:00",
    9: "",
    9: "",
    "9 AM": "",
    "9ish": "",
    "25:00": "",
    "13:00 PM": "",
    "0:30 AM": "",
    "9:60": "",
    "9:00:60": "",
    "9:5": "",
    "12/30/1899 9:00 AM": "",
    "": "",
    null: "",
  };
  for (const [text, want] of Object.entries(cases)) assert.equal(L.clockText(text), want, text);
  assert.equal(L.clockText(null), "");
  assert.equal(L.clockText(undefined), "");
  assert.equal(L.clockText(0.375), "");
  assert.equal(L.timeOnlyDate(), "1899-12-30");
});

// Sheets keeps a time typed with no date as that time on 1899-12-30.
const typedTime = (hhmm) => new Date(timeOnDate("1899-12-30", hhmm).ms);

test("logEntry reads a time with no date as that time on the row's Date", () => {
  const cols = L.logColumns(LOG_HEADERS);
  const cells = closedRow(LOG_HEADERS, {
    // Read to the minute: the seconds are dropped.
    "Check-In Recorded (timestamp)": new Date(typedTime("08:00").getTime() + 45000),
    "Check-In Stated (user)": "9:00 AM",
    "Check-Out Stated (user)": "2:30 PM",
    "Check-Out Recorded (timestamp)": typedTime("14:45"),
  });
  assert.equal(READ.time(typedTime("09:00")).date, "1899-12-30");
  assert.equal(READ.time(typedTime("09:00")).clock, "09:00");
  const e = L.logEntry(cells, 3, cols, READ);
  assert.equal(e.recordedInMs, T("08:00").getTime());
  assert.equal(e.statedInMs, T("09:00").getTime());
  assert.equal(e.statedOutMs, T("14:30").getTime());
  assert.equal(e.recordedOutMs, T("14:45").getTime());
  assert.equal(L.hasReadableStart(e), true);
  // A full date-time on the row's Date is kept as before, seconds and all.
  const kept = L.logEntry(
    closedRow(LOG_HEADERS, { "Check-In Stated (user)": new Date(T("07:45").getTime() + 45000) }),
    3,
    cols,
    READ,
  );
  assert.equal(kept.statedInMs, T("07:45").getTime() + 45000);
});

test("logEntry: a full date-time on another day, or text that isn't a time, is unreadable", () => {
  const cols = L.logColumns(LOG_HEADERS);
  const read = (byHeader, extra = {}) =>
    L.logEntry(closedRow(LOG_HEADERS, { ...byHeader, ...extra }), 3, cols, READ);
  inZone("America/Chicago", () => {
    const e = read({
      "Check-In Recorded (timestamp)": "9ish",
      "Check-In Stated (user)": "12/30/1899 9:00 AM",
      "Check-Out Recorded (timestamp)": new Date(T("10:00").getTime() + 24 * HOUR),
      "Check-Out Stated (user)": T("09:30").getTime() + 24 * HOUR,
    });
    assert.ok(Number.isNaN(e.recordedInMs));
    assert.ok(Number.isNaN(e.statedInMs));
    assert.ok(Number.isNaN(e.recordedOutMs));
    assert.ok(Number.isNaN(e.statedOutMs));
    assert.equal(L.hasReadableStart(e), false);
    // Text with a date in it is a full date-time, even on 1899-12-30: it has no clock.
    assert.deepEqual(READ.time("12/30/1899 9:00 AM").date, "1899-12-30");
    assert.equal(READ.time("12/30/1899 9:00 AM").clock, "");
    // 1899-12-31 is a duration past 24 hours, not a time of day.
    const dayOne = read({
      "Check-In Stated (user)": new Date(typedTime("09:00").getTime() + 24 * HOUR),
    });
    assert.ok(Number.isNaN(dayOne.statedInMs));
    // Bare 9, 9 AM, 25:00 and 13:00 PM aren't times of day; Date.parse puts bare 9 in 2001.
    for (const text of ["9", "9 AM", "25:00", "13:00 PM", 0.375]) {
      assert.ok(Number.isNaN(read({ "Check-In Stated (user)": text }).statedInMs), String(text));
    }
    // A date with no time: m/d/yyyy is midnight in the script's zone, on the row's Date;
    // yyyy-MM-dd is UTC midnight, the day before in Central.
    assert.equal(read({ "Check-In Stated (user)": "11/12/2026" }).statedInMs, T("00:00").getTime());
    assert.ok(Number.isNaN(read({ "Check-In Stated (user)": "2026-11-12" }).statedInMs));
  });
  // With no readable Date, no time on the row is readable, a time with no date included.
  const noDate = read({ "Check-In Stated (user)": typedTime("09:00"), Date: "soon" });
  assert.ok(Number.isNaN(noDate.recordedInMs));
  assert.ok(Number.isNaN(noDate.statedInMs));
  assert.ok(Number.isNaN(read({ "Check-In Stated (user)": "9:00 AM", Date: "soon" }).statedInMs));
});

test("logEntry: a time with no date that read.at puts on another date, or a read without at, is unreadable", () => {
  const cols = L.logColumns(LOG_HEADERS);
  const cells = closedRow(LOG_HEADERS, {
    "Check-In Stated (user)": typedTime("09:00"),
    "Check-Out Stated (user)": "9:30 AM",
  });
  const noAt = L.logEntry(cells, 3, cols, { text: READ.text, time: READ.time });
  assert.ok(Number.isNaN(noAt.statedInMs));
  assert.ok(Number.isNaN(noAt.statedOutMs));
  assert.equal(noAt.recordedInMs, T("08:00").getTime(), "a full date-time still reads");
  const nextDay = {
    ...READ,
    at: () => ({ ms: T("09:00").getTime() + 24 * HOUR, date: "2026-11-13" }),
  };
  assert.ok(Number.isNaN(L.logEntry(cells, 3, cols, nextDay).statedInMs));
});

test("logEntry: a time in the hour skipped when daylight time starts reads as the next valid time", () => {
  const cols = L.logColumns(LOG_HEADERS);
  // 2:30 AM on 2027-03-14 doesn't exist in Central; the reader takes 3:30 AM daylight time.
  const cells = closedRow(LOG_HEADERS, { Date: "2027-03-14", "Check-In Stated (user)": "2:30 AM" });
  const e = L.logEntry(cells, 3, cols, READ);
  assert.equal(e.statedInMs, Date.parse("2027-03-14T03:30:00-05:00"));
  // A summer Date gets daylight time, a winter one standard time.
  const summer = closedRow(LOG_HEADERS, {
    Date: "2026-06-01",
    "Check-In Stated (user)": "9:00 AM",
  });
  assert.equal(
    L.logEntry(summer, 3, cols, READ).statedInMs,
    Date.parse("2026-06-01T09:00:00-05:00"),
  );
});

test("logEntry: a Date object in the Date column, blank hours, and a missing Notes column", () => {
  const header = LOG_HEADERS.filter((h) => h !== "Notes");
  const cells = closedRow(header, {
    Date: new Date("2026-11-12T00:00:00-06:00"),
    "Hours Served (timestamps)": "",
    "Hours Served (stated)": "1.5",
    Notes: undefined,
  });
  const e = L.logEntry(cells, 4, L.logColumns(header), READ);
  assert.equal(e.dateText, "2026-11-12");
  assert.equal(e.statedInMs, T("07:45").getTime());
  assert.ok(Number.isNaN(e.recordedHours));
  assert.equal(e.statedHours, 1.5);
  assert.equal(e.notes, "");
});

test("cellWrites gives 1-based columns on a reordered header and leaves the rest alone", () => {
  const cols = L.logColumns(SHUFFLED);
  const writes = plain(
    L.cellWrites(
      {
        [H.status]: "closed",
        [H.statedOut]: NOW,
        [H.statedHours]: 1.5,
        [H.recordedHours]: "",
        [H.recordedOut]: NaN,
      },
      cols,
    ),
  );
  assert.deepEqual(writes, [
    { col: 10, value: "", kind: "time" },
    { col: 9, value: NOW, kind: "time" },
    { col: 14, value: "", kind: "hours" },
    { col: 13, value: 1.5, kind: "hours" },
    { col: 4, value: "closed", kind: "text" },
  ]);
});

test("cellWrites throws on an unknown key and on a column the Log lacks", () => {
  const cols = L.logColumns(SHUFFLED.filter((h) => h !== "Notes"));
  assert.throws(() => L.cellWrites({ Flag: "x" }, cols), /"flag" is not a Log header/);
  assert.throws(
    () => L.cellWrites({ [H.notes]: "note" }, cols),
    /The Log has no "notes" column\. Run setupSheets\(\)\./,
  );
});

// ---------------------------------------------------------------------------
// Log rows and the check-in and check-out decisions

const ID = "aaaaaaaaaaaaaaaa";
const TOKEN = "tok-sam";
const OTHER_TOKEN = "tok-ruth";
const entry = (row, fields) => ({
  row,
  shiftId: "shift-" + row,
  token: TOKEN,
  name: "Sam Lee",
  dateText: TODAY,
  recordedInMs: NOW - 2 * HOUR,
  statedInMs: NOW - 2 * HOUR,
  recordedOutMs: NaN,
  statedOutMs: NaN,
  recordedHours: NaN,
  statedHours: NaN,
  alerts: "",
  notes: "",
  status: "open",
  outBy: "",
  ...fields,
});
const WINDOW = 12 * HOUR;

test("findOpenShift matches by token and ignores rows out of the window and closed rows", () => {
  const find = (entries, token = TOKEN) => L.findOpenShift(entries, token, NOW, WINDOW, TODAY);
  const entries = [
    // Checked in 13 hours ago, yesterday: out of a 12-hour window.
    entry(2, {
      dateText: "2026-11-11",
      recordedInMs: NOW - 13 * HOUR,
      statedInMs: NOW - 13 * HOUR,
    }),
    entry(3, { status: "closed", statedHours: 1 }),
    entry(4, { token: OTHER_TOKEN }),
    entry(5, { token: "" }),
  ];
  assert.equal(find(entries), null);
  assert.equal(find(entries, ""), null);
  entries.push(entry(6, { status: " Open " }));
  assert.equal(find(entries).row, 6);
  // Latest start wins.
  entries.push(entry(7, { statedInMs: NOW - HOUR }));
  assert.equal(find(entries).row, 7);
  // An unreadable stated arrival falls back to the recorded one.
  entries.push(entry(8, { statedInMs: NaN, recordedInMs: NOW - 30 * MIN }));
  assert.equal(find(entries).row, 8);
});

test("findOpenShift: the open row it picks doesn't depend on row order", () => {
  const find = (entries) => L.findOpenShift(entries, TOKEN, NOW, WINDOW, TODAY).row;
  // Row 4 has no readable time; row 5 was checked in an hour ago.
  const noTime = entry(4, { recordedInMs: NaN, statedInMs: NaN });
  const real = entry(5, { recordedInMs: NOW - HOUR, statedInMs: NOW - HOUR });
  assert.equal(find([noTime, real]), 5);
  assert.equal(find([real, noTime]), 5);
  // Check-out closes the real row, whichever comes first.
  assert.equal(checkOut({ entries: [noTime, real] }).row, 5);
  // Equal starts, readable or not, go to the later row.
  const twin = entry(6, { recordedInMs: NOW - HOUR, statedInMs: NOW - HOUR });
  assert.equal(find([real, twin]), 6);
  assert.equal(find([twin, real]), 6);
  const noTime2 = entry(7, { recordedInMs: NaN, statedInMs: NaN });
  assert.equal(find([noTime, noTime2]), 7);
  assert.equal(find([noTime2, noTime]), 7);
});

test("closedTotals counts this token's closed rows by stated hours, menu rows included", () => {
  const entries = [
    entry(2, { status: "closed", statedHours: 1.5, recordedHours: 9, dateText: "2026-10-01" }),
    entry(3, { status: "Closed", statedHours: 2.25 }),
    entry(4, { status: "closed", statedHours: NaN }),
    entry(5, { status: "open" }),
    entry(6, { status: "auto-closed", statedHours: 3 }),
    entry(7, { status: "closed", statedHours: 4, token: OTHER_TOKEN }),
    // A menu row: no recorded times or recorded hours.
    entry(8, {
      status: "closed",
      recordedInMs: NaN,
      recordedHours: NaN,
      statedHours: 1,
      dateText: "2026-11-03",
    }),
  ];
  assert.deepEqual(plain(L.closedTotals(entries, TOKEN)), { shifts: 4, minutes: 285 });
  assert.deepEqual(plain(L.closedTotals(entries, "")), { shifts: 0, minutes: 0 });
  assert.equal(L.milestoneHours(entries[0]), 1.5);
});

test("volunteerSummaries gives the arrival of an open row in the window and no private fields", () => {
  const volunteers = [
    {
      id: ID,
      firstName: "Sam",
      lastName: "Lee",
      phoneLast4: "0131",
      startDate: "2026-01-15",
      needsPhoneCheck: true,
      token: TOKEN,
      row: 4,
    },
    {
      id: "bbbbbbbbbbbbbbbb",
      firstName: "Ruth",
      lastName: "Okafor",
      phoneLast4: "0150",
      startDate: "",
      needsPhoneCheck: false,
      token: OTHER_TOKEN,
      row: 5,
    },
  ];
  const entries = [
    entry(2, {
      token: OTHER_TOKEN,
      dateText: "2026-11-11",
      recordedInMs: NOW - 12 * HOUR,
      statedInMs: NOW - 12 * HOUR,
    }),
    entry(3, { statedInMs: NaN, recordedInMs: NOW - HOUR }),
  ];
  assert.deepEqual(plain(L.volunteerSummaries(volunteers, entries, NOW, WINDOW, TODAY)), [
    {
      id: ID,
      firstName: "Sam",
      lastName: "Lee",
      checkedIn: true,
      openShiftArrival: new Date(NOW - HOUR).toISOString(),
      needsPhoneCheck: true,
    },
    {
      id: "bbbbbbbbbbbbbbbb",
      firstName: "Ruth",
      lastName: "Okafor",
      checkedIn: false,
      openShiftArrival: null,
      needsPhoneCheck: false,
    },
  ]);
});

const VOL = {
  id: ID,
  firstName: "Sam",
  lastName: "Lee",
  phoneLast4: "0131",
  startDate: "2026-11-05",
  needsPhoneCheck: false,
  token: TOKEN,
  row: 4,
};
const TWIN = { ...VOL, needsPhoneCheck: true };
// The other member of TWIN's name: another token and other digits.
const TWIN2 = { ...TWIN, id: "bbbbbbbbbbbbbbbb", phoneLast4: "0199", token: "tok-sam-2", row: 5 };

test("checkInCells: a no-picker check-in", () => {
  const cells = plain(L.checkInCells(VOL, TODAY, NOW, NOW, "", "shift-9"));
  assert.deepEqual(cells, {
    [H.date]: TODAY,
    [H.day]: "Thursday",
    [H.name]: "Sam Lee",
    [H.recordedIn]: NOW,
    [H.statedIn]: NOW,
    [H.alerts]: "",
    [H.token]: TOKEN,
    [H.status]: "open",
    [H.inBy]: "kiosk",
    [H.shiftId]: "shift-9",
  });
});

test("checkInCells: a picked arrival, and text that looks like a formula", () => {
  const vol = { ...VOL, firstName: "=Sam", token: "=tok" };
  const cells = plain(
    L.checkInCells(vol, TODAY, NOW, NOW - HOUR, "arrival differs by 60 min", "shift-9"),
  );
  assert.equal(cells[H.statedIn], NOW - HOUR);
  assert.equal(cells[H.recordedIn], NOW);
  assert.equal(cells[H.alerts], "arrival differs by 60 min");
  assert.equal(cells[H.name], "'=Sam Lee");
  assert.equal(cells[H.token], "'=tok");
});

test("checkInCells throws on an empty token or Shift ID", () => {
  assert.throws(
    () => L.checkInCells({ ...VOL, token: " " }, TODAY, NOW, NOW, "", "shift-9"),
    /without a User Token/,
  );
  assert.throws(() => L.checkInCells(VOL, TODAY, NOW, NOW, "", ""), /without a Shift ID/);
});

test("checkOutCells: a no-picker shift has equal hours and no alert", () => {
  const open = entry(9, {});
  const cells = plain(L.checkOutCells(open, NOW, NOW, ""));
  assert.deepEqual(cells, {
    [H.recordedOut]: NOW,
    [H.statedOut]: NOW,
    [H.recordedHours]: 2,
    [H.statedHours]: 2,
    [H.status]: "closed",
    [H.outBy]: "kiosk",
  });
});

test("checkOutCells: pickers on both ends give different hours and keep existing alerts", () => {
  const open = entry(9, {
    recordedInMs: NOW - 2 * HOUR,
    statedInMs: NOW - 3 * HOUR,
    alerts: "arrival differs by 60 min",
  });
  const cells = plain(L.checkOutCells(open, NOW, NOW - 30 * MIN, "check-out differs by 30 min"));
  assert.equal(cells[H.recordedHours], 2);
  assert.equal(cells[H.statedHours], 2.5);
  assert.equal(cells[H.statedOut], NOW - 30 * MIN);
  assert.equal(cells[H.alerts], "arrival differs by 60 min; check-out differs by 30 min");
});

test("checkOutCells: an unreadable start gives blank hours and an alert, never 0.00", () => {
  const open = entry(9, { recordedInMs: NaN, statedInMs: NaN, alerts: "staff text" });
  const cells = plain(L.checkOutCells(open, NOW, NOW, ""));
  assert.equal(cells[H.recordedHours], "");
  assert.equal(cells[H.statedHours], "");
  assert.equal(cells[H.alerts], "staff text; " + L.unreadableStartAlert());
  // Only the recorded check-in unreadable: recorded hours blank, stated hours kept.
  const half = plain(L.checkOutCells(entry(9, { recordedInMs: NaN }), NOW, NOW, ""));
  assert.equal(half[H.recordedHours], "");
  assert.equal(half[H.statedHours], 2);
  assert.equal(half[H.alerts], undefined);
});

test("every key of every kiosk cell map is a Log header", () => {
  const maps = [
    L.checkInCells(VOL, TODAY, NOW, NOW - HOUR, "flag", "shift-9"),
    L.checkOutCells(entry(9, { statedInMs: NaN, recordedInMs: NaN }), NOW, NOW, "flag"),
  ];
  for (const cells of maps) {
    for (const key of Object.keys(cells)) assert.ok(LOG_HEADERS.includes(key), key);
    assert.doesNotThrow(() => L.cellWrites(cells, L.logColumns(LOG_HEADERS)));
  }
});

const checkIn = (fields) =>
  plain(
    L.decideCheckIn({
      volunteers: [VOL],
      id: ID,
      digits: null,
      entries: [],
      todayDate: TODAY,
      nowMs: NOW,
      windowMs: WINDOW,
      arrivedMs: NOW - 20 * MIN,
      arrivedDate: TODAY,
      flagMinutes: 15,
      launchDate: LAUNCH,
      ...fields,
    }),
  );

test("decideCheckIn accepts and flags", () => {
  assert.deepEqual(checkIn({}), {
    volunteer: VOL,
    arrivedMs: NOW - 20 * MIN,
    flag: "arrival differs by 20 min",
    flags: ["arrival differs by 20 min"],
    missedSignOut: false,
  });
  assert.deepEqual(checkIn({ arrivedMs: NOW - 5 * MIN }), {
    volunteer: VOL,
    arrivedMs: NOW - 5 * MIN,
    flag: "",
    flags: [],
    missedSignOut: false,
  });
  assert.deepEqual(checkIn({ arrivedMs: NOW + 3 * MIN }), {
    volunteer: VOL,
    arrivedMs: NOW,
    flag: "",
    flags: [],
    missedSignOut: false,
  });
  // No chosen time: arrived is server time and nothing is flagged.
  assert.deepEqual(checkIn({ arrivedMs: null, arrivedDate: "" }), {
    volunteer: VOL,
    arrivedMs: NOW,
    flag: "",
    flags: [],
    missedSignOut: false,
  });
  assert.deepEqual(
    checkIn({ volunteers: [TWIN], digits: "0131" }).flag,
    "arrival differs by 20 min",
  );
  // Yesterday's open row out of the window is left for the auto clock-out and doesn't
  // block today.
  const old = {
    dateText: "2026-11-11",
    recordedInMs: NOW - 13 * HOUR,
    statedInMs: NOW - 13 * HOUR,
  };
  assert.deepEqual(checkIn({ entries: [entry(2, old)] }).flag, "arrival differs by 20 min");
  // Another volunteer's open row doesn't block.
  assert.equal(checkIn({ entries: [entry(2, { token: OTHER_TOKEN })] }).flag.length > 0, true);
});

test("decideCheckIn refuses in order", () => {
  const open = [entry(2, {})];
  const late = { arrivedMs: NOW + HOUR };
  assert.deepEqual(checkIn({ id: "zzzzzzzzzzzzzzzz", entries: open, ...late }), {
    refusal: "NOT_FOUND",
  });
  assert.deepEqual(checkIn({ volunteers: [{ ...TWIN, phoneLast4: "" }], entries: open }), {
    refusal: "PHONE_MISSING",
  });
  assert.deepEqual(checkIn({ volunteers: [TWIN], entries: open }), { refusal: "PHONE_NEEDED" });
  assert.deepEqual(checkIn({ volunteers: [TWIN], digits: "9999", entries: open }), {
    refusal: "PHONE_WRONG",
  });
  assert.deepEqual(checkIn({ volunteers: [TWIN], digits: "0131", entries: open, ...late }), {
    refusal: "ALREADY_IN",
  });
  assert.deepEqual(checkIn(late), { refusal: "ARRIVAL_FUTURE" });
  assert.deepEqual(checkIn({ arrivedMs: NOW - 12 * HOUR, arrivedDate: "2026-11-11" }), {
    refusal: "ARRIVAL_OTHER_DAY",
  });
});

const checkOut = (fields) =>
  plain(
    L.decideCheckOut({
      volunteers: [VOL],
      id: ID,
      digits: null,
      entries: [entry(9, {})],
      todayDate: TODAY,
      nowMs: NOW,
      windowMs: WINDOW,
      outMs: null,
      outDate: "",
      flagMinutes: 15,
      longShiftHours: 8,
      launchDate: LAUNCH,
      ...fields,
    }),
  );

test("decideCheckOut closes the open row at server time and picks the milestone", () => {
  const first = checkOut({});
  assert.deepEqual(first, {
    volunteer: VOL,
    row: 9,
    cells: {
      [H.recordedOut]: NOW,
      [H.statedOut]: NOW,
      [H.recordedHours]: 2,
      [H.statedHours]: 2,
      [H.status]: "closed",
      [H.outBy]: "kiosk",
    },
    minutes: 120,
    milestone: {
      id: "shift-1",
      title: "First completed shift",
      message: "Your first day making a difference. Welcome to the neighborhood!",
    },
    statedOutMs: NOW,
    flags: [],
    open: plain(entry(9, {})),
  });
  const history = Array.from({ length: 9 }, (_, i) =>
    entry(20 + i, { status: "closed", statedHours: 3, dateText: "2026-10-0" + (i + 1) }),
  );
  const tenth = checkOut({ entries: [...history, entry(9, {})] });
  assert.equal(tenth.milestone.id, "shift-10");
  const second = checkOut({ entries: [history[0], entry(9, {})] });
  assert.equal(second.milestone, null);
});

test("decideCheckOut with a chosen time writes it as stated and flags the gap", () => {
  const out = checkOut({ outMs: NOW - 30 * MIN, outDate: TODAY });
  assert.equal(out.statedOutMs, NOW - 30 * MIN);
  assert.equal(out.cells[H.recordedOut], NOW);
  assert.equal(out.cells[H.statedOut], NOW - 30 * MIN);
  assert.equal(out.cells[H.recordedHours], 2);
  assert.equal(out.cells[H.statedHours], 1.5);
  assert.equal(out.cells[H.alerts], "check-out differs by 30 min");
  assert.equal(out.minutes, 90);
  // Under the Settings threshold, nothing is flagged and Admin Alerts? isn't written.
  assert.equal(
    checkOut({ outMs: NOW - 30 * MIN, outDate: TODAY, flagMinutes: 30 }).cells[H.alerts],
    undefined,
  );
  // Up to 5 minutes ahead is taken as now.
  assert.equal(checkOut({ outMs: NOW + 4 * MIN, outDate: TODAY }).statedOutMs, NOW);
});

test("decideCheckOut counts milestones from stated hours, not recorded", () => {
  // 30 closed shifts with 49 stated hours; this one is 1.5 stated hours but 0.5 recorded.
  const history = Array.from({ length: 30 }, (_, i) =>
    entry(20 + i, {
      status: "closed",
      statedHours: i === 0 ? 20 : 1,
      recordedHours: 0,
      dateText: "2026-10-01",
    }),
  );
  const open = entry(9, { recordedInMs: NOW - 30 * MIN, statedInMs: NOW - 90 * MIN });
  const out = checkOut({ entries: [...history, open] });
  assert.equal(out.cells[H.recordedHours], 0.5);
  assert.equal(out.cells[H.statedHours], 1.5);
  assert.equal(out.minutes, 90);
  assert.equal(out.milestone.id, "hours-50");
});

test("decideCheckOut on a row with no readable start closes it with blank hours and an alert", () => {
  const open = entry(9, { recordedInMs: NaN, statedInMs: NaN });
  const out = checkOut({ entries: [open], outMs: NOW - 4 * HOUR, outDate: TODAY });
  assert.equal(out.cells[H.statedHours], "");
  assert.equal(out.cells[H.recordedHours], "");
  assert.equal(out.cells[H.status], "closed");
  assert.equal(out.cells[H.alerts], "check-out differs by 240 min; " + L.unreadableStartAlert());
  assert.equal(out.minutes, 0);
});

/** An open row today whose two check-in cells hold the given values. */
const openRowWithStart = (recordedIn, statedIn) =>
  closedRow(LOG_HEADERS, {
    "Check-In Recorded (timestamp)": recordedIn,
    "Check-In Stated (user)": statedIn,
    "Check-Out Recorded (timestamp)": "",
    "Check-Out Stated (user)": "",
    "Hours Served (timestamps)": "",
    "Hours Served (stated)": "",
    "Admin Alerts?": "",
    "User Token": TOKEN,
    Status: "open",
    "Check-Out Entered By": "",
  });

test("an open row today with both check-in times typed with no date shows its arrival and closes with hours", () => {
  // Staff typed a time alone: into a date-time cell, and into a plain-text cell.
  const open = L.logEntry(
    openRowWithStart(typedTime("08:00"), "8:00 AM"),
    9,
    L.logColumns(LOG_HEADERS),
    READ,
  );
  assert.equal(L.hasReadableStart(open), true);
  const [summary] = plain(L.volunteerSummaries([VOL], [open], NOW, WINDOW, TODAY));
  assert.equal(summary.checkedIn, true);
  assert.equal(summary.openShiftArrival, T("08:00").toISOString());
  const out = checkOut({ entries: [open] });
  assert.equal(out.refusal, undefined);
  assert.equal(out.row, 9);
  assert.equal(out.cells[H.status], "closed");
  assert.equal(out.cells[H.statedOut], NOW);
  assert.equal(out.cells[H.statedHours], 2);
  assert.equal(out.cells[H.recordedHours], 2);
  assert.ok(!String(out.cells[H.alerts] ?? "").includes(L.unreadableStartAlert()));
  // A picked check-out before that arrival is refused.
  assert.equal(
    checkOut({ entries: [open], outMs: T("07:30").getTime(), outDate: TODAY }).refusal,
    "CHECKOUT_BEFORE_ARRIVAL",
  );
});

test("an open row today with both check-in times unreadable still shows as checked in and closes at check-out", () => {
  // Staff typed text that isn't a time into both check-in cells.
  const open = L.logEntry(openRowWithStart("9ish", "9ish"), 9, L.logColumns(LOG_HEADERS), READ);
  assert.equal(L.hasReadableStart(open), false);
  // The list says checked in, by the same test check-in uses, with no arrival to show.
  const [summary] = plain(L.volunteerSummaries([VOL], [open], NOW, WINDOW, TODAY));
  assert.equal(summary.checkedIn, true);
  assert.equal(summary.openShiftArrival, null);
  assert.deepEqual(checkIn({ entries: [open], arrivedMs: null, arrivedDate: "" }), {
    refusal: "ALREADY_IN",
  });
  // The tablet sends no check-out time, so the server's clock is used and the row closes.
  const out = checkOut({ entries: [open] });
  assert.equal(out.refusal, undefined);
  assert.equal(out.row, 9);
  assert.equal(out.cells[H.status], "closed");
  assert.equal(out.cells[H.statedOut], NOW);
  assert.equal(out.cells[H.statedHours], "");
  assert.equal(out.cells[H.alerts], L.unreadableStartAlert());
});

test("decideCheckOut refuses in order", () => {
  const future = { outMs: NOW + HOUR, outDate: TODAY };
  assert.deepEqual(checkOut({ id: "zzzzzzzzzzzzzzzz", ...future }), { refusal: "NOT_FOUND" });
  // The only member of the name in, with no digits: the rule acts and the time is checked.
  assert.deepEqual(checkOut({ volunteers: [TWIN], ...future }), { refusal: "CHECKOUT_FUTURE" });
  // Another member of the name in too: the phone step comes before the time.
  assert.deepEqual(
    checkOut({
      volunteers: [TWIN, TWIN2],
      entries: [entry(9, {}), entry(10, { token: TWIN2.token })],
      ...future,
    }),
    { refusal: "PHONE_NEEDED" },
  );
  assert.deepEqual(checkOut({ volunteers: [TWIN], digits: "0000", ...future }), {
    refusal: "PHONE_WRONG",
  });
  assert.deepEqual(checkOut({ volunteers: [TWIN], digits: "0131" }).row, 9);
  assert.deepEqual(checkOut({ entries: [], ...future }), { refusal: "NOT_IN" });
  assert.deepEqual(
    checkOut({
      entries: [
        entry(9, {
          dateText: "2026-11-11",
          recordedInMs: NOW - 12 * HOUR,
          statedInMs: NOW - 13 * HOUR,
        }),
      ],
    }),
    { refusal: "NOT_IN" },
  );
  assert.deepEqual(checkOut({ entries: [entry(9, { status: "closed", statedHours: 1 })] }), {
    refusal: "NOT_IN",
  });
  assert.deepEqual(checkOut({ entries: [entry(9, { token: OTHER_TOKEN })] }), {
    refusal: "NOT_IN",
  });
  assert.deepEqual(checkOut({ outMs: NaN, outDate: "" }), { refusal: "CHECKOUT_OTHER_DAY" });
  assert.deepEqual(checkOut(future), { refusal: "CHECKOUT_FUTURE" });
  // Another date is refused only for being before the arrival; with no readable start,
  // for being another day.
  assert.deepEqual(checkOut({ outMs: NOW - 24 * HOUR, outDate: "2026-11-11" }), {
    refusal: "CHECKOUT_BEFORE_ARRIVAL",
  });
  assert.deepEqual(
    checkOut({
      entries: [entry(9, { recordedInMs: NaN, statedInMs: NaN })],
      outMs: NOW - 24 * HOUR,
      outDate: "2026-11-11",
    }),
    { refusal: "CHECKOUT_OTHER_DAY" },
  );
  assert.deepEqual(checkOut({ outMs: NOW - 2 * HOUR - MIN, outDate: TODAY }), {
    refusal: "CHECKOUT_BEFORE_ARRIVAL",
  });
  // Equal to the stated arrival is a zero-hour shift.
  const zero = checkOut({ outMs: NOW - 2 * HOUR, outDate: TODAY });
  assert.equal(zero.cells[H.statedHours], 0);
  // Before the recorded tap but after the stated arrival is allowed.
  const early = entry(9, { recordedInMs: NOW - HOUR, statedInMs: NOW - 3 * HOUR });
  const beforeTap = checkOut({ entries: [early], outMs: NOW - 2 * HOUR, outDate: TODAY });
  assert.equal(beforeTap.cells[H.statedHours], 1);
});

// A same-name group as parseProfiles lists it: two Sam Lees told apart by their last
// four, a third whose phone is unusable, and Ruth, who shares only the digits.
const group = () =>
  parse([
    person("Sam", "Lee", "tok-1", "615-555-0131"),
    person("Ruth", "Okafor", "tok-2", "615-555-0132"),
    person(" sam ", "LEE", "tok-3", "615-555-0132"),
    person("Sam", "Lee", "tok-4", ""),
  ]).volunteers;

test("resolveVolunteer acts on the tapped volunteer when the digits are theirs", () => {
  const list = group();
  assert.equal(L.resolveVolunteer(list, idOf("tok-1"), "0131").volunteer.id, idOf("tok-1"));
  assert.equal(L.resolveVolunteer(list, idOf("tok-3"), "0132").volunteer.id, idOf("tok-3"));
  // No phone check outside a group: any digits, or none, pass.
  assert.equal(L.resolveVolunteer(list, idOf("tok-2"), null).volunteer.id, idOf("tok-2"));
  assert.equal(L.resolveVolunteer(list, idOf("tok-2"), "0131").volunteer.id, idOf("tok-2"));
  assert.deepEqual(plain(L.resolveVolunteer(list, "zzzzzzzzzzzzzzzz", "0131")), {
    refusal: "NOT_FOUND",
  });
  assert.deepEqual(plain(L.resolveVolunteer(list, idOf("tok-1"), "")), {
    refusal: "PHONE_NEEDED",
  });
});

test("resolveVolunteer: the wrong same-name entry with the right digits acts on the right person", () => {
  const list = group();
  assert.equal(L.resolveVolunteer(list, idOf("tok-1"), "0132").volunteer.id, idOf("tok-3"));
  assert.equal(L.resolveVolunteer(list, idOf("tok-3"), "0131").volunteer.id, idOf("tok-1"));
  // Ruth has 0132 too, but she isn't in the group.
  assert.notEqual(L.resolveVolunteer(list, idOf("tok-1"), "0132").volunteer.id, idOf("tok-2"));
});

test("resolveVolunteer: digits matching nobody in the group are PHONE_WRONG", () => {
  const list = group();
  assert.deepEqual(plain(L.resolveVolunteer(list, idOf("tok-1"), "9999")), {
    refusal: "PHONE_WRONG",
  });
  // Ruth's digits don't reach across names: she isn't a Sam Lee.
  const withoutThird = list.filter((v) => v.id !== idOf("tok-3"));
  assert.deepEqual(plain(L.resolveVolunteer(withoutThird, idOf("tok-1"), "0132")), {
    refusal: "PHONE_WRONG",
  });
});

test("resolveVolunteer: a member without usable digits is PHONE_MISSING and never matched", () => {
  const list = group();
  for (const digits of ["0131", "0132", "9999", null]) {
    assert.deepEqual(plain(L.resolveVolunteer(list, idOf("tok-4"), digits)), {
      refusal: "PHONE_MISSING",
    });
  }
  // Two members sharing a last four are both blanked: their digits match nobody.
  const shared = parse([
    person("Sam", "Lee", "tok-1", "615-555-0131"),
    person("Sam", "Lee", "tok-2", "615-555-0135"),
    person("Sam", "Lee", "tok-3", "615-555-0135"),
  ]).volunteers;
  assert.deepEqual(plain(L.resolveVolunteer(shared, idOf("tok-1"), "0135")), {
    refusal: "PHONE_WRONG",
  });
  assert.deepEqual(plain(L.resolveVolunteer(shared, idOf("tok-2"), "0135")), {
    refusal: "PHONE_MISSING",
  });
  assert.equal(L.resolveVolunteer(shared, idOf("tok-2"), "0131").refusal, "PHONE_MISSING");
});

test("check-in and check-out act on the member the digits pick", () => {
  const list = group();
  const tapped = idOf("tok-1");
  const right = idOf("tok-3");
  const inDecision = checkIn({ volunteers: list, id: tapped, digits: "0132" });
  assert.equal(inDecision.volunteer.id, right);
  // The right member's open row is what counts for ALREADY_IN and NOT_IN.
  const openRight = [entry(2, { token: "tok-3" })];
  assert.deepEqual(checkIn({ volunteers: list, id: tapped, digits: "0132", entries: openRight }), {
    refusal: "ALREADY_IN",
  });
  assert.equal(
    checkIn({ volunteers: list, id: tapped, digits: "0131", entries: openRight }).volunteer.id,
    tapped,
  );
  const outDecision = checkOut({
    volunteers: list,
    id: tapped,
    digits: "0132",
    entries: openRight,
  });
  assert.equal(outDecision.volunteer.id, right);
  assert.equal(outDecision.row, 2);
  assert.deepEqual(checkOut({ volunteers: list, id: right, digits: "0131", entries: openRight }), {
    refusal: "NOT_IN",
  });
});

// A check-out with no digits for a member of a same-name group acts on the tapped member
// when that member has the only open row of the name; otherwise digits are asked for.
const BLANK_DIGITS = [null, "", "--"];

test("checkOutTokens: the rows a check-out reads", () => {
  const list = group();
  const tokens = (id, digits) => plain(L.checkOutTokens(list, id, digits));
  assert.deepEqual(tokens("zzzzzzzzzzzzzzzz", null), { refusal: "NOT_FOUND" });
  assert.deepEqual(tokens("zzzzzzzzzzzzzzzz", "0131"), { refusal: "NOT_FOUND" });
  // Ruth is in no group: her own token, with digits or without.
  assert.deepEqual(tokens(idOf("tok-2"), null), { tokens: ["tok-2"] });
  assert.deepEqual(tokens(idOf("tok-2"), "0131"), { tokens: ["tok-2"] });
  // A Sam Lee with no digits: every Sam Lee's token, the one with no usable phone too, and
  // not Ruth's.
  for (const digits of BLANK_DIGITS) {
    for (const id of [idOf("tok-1"), idOf("tok-3"), idOf("tok-4")]) {
      assert.deepEqual(tokens(id, digits), { tokens: ["tok-1", "tok-3", "tok-4"] });
    }
  }
  // With digits, as resolveVolunteer decides.
  assert.deepEqual(tokens(idOf("tok-1"), "0131"), { tokens: ["tok-1"] });
  assert.deepEqual(tokens(idOf("tok-1"), "0132"), { tokens: ["tok-3"] });
  assert.deepEqual(tokens(idOf("tok-1"), "9999"), { refusal: "PHONE_WRONG" });
  assert.deepEqual(tokens(idOf("tok-4"), "0131"), { refusal: "PHONE_MISSING" });
});

test("decideCheckOut with no digits in a group of two acts only when the tapped member is the one in", () => {
  const pair = [TWIN, TWIN2];
  const noPhone = [{ ...TWIN, phoneLast4: "" }, TWIN2];
  const mine = entry(9, {});
  const theirs = entry(10, { token: TWIN2.token });
  for (const digits of BLANK_DIGITS) {
    const out = (fields) => checkOut({ volunteers: pair, digits, ...fields });
    // Only the tapped member open: their row is closed.
    const closed = out({ entries: [mine] });
    assert.equal(closed.row, 9);
    assert.equal(closed.volunteer.id, TWIN.id);
    assert.equal(closed.cells[H.status], "closed");
    // Both open.
    assert.deepEqual(out({ entries: [mine, theirs] }), { refusal: "PHONE_NEEDED" });
    assert.deepEqual(out({ volunteers: noPhone, entries: [mine, theirs] }), {
      refusal: "PHONE_MISSING",
    });
    // Only the other member open.
    assert.deepEqual(out({ entries: [theirs] }), { refusal: "PHONE_NEEDED" });
    assert.deepEqual(out({ volunteers: noPhone, entries: [theirs] }), {
      refusal: "PHONE_MISSING",
    });
    // Neither open, with a closed row for each.
    const shut = { status: "closed", statedHours: 1 };
    for (const entries of [[], [entry(9, shut), entry(10, { ...shut, token: TWIN2.token })]]) {
      assert.deepEqual(out({ entries }), { refusal: "NOT_IN" });
      assert.deepEqual(out({ volunteers: noPhone, entries }), { refusal: "NOT_IN" });
    }
  }
});

test("a check-out with no digits writes what the same check-out with the tapped member's digits writes", () => {
  const pair = [TWIN, TWIN2];
  const cases = [
    { entries: [entry(9, {})] },
    { entries: [entry(9, {})], outMs: NOW - 30 * MIN, outDate: TODAY },
    // Stated hours past "Long shift flag hours".
    { entries: [entry(9, { recordedInMs: NOW - 9 * HOUR, statedInMs: NOW - 9 * HOUR })] },
    { entries: [entry(9, { recordedInMs: NaN, statedInMs: NaN, alerts: "staff text" })] },
    // The other member's closed row is read too, and changes nothing.
    {
      entries: [entry(9, {}), entry(10, { token: TWIN2.token, status: "closed", statedHours: 1 })],
    },
  ];
  let flagged = 0;
  cases.forEach((fields, i) => {
    const withDigits = checkOut({ volunteers: pair, digits: "0131", ...fields });
    assert.equal(withDigits.row, 9);
    for (const digits of BLANK_DIGITS) {
      assert.deepEqual(
        checkOut({ volunteers: pair, digits, ...fields }),
        withDigits,
        "case " + i + ", digits " + JSON.stringify(digits),
      );
    }
    if (withDigits.flags.length) flagged += 1;
  });
  const long = checkOut({ volunteers: pair, digits: null, ...cases[2] });
  assert.match(long.flags.join(";"), /^long shift: 9 h stated, over 8 h$/);
  assert.equal(long.cells[H.alerts], long.flags[0]);
  assert.equal(flagged, 3);
});

test("the only member of the name in checks out with no digits even without a usable phone", () => {
  const list = [{ ...TWIN, phoneLast4: "" }, TWIN2];
  const out = checkOut({ volunteers: list, digits: null, entries: [entry(9, {})] });
  assert.equal(out.row, 9);
  assert.equal(out.volunteer.id, TWIN.id);
  // Digits still give PHONE_MISSING: they can't be matched.
  assert.deepEqual(checkOut({ volunteers: list, digits: "0131", entries: [entry(9, {})] }), {
    refusal: "PHONE_MISSING",
  });
});

test("a group of three: only rows the tablet can still check out count as in", () => {
  const TWIN3 = { ...TWIN, id: "cccccccccccccccc", phoneLast4: "0177", token: "tok-sam-3" };
  const trio = [TWIN, TWIN2, TWIN3];
  const mine = entry(9, {});
  const shut = (row, token) => entry(row, { token, status: "closed", statedHours: 1 });
  // Checked in 13 hours ago, yesterday: past the 12-hour window.
  const stale = (row, token) =>
    entry(row, {
      token,
      dateText: "2026-11-11",
      recordedInMs: NOW - 13 * HOUR,
      statedInMs: NOW - 13 * HOUR,
    });
  const out = (entries) => checkOut({ volunteers: trio, digits: null, entries });
  assert.equal(out([mine, shut(10, TWIN2.token), shut(11, TWIN3.token)]).row, 9);
  assert.equal(out([mine, stale(10, TWIN2.token), stale(11, TWIN3.token)]).row, 9);
  assert.equal(out([mine, shut(10, TWIN2.token), stale(11, TWIN3.token)]).row, 9);
  // The other two in and the tapped member's row closed: digits are asked for.
  const both = [
    shut(9, TOKEN),
    entry(10, { token: TWIN2.token }),
    entry(11, { token: TWIN3.token }),
  ];
  assert.deepEqual(out(both), { refusal: "PHONE_NEEDED" });
  // One other in as well as the tapped member.
  assert.deepEqual(out([mine, entry(10, { token: TWIN3.token })]), { refusal: "PHONE_NEEDED" });
  // The tapped member's own row past the window doesn't count either.
  assert.deepEqual(out([stale(9, TOKEN)]), { refusal: "NOT_IN" });
});

test("decideCheckIn in a group still asks for digits when nobody of the name is in", () => {
  for (const digits of BLANK_DIGITS) {
    assert.deepEqual(checkIn({ volunteers: [TWIN, TWIN2], digits, entries: [] }), {
      refusal: "PHONE_NEEDED",
    });
    assert.deepEqual(
      checkIn({ volunteers: [{ ...TWIN, phoneLast4: "" }, TWIN2], digits, entries: [] }),
      { refusal: "PHONE_MISSING" },
    );
  }
  assert.equal(checkIn({ volunteers: [TWIN, TWIN2], digits: "0131" }).volunteer.id, TWIN.id);
});

// ---------------------------------------------------------------------------
// Kiosk admin menu
//
// The menu's rules: the server checks every limit the dialog shows; a menu row's
// Recorded times and Hours Served (timestamps) are never written; and nothing the menu
// writes overlaps another shift of the same volunteer on the same date. The guard on the
// public admin functions is tested in admin.test.mjs.

/** A Central clock time like Admin.js's adminClock_, "9:00 AM". */
const CLOCK = (ms) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    hour: "numeric",
    minute: "2-digit",
  })
    .format(new Date(ms))
    .replace(/\s/g, " ");
// A time on 2026-11-12 Central in milliseconds; NOW is 10:00.
const at = (hhmm) => T(hhmm).getTime();

test("normalizeInitials keeps 1 to 5 letters, upper-cased", () => {
  assert.equal(L.normalizeInitials("jp"), "JP");
  assert.equal(L.normalizeInitials("J.P."), "JP");
  assert.equal(L.normalizeInitials(" J P "), "JP");
  assert.equal(L.normalizeInitials("abcde"), "ABCDE");
  assert.equal(L.normalizeInitials(""), "");
  assert.equal(L.normalizeInitials(null), "");
  assert.equal(L.normalizeInitials("J2"), "");
  assert.equal(L.normalizeInitials("ABCDEF"), "");
  assert.equal(L.normalizeInitials("=A"), "");
  assert.equal(L.normalizeInitials("J-P"), "");
});

test("adminRosterLabels sorts by last then first name and tells same-name members apart", () => {
  const vols = [
    { ...VOL, id: "1", firstName: "Sam", lastName: "Lee", row: 9, needsPhoneCheck: true },
    { ...VOL, id: "2", firstName: "ruth", lastName: "Okafor", row: 3 },
    {
      ...VOL,
      id: "3",
      firstName: "Sam",
      lastName: "Lee",
      row: 4,
      needsPhoneCheck: true,
      phoneLast4: "",
    },
    { ...VOL, id: "4", firstName: "Ana", lastName: "lee", row: 12 },
  ];
  assert.deepEqual(plain(L.adminRosterLabels(vols)), [
    { id: "4", label: "Ana lee" },
    { id: "3", label: "Sam Lee (Profiles row 4, no usable phone)" },
    { id: "1", label: "Sam Lee (Profiles row 9, phone ending 0131)" },
    { id: "2", label: "ruth Okafor" },
  ]);
});

test("openShiftChoices lists open rows with a Shift ID, newest first", () => {
  const entries = [
    entry(2, { dateText: "2026-11-10", name: "Ruth Okafor" }),
    entry(3, { statedInMs: at("09:15"), name: "Jordan Rivera" }),
    entry(4, { status: "closed", statedHours: 1 }),
    entry(5, { shiftId: "" }),
    entry(6, { statedInMs: at("09:45"), name: "" }),
    entry(7, { dateText: "2026-11-11", statedInMs: NaN, recordedInMs: NaN }),
  ];
  assert.deepEqual(plain(L.openShiftChoices(entries, CLOCK)), [
    { shiftId: "shift-6", label: "Thu 2026-11-12 · no name · in 9:45 AM" },
    { shiftId: "shift-3", label: "Thu 2026-11-12 · Jordan Rivera · in 9:15 AM" },
    { shiftId: "shift-7", label: "Wed 2026-11-11 · Sam Lee · check-in time unreadable" },
    { shiftId: "shift-2", label: "Tue 2026-11-10 · Ruth Okafor · in 8:00 AM" },
  ]);
});

test("adminDateTimeText accepts a real date and a 24-hour time only", () => {
  assert.equal(L.adminDateTimeText("2026-11-12", "09:05"), "2026-11-12 09:05");
  assert.equal(L.adminDateTimeText("2026-11-12", "9:05"), "2026-11-12 09:05");
  assert.equal(L.adminDateTimeText("2026-11-12", "17:30:00"), "2026-11-12 17:30");
  assert.equal(L.adminDateTimeText("2026-11-12", "24:00"), "");
  assert.equal(L.adminDateTimeText("2026-11-12", "12:60"), "");
  assert.equal(L.adminDateTimeText("2026-11-12", "9am"), "");
  assert.equal(L.adminDateTimeText("2026-02-30", "09:00"), "");
  assert.equal(L.adminDateTimeText("11/12/2026", "09:00"), "");
  assert.equal(L.adminDateTimeText("", ""), "");
});

/** An Add a shift on TODAY, 8:00 to 9:30, for VOL. */
const addShift = (fields) =>
  plain(
    L.decideAddShift({
      volunteers: [VOL],
      id: ID,
      entries: [],
      todayDate: TODAY,
      nowMs: NOW,
      date: TODAY,
      inMs: at("08:00"),
      inDate: TODAY,
      outMs: at("09:30"),
      outDate: TODAY,
      initials: "j.p.",
      note: "",
      shiftId: "shift-new",
      ...fields,
    }),
  );

test("decideAddShift writes a closed row with stated times only and the initials", () => {
  const d = addShift({ note: " emailed Andrea " });
  assert.equal(d.hours, 1.5);
  assert.deepEqual(d.cells, {
    [H.date]: TODAY,
    [H.day]: "Thursday",
    [H.name]: "Sam Lee",
    [H.statedIn]: at("08:00"),
    [H.statedOut]: at("09:30"),
    [H.statedHours]: 1.5,
    [H.notes]: "emailed Andrea",
    [H.token]: TOKEN,
    [H.status]: "closed",
    [H.inBy]: "JP",
    [H.outBy]: "JP",
    [H.shiftId]: "shift-new",
  });
  // No note, no Notes cell; the Recorded times, their hours and Admin Alerts? are never
  // written.
  const bare = addShift({}).cells;
  for (const h of [H.notes, H.recordedIn, H.recordedOut, H.recordedHours, H.alerts]) {
    assert.ok(!(h in bare), h);
  }
  // Equal times are a zero-hour shift, as at the kiosk.
  assert.equal(addShift({ outMs: at("08:00") }).hours, 0);
  // A time up to 5 minutes ahead is taken as now.
  assert.equal(addShift({ inMs: at("09:00"), outMs: NOW + 3 * MIN }).cells[H.statedOut], NOW);
  // A past date.
  const past = addShift({
    date: "2026-11-01",
    inMs: Date.parse("2026-11-01T09:00:00-05:00"),
    inDate: "2026-11-01",
    outMs: Date.parse("2026-11-01T12:15:00-05:00"),
    outDate: "2026-11-01",
  });
  assert.equal(past.cells[H.day], "Sunday");
  assert.equal(past.hours, 3.25);
});

test("decideAddShift refuses in order", () => {
  const order = [
    [{ initials: "J2" }, "ADMIN_INITIALS"],
    [{ note: "x".repeat(501) }, "ADMIN_NOTE_TOO_LONG"],
    [{ id: "nobody" }, "ADMIN_NOT_FOUND"],
    [{ date: "2026-13-01" }, "ADMIN_BAD_TIME"],
    [{ date: "2026-11-13" }, "ADMIN_FUTURE"],
    [{ inMs: NaN, inDate: "" }, "ADMIN_BAD_TIME"],
    [{ inMs: NOW + 6 * MIN }, "ADMIN_FUTURE"],
    [{ outMs: NaN, outDate: "" }, "ADMIN_BAD_TIME"],
    [{ outMs: NOW + 6 * MIN }, "ADMIN_FUTURE"],
    [{ outDate: "2026-11-11" }, "ADMIN_BAD_TIME"],
    [{ outMs: at("07:59") }, "ADMIN_OUT_BEFORE_IN"],
  ];
  for (const [fields, code] of order) assert.equal(addShift(fields).refusal, code, code);
  // Each refusal wins over the ones after it.
  assert.equal(addShift({ initials: "", id: "nobody", date: "x" }).refusal, "ADMIN_INITIALS");
  assert.equal(addShift({ id: "nobody", date: "x" }).refusal, "ADMIN_NOT_FOUND");
  assert.equal(addShift({ date: "2026-11-13", inMs: NaN }).refusal, "ADMIN_FUTURE");
  // 500 characters is allowed.
  assert.equal(addShift({ note: "x".repeat(500) }).refusal, undefined);
});

test("decideAddShift: never beside an open row on that date", () => {
  const openToday = entry(5, { statedInMs: at("11:00") });
  assert.equal(addShift({ entries: [openToday] }).refusal, "ADMIN_OPEN_SHIFT");
  // Another volunteer's open row, or this volunteer's open row on another date, doesn't block.
  assert.equal(addShift({ entries: [{ ...openToday, token: OTHER_TOKEN }] }).refusal, undefined);
  const otherDay = addShift({
    entries: [openToday],
    date: "2026-11-11",
    inMs: Date.parse("2026-11-11T08:00:00-06:00"),
    inDate: "2026-11-11",
    outMs: Date.parse("2026-11-11T09:00:00-06:00"),
    outDate: "2026-11-11",
  });
  assert.equal(otherDay.refusal, undefined);
  assert.equal(otherDay.hours, 1);
});

test("decideAddShift: overlap uses the other row's stated check-out time", () => {
  // A kiosk row: stated 9:00 to 9:30, tapped out at 10:00.
  const kiosk = entry(6, {
    status: "closed",
    statedInMs: at("09:00"),
    recordedInMs: at("09:00"),
    statedOutMs: at("09:30"),
    recordedOutMs: at("10:00"),
    statedHours: 0.5,
  });
  const overlap = addShift({ entries: [kiosk], inMs: at("09:15"), outMs: at("09:45") });
  assert.equal(overlap.refusal, "ADMIN_OVERLAP");
  assert.equal(overlap.conflict.row, 6);
  // After the stated check-out is fine, though the tap was later.
  assert.equal(
    addShift({ entries: [kiosk], inMs: at("09:45"), outMs: at("09:55") }).refusal,
    undefined,
  );
  // Touching at either end is fine.
  assert.equal(
    addShift({ entries: [kiosk], inMs: at("08:00"), outMs: at("09:00") }).refusal,
    undefined,
  );
  assert.equal(
    addShift({ entries: [kiosk], inMs: at("09:30"), outMs: at("09:50") }).refusal,
    undefined,
  );
  // Covering the other shift whole overlaps.
  assert.equal(
    addShift({ entries: [kiosk], inMs: at("08:00"), outMs: at("09:50") }).refusal,
    "ADMIN_OVERLAP",
  );
  // A closed row with no readable stated out falls back to the recorded out.
  const noStatedOut = { ...kiosk, statedOutMs: NaN };
  assert.equal(
    addShift({ entries: [noStatedOut], inMs: at("09:45"), outMs: at("09:50") }).refusal,
    "ADMIN_OVERLAP",
  );
  // Rows with no readable end, other volunteers' rows and other dates are skipped.
  const skipped = [
    { ...kiosk, statedOutMs: NaN, recordedOutMs: NaN },
    { ...kiosk, token: OTHER_TOKEN },
    { ...kiosk, dateText: "2026-11-11" },
  ];
  assert.equal(
    addShift({ entries: skipped, inMs: at("09:15"), outMs: at("09:45") }).refusal,
    undefined,
  );
  // With two overlaps, the earlier-starting one is named.
  const early = { ...kiosk, row: 3, statedInMs: at("08:30"), statedOutMs: at("09:05") };
  assert.equal(
    addShift({ entries: [kiosk, early], inMs: at("08:00"), outMs: at("09:50") }).conflict.row,
    3,
  );
});

test("findOverlap skips a closed row whose check-out reads before its check-in", () => {
  // A shift that ran past midnight, typed by hand: 9:00 PM in, 12:15 AM out, one Date.
  const day = "2026-11-11";
  const Y = (hhmm) => Date.parse(day + "T" + hhmm + ":00-06:00");
  const cols = L.logColumns(LOG_HEADERS);
  const pastMidnight = L.logEntry(
    closedRow(LOG_HEADERS, {
      Date: day,
      "User Token": TOKEN,
      "Check-In Recorded (timestamp)": "",
      "Check-In Stated (user)": "9:00 PM",
      "Check-Out Recorded (timestamp)": "",
      "Check-Out Stated (user)": "12:15 AM",
      "Hours Served (stated)": 3.25,
    }),
    6,
    cols,
    READ,
  );
  assert.equal(pastMidnight.statedInMs, Y("21:00"));
  assert.equal(pastMidnight.statedOutMs, Y("00:15"));
  const add = (entries, inAt, outAt) =>
    addShift({
      entries,
      date: day,
      inMs: Y(inAt),
      inDate: day,
      outMs: Y(outAt),
      outDate: day,
    });
  assert.equal(add([pastMidnight], "13:00", "15:00").refusal, undefined);
  // A shift covering 12:15 AM to 9:00 PM would overlap the row read as a window.
  assert.equal(add([pastMidnight], "00:10", "21:30").refusal, undefined);
  assert.equal(L.findOverlap([pastMidnight], TOKEN, day, Y("00:10"), Y("21:30")), null);
  // A normal row in that window still is refused.
  const normal = entry(7, {
    status: "closed",
    dateText: day,
    statedInMs: Y("13:30"),
    recordedInMs: Y("13:30"),
    statedOutMs: Y("14:30"),
    recordedOutMs: Y("14:30"),
  });
  const refused = add([pastMidnight, normal], "13:00", "15:00");
  assert.equal(refused.refusal, "ADMIN_OVERLAP");
  assert.equal(refused.conflict.row, 7);
});

test("a kiosk check-out written on the day after the row's Date ends that shift", () => {
  // Checked in 11:00 PM on the 11th, checked out at the kiosk 12:30 AM on the 12th.
  const day = "2026-11-11";
  const Y = (hhmm) => Date.parse(day + "T" + hhmm + ":00-06:00");
  const N = (hhmm) => Date.parse("2026-11-12T" + hhmm + ":00-06:00");
  const cols = L.logColumns(LOG_HEADERS);
  const row = (extra = {}) =>
    L.logEntry(
      closedRow(LOG_HEADERS, {
        Date: day,
        "User Token": TOKEN,
        "Check-In Recorded (timestamp)": new Date(Y("23:00")),
        "Check-In Stated (user)": new Date(Y("23:00")),
        "Check-Out Recorded (timestamp)": new Date(N("00:30")),
        "Check-Out Stated (user)": new Date(N("00:30")),
        "Hours Served (timestamps)": 1.5,
        "Hours Served (stated)": 1.5,
        ...extra,
      }),
      6,
      cols,
      READ,
    );
  const overnight = row();
  assert.equal(overnight.recordedOutMs, N("00:30"));
  assert.equal(overnight.statedOutMs, N("00:30"));
  // Add a shift inside it that night is refused.
  assert.equal(L.findOverlap([overnight], TOKEN, day, Y("23:15"), Y("23:45")).row, 6);
  const added = addShift({
    entries: [overnight],
    date: day,
    inMs: Y("23:15"),
    inDate: day,
    outMs: Y("23:45"),
    outDate: day,
  });
  assert.equal(added.refusal, "ADMIN_OVERLAP");
  // Only an end time belongs to the day before: a check-in on the next day is unreadable.
  assert.ok(Number.isNaN(row({ "Check-In Stated (user)": new Date(N("00:10")) }).statedInMs));
  // With no readable start there is no shift to end, and two days on is still unreadable.
  const noStart = row({ "Check-In Recorded (timestamp)": "", "Check-In Stated (user)": "" });
  assert.ok(Number.isNaN(noStart.statedOutMs));
  const later = row({ "Check-Out Stated (user)": new Date(N("00:30") + 24 * HOUR) });
  assert.ok(Number.isNaN(later.statedOutMs));
});

test("handShiftCells throws on an empty token or Shift ID", () => {
  assert.throws(
    () => L.handShiftCells({ ...VOL, token: "" }, TODAY, at("08:00"), at("09:00"), "", "JP", "s"),
    /without a User Token/,
  );
  assert.throws(
    () => L.handShiftCells(VOL, TODAY, at("08:00"), at("09:00"), "", "JP", " "),
    /without a Shift ID/,
  );
});

/** A Fix a sign-out of row 9 (open, kiosk check-in at 8:00) at 9:30. */
const fixRow = () =>
  entry(9, { shiftId: "shift-open", recordedInMs: at("08:05"), statedInMs: at("08:00") });
const fixSignOut = (fields) =>
  plain(
    L.decideFixSignOut({
      entries: [fixRow()],
      shiftId: "shift-open",
      nowMs: NOW,
      outMs: at("09:30"),
      outDate: TODAY,
      initials: "ab",
      note: "",
      ...fields,
    }),
  );

test("decideFixSignOut closes a kiosk row with the stated check-out and the initials", () => {
  const d = fixSignOut({});
  assert.equal(d.open.row, 9);
  assert.equal(d.hours, 1.5);
  // Check-In Entered By stays kiosk: it isn't written. Nor are the Recorded times, their
  // hours, Admin Alerts? or Notes when no note is given.
  assert.deepEqual(d.cells, {
    [H.statedOut]: at("09:30"),
    [H.statedHours]: 1.5,
    [H.status]: "closed",
    [H.outBy]: "AB",
  });
  // A note is added after what the row's Notes hold.
  const noted = fixSignOut({
    entries: [{ ...fixRow(), notes: "staff note" }],
    note: "emailed at 5",
  });
  assert.equal(noted.cells[H.notes], "staff note; emailed at 5");
  assert.equal(fixSignOut({ note: "=SUM(A1)" }).cells[H.notes], "'=SUM(A1)");
  // A row on an earlier date, fixed today.
  const yesterday = entry(4, {
    shiftId: "shift-old",
    dateText: "2026-11-11",
    statedInMs: Date.parse("2026-11-11T13:00:00-06:00"),
  });
  const old = fixSignOut({
    entries: [yesterday],
    shiftId: "shift-old",
    outMs: Date.parse("2026-11-11T17:45:00-06:00"),
    outDate: "2026-11-11",
  });
  assert.equal(old.hours, 4.75);
  // Equal to the start is a zero-hour shift; a time up to 5 minutes ahead is now.
  assert.equal(fixSignOut({ outMs: at("08:00") }).hours, 0);
  assert.equal(fixSignOut({ outMs: NOW + 4 * MIN }).cells[H.statedOut], NOW);
});

test("decideFixSignOut refuses in order", () => {
  const order = [
    [{ initials: "" }, "ADMIN_INITIALS"],
    [{ note: "x".repeat(501) }, "ADMIN_NOTE_TOO_LONG"],
    [{ shiftId: "" }, "ADMIN_NOT_OPEN"],
    [{ shiftId: "shift-gone" }, "ADMIN_NOT_OPEN"],
    [{ entries: [{ ...fixRow(), status: "closed" }] }, "ADMIN_NOT_OPEN"],
    [{ entries: [fixRow(), { ...fixRow(), row: 10 }] }, "ADMIN_DUPLICATE_SHIFT"],
    [{ entries: [{ ...fixRow(), statedInMs: NaN, recordedInMs: NaN }] }, "ADMIN_BAD_ROW"],
    [{ outMs: NaN, outDate: "" }, "ADMIN_BAD_TIME"],
    [{ outMs: NOW + 6 * MIN }, "ADMIN_FUTURE"],
    [{ outDate: "2026-11-11" }, "ADMIN_BAD_TIME"],
    [{ outMs: at("07:59") }, "ADMIN_OUT_BEFORE_IN"],
  ];
  for (const [fields, code] of order) assert.equal(fixSignOut(fields).refusal, code, code);
  // A start that falls back to the recorded check-in is readable.
  const recordedOnly = { ...fixRow(), statedInMs: NaN };
  assert.equal(fixSignOut({ entries: [recordedOnly] }).hours, 1.42);
  // A closed row with the same Shift ID beside the open one doesn't count as a duplicate.
  assert.equal(
    fixSignOut({ entries: [fixRow(), { ...fixRow(), row: 2, status: "closed" }] }).open.row,
    9,
  );
});

test("decideFixSignOut: the closed shift may not overlap the volunteer's other shifts that date", () => {
  const later = entry(12, {
    status: "closed",
    statedInMs: at("09:00"),
    statedOutMs: at("09:45"),
    statedHours: 0.75,
  });
  const d = fixSignOut({ entries: [fixRow(), later] });
  assert.equal(d.refusal, "ADMIN_OVERLAP");
  assert.equal(d.conflict.row, 12);
  assert.ok(!("openStartMs" in d));
  // Closing before the other shift starts is fine.
  assert.equal(fixSignOut({ entries: [fixRow(), later], outMs: at("09:00") }).hours, 1);
});

test("decideFixSignOut: an open row that starts inside a menu shift names it", () => {
  // A menu shift 7:00 to 9:00 was added for today; the volunteer then checked in at the
  // kiosk at 8:00 and never checked out. Every check-out time overlaps the menu shift.
  const menu = entry(3, {
    status: "closed",
    recordedInMs: NaN,
    statedInMs: at("07:00"),
    statedOutMs: at("09:00"),
    statedHours: 2,
  });
  const d = fixSignOut({ entries: [menu, fixRow()], outMs: at("08:30") });
  assert.equal(d.refusal, "ADMIN_OVERLAP");
  assert.equal(d.conflict.row, 3);
  assert.equal(d.openStartMs, at("08:00"));
  assert.deepEqual(plain(L.overlapRefusal(d.conflict, CLOCK, d.openStartMs)), {
    ok: false,
    refusal: "ADMIN_OVERLAP",
    message:
      "This shift overlaps another shift for this volunteer on that date. The other shift" +
      " is 7:00 AM to 9:00 AM, on Log row 3. This open shift starts at 8:00 AM, inside" +
      " that one, so any check-out time would overlap it. Correct or remove one of the two" +
      " rows in the sheet first, then close this one.",
  });
  // Once staff correct the menu row to end at 8:00, the open row can be closed.
  const corrected = { ...menu, statedOutMs: at("08:00"), statedHours: 1 };
  assert.equal(fixSignOut({ entries: [corrected, fixRow()] }).hours, 1.5);
});

test("overlapRefusal names the other shift", () => {
  const other = entry(14, { status: "closed", statedInMs: at("09:00"), statedOutMs: at("11:15") });
  assert.deepEqual(plain(L.overlapRefusal(other, CLOCK)), {
    ok: false,
    refusal: "ADMIN_OVERLAP",
    message:
      "This shift overlaps another shift for this volunteer on that date. The other shift" +
      " is 9:00 AM to 11:15 AM, on Log row 14.",
  });
});

test("admin cell maps use Log headers only, and a menu row counts toward milestones", () => {
  const added = L.handShiftCells(VOL, TODAY, at("08:00"), at("09:30"), "note", "JP", "s-1");
  const fixed = L.fixSignOutCells(fixRow(), at("09:30"), "note", "JP");
  const cols = L.logColumns(LOG_HEADERS);
  for (const cells of [added, fixed]) {
    for (const key of Object.keys(cells)) assert.ok(LOG_HEADERS.includes(key), key);
    assert.doesNotThrow(() => L.cellWrites(cells, cols));
  }
  // A note needs the Notes column; without one the write throws before any cell is set.
  const noNotes = L.logColumns(LOG_HEADERS.filter((h) => h !== "Notes"));
  assert.throws(() => L.cellWrites(added, noNotes), /no "notes" column/);
  // The added row read back: closed, by token, 1.5 stated hours, no recorded times.
  const cells = LOG_HEADERS.map(() => "");
  for (const w of plain(L.cellWrites(added, cols))) {
    cells[w.col - 1] = w.kind === "time" && w.value !== "" ? new Date(w.value) : w.value;
  }
  const back = plain(L.logEntry(cells, 20, cols, READ));
  assert.equal(back.status, "closed");
  assert.equal(back.recordedInMs, null);
  assert.equal(back.statedOutMs, at("09:30"));
  assert.deepEqual(plain(L.closedTotals([back], TOKEN)), { shifts: 1, minutes: 90 });
});

// ---------------------------------------------------------------------------
// Refusals

test("refusal gives each code its exact message", () => {
  const expected = {
    ACCESS: "This kiosk needs to be set up. Please ask a board member.",
    NOT_FOUND: "We couldn't find your profile. Please see a board member.",
    ALREADY_IN: "You're already checked in.",
    NOT_IN: "You're not checked in.",
    ARRIVAL_FUTURE: "Your arrival time can't be in the future. Please choose an earlier time.",
    ARRIVAL_OTHER_DAY: "Please choose a time from today.",
    PHONE_NEEDED: "Please enter the last four digits of your phone number.",
    PHONE_WRONG: "Those digits don't match our records. Please try again or see a board member.",
    PHONE_MISSING: "We need to confirm who you are. Please see a board member.",
    CHECKOUT_FUTURE: "Your check-out time can't be in the future. Please choose an earlier time.",
    CHECKOUT_OTHER_DAY: "Please choose a time from today.",
    CHECKOUT_BEFORE_ARRIVAL:
      "Your check-out time can't be before your arrival time. Please choose a later time.",
    BUSY: "The kiosk is busy. Please try again.",
    ADMIN_EXPIRED: "This window has expired. Close it and open the Kiosk admin menu again.",
    ADMIN_INITIALS: "Please enter your initials, letters only.",
    ADMIN_NOTE_TOO_LONG: "Please keep the note to 500 characters or fewer.",
    ADMIN_NOT_FOUND:
      "That volunteer is no longer in Volunteer Profiles. Close this window and open it again.",
    ADMIN_BAD_TIME: "Please enter a valid date and time.",
    ADMIN_FUTURE: "That date or time is in the future.",
    ADMIN_OUT_BEFORE_IN: "The check-out time can't be before the check-in time.",
    ADMIN_OPEN_SHIFT:
      "This volunteer has an open shift on that date. Use Fix a sign-out to close it.",
    ADMIN_OVERLAP: "This shift overlaps another shift for this volunteer on that date.",
    ADMIN_NOT_OPEN:
      "That shift is no longer open. Close this window and open Fix a sign-out again.",
    ADMIN_DUPLICATE_SHIFT:
      "More than one open row in the Log has this Shift ID. Fix the extra row in the sheet first.",
    ADMIN_BAD_ROW:
      "That row's date or check-in time can't be read, so its hours can't be worked out. Fix the row in the sheet first.",
    ADMIN_BAD_MONTH: "Please choose a month.",
    ADMIN_REMOVE_REASON: "Please enter a reason for removing this shift.",
    ADMIN_REMOVE_NO_ID:
      "That row has no Shift ID, so the menu can't remove it. Delete it in the sheet by hand.",
    ADMIN_REMOVE_NOT_FOUND:
      "No Log row has that Shift ID any more. Close this window and find the shift again.",
    ADMIN_REMOVE_MOVED:
      "That row moved or changed in the Log since you found it. Find the shift again, then remove it.",
    ADMIN_REMOVE_HEADERS:
      "This row has a value in a column whose header is blank, repeated, or named like a Removed shifts column, so it can't be removed without losing that value. Give that column a unique header first.",
    ADMIN_RESTORE_NOT_FOUND:
      "That shift is no longer on the Removed shifts tab. Close this window and open Restore a shift again.",
    ADMIN_RESTORE_MOVED:
      "That row moved or changed on the Removed shifts tab. Close this window and open Restore a shift again.",
    ADMIN_RESTORE_IN_LOG:
      "A Log row already has this Shift ID, so the shift is already in the Log. Tidy the extra copy by hand.",
    ADMIN_RESTORE_OPEN_SHIFT:
      "This shift is open and the volunteer already has an open shift in the Log. Close that one with Fix a sign-out first.",
    ADMIN_RESTORE_HEADERS:
      "This row has a value in a column the Log doesn't have exactly once, or whose header is blank or repeated, so it can't go back without losing that value. Give the Log one column with that header first.",
  };
  for (const [code, message] of Object.entries(expected)) {
    assert.deepEqual(plain(L.refusal(code)), { ok: false, refusal: code, message });
  }
  assert.deepEqual(Object.keys(plain(L.refusalMessages())).sort(), Object.keys(expected).sort());
  assert.throws(() => L.refusal("NOPE"), /Unknown refusal code/);
});

// ---------------------------------------------------------------------------
// The Profiles cache
//
// The script cache holds the parsed Profiles list under a key that carries
// profilesCacheVersion(). Code must never read a list cached in another shape, so the
// version goes up whenever the shape changes. Each version is pinned here with the shape
// of a cached volunteer (its fields and their types, sorted): changing the shape without
// raising the version fails this test. To change it, raise profilesCacheVersion() and
// add a line here.
const PROFILES_CACHE_SHAPES = {
  2: "firstName:string,id:string,lastName:string,needsPhoneCheck:boolean,phoneLast4:string,row:number,startDate:string,token:string",
};

test("the cached Profiles shape goes with its cache version", () => {
  const { volunteers } = parse([person("Lena", "Park", "tok-a"), person("Sam", "Lee", "tok-b")]);
  const shapes = new Set(
    volunteers.map((v) =>
      Object.keys(v)
        .sort()
        .map((k) => k + ":" + typeof v[k])
        .join(","),
    ),
  );
  assert.equal(shapes.size, 1);
  const version = L.profilesCacheVersion();
  assert.equal(
    [...shapes][0],
    PROFILES_CACHE_SHAPES[version],
    "the cached volunteer's shape changed: raise profilesCacheVersion() and pin the new shape",
  );
  assert.equal(version, 2);
});

test("profilesCacheKey carries the version", () => {
  assert.equal(
    L.profilesCacheKey("file-1", "Volunteer Profiles"),
    "profiles:v2:file-1:Volunteer Profiles",
  );
});

test("constants", () => {
  assert.equal(L.kioskTimeZone(), "America/Chicago");
  assert.equal(L.profilesCacheSeconds(), 300);
  assert.equal(L.defaultFlagMinutes(), 15);
});

// ---------------------------------------------------------------------------
// Settings in the script cache

const SETTINGS = { "Kiosk access code": "lettersonlylettersonly", "Volunteer Profiles tab": "" };

test("the Settings cache's keys and limits", () => {
  assert.equal(L.settingsCacheKey(), "settings:v1");
  assert.equal(L.settingsStampKey(), "settings:edited");
  assert.equal(L.settingsCacheSeconds(), 300);
  assert.equal(L.settingsCacheMaxBytes(), 100000);
  assert.notEqual(L.settingsCacheKey(), L.settingsStampKey());
});

test("a cached Settings copy round-trips and is used with no stamp", () => {
  const text = L.settingsCacheValue(SETTINGS, NOW - 1000);
  assert.deepEqual(JSON.parse(text), { v: 1, readAt: NOW - 1000, settings: SETTINGS });
  assert.deepEqual(plain(L.settingsFromCache(text, null, NOW)), SETTINGS);
  assert.deepEqual(plain(L.settingsFromCache(text, undefined, NOW)), SETTINGS);
  assert.deepEqual(plain(L.settingsFromCache(L.settingsCacheValue({}, NOW), null, NOW)), {});
});

test("a cached Settings copy is used only when read after the stamp", () => {
  const readAt = NOW - 10000;
  const text = L.settingsCacheValue(SETTINGS, readAt);
  assert.deepEqual(plain(L.settingsFromCache(text, String(readAt - 1), NOW)), SETTINGS);
  assert.equal(L.settingsFromCache(text, String(readAt), NOW), null, "read at the stamp");
  assert.equal(L.settingsFromCache(text, String(readAt + 1), NOW), null, "read before it");
});

test("a cached Settings copy is used for less than 5 minutes after its read", () => {
  const text = L.settingsCacheValue(SETTINGS, NOW);
  assert.deepEqual(plain(L.settingsFromCache(text, null, NOW + 300000 - 1)), SETTINGS);
  assert.equal(L.settingsFromCache(text, null, NOW + 300000), null);
  assert.equal(L.settingsFromCache(text, null, NOW + 3600000), null);
});

test("a cached Settings copy or stamp that can't be read gives null", () => {
  const good = { v: 1, readAt: NOW - 1000, settings: SETTINGS };
  const bad = [
    null,
    undefined,
    "",
    "not json",
    "null",
    "[]",
    "7",
    JSON.stringify({ ...good, v: 2 }),
    JSON.stringify({ ...good, v: "1" }),
    JSON.stringify({ ...good, readAt: "1" }),
    JSON.stringify({ ...good, readAt: null }),
    JSON.stringify({ v: 1, settings: SETTINGS }),
    JSON.stringify({ ...good, settings: null }),
    JSON.stringify({ ...good, settings: [] }),
    JSON.stringify({ ...good, settings: "text" }),
    JSON.stringify({ ...good, settings: { ...SETTINGS, "Kiosk access code": 7 } }),
    JSON.stringify({ ...good, settings: { ...SETTINGS, "Kiosk launch date": null } }),
  ];
  for (const text of bad) assert.equal(L.settingsFromCache(text, null, NOW), null, String(text));
  const text = JSON.stringify(good);
  for (const stamp of ["", "soon", "12.5", "-1", " 1", "1e3", 5]) {
    assert.equal(L.settingsFromCache(text, stamp, NOW), null, JSON.stringify(stamp));
  }
  assert.deepEqual(plain(L.settingsFromCache(text, "0", NOW)), SETTINGS);
});

// ---------------------------------------------------------------------------
// The Flags tab

const FLAG_HEADERS = [
  "Date",
  "Volunteer Name",
  "Shift ID",
  "Reason",
  "Raised At",
  "Reviewed",
  "Reviewed By",
  "Notes",
  "Source",
  "Log Row",
];
const F = plain(L.flagHeaderNames());

test("flagHeaders are the eight review columns, then Source and Log Row", () => {
  assert.deepEqual(plain(L.flagHeaders()), FLAG_HEADERS);
  assert.deepEqual(plain(L.flagColumnKinds()), {
    Date: "text",
    "Volunteer Name": "text",
    "Shift ID": "text",
    Reason: "text",
    "Raised At": "time",
    Reviewed: "checkbox",
    "Reviewed By": "text",
    Notes: "text",
    Source: "text",
    "Log Row": "number",
  });
});

test("flagColumns finds headers in any order, with staff columns between", () => {
  const header = [
    "log row",
    "Staff column",
    "REVIEWED",
    "Source",
    " raised  at ",
    "Reason",
    "Notes",
    "Shift\nID",
    "Volunteer Name",
    "Date",
    "Reviewed By",
  ];
  assert.deepEqual(plain(L.flagColumns(header)), {
    Date: 9,
    "Volunteer Name": 8,
    "Shift ID": 7,
    Reason: 5,
    "Raised At": 4,
    Reviewed: 2,
    "Reviewed By": 10,
    Notes: 6,
    Source: 3,
    "Log Row": 0,
  });
});

test("flagColumns needs only the columns the script writes", () => {
  const header = FLAG_HEADERS.filter((h) => h !== "Reviewed By" && h !== "Notes");
  const cols = plain(L.flagColumns(header));
  assert.equal(cols["Reviewed By"], -1);
  assert.equal(cols.Notes, -1);
  // Staff's columns may be repeated.
  assert.doesNotThrow(() => L.flagColumns([...FLAG_HEADERS, "Notes", "Reviewed By"]));
  assert.throws(
    () => L.flagColumns(FLAG_HEADERS.filter((h) => h !== "Shift ID")),
    /^Error: The Flags tab has no "shift id" column\. Run setupSheets\(\)\.$/,
  );
  assert.throws(
    () => L.flagColumns([...FLAG_HEADERS, "reason"]),
    /^Error: The Flags tab has more than one "reason" column\. Rename or remove the extra one\.$/,
  );
});

test("flagHeaderWrites: an empty row gets every header; a short one gets what it lacks", () => {
  const full = FLAG_HEADERS.map((header, i) => ({ col: i + 1, header }));
  assert.deepEqual(plain(L.flagHeaderWrites([])), full);
  assert.deepEqual(plain(L.flagHeaderWrites(["", " "])), full);
  assert.deepEqual(plain(L.flagHeaderWrites(FLAG_HEADERS)), []);
  const short = FLAG_HEADERS.slice(0, 8);
  assert.deepEqual(plain(L.flagHeaderWrites([...short, "", "Staff"])), [
    { col: 11, header: "Source" },
    { col: 12, header: "Log Row" },
  ]);
  // Reviewed By and Notes are staff's and never added.
  const noStaff = FLAG_HEADERS.filter((h) => h !== "Reviewed By" && h !== "Notes");
  assert.deepEqual(plain(L.flagHeaderWrites(noStaff)), []);
});

const FLAG_BASE = {
  date: TODAY,
  name: "Sam Lee",
  shiftId: "shift-9",
  raisedAtMs: NOW,
  source: "kiosk check-out",
  logRow: 9,
};

test("flagRows: one row per reason, the same base on each, Reviewed false, no token", () => {
  const rows = plain(
    L.flagRows(FLAG_BASE, ["check-out differs by 30 min", L.unreadableStartAlert()]),
  );
  assert.equal(rows.length, 2);
  const want = (reason) => ({
    Date: TODAY,
    "Volunteer Name": "Sam Lee",
    "Shift ID": "shift-9",
    Reason: reason,
    "Raised At": NOW,
    Reviewed: false,
    Source: "kiosk check-out",
    "Log Row": 9,
  });
  assert.deepEqual(rows, [want("check-out differs by 30 min"), want(L.unreadableStartAlert())]);
  for (const row of rows) {
    for (const value of Object.values(row)) assert.notEqual(value, TOKEN);
    assert.ok(!Object.keys(row).some((k) => /token/i.test(k)));
  }
  assert.deepEqual(plain(L.flagRows(FLAG_BASE, [])), []);
  assert.equal(L.flagRows({ ...FLAG_BASE, name: "=Sam" }, ["x"])[0]["Volunteer Name"], "'=Sam");
});

test("flagRows throws on an empty Shift ID", () => {
  for (const shiftId of ["", "  ", undefined]) {
    assert.throws(
      () => L.flagRows({ ...FLAG_BASE, shiftId }, ["arrival differs by 24 min"]),
      /without a Shift ID/,
    );
  }
});

test("flagRowValues puts each value under its header and blanks elsewhere", () => {
  const header = [
    "Staff",
    "Log Row",
    "Reason",
    "Shift ID",
    "Date",
    "Notes",
    "Volunteer Name",
    "Raised At",
    "Reviewed",
    "Source",
  ];
  const cols = L.flagColumns(header);
  const [cells] = L.flagRows(FLAG_BASE, ["check-out differs by 30 min"]);
  assert.deepEqual(plain(L.flagRowValues(cells, cols, header.length + 1)), [
    "",
    9,
    "check-out differs by 30 min",
    "shift-9",
    TODAY,
    "",
    "Sam Lee",
    NOW,
    false,
    "kiosk check-out",
    "",
  ]);
  assert.throws(() => L.flagRowValues({ Token: "x" }, cols, 10), /not a Flags header/);
});

test("checkOutFlags lists the check-out flag, then the unreadable start", () => {
  const readable = entry(9, {});
  const unreadable = entry(9, { recordedInMs: NaN, statedInMs: NaN });
  assert.deepEqual(plain(L.checkOutFlags(readable, "")), []);
  assert.deepEqual(plain(L.checkOutFlags(readable, "check-out differs by 30 min")), [
    "check-out differs by 30 min",
  ]);
  assert.deepEqual(plain(L.checkOutFlags(unreadable, "")), [L.unreadableStartAlert()]);
  assert.deepEqual(plain(L.checkOutFlags(unreadable, "check-out differs by 30 min")), [
    "check-out differs by 30 min",
    L.unreadableStartAlert(),
  ]);
  // checkOutCells writes Admin Alerts? as the same list added to what the cell held.
  for (const [open, flag] of [
    [readable, ""],
    [readable, "check-out differs by 30 min"],
    [{ ...unreadable, alerts: "staff text" }, ""],
    [{ ...unreadable, alerts: "staff text" }, "check-out differs by 30 min"],
  ]) {
    const flags = L.checkOutFlags(open, flag);
    const cells = plain(L.checkOutCells(open, NOW, NOW, flag));
    const want = flags.length ? flags.reduce((t, f) => L.appendText(t, f), open.alerts) : undefined;
    assert.equal(cells[H.alerts], want);
  }
});

test("decideCheckIn's flags are the arrival flag Admin Alerts? gets", () => {
  assert.deepEqual(checkIn({ arrivedMs: NOW - 5 * MIN }).flags, []);
  assert.deepEqual(checkIn({ arrivedMs: NOW - 24 * MIN }).flags, ["arrival differs by 24 min"]);
});

test("decideCheckOut returns both flags and the open row for a picked time on an unreadable start", () => {
  const open = entry(9, { recordedInMs: NaN, statedInMs: NaN });
  const out = checkOut({ entries: [open], outMs: NOW - 30 * MIN, outDate: TODAY });
  assert.deepEqual(out.flags, ["check-out differs by 30 min", L.unreadableStartAlert()]);
  assert.equal(out.cells[H.alerts], out.flags.join("; "));
  assert.deepEqual(out.open, plain(open));
  assert.equal(out.open.shiftId, "shift-9");
});

test("the admin menu raises no flags", () => {
  assert.equal(addShift({}).flags, undefined);
  assert.equal(fixSignOut({}).flags, undefined);
});

test("flagFilterViewRequests uses the map's letters, and updates by id or adds", () => {
  const header = [
    "Staff",
    "Log Row",
    "Reason",
    "Shift ID",
    "Date",
    "Volunteer Name",
    "Raised At",
    "Source",
    "Reviewed",
  ];
  const cols = L.flagColumns(header);
  const view = {
    title: "Flags: Unreviewed",
    range: { sheetId: 77 },
    filterSpecs: [
      {
        columnIndex: 8,
        filterCriteria: {
          condition: {
            type: "CUSTOM_FORMULA",
            values: [{ userEnteredValue: '=AND(TRIM($D2) <> "", $I2 <> TRUE)' }],
          },
        },
      },
    ],
    sortSpecs: [{ dimensionIndex: 6, sortOrder: "DESCENDING" }],
  };
  assert.deepEqual(plain(L.flagFilterViewRequests(cols, 77, null)), [
    { addFilterView: { filter: view } },
  ]);
  assert.deepEqual(plain(L.flagFilterViewRequests(cols, 77, 1234)), [
    {
      updateFilterView: {
        filter: { filterViewId: 1234, ...view },
        fields: "title,range,filterSpecs,sortSpecs",
      },
    },
  ]);
  // The title doesn't start "Kiosk: ", so setupReports never takes it for its own.
  assert.ok(!L.flagsViewTitle().startsWith(L.filterViewTitlePrefix()));
});

// ---------------------------------------------------------------------------
// The window after the check-in tap, the long-shift flag and the missed check-out
//
// An open row is the tablet's for "Auto clock-out after hours" after its check-in tap and
// the auto clock-out's from then on. Times here are Central; every person is invented.

/** A Central time on a date, in milliseconds. */
const C = (date, hhmm) => timeOnDate(date, hhmm).ms;
const YESTERDAY = "2026-11-11";
/** An open row of Sam's tapped at tap and stating stated (both Central on date). */
const tapped = (row, date, tap, stated = tap, fields = {}) =>
  entry(row, {
    dateText: date,
    recordedInMs: tap === null ? NaN : C(date, tap),
    statedInMs: stated === null ? NaN : C(date, stated),
    ...fields,
  });

test("checkedInMs is the tap, else the start, else NaN", () => {
  assert.equal(L.checkedInMs(entry(2, { statedInMs: NOW - 9 * HOUR })), NOW - 2 * HOUR);
  assert.equal(L.checkedInMs(entry(2, { recordedInMs: NaN })), NOW - 2 * HOUR);
  assert.ok(Number.isNaN(L.checkedInMs(entry(2, { recordedInMs: NaN, statedInMs: NaN }))));
});

test("a 22:00 check-in is found at 01:00 and gone when 12 hours have passed since the tap", () => {
  const row = tapped(2, YESTERDAY, "22:00");
  const find = (at) => L.findOpenShift([row], TOKEN, at, WINDOW, TODAY);
  assert.equal(find(C(TODAY, "01:00")).row, 2);
  assert.equal(find(C(TODAY, "09:59")).row, 2);
  // At an age of exactly the window the row is the job's, not the tablet's.
  assert.equal(find(C(TODAY, "10:00")), null);
  assert.equal(find(C(TODAY, "10:01")), null);
  const job = (at) => L.autoClockOutRows([row], at, WINDOW, TODAY, LAUNCH).close.length;
  assert.equal(job(C(TODAY, "04:00")), 0);
  assert.equal(job(C(TODAY, "09:59")), 0);
  assert.equal(job(C(TODAY, "10:00")), 1);
  const [listed] = plain(L.volunteerSummaries([VOL], [row], C(TODAY, "01:00"), WINDOW, TODAY));
  assert.equal(listed.checkedIn, true);
  assert.equal(listed.openShiftArrival, new Date(C(YESTERDAY, "22:00")).toISOString());
});

test("with a 10-hour window a 16:00 tap stating 08:00 can check out until 02:00, then is the job's", () => {
  const window = L.autoClockOutWindowMs("10");
  assert.equal(window, 10 * HOUR);
  const row = tapped(2, YESTERDAY, "16:00", "08:00");
  const at = (hhmm) => ({ nowMs: C(TODAY, hhmm), windowMs: window, entries: [row] });
  const listed = (hhmm) =>
    plain(L.volunteerSummaries([VOL], [row], C(TODAY, hhmm), window, TODAY))[0].checkedIn;
  assert.equal(listed("01:59"), true);
  assert.equal(listed("02:00"), false);
  const out = checkOut(at("01:59"));
  assert.equal(out.row, 2);
  assert.equal(out.cells[H.statedHours], 17.98);
  assert.deepEqual(checkOut(at("02:00")), { refusal: "NOT_IN" });
  const job = (hhmm) => L.autoClockOutRows([row], C(TODAY, hhmm), window, TODAY, LAUNCH);
  assert.equal(job("01:59").close.length, 0);
  assert.equal(job("02:00").close.length, 1);
  assert.equal(job("04:00").close[0].row, 2);
});

test("a row with no readable tap is measured from its start; one with no time is today's only", () => {
  const typed = tapped(2, TODAY, null, "08:00");
  const find = (rows, at) => L.findOpenShift(rows, TOKEN, at, WINDOW, TODAY);
  assert.equal(find([typed], C(TODAY, "19:59")).row, 2);
  assert.equal(find([typed], C(TODAY, "20:00")), null);
  const noTime = (date) => tapped(3, date, null, null);
  assert.equal(find([noTime(TODAY)], C(TODAY, "23:59")).row, 3);
  assert.equal(find([noTime(YESTERDAY)], C(TODAY, "00:01")), null);
  // A later start among two open rows in the window wins.
  const both = [tapped(4, TODAY, "08:00"), tapped(5, TODAY, "09:00")];
  assert.equal(find(both, NOW).row, 5);
});

test("the night clocks spring forward, a 24-hour window keeps a row two dates back that the list doesn't read", () => {
  // 2027-03-14 is the spring-forward date. Tapped 23:30 on the 13th; the window ends at
  // 00:30 on the 15th, which is 24 hours later.
  const window = L.autoClockOutWindowMs("24");
  const row = { ...tapped(2, "2027-03-13", "23:30"), status: "open" };
  const now = C("2027-03-15", "00:15");
  assert.deepEqual(plain(L.recentLogDates("2027-03-15")), ["2027-03-14", "2027-03-15"]);
  const listedRows = [row].filter((e) =>
    L.recentLogDates("2027-03-15").includes(L.rowDate(e.dateText)),
  );
  const [listed] = plain(L.volunteerSummaries([VOL], listedRows, now, window, "2027-03-15"));
  assert.equal(listed.checkedIn, false);
  // Check-in reads the whole Log, so it is refused until the hour has passed.
  const at = (ms) => ({
    entries: [row],
    nowMs: ms,
    windowMs: window,
    todayDate: "2027-03-15",
    arrivedMs: null,
    arrivedDate: "",
  });
  assert.deepEqual(checkIn(at(now)), { refusal: "ALREADY_IN" });
  const later = checkIn(at(C("2027-03-15", "00:31")));
  assert.equal(later.refusal, undefined);
  assert.equal(later.missedSignOut, true);
});

test("check-in is refused while a row is in the window and accepted once it has left it", () => {
  const row = tapped(2, YESTERDAY, "22:00");
  const at = (hhmm) => ({
    entries: [row],
    nowMs: C(TODAY, hhmm),
    arrivedMs: null,
    arrivedDate: "",
  });
  assert.deepEqual(checkIn(at("01:00")), { refusal: "ALREADY_IN" });
  const after = checkIn(at("10:01"));
  assert.equal(after.arrivedMs, C(TODAY, "10:01"));
  assert.equal(after.missedSignOut, true);
});

test("check-out across midnight: server time, a chosen time on either date, and the refusals", () => {
  const row = tapped(2, YESTERDAY, "22:00");
  const at = (fields) => checkOut({ entries: [row], nowMs: C(TODAY, "01:00"), ...fields });
  const server = at({});
  assert.equal(server.cells[H.statedOut], C(TODAY, "01:00"));
  assert.equal(server.cells[H.statedHours], 3);
  assert.deepEqual(server.flags, []);
  const before = at({ outMs: C(YESTERDAY, "23:30"), outDate: YESTERDAY });
  assert.equal(before.cells[H.statedHours], 1.5);
  assert.equal(before.cells[H.alerts], "check-out differs by 90 min");
  assert.equal(at({ outMs: C(TODAY, "00:30"), outDate: TODAY }).cells[H.statedHours], 2.5);
  assert.deepEqual(at({ outMs: C(YESTERDAY, "21:30"), outDate: YESTERDAY }), {
    refusal: "CHECKOUT_BEFORE_ARRIVAL",
  });
  assert.deepEqual(at({ outMs: C(TODAY, "01:06"), outDate: TODAY }), {
    refusal: "CHECKOUT_FUTURE",
  });
});

test("longShiftAlert prints whole and decimal hours and flags only more than the limit", () => {
  assert.equal(L.longShiftAlert(10.25, 8), "long shift: 10.25 h stated, over 8 h");
  assert.equal(L.longShiftAlert(10, 8), "long shift: 10 h stated, over 8 h");
  assert.equal(L.longShiftAlert(9, 8.5), "long shift: 9 h stated, over 8.5 h");
  assert.equal(L.longShiftAlert(8, 8), "");
  assert.equal(L.longShiftAlert(8.01, 8), "long shift: 8.01 h stated, over 8 h");
  assert.equal(L.longShiftAlert("", 8), "");
  assert.equal(L.longShiftAlert(NaN, 8), "");
  for (const text of ["Infinity", "-Infinity", "1e999"]) {
    assert.equal(L.parseLongShiftHours(text), 8, text);
  }
});

test("a check-out of more than Long shift flag hours stated is flagged, whatever the date", () => {
  const out = (start, fields = {}) =>
    checkOut({ entries: [entry(9, { recordedInMs: start, statedInMs: start })], ...fields });
  // Exactly 8.00 stated hours at 8 is not flagged; 8.01 is.
  assert.deepEqual(out(NOW - 8 * HOUR).flags, []);
  const over = out(NOW - 8.01 * HOUR);
  assert.equal(over.cells[H.statedHours], 8.01);
  assert.deepEqual(over.flags, ["long shift: 8.01 h stated, over 8 h"]);
  assert.equal(over.cells[H.alerts], "long shift: 8.01 h stated, over 8 h");
  // 11 PM to 2 AM across midnight: 3 hours, not flagged.
  const night = tapped(9, YESTERDAY, "23:00");
  assert.deepEqual(checkOut({ entries: [night], nowMs: C(TODAY, "02:00") }).flags, []);
  // A 4 PM tap stating 8 AM, checked out at 5 PM: 9 stated hours, flagged, after the
  // arrival alert the row already holds.
  const early = tapped(9, TODAY, "16:00", "08:00", { alerts: "arrival differs by 480 min" });
  const nine = checkOut({ entries: [early], nowMs: C(TODAY, "17:00") });
  assert.equal(nine.cells[H.statedHours], 9);
  assert.deepEqual(nine.flags, ["long shift: 9 h stated, over 8 h"]);
  assert.equal(
    nine.cells[H.alerts],
    "arrival differs by 480 min; long shift: 9 h stated, over 8 h",
  );
  // A setting of 10 moves the line.
  assert.deepEqual(
    checkOut({ entries: [early], nowMs: C(TODAY, "17:00"), longShiftHours: 10 }).flags,
    [],
  );
  assert.deepEqual(
    checkOut({ entries: [early], nowMs: C(TODAY, "18:15"), longShiftHours: 10 }).flags,
    ["long shift: 10.25 h stated, over 10 h"],
  );
  // The long-shift flag comes after the check-out flag, in the cell and the Flags list.
  const both = out(NOW - 10 * HOUR, { outMs: NOW - 30 * MIN, outDate: TODAY });
  assert.deepEqual(both.flags, [
    "check-out differs by 30 min",
    "long shift: 9.5 h stated, over 8 h",
  ]);
  assert.equal(both.cells[H.alerts], both.flags.join("; "));
  // checkOutCells and checkOutFlags take the long-shift text after the check-out flag.
  assert.deepEqual(plain(L.checkOutFlags(entry(9, {}), "a", "b")), ["a", "b"]);
});

test("a row with no readable start gets no long-shift alert", () => {
  const open = entry(9, { recordedInMs: NaN, statedInMs: NaN });
  const out = checkOut({ entries: [open], longShiftHours: 0.01 });
  assert.equal(out.cells[H.statedHours], "");
  assert.ok(!out.flags.some((f) => f.startsWith("long shift")));
  assert.deepEqual(out.flags, [L.unreadableStartAlert()]);
});

test("missedSignOut: the latest row since launch is open, or closed by anyone but the kiosk", () => {
  const closed = (row, date, outBy, fields = {}) =>
    tapped(row, date, "09:00", "09:00", { status: "closed", statedHours: 2, outBy, ...fields });
  const missed = (rows, launch = LAUNCH) => L.missedSignOut(rows, TOKEN, launch);
  assert.equal(missed([]), false);
  assert.equal(missed([closed(2, "2026-11-10", "kiosk")]), false);
  assert.equal(missed([closed(2, "2026-11-10", " Kiosk ")]), false);
  for (const outBy of ["auto-close", "EM", "", "import"]) {
    assert.equal(missed([closed(2, "2026-11-10", outBy)]), true, outBy);
  }
  // Open and out of the window.
  assert.equal(missed([tapped(2, "2026-11-10", "09:00")]), true);
  // Only the latest row counts, in date then start order.
  assert.equal(
    missed([closed(2, "2026-11-10", "auto-close"), closed(3, "2026-11-11", "kiosk")]),
    false,
  );
  assert.equal(
    missed([
      closed(4, "2026-11-11", "auto-close", { statedInMs: C("2026-11-11", "14:00") }),
      closed(3, "2026-11-11", "kiosk"),
    ]),
    true,
  );
  // Rows before the launch date, such as imported ones, never count.
  assert.equal(missed([closed(2, "2026-06-01", "import")]), false);
  assert.equal(
    missed([closed(2, "2026-10-31", "auto-close"), closed(3, "2026-11-02", "kiosk")]),
    false,
  );
  // Another volunteer's rows don't count.
  assert.equal(missed([closed(2, "2026-11-10", "auto-close", { token: OTHER_TOKEN })]), false);
  // A blank or unreadable launch date: no notice.
  assert.equal(missed([closed(2, "2026-11-10", "auto-close")], ""), false);
  // decideCheckIn carries it.
  assert.equal(checkIn({ entries: [closed(2, "2026-11-10", "auto-close")] }).missedSignOut, true);
  assert.equal(checkIn({ entries: [closed(2, "2026-11-10", "kiosk")] }).missedSignOut, false);
});

// ---------------------------------------------------------------------------
// Auto clock-out

/** A closed row of Sam's on date, stated length in minutes, check-out entered by outBy. */
const past = (row, date, minutes, outBy = "kiosk", fields = {}) =>
  tapped(row, date, "09:00", "09:00", {
    status: "closed",
    statedHours: Math.round((minutes / 60) * 100) / 100,
    outBy,
    ...fields,
  });
// Thursdays before TODAY (2026-11-12, a Thursday).
const THURSDAYS = ["2026-11-05", "2026-10-29", "2026-10-22", "2026-10-15", "2026-10-08"];

test("autoClockOutRows: open rows since launch whose age from the tap is at least the window, oldest first", () => {
  const now = C(TODAY, "04:00");
  const rows = [
    // Tapped 16:30 yesterday stating 07:00: age 11.5 hours from the tap, left.
    tapped(2, YESTERDAY, "16:30", "07:00"),
    // Tapped 15:00 yesterday: age 13 hours, closed.
    tapped(3, YESTERDAY, "15:00"),
    // Two days back, closed first.
    tapped(4, "2026-11-10", "18:00"),
    // Before the launch date: nobody's.
    tapped(5, "2026-10-30", "09:00"),
    // Closed already.
    tapped(6, "2026-11-10", "09:00", "09:00", { status: "closed" }),
    // No readable time, dated before today: skipped and flagged.
    tapped(7, "2026-11-10", null, null),
    // The same, already flagged: neither.
    tapped(8, "2026-11-10", null, null, {
      alerts: "staff note; auto clock-out skipped: check-in time unreadable",
    }),
    // No readable time, dated today: the tablet's.
    tapped(9, TODAY, null, null),
    // An unreadable Date: no age, not today.
    entry(10, { dateText: "sometime", recordedInMs: NaN, statedInMs: NaN }),
    // Edited by hand so its start is after the run: left for a later run.
    tapped(11, "2026-11-10", "08:00", "09:00", { statedInMs: now + HOUR }),
  ];
  const plan = L.autoClockOutRows(rows, now, WINDOW, TODAY, LAUNCH);
  assert.deepEqual(plain(plan.close.map((e) => e.row)), [4, 3]);
  assert.deepEqual(plain(plan.skip.map((e) => e.row)), [7]);
  assert.throws(() => L.autoClockOutLaunchDate(""), /Kiosk launch date/);
  assert.throws(() => L.autoClockOutLaunchDate("soon"), /Kiosk launch date/);
  assert.equal(L.autoClockOutLaunchDate("11/01/2026"), "2026-11-01");
});

test("usualLength needs 3 rows on the weekday, takes the median and refuses a spread sample", () => {
  const open = tapped(2, TODAY, "09:00");
  const usual = (rows) => plain(L.usualLength([open, ...rows], open));
  const on = (lengths, outBy) => lengths.map((m, i) => past(20 + i, THURSDAYS[i], m, outBy));
  assert.equal(usual(on([180, 180])), null);
  assert.deepEqual(usual(on([180, 180, 420])), { minutes: 180, weekday: "Thursday" });
  assert.equal(usual(on([120, 300, 480])), null);
  // Exactly 60 minutes from the median is near; 61 isn't.
  assert.deepEqual(usual(on([180, 240, 300])), { minutes: 240, weekday: "Thursday" });
  assert.equal(usual(on([180, 241, 302])), null);
  // An even count takes the mean of the middle two, rounded down.
  assert.deepEqual(usual(on([180, 181, 200, 201])), { minutes: 190, weekday: "Thursday" });
  // Admin initials and typed rows count; auto-closed and imported rows don't.
  const mixed = [
    past(20, THURSDAYS[0], 200, "EM"),
    past(21, THURSDAYS[1], 200, ""),
    past(22, THURSDAYS[2], 200),
  ];
  assert.deepEqual(usual(mixed), { minutes: 200, weekday: "Thursday" });
  assert.equal(usual(on([200, 200, 200], "auto-close")), null);
  assert.equal(usual(on([200, 200, 200], "import")), null);
  // Other weekdays, other volunteers, open rows and unreadable hours don't count.
  assert.equal(
    usual([
      past(20, "2026-11-04", 200),
      past(21, THURSDAYS[1], 200, "kiosk", { token: OTHER_TOKEN }),
      past(22, THURSDAYS[2], 200, "kiosk", { status: "open" }),
      past(23, THURSDAYS[3], 200, "kiosk", { statedHours: NaN }),
      past(24, THURSDAYS[4], 200, "kiosk", { statedHours: 0 }),
      past(25, "2026-10-01", 200, "kiosk", { statedHours: 25 }),
    ]),
    null,
  );
});

test("usualLength looks back 26 weeks and takes the 8 most recent", () => {
  const open = tapped(2, TODAY, "09:00");
  // 182 days back is 26 weeks: in. 189 is out.
  const edge = [past(20, "2026-11-05", 200), past(21, "2026-10-29", 200)];
  assert.deepEqual(plain(L.usualLength([open, ...edge, past(22, "2026-05-14", 200)], open)), {
    minutes: 200,
    weekday: "Thursday",
  });
  assert.equal(L.usualLength([open, ...edge, past(22, "2026-05-07", 200)], open), null);
  // Ten Thursdays: the 8 most recent are 240; the 2 oldest 60 and 600 are left out.
  const ten = Array.from({ length: 10 }, (_, i) =>
    past(30 + i, L.addDays("2026-11-05", -7 * i), i < 8 ? 240 : i === 8 ? 60 : 600),
  );
  assert.deepEqual(plain(L.usualLength([open, ...ten], open)), {
    minutes: 240,
    weekday: "Thursday",
  });
  // Rows on or after the open row's Date are not history.
  assert.equal(
    L.usualLength([open, past(20, TODAY, 200), past(21, TODAY, 200), past(22, TODAY, 200)], open),
    null,
  );
});

test("a Date typed as m/d/yyyy sorts by its day among yyyy-MM-dd dates", () => {
  const typed = (row, date, iso, outBy, minutes = 120) =>
    past(row, date, minutes, outBy, {
      recordedInMs: C(iso, "09:00"),
      statedInMs: C(iso, "09:00"),
    });
  // The typed row is the latest: its check-out decides the notice.
  const missed = (rows) => L.missedSignOut(rows, TOKEN, LAUNCH);
  assert.equal(
    missed([past(2, "2026-11-10", 120, "kiosk"), typed(3, "11/12/2026", TODAY, "EM")]),
    true,
  );
  assert.equal(
    missed([past(2, "2026-11-10", 120, "auto-close"), typed(3, "11/12/2026", TODAY, "kiosk")]),
    false,
  );
  // The most recent Thursday is typed; it is one of the 8 most recent, and the oldest isn't.
  const open = tapped(2, TODAY, "09:00");
  const lengths = [200, 200, 200, 260, 200, 260, 260, 200, 260];
  const rows = lengths.map((m, i) => {
    const date = L.addDays("2026-11-05", -7 * i);
    return i === 0 ? typed(30, "11/5/2026", date, "kiosk", m) : past(30 + i, date, m);
  });
  assert.deepEqual(plain(L.usualLength([open, ...rows], open)), {
    minutes: 200,
    weekday: "Thursday",
  });
});

// ENCM's Shifts tab layout: A "Shifts" (the weekday), B "Shift Schedule" (a label), D
// "Start", E "Finish". Invented windows; times as sheet times (a Date on 1899-12-30) and
// as text.
const sheetTime = (hhmm) => new Date(timeOnDate("1899-12-30", hhmm).ms);
const SHIFTS_FIXTURE = [
  ["Volunteer shift schedule", "", "", "", ""],
  ["Shifts", "Shift Schedule", "Lead", "Start", "Finish"],
  ["Monday", "Morning pantry", "", sheetTime("09:00"), sheetTime("13:00")],
  ["Thursday", "Morning pantry", "", sheetTime("09:00"), sheetTime("13:00")],
  ["thu", "Afternoon pantry", "", "12:00 PM", "4:00 PM"],
  ["Thursday", "Evening stock", "", "9 PM", "2am"],
  ["Thursday", "No finish yet", "", "6:00 PM", ""],
  ["", "Notes row", "", "", ""],
  ["Holiday", "Closed", "", "9:00 AM", "1:00 PM"],
];
const SHIFTS_READ = { text: READ.text, clock: (v) => READ.time(v).clock };

test("shiftsTabWindows reads ENCM's layout by header, sheet times and text alike", () => {
  const read = plain(L.shiftsTabWindows(SHIFTS_FIXTURE, SHIFTS_READ));
  assert.equal(read.problem, "");
  assert.deepEqual(read.windows, [
    { weekday: "Monday", start: "09:00", finish: "13:00" },
    { weekday: "Thursday", start: "09:00", finish: "13:00" },
    { weekday: "Thursday", start: "12:00", finish: "16:00" },
    { weekday: "Thursday", start: "21:00", finish: "02:00" },
  ]);
  // Columns in another order read the same.
  const moved = SHIFTS_FIXTURE.map((r) => [r[4], r[3], r[2], r[1], r[0]]);
  assert.deepEqual(plain(L.shiftsTabWindows(moved, SHIFTS_READ)).windows, read.windows);
  // No Finish header: no windows, and a line for the log.
  const noFinish = SHIFTS_FIXTURE.map((r) => r.slice(0, 4));
  const missing = plain(L.shiftsTabWindows(noFinish, SHIFTS_READ));
  assert.deepEqual(missing.windows, []);
  assert.match(missing.problem, /no header row with Shifts, Start and Finish/);
  assert.match(plain(L.shiftsTabWindows([], SHIFTS_READ)).problem, /no header row/);
});

test("matchShiftsWindow: an early tap, an overnight Finish, the nearest Start and a tie", () => {
  const windows = plain(L.shiftsTabWindows(SHIFTS_FIXTURE, SHIFTS_READ)).windows;
  const match = (hhmm, list = windows) =>
    plain(L.matchShiftsWindow(list, TODAY, C(TODAY, hhmm), timeOnDate));
  // Up to 30 minutes early still matches.
  assert.equal(match("08:30").finishMs, C(TODAY, "13:00"));
  assert.equal(match("08:29"), null);
  // Before Finish, not at it.
  assert.equal(match("15:59").finishMs, C(TODAY, "16:00"));
  assert.equal(match("16:00"), null);
  // The nearest Start: 11:50 is 10 minutes from 12:00 and 170 from 9:00.
  assert.deepEqual(match("11:50"), {
    startMs: C(TODAY, "12:00"),
    finishMs: C(TODAY, "16:00"),
    start: "12:00",
  });
  // A Finish not after its Start is on the next day.
  assert.equal(match("21:10").finishMs, C("2026-11-13", "02:00"));
  // Equally near two Starts: the later Start wins.
  const tie = [
    { weekday: "Thursday", start: "09:00", finish: "13:00" },
    { weekday: "Thursday", start: "10:00", finish: "14:00" },
  ];
  assert.equal(match("09:30", tie).start, "10:00");
  // Another weekday's windows don't match.
  assert.equal(
    L.matchShiftsWindow(windows, "2026-11-10", C("2026-11-10", "09:00"), timeOnDate),
    null,
  );
  assert.equal(L.matchShiftsWindow([], TODAY, C(TODAY, "09:00"), timeOnDate), null);
});

test("autoClockOutGuess: usual length, then Shifts Finish, then arrival + 3 h, never outside floor and limit", () => {
  const windows = plain(L.shiftsTabWindows(SHIFTS_FIXTURE, SHIFTS_READ)).windows;
  const run = C("2026-11-13", "04:00");
  const guess = (row, others = [], list = windows) =>
    plain(L.autoClockOutGuess([row, ...others], row, run, list, READ));
  const open = tapped(2, TODAY, "09:00");
  const history = [200, 210, 220].map((m, i) => past(20 + i, THURSDAYS[i], m));
  assert.deepEqual(guess(open, history), {
    ms: C(TODAY, "12:30"),
    source: "usual",
    weekday: "Thursday",
  });
  assert.deepEqual(guess(open), {
    ms: C(TODAY, "13:00"),
    source: "shifts",
    windowStart: "09:00",
  });
  assert.deepEqual(guess(open, [], []), { ms: C(TODAY, "12:00"), source: "arrival" });
  // A 19:15 tap stating 07:00: the usual length, the 7:00 window's Finish and arrival + 3 h
  // all fall before the tap, so the guess is the tap.
  const late = tapped(3, TODAY, "19:15", "07:00");
  const early = [{ weekday: "Thursday", start: "07:00", finish: "11:00" }];
  assert.deepEqual(guess(late, history, early), { ms: C(TODAY, "19:15"), source: "tap" });
  // A next row caps the guess.
  const next = tapped(4, TODAY, "11:00", "11:00", { status: "closed", outBy: "kiosk" });
  assert.deepEqual(guess(open, [next], []), { ms: C(TODAY, "11:00"), source: "next" });
  // And wins when it starts before the tap.
  const before = tapped(5, TODAY, "12:00", "12:00", { status: "closed" });
  assert.deepEqual(guess(late, [before], []), { ms: C(TODAY, "12:00"), source: "next" });
  // A usual length that runs past the next row is skipped for the Finish, if that fits.
  const tenAm = tapped(6, TODAY, "13:00", "13:00", { status: "closed" });
  const long = [500, 500, 500].map((m, i) => past(30 + i, THURSDAYS[i], m));
  assert.deepEqual(guess(open, [...long, tenAm]), {
    ms: C(TODAY, "13:00"),
    source: "shifts",
    windowStart: "09:00",
  });
  // Never in the future: an evening row caught by an early run gets the run's time.
  const evening = tapped(7, TODAY, "23:00");
  const soon = plain(L.autoClockOutGuess([evening], evening, C("2026-11-13", "01:00"), [], READ));
  assert.deepEqual(soon, { ms: C("2026-11-13", "01:00"), source: "run" });
  // Other volunteers' rows don't cap it.
  assert.deepEqual(guess(open, [{ ...next, token: OTHER_TOKEN }], []), {
    ms: C(TODAY, "12:00"),
    source: "arrival",
  });
});

test("autoClockOutAlert names where the time came from, with the weekday when it is another day", () => {
  const row = tapped(2, TODAY, "21:10");
  const alert = (guess) => L.autoClockOutAlert(row, guess, READ);
  assert.equal(
    alert({ ms: C(TODAY, "13:30"), source: "usual", weekday: "Thursday" }),
    "auto clock-out at 1:30 PM, usual Thursday length",
  );
  assert.equal(
    alert({ ms: C("2026-11-13", "02:00"), source: "shifts", windowStart: "21:00" }),
    "auto clock-out at Friday 2:00 AM, Finish of the 9:00 PM Shifts window",
  );
  assert.equal(
    alert({ ms: C(TODAY, "12:00"), source: "arrival" }),
    "auto clock-out at 12:00 PM, arrival + 3 h",
  );
  assert.equal(
    alert({ ms: C(TODAY, "00:15"), source: "tap" }),
    "auto clock-out at 12:15 AM, time of the check-in tap",
  );
  assert.equal(
    alert({ ms: C(TODAY, "11:00"), source: "next" }),
    "auto clock-out at 11:00 AM, start of the next shift",
  );
  assert.equal(
    alert({ ms: C("2026-11-13", "04:00"), source: "run" }),
    "auto clock-out at Friday 4:00 AM, time of this run",
  );
});

test("autoClockOutCells close the row with the guess, blank recorded cells and the alert", () => {
  const row = tapped(2, TODAY, "21:10", "21:00", { alerts: "staff note" });
  const guess = { ms: C("2026-11-13", "02:00"), source: "shifts", windowStart: "21:00" };
  const cells = plain(L.autoClockOutCells(row, guess, "the alert", "new-id"));
  assert.deepEqual(cells, {
    [H.recordedOut]: "",
    [H.statedOut]: C("2026-11-13", "02:00"),
    [H.recordedHours]: "",
    [H.statedHours]: 5,
    [H.alerts]: "staff note; the alert",
    [H.status]: "closed",
    [H.outBy]: "auto-close",
  });
  // A row with no Shift ID gets the new one.
  const noId = plain(L.autoClockOutCells({ ...row, shiftId: "" }, guess, "a", "new-id"));
  assert.equal(noId[H.shiftId], "new-id");
  assert.equal(L.entrySource(cells[H.outBy]), "other");
  // Every key is a Log header.
  assert.doesNotThrow(() => L.cellWrites(cells, L.logColumns(LOG_HEADERS)));
  // A skipped row keeps its Status and gets the alert, and a Shift ID when it has none.
  assert.deepEqual(plain(L.autoClockOutSkipCells({ ...row, shiftId: "" }, "new-id")), {
    [H.alerts]: "staff note; auto clock-out skipped: check-in time unreadable",
    [H.shiftId]: "new-id",
  });
  assert.deepEqual(plain(L.autoClockOutSkipCells(row, "new-id")), {
    [H.alerts]: "staff note; auto clock-out skipped: check-in time unreadable",
  });
  assert.deepEqual(plain(L.autoClockOutFlagBase({ ...row, shiftId: "" }, "new-id", 5)), {
    date: TODAY,
    name: "Sam Lee",
    shiftId: "new-id",
    raisedAtMs: 5,
    source: "auto-close",
    logRow: 2,
  });
});

test("dailyJobs lists the hourly email, the 4 AM auto clock-out and the 5 AM Hours refresh", () => {
  assert.deepEqual(plain(L.dailyJobs()), [
    { handler: "runFlagsEmail", everyHours: 1 },
    { handler: "runAutoClockOut", atHour: 4 },
    { handler: "runHoursRefresh", atHour: 5 },
  ]);
  assert.equal(L.flagSources().autoClose, "auto-close");
  assert.equal(L.weekdayFromText("TUE"), "Tuesday");
  assert.equal(L.weekdayFromText("Tues"), "");
  assert.equal(L.parseWeekdaySetting("Tues"), "Monday");
});

// ---------------------------------------------------------------------------
// Deciding on the tapped volunteer's rows alone

/** A seeded generator (mulberry32), so a failing case can be run again from its seed. */
const seeded = (seed) => {
  let state = seed >>> 0;
  const rnd = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  return { rnd, pick };
};
/** JSON that keeps NaN and Infinity apart from null, for comparing decisions. */
const exact = (x) =>
  JSON.stringify(x, (_, v) => (typeof v === "number" && !Number.isFinite(v) ? String(v) : v));

test("the token filter keeps exactly the rows isTokenRow keeps", () => {
  const SEED = 4211;
  const { rnd, pick } = seeded(SEED);
  const cells = [
    "tok-1",
    " tok-1",
    "tok-1 ",
    "TOK-1",
    "tok-2",
    "",
    "   ",
    null,
    undefined,
    1234,
    0,
    false,
    T("08:00"),
    "2026-11-12",
  ];
  const tokens = [
    "tok-1",
    " tok-1 ",
    "TOK-1",
    "tok-2",
    "",
    "  ",
    null,
    undefined,
    "1234",
    1234,
    "0",
  ];
  for (const header of [LOG_HEADERS, SHUFFLED]) {
    const cols = L.logColumns(header);
    for (let k = 0; k < 500; k++) {
      const row = closedRow(header, { "User Token": pick(cells) });
      if (rnd() < 0.3) row[cols[H.status]] = pick(["open", "", "Closed "]);
      const token = pick(tokens);
      const entry = L.logEntry(row, 2, cols, READ);
      assert.equal(
        L.logRowHasToken(row, cols, token, READ),
        L.isTokenRow(entry, token),
        "seed " +
          SEED +
          ", case " +
          k +
          ": cell " +
          String(row[cols[H.token]]) +
          ", token " +
          token,
      );
    }
  }
  // A blank token keeps no row, a blank token cell included.
  const cols = L.logColumns(LOG_HEADERS);
  for (const token of ["", " ", null, undefined]) {
    assert.equal(
      L.logRowHasToken(closedRow(LOG_HEADERS, { "User Token": "" }), cols, token, READ),
      false,
    );
    assert.equal(L.logRowHasToken(closedRow(LOG_HEADERS), cols, token, READ), false);
  }
  // A padded cell matches its trimmed token, as logEntry trims it; case still counts.
  assert.equal(
    L.logRowHasToken(closedRow(LOG_HEADERS, { "User Token": " tok-1 " }), cols, "tok-1", READ),
    true,
  );
  assert.equal(L.logRowHasToken(closedRow(LOG_HEADERS), cols, "TOK-1", READ), false);
});

test("decisions on the volunteer's own rows equal decisions on the whole Log", () => {
  const SEED = 20261113;
  const CASES = 3000;
  const { rnd, pick } = seeded(SEED);
  const DAY_MS = 24 * HOUR;
  const vol = (id, first, last, phone, start, check, token) => ({
    id,
    firstName: first,
    lastName: last,
    phoneLast4: phone,
    startDate: start,
    needsPhoneCheck: check,
    token,
    row: 2,
  });
  // A same-name group of three (one with no usable phone), a padded token, a token that is
  // another's lower-cased, a blank token, and a volunteer who started after launch.
  const volunteers = [
    vol("a", "Ann", "Lee", "1111", "2026-01-01", true, "TOK-A"),
    vol("b", "Ann", "Lee", "2222", "2026-12-01", true, "TOK-B"),
    vol("b2", "ann", "LEE", "", "2026-03-01", true, "TOK-B2"),
    vol("c", "Bo", "Ng", "", "", false, "TOK-C"),
    vol("d", "Cy", "Ox", "", "2025-05-05", false, " TOK-D "),
    vol("e", "Di", "Po", "", "2026-11-01", false, "tok-a"),
    vol("f", "Ed", "Qu", "", "2026-02-02", false, ""),
    vol("g", "Fay", "Ruiz", "", "2026-11-12", false, "TOK-G"),
  ];
  const rowTokens = [
    "TOK-A",
    "TOK-A",
    "TOK-B",
    "TOK-B2",
    "TOK-C",
    "TOK-D",
    " TOK-D",
    "TOK-A ",
    "tok-a",
    "TOK-G",
    "",
    "OTHER",
    4321,
  ];
  const mdy = (date) => {
    const [y, m, d] = date.split("-");
    return +m + "/" + +d + "/" + y;
  };
  const layouts = [LOG_HEADERS, SHUFFLED].map((header) => ({
    header,
    cols: L.logColumns(header),
  }));
  // "7:30 AM" typed into a cell: Sheets keeps it on 1899-12-30.
  const TYPED = typedTime("07:30");
  const tally = {};
  const count = (key) => (tally[key] = (tally[key] || 0) + 1);

  for (let k = 0; k < CASES; k++) {
    const { header, cols } = pick(layouts);
    const fill = (byKey) => {
      const cells = header.map(() => "");
      for (const [key, value] of Object.entries(byKey)) cells[cols[key]] = value;
      return cells;
    };
    const nowMs = pick([NOW, NOW, NOW + 15 * HOUR, NOW - 9 * HOUR]);
    const today = centralDate(new Date(nowMs));
    const tapped = rnd() < 0.05 ? "nobody" : pick(volunteers).id;
    const digits = pick([null, null, "", "1111", "2222", "9999", "22-22"]);
    // The tapped volunteer's token, often, so they have rows to decide on.
    const own = (volunteers.find((v) => v.id === tapped) || {}).token;
    const n = rnd() < 0.05 ? 0 : 1 + Math.floor(rnd() * 60);
    const rows = [];
    for (let i = 0; i < n; i++) {
      const daysBack = rnd() < 0.5 ? Math.floor(rnd() * 3) : Math.floor(rnd() * 60);
      const inMs =
        nowMs - daysBack * DAY_MS - Math.floor(rnd() * 16) * HOUR - Math.floor(rnd() * 60) * MIN;
      const date = centralDate(new Date(inMs));
      const status = pick(["open", "open", "closed", "closed", "Closed ", "OPEN", "", "void"]);
      const closed = !/open/i.test(status);
      rows.push(
        fill({
          [H.shiftId]: "s" + i,
          [H.token]: rnd() < 0.3 && own !== undefined ? own : pick(rowTokens),
          [H.status]: status,
          [H.date]: pick([date, date, date, mdy(date), new Date(inMs), "", "bad"]),
          [H.name]: "Name " + i,
          [H.recordedIn]: pick([new Date(inMs), new Date(inMs), "", "9:15 AM"]),
          [H.statedIn]: pick([
            new Date(inMs - 10 * MIN),
            new Date(inMs - 10 * MIN),
            "",
            "8:00",
            TYPED,
            new Date(inMs - 30 * HOUR),
          ]),
          [H.statedOut]: closed ? pick([new Date(inMs + 3 * HOUR), ""]) : "",
          [H.statedHours]: closed ? pick([3, 3, "2.5", 0.25, 9, "", -1, "abc"]) : "",
          [H.alerts]: pick(["", "", "staff note"]),
          [H.inBy]: "kiosk",
          [H.outBy]: closed ? pick(["kiosk", "kiosk", "auto-close", "", "JP", "Kiosk"]) : "",
        }),
      );
    }
    const all = rows.map((cells, i) => L.logEntry(cells, i + 2, cols, READ));
    const base = {
      volunteers,
      id: tapped,
      digits,
      todayDate: today,
      nowMs,
      windowMs: pick([1, 10, 12, 12, 24]) * HOUR,
      flagMinutes: pick([15, 5]),
      launchDate: pick(["2026-10-01", "2026-11-11", today, "", "bad", "11/01/2026"]),
    };
    const arrivedMs = pick([
      null,
      null,
      nowMs - HOUR,
      nowMs - 20 * MIN,
      nowMs + HOUR,
      nowMs - 30 * HOUR,
    ]);
    const outMs = pick([
      null,
      null,
      nowMs - 30 * MIN,
      nowMs - 2 * HOUR,
      nowMs + HOUR,
      nowMs - 20 * HOUR,
    ]);
    const inArgs = {
      ...base,
      arrivedMs,
      arrivedDate: arrivedMs === null ? "" : centralDate(new Date(arrivedMs)),
    };
    const outArgs = {
      ...base,
      outMs,
      outDate: outMs === null ? "" : centralDate(new Date(outMs)),
      longShiftHours: pick([8, 2]),
    };
    const where =
      "seed " +
      SEED +
      ", case " +
      k +
      ": " +
      exact({
        tapped,
        digits,
        rows: n,
        nowMs,
        windowMs: base.windowMs,
        launch: base.launchDate,
        arrivedMs,
        outMs,
      });

    const wholeIn = L.decideCheckIn({ ...inArgs, entries: all });
    const wholeOut = L.decideCheckOut({ ...outArgs, entries: all });
    const who = L.resolveVolunteer(volunteers, tapped, digits);
    if (who.refusal) {
      // The kiosk returns this refusal before it reads the Log.
      assert.equal(exact(wholeIn), exact({ refusal: who.refusal }), where);
      count(who.refusal);
    } else {
      const token = who.volunteer.token;
      const own_ = all.filter((_, i) => L.logRowHasToken(rows[i], cols, token, READ));
      assert.equal(exact(own_), exact(all.filter((e) => L.isTokenRow(e, token))), where);
      assert.equal(exact(L.decideCheckIn({ ...inArgs, entries: own_ })), exact(wholeIn), where);
      if (who.volunteer.id !== tapped) count("another member");
      count("in: " + (wholeIn.refusal || (wholeIn.missedSignOut ? "ok, missed sign-out" : "ok")));
    }
    // A check-out reads the rows of the tokens checkOutTokens names: the tapped member's
    // whole name when it sends no digits for a same-name group, else the one volunteer's.
    const t = L.checkOutTokens(volunteers, tapped, digits);
    if (t.refusal) {
      // The kiosk returns this refusal before it reads the Log.
      assert.equal(exact(wholeOut), exact({ refusal: t.refusal }), where);
      continue;
    }
    const read_ = all.filter((_, i) =>
      t.tokens.some((token) => L.logRowHasToken(rows[i], cols, token, READ)),
    );
    assert.equal(exact(L.decideCheckOut({ ...outArgs, entries: read_ })), exact(wholeOut), where);
    const tappedVol = volunteers.find((v) => v.id === tapped);
    if (tappedVol.needsPhoneCheck && !String(digits ?? "").replace(/\D/g, "")) {
      const blank = {
        PHONE_NEEDED: "PHONE_NEEDED, another in",
        PHONE_MISSING: "PHONE_MISSING, no digits",
        NOT_IN: "NOT_IN, none of the name in",
      };
      count(
        "out: " +
          (wholeOut.refusal
            ? blank[wholeOut.refusal] || wholeOut.refusal + ", no digits"
            : "ok, no digits"),
      );
      // The rule's answers, against the Log itself.
      const inNow = volunteers.filter(
        (v) =>
          v.needsPhoneCheck &&
          L.volunteerNameKey(v) === L.volunteerNameKey(tappedVol) &&
          L.findOpenShift(all, v.token, nowMs, base.windowMs, today),
      );
      if (!inNow.length) assert.equal(wholeOut.refusal, "NOT_IN", where);
      else if (inNow.length === 1 && inNow[0].id === tapped) {
        assert.notEqual(wholeOut.refusal, "PHONE_NEEDED", where);
        assert.notEqual(wholeOut.refusal, "PHONE_MISSING", where);
        assert.notEqual(wholeOut.refusal, "NOT_IN", where);
      } else {
        assert.equal(
          wholeOut.refusal,
          tappedVol.phoneLast4 ? "PHONE_NEEDED" : "PHONE_MISSING",
          where,
        );
      }
    } else {
      count("out: " + (wholeOut.refusal || (wholeOut.milestone ? "ok, milestone" : "ok")));
    }
  }
  // The cases reach every path the decisions have.
  for (const key of [
    "NOT_FOUND",
    "PHONE_NEEDED",
    "PHONE_WRONG",
    "PHONE_MISSING",
    "another member",
    "in: ok",
    "in: ok, missed sign-out",
    "in: ALREADY_IN",
    "in: ARRIVAL_FUTURE",
    "in: ARRIVAL_OTHER_DAY",
    "out: ok",
    "out: ok, milestone",
    "out: NOT_IN",
    "out: ok, no digits",
    "out: PHONE_NEEDED, another in",
    "out: PHONE_MISSING, no digits",
    "out: NOT_IN, none of the name in",
  ]) {
    assert.ok(tally[key] > 0, "no case reached " + key + ": " + exact(tally));
  }
});
