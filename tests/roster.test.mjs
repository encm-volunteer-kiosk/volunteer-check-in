// Tests for the volunteer list's columns, as Settings' Roster column rows map them, in
// apps-script/Logic.js: which columns parseProfiles reads, a list with one column for the
// whole name, the Profiles cache key, the admin picker's order, the Email column Email
// hours reads, the import's name key, Fill in missing IDs and the blank Kiosk launch date.
// Every name here is made up.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import vm from "node:vm";
import { personName } from "../src/names.ts";
import { rankNames } from "../src/nameSearch.ts";
import { nameKey as sameNameKey } from "../src/sameName.ts";

const read = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");
const L = {};
vm.runInNewContext(read("apps-script/Brand.js") + "\n" + read("apps-script/Logic.js"), L);
const plain = (x) => JSON.parse(JSON.stringify(x));
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

const BLANK = {
  firstName: "",
  lastName: "",
  fullName: "",
  phone: "",
  email: "",
  startDate: "",
  token: "",
};
const mapped = (rows) => ({ ...BLANK, ...rows });
const settingsWith = (rows) => {
  const names = L.rosterColumnSettings();
  const out = {};
  Object.entries(rows).forEach(([key, value]) => (out[names[key]] = value));
  return out;
};

// A list with its own headers, in another order, with first and last name columns.
const OWN_HEADER = ["Given", "Family", "Mobile", "E-mail", "Joined", "Member ID"];
const OWN_MAPPING = mapped({
  firstName: "given",
  lastName: " FAMILY ",
  phone: "Mobile",
  email: "E-mail",
  startDate: "Joined",
  token: "Member  ID",
});
const KIOSK_HEADER = [
  "Volunteer First Name",
  "Volunteer Last Name",
  "Volunteer Phone",
  "Email",
  "Start Date mm/dd/yyyy",
  "User Token",
];
// A list with one column for the whole name.
const FULL_HEADER = ["Name", "Phone", "Email", "Start", "ID"];
const FULL_MAPPING = mapped({
  fullName: "Name",
  phone: "Phone",
  email: "Email",
  startDate: "Start",
  token: "ID",
});

test("rosterColumnMapping reads each Roster column row trimmed, blank when missing", () => {
  assert.deepEqual(plain(L.rosterColumnMapping({})), BLANK);
  assert.deepEqual(
    plain(L.rosterColumnMapping(settingsWith({ fullName: "  Name ", token: "ID" }))),
    mapped({ fullName: "Name", token: "ID" }),
  );
});

test("blank Roster column rows read the kiosk's own headers, as with no mapping", () => {
  const rows = [
    ["Ana", "Diaz", "555-0101", "ana@example.org", "2026-01-05", "tok-ana"],
    ["Ben", "", "555-0102", "", "", "tok-ben"],
  ];
  assert.deepEqual(
    plain(L.parseProfiles(KIOSK_HEADER, rows, sha256, BLANK)),
    plain(L.parseProfiles(KIOSK_HEADER, rows, sha256)),
  );
  // A missing column's message is the one without a mapping, byte for byte.
  for (const at of [0, 1, 2, 4]) {
    const header = KIOSK_HEADER.filter((_, i) => i !== at);
    const without = (() => {
      try {
        L.parseProfiles(header, [], sha256);
      } catch (e) {
        return e.message;
      }
    })();
    assert.throws(() => L.parseProfiles(header, [], sha256, BLANK), { message: without });
  }
});

test("filled Roster column rows are the only headers looked for, spacing and capitals aside", () => {
  const rows = [["Ana", "Diaz", "555-0101", "ana@example.org", "2026-01-05", "m-1"]];
  const parsed = plain(L.parseProfiles(OWN_HEADER, rows, sha256, OWN_MAPPING));
  assert.deepEqual(parsed.problems, []);
  assert.equal(parsed.volunteers.length, 1);
  assert.deepEqual(
    [parsed.volunteers[0].firstName, parsed.volunteers[0].lastName, parsed.volunteers[0].token],
    ["Ana", "Diaz", "m-1"],
  );
  assert.equal(parsed.volunteers[0].phoneLast4, "0101");
  assert.equal(parsed.volunteers[0].startDate, "2026-01-05");
  // The kiosk's own header isn't read when a row names another.
  assert.throws(() => L.parseProfiles(KIOSK_HEADER, rows, sha256, mapped({ phone: "Mobile" })), {
    message:
      'Volunteer Profiles has no "Mobile" column, the header Settings Roster column: phone names.',
  });
  // A mapped ID column is read even with a User Token column beside it.
  const both = [...OWN_HEADER, "User Token"];
  const withToken = plain(L.parseProfiles(both, [[...rows[0], "other"]], sha256, OWN_MAPPING));
  assert.equal(withToken.volunteers[0].token, "m-1");
  assert.throws(() => L.parseProfiles(KIOSK_HEADER, rows, sha256, mapped({ token: "Member ID" })), {
    message:
      'Volunteer Profiles has no "Member ID" column, the header Settings Roster column: ID names.',
  });
});

