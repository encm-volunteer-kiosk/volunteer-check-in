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
  assert.equal(defaults["Profiles problems"], "");
  assert.equal(defaults["Closing time Monday"], "17:00");
  assert.equal(defaults["Closing time Sunday"], "17:00");
  assert.equal(rows.length, 14);
  const names = rows.map((r) => r[0]);
  assert.equal(names.indexOf("Check-out flag minutes"), names.indexOf("Arrival flag minutes") + 1);
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
  assert.equal(
    L.validateCheckOut(NOW, NOW - 24 * HOUR, "2026-11-11", TODAY, start),
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
const centralDate = (d) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
const isDate = (v) => Object.prototype.toString.call(v) === "[object Date]";
const READ = {
  text: (v) => (isDate(v) ? centralDate(v) : L.cellString(v)),
  time: (v) => {
    let ms = NaN;
    if (isDate(v)) ms = v.getTime();
    else if (L.cellString(v)) ms = Date.parse(L.cellString(v));
    return Number.isFinite(ms) ? { ms, date: centralDate(new Date(ms)) } : { ms: NaN, date: "" };
  },
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
  });
  // The same row under the exact header reads the same.
  const exact = plain(L.logEntry(closedRow(LOG_HEADERS), 7, L.logColumns(LOG_HEADERS), READ));
  assert.deepEqual(exact, e);
});

test("logEntry: a time not on the row's Date is unreadable", () => {
  const cols = L.logColumns(LOG_HEADERS);
  // A time typed without a date is stored on 1899-12-30.
  const timeOnly = new Date("1899-12-30T15:00:00Z");
  const cells = closedRow(LOG_HEADERS, {
    "Check-In Stated (user)": timeOnly,
    "Check-Out Stated (user)": T("09:30").getTime() + 24 * HOUR,
    "Check-Out Recorded (timestamp)": new Date(T("10:00").getTime() + 24 * HOUR),
    "Check-In Recorded (timestamp)": "",
  });
  const e = L.logEntry(cells, 3, cols, READ);
  assert.ok(Number.isNaN(e.statedInMs));
  assert.ok(Number.isNaN(e.statedOutMs));
  assert.ok(Number.isNaN(e.recordedOutMs));
  assert.ok(Number.isNaN(e.recordedInMs));
  assert.ok(Number.isNaN(L.shiftStartMs(e)));
  assert.equal(L.hasReadableStart(e), false);
  // With no readable Date, no time on the row is readable.
  const noDate = L.logEntry(closedRow(LOG_HEADERS, { Date: "soon" }), 3, cols, READ);
  assert.ok(Number.isNaN(noDate.recordedInMs));
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
  ...fields,
});