test("a full-name row beside a first or last name row stops the list, naming the three rows", () => {
  const message =
    "Settings Roster column: full name is filled, so Roster column: first name and Roster column: last name must be blank.";
  for (const extra of [{ firstName: "Given" }, { lastName: "Family" }]) {
    assert.throws(() => L.parseProfiles(FULL_HEADER, [], sha256, { ...FULL_MAPPING, ...extra }), {
      message,
    });
  }
});

test("a whole-name list: the first word greets, the whole name shows, a one-word name has no trailing space", () => {
  const rows = [
    ["  Mary   Ann  Smith ", "555-0101", "", "", "t-1"],
    ["Madonna", "555-0102", "", "", "t-2"],
    ["", "555-0103", "", "", "t-3"],
    ["Prince", "555-0104", "", "", ""],
  ];
  const parsed = plain(L.parseProfiles(FULL_HEADER, rows, sha256, FULL_MAPPING));
  const [mary, madonna] = parsed.volunteers;
  assert.equal(parsed.volunteers.length, 2);
  assert.deepEqual([mary.firstName, mary.lastName], ["Mary", "Ann Smith"]);
  assert.deepEqual([madonna.firstName, madonna.lastName], ["Madonna", ""]);
  assert.equal(L.volunteerFullName(mary), "Mary Ann Smith");
  assert.equal(L.volunteerFullName(madonna), "Madonna");
  assert.equal(personName(mary), "Mary Ann Smith");
  assert.equal(personName(madonna), "Madonna");
  // A row with a name and no ID is a problem line with the whole name; a row with no name
  // is skipped.
  assert.deepEqual(parsed.problems, [{ row: 5, text: "row 5: Prince has no User Token" }]);
  // The Log's Name cell has no trailing space either.
  const cells = plain(L.checkInCells({ ...madonna, token: "t-2" }, "2026-11-12", 1, 1, "", "s-1"));
  assert.equal(cells[L.logHeaderNames().name], "Madonna");
});

test("with first and last name columns, the Name cell and labels are as before", () => {
  assert.equal(L.volunteerFullName({ firstName: "Ana", lastName: "Diaz" }), "Ana Diaz");
  assert.equal(
    L.volunteerFullName({ firstName: " Ana ", lastName: " de la Cruz " }),
    "Ana de la Cruz",
  );
  assert.equal(personName({ firstName: "Ana", lastName: "Diaz" }), "Ana Diaz");
});

test("whole names that differ only in spacing and case are one name, on the server and the page", () => {
  const rows = [
    ["Mary Ann Smith", "555-0101", "", "", "t-1"],
    ["mary  ann SMITH", "555-0199", "", "", "t-2"],
    ["Mary Smith", "555-0101", "", "", "t-3"],
  ];
  const parsed = plain(L.parseProfiles(FULL_HEADER, rows, sha256, FULL_MAPPING));
  const [a, b, c] = parsed.volunteers;
  assert.equal(L.volunteerNameKey(a), L.volunteerNameKey(b));
  assert.notEqual(L.volunteerNameKey(a), L.volunteerNameKey(c));
  assert.deepEqual([a.needsPhoneCheck, b.needsPhoneCheck, c.needsPhoneCheck], [true, true, false]);
  assert.equal(sameNameKey(a), sameNameKey(b));
  assert.notEqual(sameNameKey(a), sameNameKey(c));
});

test("the tablet's search finds a whole name by any of its words, and a one-word name", () => {
  const people = [
    { firstName: "Mary", lastName: "Ann Smith" },
    { firstName: "Madonna", lastName: "" },
  ];
  assert.deepEqual(rankNames(people, "smith"), [people[0]]);
  assert.deepEqual(rankNames(people, "ann"), [people[0]]);
  assert.deepEqual(rankNames(people, "madonna"), [people[1]]);
  assert.deepEqual(rankNames(people, "maryannsmith"), [people[0]]);
});

test("the Profiles cache key is the file and tab alone with every row blank, and carries filled rows", () => {
  const base = "profiles:v" + L.profilesCacheVersion() + ":file-1:Volunteer Profiles";
  assert.equal(L.profilesCacheKey("file-1", "Volunteer Profiles"), base);
  assert.equal(L.profilesCacheKey("file-1", "Volunteer Profiles", BLANK), base);
  const one = L.profilesCacheKey("file-1", "Volunteer Profiles", mapped({ phone: "Mobile" }));
  const two = L.profilesCacheKey("file-1", "Volunteer Profiles", mapped({ email: "Mobile" }));
  assert.ok(one.startsWith(base + ":"));
  assert.notEqual(one, two);
  assert.notEqual(L.profilesCacheKey("file-1", "Volunteer Profiles", FULL_MAPPING), one);
  // This spreadsheet's own tab (a blank file ID) has a key of its own.
  assert.equal(
    L.profilesCacheKey("", "Volunteer Profiles"),
    "profiles:v" + L.profilesCacheVersion() + "::Volunteer Profiles",
  );
});

test("the admin picker sorts a whole-name list by the name as written, and first/last lists by last name", () => {
  const people = [
    { id: "1", firstName: "Zoe", lastName: "Adams", row: 2 },
    { id: "2", firstName: "Adam", lastName: "Zane", row: 3 },
    { id: "3", firstName: "Madonna", lastName: "", row: 4 },
  ];
  assert.deepEqual(
    plain(L.adminRosterLabels(people)).map((v) => v.label),
    ["Madonna", "Zoe Adams", "Adam Zane"],
  );
  assert.deepEqual(
    plain(L.adminRosterLabels(people, true)).map((v) => v.label),
    ["Adam Zane", "Madonna", "Zoe Adams"],
  );
});

test("Email hours reads the email and ID columns the rows name; a missing mapped column names its row", () => {
  const v = { id: "v1", token: "m-1" };
  const rows = [["Ana", "Diaz", "", "ana@example.org", "", "m-1"]];
  const found = plain(L.profileEmailsFrom(OWN_HEADER, rows, [v], OWN_MAPPING));
  assert.deepEqual([found.v1.email, found.v1.problem, found.v1.row], ["ana@example.org", "", 2]);
  // With the email row blank, Email or Email Address, as before.
  const kiosk = plain(
    L.profileEmailsFrom(
      KIOSK_HEADER,
      [["Ana", "Diaz", "", "a@example.org", "", "m-1"]],
      [v],
      BLANK,
    ),
  );
  assert.equal(kiosk.v1.email, "a@example.org");
  const missing = plain(
    L.profileEmailsFrom(
      KIOSK_HEADER,
      [["Ana", "Diaz", "", "a@example.org", "", "m-1"]],
      [v],
      mapped({ email: "Work email" }),
    ),
  );
  assert.equal(missing.v1.problem, "no-email-column");
  assert.equal(
    missing.v1.text,
    'Volunteer Profiles has no "Work email" column, the header Settings Roster column: email names.',
  );
  assert.equal(L.hoursRequestHoldReason("no-email-column", missing.v1), missing.v1.text);
  // Unmapped, the text is as before.
  const none = plain(L.profileEmailsFrom(["User Token"], [["m-1"]], [v], BLANK));
  assert.equal(none.v1.text, "Volunteer Profiles has no Email column.");
  assert.equal(
    L.hoursRequestHoldReason("no-email-column", none.v1),
    "Volunteer Profiles has no Email column.",
  );
});

test("the import keys names as written with first and last columns, and as the list splits them with a whole-name list", () => {
  assert.equal(L.importNameKey("Mary Ann", "Smith"), "mary ann|smith");
  assert.equal(L.importNameKey("Mary Ann", "Smith", false), "mary ann|smith");
  assert.equal(L.importNameKey("Mary Ann", "Smith", true), "mary|ann smith");
  assert.equal(L.importNameKey(" Madonna ", "", true), "madonna|");
  const list = plain(
    L.parseProfiles(FULL_HEADER, [["Mary Ann Smith", "", "", "", "t-1"]], sha256, FULL_MAPPING),
  ).volunteers;
  const plan = (fullNameRoster) =>
    plain(
      L.importPlan({
        header: ["Date", "First name", "Last name", "", "", "Source cell"],
        rows: [["2026-01-05", "Mary Ann", "Smith", 3, "", ""]],
        todayDate: "2026-11-12",
        volunteers: list,
        ledgerKeys: [],
        logShiftIds: [],
        hashFn: sha256,
        fullNameRoster,
      }),
    ).toImport[0];
  const matched = plan(true);
  assert.equal(matched.volunteer.token, "t-1");
  assert.equal(matched.name, "Mary Ann Smith");
  assert.equal(L.importStandInToken(matched.nameKey), "import:mary ann smith");
  // With first and last columns the key, and so the ledger key, is as it always was.
  const asBefore = plan(undefined);
  assert.equal(asBefore.nameKey, "mary ann|smith");
  assert.equal(asBefore.key, "2026-01-05|mary ann|smith|1");
  assert.equal(L.importStandInToken(asBefore.nameKey), "import:mary ann smith");
});