test("findOpenShiftToday matches by token and ignores other days and closed rows", () => {
  const entries = [
    entry(2, { dateText: "2026-11-11" }),
    entry(3, { status: "closed", statedHours: 1 }),
    entry(4, { token: OTHER_TOKEN }),
    entry(5, { token: "" }),
  ];
  assert.equal(L.findOpenShiftToday(entries, TOKEN, TODAY), null);
  assert.equal(L.findOpenShiftToday(entries, "", TODAY), null);
  entries.push(entry(6, { status: " Open " }));
  assert.equal(L.findOpenShiftToday(entries, TOKEN, TODAY).row, 6);
  entries.push(entry(7, { statedInMs: NOW - HOUR }));
  assert.equal(L.findOpenShiftToday(entries, TOKEN, TODAY).row, 7);
  // An unreadable stated arrival falls back to the recorded one.
  entries.push(entry(8, { statedInMs: NaN, recordedInMs: NOW - 30 * MIN }));
  assert.equal(L.findOpenShiftToday(entries, TOKEN, TODAY).row, 8);
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

test("volunteerSummaries gives only today's open arrival and no private fields", () => {
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
    entry(2, { token: OTHER_TOKEN, dateText: "2026-11-11" }),
    entry(3, { statedInMs: NaN, recordedInMs: NOW - HOUR }),
  ];
  assert.deepEqual(plain(L.volunteerSummaries(volunteers, entries, TODAY)), [
    {
      id: ID,
      firstName: "Sam",
      lastName: "Lee",
      openShiftArrival: new Date(NOW - HOUR).toISOString(),
      needsPhoneCheck: true,
    },
    {
      id: "bbbbbbbbbbbbbbbb",
      firstName: "Ruth",
      lastName: "Okafor",
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
      arrivedMs: NOW - 20 * MIN,
      arrivedDate: TODAY,
      flagMinutes: 15,
      ...fields,
    }),
  );

test("decideCheckIn accepts and flags", () => {
  assert.deepEqual(checkIn({}), {
    volunteer: VOL,
    arrivedMs: NOW - 20 * MIN,
    flag: "arrival differs by 20 min",
  });
  assert.deepEqual(checkIn({ arrivedMs: NOW - 5 * MIN }), {
    volunteer: VOL,
    arrivedMs: NOW - 5 * MIN,
    flag: "",
  });
  assert.deepEqual(checkIn({ arrivedMs: NOW + 3 * MIN }), {
    volunteer: VOL,
    arrivedMs: NOW,
    flag: "",
  });
  // No chosen time: arrived is server time and nothing is flagged.
  assert.deepEqual(checkIn({ arrivedMs: null, arrivedDate: "" }), {
    volunteer: VOL,
    arrivedMs: NOW,
    flag: "",
  });
  assert.deepEqual(
    checkIn({ volunteers: [TWIN], digits: "0131" }).flag,
    "arrival differs by 20 min",
  );
  // Yesterday's open row is left for the auto-close and doesn't block today.
  assert.deepEqual(
    checkIn({ entries: [entry(2, { dateText: "2026-11-11" })] }).flag,
    "arrival differs by 20 min",
  );
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
      outMs: null,
      outDate: "",
      flagMinutes: 15,
      launchDate: LAUNCH,
      ...fields,
    }),
  );

test("decideCheckOut closes today's open row at server time and picks the milestone", () => {
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

test("decideCheckOut refuses in order", () => {
  const future = { outMs: NOW + HOUR, outDate: TODAY };
  assert.deepEqual(checkOut({ id: "zzzzzzzzzzzzzzzz", ...future }), { refusal: "NOT_FOUND" });
  assert.deepEqual(checkOut({ volunteers: [TWIN], ...future }), { refusal: "PHONE_NEEDED" });
  assert.deepEqual(checkOut({ volunteers: [TWIN], digits: "0000", ...future }), {
    refusal: "PHONE_WRONG",
  });
  assert.deepEqual(checkOut({ volunteers: [TWIN], digits: "0131" }).row, 9);
  assert.deepEqual(checkOut({ entries: [], ...future }), { refusal: "NOT_IN" });
  assert.deepEqual(checkOut({ entries: [entry(9, { dateText: "2026-11-11" })] }), {
    refusal: "NOT_IN",
  });
  assert.deepEqual(checkOut({ entries: [entry(9, { status: "closed", statedHours: 1 })] }), {
    refusal: "NOT_IN",
  });
  assert.deepEqual(checkOut({ entries: [entry(9, { token: OTHER_TOKEN })] }), {
    refusal: "NOT_IN",
  });
  assert.deepEqual(checkOut({ outMs: NaN, outDate: "" }), { refusal: "CHECKOUT_OTHER_DAY" });
  assert.deepEqual(checkOut(future), { refusal: "CHECKOUT_FUTURE" });
  assert.deepEqual(checkOut({ outMs: NOW - 24 * HOUR, outDate: "2026-11-11" }), {
    refusal: "CHECKOUT_OTHER_DAY",
  });
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

// ---------------------------------------------------------------------------
// Kiosk admin menu
//
// Tests for the admin menu's logic go here, after the kiosk's: initials, roster labels,
// open-shift choices, and the add-a-shift and fix-a-sign-out decisions.

// ---------------------------------------------------------------------------
// Refusals

test("refusal gives each code its exact message", () => {
  const expected = {
    ACCESS: "This kiosk needs to be set up. Please ask a board member.",
    NOT_FOUND: "We couldn't find your profile. Please see a board member.",
    ALREADY_IN: "You're already checked in today.",
    NOT_IN: "You're not checked in today.",
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