let ids = 0;
const nextId = () => "id-" + ++ids;
const fill = (header, rows, mapping = BLANK) => {
  ids = 0;
  return plain(L.fillIdsPlan(header, rows, mapping, nextId));
};

test("Fill in missing IDs fills blank ID cells on rows with both names, and never a filled cell", () => {
  const plan = fill(KIOSK_HEADER, [
    ["Ana", "Diaz", "", "", "", ""],
    ["Ben", "Ode", "", "", "", "kept"],
    ["Cy", "", "", "", "", ""],
    ["", "", "", "", "", ""],
    ["Di", "Lee", "", "", "", "  "],
  ]);
  assert.deepEqual(plan, {
    header: null,
    writes: [
      { row: 2, column: 6, id: "id-1" },
      { row: 6, column: 6, id: "id-2" },
    ],
  });
  assert.equal(L.fillIdsMessage(plan), "Filled in 2 missing IDs.");
  assert.equal(
    L.fillIdsMessage(fill(KIOSK_HEADER, [["Ben", "Ode", "", "", "", "kept"]])),
    "Every row with a name has an ID already. Nothing was changed.",
  );
});

test("Fill in missing IDs adds a User Token header in the first empty header cell only when the ID row is blank and no token column is there", () => {
  const header = ["Volunteer First Name", "Volunteer Last Name", "", "Notes"];
  const plan = fill(header, [["Ana", "Diaz", "", "x"]]);
  assert.deepEqual(plan, {
    header: { column: 3, text: "User Token" },
    writes: [{ row: 2, column: 3, id: "id-1" }],
  });
  assert.equal(L.fillIdsMessage(plan), 'Filled in 1 missing ID in a new "User Token" column.');
  const full = fill(["Volunteer First Name", "Volunteer Last Name"], [["Ana", "Diaz"]]);
  assert.deepEqual(full.header, { column: 3, text: "User Token" });
  // Onboarding Token is the list's ID column too.
  assert.equal(
    fill(["Volunteer First Name", "Volunteer Last Name", "Onboarding Token"], [["Ana", "Diaz", ""]])
      .writes[0].column,
    3,
  );
  // A filled ID row whose column is missing changes nothing, with the list's message.
  assert.deepEqual(fill(header, [["Ana", "Diaz", "", "x"]], mapped({ token: "Member ID" })), {
    refusal:
      'Volunteer Profiles has no "Member ID" column, the header Settings Roster column: ID names.',
  });
  // Both token columns: the list's own message.
  assert.match(
    fill([...KIOSK_HEADER, "Onboarding Token"], []).refusal,
    /has both an "onboarding token" and a "user token" column/,
  );
  // No name columns: the list's own message.
  assert.deepEqual(fill(["Name"], [["Ana"]]), {
    refusal: 'Volunteer Profiles has no "volunteer first name" column.',
  });
});

test("Fill in missing IDs reads a whole-name list's rows by their name cell, in the mapped columns", () => {
  const plan = fill(
    FULL_HEADER,
    [
      ["Madonna", "", "", "", ""],
      ["", "", "", "", ""],
      ["Mary Ann Smith", "", "", "", "t-9"],
    ],
    FULL_MAPPING,
  );
  assert.deepEqual(plan, { header: null, writes: [{ row: 2, column: 5, id: "id-1" }] });
  assert.match(
    fill(FULL_HEADER, [], { ...FULL_MAPPING, firstName: "Name" }).refusal,
    /Roster column: full name is filled/,
  );
});

test("a blank Kiosk launch date is filled with today; a date, or no row, is left", () => {
  assert.equal(L.launchDateSetting(), "Kiosk launch date");
  assert.equal(L.launchDateToFill({ "Kiosk launch date": "" }, "2026-11-12"), "2026-11-12");
  assert.equal(L.launchDateToFill({ "Kiosk launch date": "  " }, "2026-11-12"), "2026-11-12");
  assert.equal(L.launchDateToFill({ "Kiosk launch date": "2025-06-01" }, "2026-11-12"), "");
  assert.equal(L.launchDateToFill({}, "2026-11-12"), "");
});

test("sample people need this spreadsheet's list and the kiosk's own headers", () => {
  assert.equal(
    L.sampleProfilesRefusal("file-1", BLANK),
    "Settings already names a Volunteer Profiles file; nothing done.",
  );
  assert.match(L.sampleProfilesRefusal("", mapped({ phone: "Mobile" })), /Roster column row/);
  assert.equal(L.sampleProfilesRefusal("", BLANK), "");
  assert.deepEqual(plain(L.peopleTabHeader()).map(L.normalizeHeader), [
    ...Object.values(plain(L.requiredProfileHeaders())).slice(0, 3),
    "email",
    "start date mm/dd/yyyy",
    "user token",
  ]);
});
