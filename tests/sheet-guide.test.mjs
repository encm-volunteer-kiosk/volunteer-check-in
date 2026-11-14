// Tests for the staff help in apps-script/Logic.js: the Settings tab's What it does
// sentences, the Log and Flags header notes and the rule that decides when the kiosk may
// write one, the How to tab's text, and the Kiosk contact line. Logic.js is loaded as it is; Admin.js and the
// other server files are read as text, so the menu names and the settings the code writes
// are checked against the code itself.
//
// tests/header-notes-shipped.json is a record of every header note text a release has
// written to a live sheet. It is appended after a release, never edited to make a test
// pass: a cell on a live sheet may still carry any text in it, so each one must stay
// known to the kiosk (current, or listed in headerNotePastTexts()).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import vm from "node:vm";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const plain = (x) => JSON.parse(JSON.stringify(x));

const L = {};
vm.runInNewContext(read("apps-script/Logic.js"), L);

const SERVER_FILES = [
  "Admin.js",
  "Api.js",
  "HoursSort.js",
  "Import.js",
  "Jobs.js",
  "Reports.js",
  "Sheets.js",
].map((f) => read("apps-script/" + f));

const values = (o) => Object.values(plain(o));
const logNotes = () => plain(L.logHeaderNotes());
const flagNotes = () => plain(L.flagHeaderNotes());
const currentNoteTexts = () => [...values(L.logHeaderNotes()), ...values(L.flagHeaderNotes())];

// An invented volunteer and Log for the hours email's texts: every warning kind, a paper
// row, a stand-in row and a same-name group, so each text the preview and the email can
// show is built once.
const PAT = {
  id: "pat-id",
  firstName: "Pat",
  lastName: "Example",
  token: "tok-pat",
  row: 2,
  startDate: "2026-02-15",
  needsPhoneCheck: true,
};
const hoursEntry = (row, fields) => ({
  row,
  shiftId: "s-" + row,
  token: "tok-pat",
  name: "Pat Example",
  dateText: "2026-11-02",
  statedInMs: Date.UTC(2026, 10, 2, 15),
  statedOutMs: Date.UTC(2026, 10, 2, 18),
  recordedInMs: NaN,
  statedHoursCell: 3,
  alerts: "",
  status: "closed",
  outBy: "kiosk",
  ...fields,
});
const HOURS_LOG = [
  hoursEntry(2),
  hoursEntry(3, { status: "open", statedHoursCell: "" }),
  hoursEntry(4, { outBy: "auto-close", alerts: "auto clock-out" }),
  hoursEntry(5, { statedHoursCell: "" }),
  hoursEntry(6, { dateText: "11/03/2026" }),
  hoursEntry(7, { token: "tok-old" }),
  hoursEntry(8, { token: "import:pat example", shiftId: "import-1" }),
  hoursEntry(9, { shiftId: "import-2", dateText: "2025-03-01" }),
];

/** Every text the hours email's preview, results and email can show, one line each. */
function hoursEmailTexts() {
  const period = plain(L.hoursEmailPeriod("this", "2026-11-14"));
  const plan = (flags) =>
    L.hoursEmailPlan({
      volunteer: PAT,
      entries: HOURS_LOG,
      flags,
      period,
      todayDate: "2026-11-14",
      listedTokens: ["tok-pat"],
    });
  const flagged = plan([{ shiftId: "s-2", reviewed: false, name: "Pat Example" }]);
  const unread = plan(null);
  const none = L.hoursEmailPlan({
    volunteer: { ...PAT, needsPhoneCheck: false },
    entries: [],
    flags: [],
    period,
    todayDate: "2026-11-14",
    listedTokens: [],
  });
  const noneTicked = L.hoursEmailPlan({
    volunteer: { ...PAT, needsPhoneCheck: false },
    entries: [],
    flags: [],
    period,
    todayDate: "2026-11-14",
    listedTokens: [],
    attach: true,
  });
  const emails = [flagged, none].flatMap((p) =>
    [true, false].map((attach) =>
      L.hoursEmailMessage({
        firstName: "Pat",
        plan: p,
        attach,
        contact: "Pat Example\npat@example.org",
        signature: "Pat Example\nVolunteer desk",
      }),
    ),
  );
  // Last month with no shifts in it, and this month with none yet.
  [
    ["last", "2026-11-03"],
    ["this", "2026-12-03"],
  ].forEach(([choice, today]) => {
    const p = L.hoursEmailPlan({
      volunteer: PAT,
      entries: HOURS_LOG,
      flags: [],
      period: L.hoursEmailPeriod(choice, today),
      todayDate: today,
      listedTokens: ["tok-pat"],
    });
    emails.push(
      L.hoursEmailMessage({
        firstName: "Pat",
        plan: p,
        attach: true,
        contact: "Pat",
        signature: "",
      }),
    );
  });
  const results = plain(L.hoursEmailResults());
  return [
    ...["no-email", "bad-email", "no-email-column", "not-found", "duplicate-token"].map((p) =>
      L.hoursEmailProblemText(p, [2, 5], "pat@example.org, pat2@example.org"),
    ),
    L.hoursEmailContactProblem(),
    L.hoursEmailNoneProblem(),
    L.hoursEmailQuotaProblem(12, 3),
    L.hoursEmailQuotaProblem(1, 0),
    ...[
      ...plain(flagged.warnings),
      ...plain(unread.warnings),
      ...plain(none.warnings),
      ...plain(noneTicked.warnings),
    ].map((w) => w.text),
    ...plain(L.hoursEmailTotalLines(flagged)),
    L.hoursEmailFromLine("staff@example.org"),
    ...Object.values(results),
    L.refusal("HOURS_EMAIL_STALE").message,
    L.refusal("HOURS_EMAIL_TOO_MANY").message,
    L.hoursEmailProtectionDescription(),
    ...emails.flatMap((m) => [m.subject, ...m.body.split("\n").map((line) => line.trim())]),
  ];
}

/**
 * Every text staff read: How to rows, Settings sentences and lines, header notes, warnings,
 * and the hours email's texts. The contact cell's text is "" (it is a formula), so its two
 * texts stand in for it, the prefix with an example contact after it.
 */
function staffTexts() {
  const contact = plain(L.howToContactTexts());
  return [
    ...plain(L.howToRows()).map((r) => r.text),
    contact.blank,
    contact.prefix + "Pat Example",
    L.kioskContactNote("Pat Example"),
    ...values(L.settingsDescriptions()),
    L.settingsDescriptionHeader(),
    ...plain(L.settingsDescriptionColumn(["Kiosk access code", "Kiosk access code", "nope"])),
    L.settingsDescriptionProtection(),
    L.howToProtectionDescription(),
    ...currentNoteTexts(),
    ...hoursEmailTexts(),
  ].filter((t) => t !== "");
}

// ---------------------------------------------------------------------------
// Settings: the What it does column

test("every setting has one What it does sentence, and no sentence names a setting that isn't there", () => {
  const names = plain(L.settingsDefaults("2026-11-13")).map((r) => r[0]);
  const described = Object.keys(plain(L.settingsDescriptions()));
  assert.deepEqual([...described].sort(), [...names].sort());
  values(L.settingsDescriptions()).forEach((s) => {
    assert.ok(s.length > 0 && s.length <= 300, s);
    assert.ok(s.endsWith("."), s);
    assert.ok(!/^[='+-]/.test(s), s);
  });
  assert.equal(L.settingsDescriptionHeader(), "What it does");
});

test("every setting the server code writes has a description", () => {
  const written = new Set();
  const call = /setSetting_\(\s*(?:"([^"]+)"|(\w+)\(\))/g;
  SERVER_FILES.forEach((src) => {
    for (const m of src.matchAll(call)) written.add(m[1] !== undefined ? m[1] : L[m[2]]());
  });
  assert.deepEqual([...written].sort(), [
    "Auto clock-out last run",
    "Daily jobs installed by",
    "Flags email last run",
    "Past hours file ID",
    "Past hours tab",
    "Profiles problems",
    "Volunteer Profiles file ID",
  ]);
  const d = plain(L.settingsDescriptions());
  written.forEach((name) => assert.ok(d[name], name));
});

test("settingsDescriptionColumn says what the kiosk does with each row", () => {
  const d = plain(L.settingsDescriptions());
  const unknown = "The kiosk doesn't use this row.";
  const repeat = "Not used: an earlier row has the same name, and only the first one counts.";
  const names = [
    "Flags email",
    "Closing time",
    "",
    "Flags email",
    "Closing time",
    "toString",
    "constructor",
    "Kiosk access code",
  ];
  const out = plain(L.settingsDescriptionColumn(names));
  assert.equal(out.length, names.length);
  assert.deepEqual(out, [
    d["Flags email"],
    unknown,
    "",
    repeat,
    unknown,
    unknown,
    unknown,
    d["Kiosk access code"],
  ]);
  assert.deepEqual(plain(L.settingsDescriptionColumn([])), []);
});

// ---------------------------------------------------------------------------
// Header notes

test("each tab's notes have exactly its headers' keys", () => {
  assert.deepEqual(Object.keys(logNotes()), Object.keys(plain(L.logHeaderNames())));
  assert.deepEqual(Object.keys(flagNotes()), Object.keys(plain(L.flagHeaderNames())));
});

test("every kiosk note text is one line with plain single spaces, so Sheets has nothing to reshape", () => {
  const texts = [...currentNoteTexts(), ...plain(L.headerNotePastTexts())];
  texts.forEach((t) => {
    assert.equal(typeof t, "string");
    assert.ok(t.length > 0, "empty note");
    assert.ok(!/[\r\n]/.test(t), "line break in: " + t);
    assert.equal(t, t.trim(), "space at an end of: " + t);
    assert.ok(!/ {2}/.test(t), "two spaces in a row in: " + t);
    assert.ok(!/[^\S ]/.test(t), "a tab or a space other than a plain one in: " + t);
  });
  // The 28 current texts are all different, so each cell's note names its column.
  assert.equal(new Set(currentNoteTexts()).size, 28);
});

test("headerNoteKioskTexts holds every current note and every past one", () => {
  const past = plain(L.headerNotePastTexts());
  assert.ok(Array.isArray(past));
  past.forEach((t) => assert.equal(typeof t, "string"));
  const kiosk = new Set(plain(L.headerNoteKioskTexts()));
  [...currentNoteTexts(), ...past].forEach((t) => assert.ok(kiosk.has(t), t));
});

test("every note text a release has written is still known to the kiosk", () => {
  // A wording change fails here until the old text is listed in headerNotePastTexts().
  // Removing a text from the record instead would leave cells on a live sheet carrying it
  // taken for staff notes and never updated.
  const shipped = JSON.parse(read("tests/header-notes-shipped.json"));
  assert.ok(Array.isArray(shipped) && shipped.length > 0);
  assert.equal(new Set(shipped).size, shipped.length, "each text once");
  const kiosk = new Set(plain(L.headerNoteKioskTexts()));
  shipped.forEach((t) => assert.ok(kiosk.has(t), "no longer the kiosk's: " + JSON.stringify(t)));
});

// The ENCM Log header, line breaks included.
const LOG_HEADERS = values(L.logHeaderNames());

test("headerNotesRow writes a note only on an empty note or an exact kiosk text", () => {
  const names = plain(L.logHeaderNames());
  const notes = logNotes();
  const kiosk = [...plain(L.headerNoteKioskTexts()), "OLD"];
  const date = notes.date;
  const flagText = flagNotes().reason;
  const row = (header, existing) => plain(L.headerNotesRow(header, names, notes, existing, kiosk));
  const one = (existing, header = "Date") => row([header], [existing])[0];

  // The cases, as [header, existing note, expected].
  const cases = [
    ["Date", "", date],
    ["Date", date, date],
    ["Date", "OLD", date],
    ["Date", notes.status, date],
    ["Date", flagText, date],
    ["Date", "Andrea checks these", "Andrea checks these"],
    ["Date", "Two lines\nof staff words", "Two lines\nof staff words"],
    ["Date", date.replace("shift's", "shifts"), date.replace("shift's", "shifts")],
    ["Date", date + " Ask Andrea.", date + " Ask Andrea."],
    ["Date", "See: " + date, "See: " + date],
    ["Date", date + " ", date + " "],
    ["Date", date + "\n", date + "\n"],
    ["Date", "OLd", "OLd"],
    ["Checked by", "", ""],
    ["Checked by", "mine", "mine"],
    ["Checked by", date, ""],
    ["Checked by", "OLD", ""],
  ];
  cases.forEach(([header, existing, want]) =>
    assert.equal(one(existing, header), want, header + " / " + JSON.stringify(existing)),
  );
  // Every output is its input note, the current text, or "" in place of a kiosk text.
  cases.forEach(([header, existing]) => {
    const out = one(existing, header);
    const current = header === "Date" ? date : null;
    assert.ok(
      out === existing || out === current || (out === "" && kiosk.includes(existing)),
      JSON.stringify([header, existing, out]),
    );
  });

  // ENCM's live header, reordered, a header twice and a missing note list.
  assert.deepEqual(row(LOG_HEADERS, []), values(notes));
  const reversed = [...LOG_HEADERS].reverse();
  assert.deepEqual(row(reversed, []), values(notes).reverse());
  const spaced = LOG_HEADERS.map((h) => h.replace(/\n/g, "  ").toUpperCase());
  assert.deepEqual(row(spaced, []), values(notes));
  assert.deepEqual(row(["Status", "x", "status"], ["", "", "OLD"]), [
    notes.status,
    "",
    notes.status,
  ]);
  assert.equal(row(["Date", "", "Day", ""], ["", "", ""]).length, 4);

  // Running it on its own output changes nothing.
  const mixed = ["Date", "Checked by", "Status", "Shift ID", "Day"];
  const existing = ["OLD", date, "staff", "", notes.day + " "];
  const once = row(mixed, existing);
  assert.deepEqual(row(mixed, once), once);
});

test("howToColumnLines gives one line per header, its line breaks made spaces, its note exact", () => {
  const lines = plain(L.howToColumnLines(L.logHeaderNames(), L.logHeaderNotes()));
  assert.equal(lines.length, 18);
  assert.ok(lines.every((l) => l.kind === "item"));
  assert.equal(lines[4].text, "Check-In Recorded (timestamp): " + logNotes().recordedIn);
  Object.keys(logNotes()).forEach((k, i) =>
    assert.ok(lines[i].text.endsWith(": " + logNotes()[k])),
  );
});

// ---------------------------------------------------------------------------
// The How to tab's text

const menuLabels = () =>
  [...read("apps-script/Admin.js").matchAll(/\.addItem\("([^"]+)"/g)].map((m) => m[1]);

test("every Kiosk admin > in the staff text names a menu item exactly as the menu spells it", () => {
  const labels = menuLabels();
  assert.ok(labels.length >= 8);
  let seen = 0;
  staffTexts().forEach((t) => {
    const parts = t.split("Kiosk admin > ").slice(1);
    parts.forEach((rest) => {
      seen++;
      const label = labels.find(
        (l) => rest.startsWith(l) && !/^[A-Za-z0-9]/.test(rest.slice(l.length)),
      );
      assert.ok(label, "not a menu item: Kiosk admin > " + rest.slice(0, 40));
    });
  });
  assert.ok(seen > 10);
  // Each walkthrough's menu item is named at least once.
  const all = staffTexts().join("\n");
  [
    "Fix a sign-out…",
    "Add a shift…",
    "Remove a shift…",
    "Restore a shift…",
    "Monthly report…",
    "Email hours…",
  ].forEach((l) => assert.ok(all.includes("Kiosk admin > " + l), l));
});

const DEV_TOKENS = [
  "setupSheets",
  "setupReports",
  "setupDailyJobs",
  "Apps Script",
  "trigger",
  "triggers",
  "metadata",
  "API",
  "function",
  "functions",
  "script lock",
];

/** The developer tokens in text: whole words, case-sensitive, lower-case ones also capitalised. */
function devWords(text) {
  const found = [];
  DEV_TOKENS.forEach((token) => {
    const forms = [token];
    if (/^[a-z]/.test(token)) forms.push(token[0].toUpperCase() + token.slice(1));
    forms.forEach((form) => {
      if (new RegExp("(?<![A-Za-z0-9_])" + form + "(?![A-Za-z0-9_])").test(text)) found.push(form);
    });
  });
  return found;
}

test("the developer-word matcher matches whole words only", () => {
  ["capitals", "functional", "triggered", "api", "Metadatas"].forEach((t) =>
    assert.deepEqual(devWords(t), [], t),
  );
  ["API", "Trigger", "function", "run setupSheets", "the Apps Script editor"].forEach((t) =>
    assert.ok(devWords(t).length > 0, t),
  );
});

test("no staff text names code", () => {
  staffTexts().forEach((t) => {
    assert.deepEqual(devWords(t), [], t);
    assert.ok(!/[A-Za-z0-9]_(?![A-Za-z0-9])/.test(t), "a word ending in _: " + t);
    assert.ok(!/[A-Za-z0-9_]\(/.test(t), "a word followed by (: " + t);
    const underscored = (t.match(/[A-Za-z0-9]*_[A-Za-z0-9_]*/g) || []).filter(
      (w) => w !== "PERMISSION_DENIED",
    );
    assert.deepEqual(underscored, [], t);
  });
});

test("no staff line starts like a formula, and none has a stray line break or odd space", () => {
  staffTexts().forEach((t) => {
    assert.ok(!/^[='+-]/.test(t), t);
    assert.ok(!/[\r\n]/.test(t), t);
    assert.equal(t, t.trim(), t);
    assert.ok(!/ {2}/.test(t) && !/[^\S ]/.test(t), t);
  });
});

test("the Hours section carries hoursHowTo() and hoursDateNote() exactly", () => {
  const hours = plain(L.howToSections()).find((s) => s.title.startsWith("Look up hours"));
  const texts = hours.lines.map((l) => l.text);
  assert.ok(texts.includes("2. " + L.hoursHowTo()));
  assert.ok(texts.includes("3. " + L.hoursDateNote()));
});

test("howToRows: the title, two notes, then a blank row and heading per section", () => {
  const rows = plain(L.howToRows());
  const sections = plain(L.howToSections());
  const styles = plain(L.howToStyles());
  assert.deepEqual(
    rows.slice(0, 3).map((r) => r.kind),
    ["title", "note", "note"],
  );
  assert.equal(rows[0].text, "How to: the volunteer kiosk sheet");
  let at = 3;
  sections.forEach((s) => {
    assert.deepEqual(rows[at], { kind: "blank", text: "" });
    assert.deepEqual(rows[at + 1], { kind: "heading", text: s.title });
    assert.deepEqual(rows.slice(at + 2, at + 2 + s.lines.length), s.lines);
    at += 2 + s.lines.length;
  });
  assert.equal(at, rows.length);
  rows.forEach((r) => assert.ok(styles[r.kind], r.kind));
  ["text", "step", "tip", "item"].forEach((k) => assert.ok(styles[k], k));

  const [log, flags] = sections.slice(-2);
  assert.equal(log.title, "What the Log columns hold");
  assert.equal(flags.title, "What the Flags columns hold");
  assert.deepEqual(
    log.lines.filter((l) => l.kind === "item"),
    plain(L.howToColumnLines(L.logHeaderNames(), L.logHeaderNotes())),
  );
  assert.deepEqual(
    flags.lines,
    plain(L.howToColumnLines(L.flagHeaderNames(), L.flagHeaderNotes())),
  );
});

test("the How to tab's name is none the code finds a tab by", () => {
  const sheets = read("apps-script/Sheets.js");
  const consts = ["LOG_TAB", "OLD_LOG_TAB", "SETTINGS_TAB", "FLAGS_TAB"].map(
    (c) => new RegExp("const " + c + ' = "([^"]+)"').exec(sheets)[1],
  );
  const names = [
    ...consts,
    L.removedTabName(),
    L.importLedgerTab(),
    L.shiftsTab(),
    L.hoursTabName(),
    L.hoursDataTabName(),
    L.monthlyHoursTabName(),
  ];
  assert.deepEqual(consts, ["Log", "Log (old layout)", "Settings", "Flags"]);
  const name = L.howToTabName().toLowerCase();
  names.forEach((n) => assert.notEqual(name, n.toLowerCase(), n));
  assert.ok(!name.startsWith(L.reportTabName("2026-11", []).split(" ")[0].toLowerCase() + " "));
  assert.notEqual(L.howToTabMark().key, L.hoursTabMark().key);
});

test("staff are sent to Data > Change view for the saved Flags view, the menu Sheets has", () => {
  const rows = plain(L.howToRows()).map((r) => r.text);
  assert.ok(rows.some((t) => t.includes("Data > Change view > Flags: Unreviewed")));
  assert.ok(!rows.some((t) => /Data > Filter views/.test(t)));
});

// ---------------------------------------------------------------------------
// The Kiosk contact

const CONTACT_SENTENCE =
  "Who to ask when the kiosk or this sheet isn't working, such as a name and an email or phone: the How to tab shows it, and so does the Kiosk admin menu when something goes wrong; while it's blank, the How to tab says to ask whoever looks after the kiosk.";
const BLANK_TEXT =
  "If the kiosk or this sheet isn't working and this tab doesn't help, ask whoever looks after the kiosk. To name them here, type their name and an email or phone in Kiosk contact on the Settings tab.";
const PREFIX = "If the kiosk or this sheet isn't working and this tab doesn't help, contact: ";

test("Kiosk contact is the last Settings row before the hours email rows, blank by default, with its sentence", () => {
  const rows = plain(L.settingsDefaults("2026-11-13"));
  assert.equal(L.kioskContactSetting(), "Kiosk contact");
  assert.deepEqual(rows[rows.length - 3], ["Kiosk contact", ""]);
  assert.equal(rows.filter((r) => r[0] === "Kiosk contact").length, 1);
  assert.equal(plain(L.settingsDescriptions())["Kiosk contact"], CONTACT_SENTENCE);
});

test("the two hours email rows are the last two Settings rows, blank by default, with their sentences", () => {
  const rows = plain(L.settingsDefaults("2026-11-13"));
  assert.equal(L.hoursEmailContactSetting(), "Hours email contact");
  assert.equal(L.hoursEmailSignatureSetting(), "Hours email signature");
  assert.deepEqual(rows.slice(-2), [
    ["Hours email contact", ""],
    ["Hours email signature", ""],
  ]);
  const d = plain(L.settingsDescriptions());
  assert.equal(
    d["Hours email contact"],
    "Who volunteers should contact about their hours, such as a name and an email or phone: Kiosk admin > Email hours… ends every email with it, because nobody can reply to that email; while it's blank, no hours email can be sent.",
  );
  assert.equal(
    d["Hours email signature"],
    'Lines added under "Thank you for volunteering." in Kiosk admin > Email hours…, such as a name and a role; blank adds nothing.',
  );
});

test("How to has the Email hours steps, after the monthly report", () => {
  const sections = plain(L.howToSections());
  const at = sections.findIndex((s) => s.title === "Email volunteers their hours");
  assert.ok(at > 0);
  assert.equal(sections[at - 1].title, "Make the monthly report");
  const texts = sections[at].lines.map((l) => l.text);
  assert.ok(texts.includes("1. Kiosk admin > Email hours…"));
  const all = texts.join("\n");
  [
    "this month or last month",
    "last month, all three totals are as of that month's last day",
    "Attach all shifts",
    "Tick all shown with the search empty",
    "Preview",
    "Check before sending",
    "initials",
    "Send email",
    "Hours email contact",
    "can't take replies",
    "Hours emails tab",
    "Bounces",
  ].forEach((part) => assert.ok(all.includes(part), part));
});

test("the hours email's texts are in the staff text the wording tests read", () => {
  const texts = hoursEmailTexts();
  const all = staffTexts();
  texts.filter((t) => t !== "").forEach((t) => assert.ok(all.includes(t), t));
  // Every warning kind and every problem is among them.
  const joined = texts.join("\n");
  [
    "open shift not counted",
    "with an unreviewed flag",
    "with Admin Alerts? set",
    "no listed volunteer has",
    "auto clock-out in the totals",
    "counted as 0 hours",
    "left out (",
    "with an import: User Token",
    "The Flags tab couldn't be read",
    "no counted hours yet",
    "Two volunteers share this name",
    "has no email",
    "isn't one email address",
    "has no Email column",
    "Not on the volunteer list any more",
    "have the same User Token",
    "Google allows 3 more",
    "daily email limit",
    "We don't have any volunteer hours recorded for you yet.",
    "The shifts file is left out, since there are no shifts to list.",
    "No shifts in October 2026.",
    "No shifts yet in December 2026.",
  ].forEach((part) => assert.ok(joined.includes(part), part));
});

test("How to opens with Problems with the kiosk: one contact line, styled like text", () => {
  const sections = plain(L.howToSections());
  assert.equal(sections[0].title, "Problems with the kiosk");
  assert.deepEqual(sections[0].lines, [
    { kind: "contact", text: "", formula: L.kioskContactFormula() },
  ]);
  assert.equal(sections[1].title, "Before you start");
  const styles = plain(L.howToStyles());
  assert.deepEqual(styles.contact, styles.text);
  // Only the contact row carries a formula; every row has a kind and a text.
  const rows = plain(L.howToRows());
  assert.deepEqual(
    rows.filter((r) => "formula" in r).map((r) => r.kind),
    ["contact"],
  );
  rows.forEach((r) => {
    const keys = Object.keys(r).sort();
    assert.deepEqual(keys, r.kind === "contact" ? ["formula", "kind", "text"] : ["kind", "text"]);
  });
  assert.deepEqual(rows.slice(3, 6), [
    { kind: "blank", text: "" },
    { kind: "heading", text: "Problems with the kiosk" },
    { kind: "contact", text: "", formula: L.kioskContactFormula() },
  ]);
});

const TRIM_SET =
  "[\\t\\n\\x{0B}\\f\\r\\x{20}\\x{A0}\\x{1680}\\x{2000}-\\x{200A}\\x{2028}\\x{2029}\\x{202F}\\x{205F}\\x{3000}\\x{FEFF}]";
const TRIM = "^" + TRIM_SET + "+|" + TRIM_SET + "+$";

test("the How to contact formula reads the Settings row live, by name, and falls back to the blank text", () => {
  assert.deepEqual(plain(L.howToContactTexts()), { blank: BLANK_TEXT, prefix: PREFIX });
  assert.equal(L.kioskContactTrimPattern(), TRIM);
  const t = (x) => "REGEXREPLACE(" + x + '&"", "' + TRIM + '", "")';
  const want =
    "=LET(contact, IFERROR(" +
    t(
      "INDEX(Settings!B:B, MATCH(1, ARRAYFORMULA(EXACT(" +
        t("Settings!A:A") +
        ', "Kiosk contact")*(ROW(Settings!A:A)>1)), 0))',
    ) +
    ', ""), IF(contact = "", "' +
    BLANK_TEXT +
    '", "' +
    PREFIX +
    '" & contact))';
  assert.equal(L.kioskContactFormula(), want);
  const f = L.kioskContactFormula();
  ["Settings!A:A", "Settings!B:B", '"Kiosk contact"', "EXACT(", "IFERROR("].forEach((part) =>
    assert.ok(f.includes(part), part),
  );
  // The formula's tab is the tab the server reads Settings from.
  const sheets = read("apps-script/Sheets.js");
  assert.equal(/const SETTINGS_TAB = "([^"]+)"/.exec(sheets)[1], "Settings");
  // Neither text needs a doubled quote, so the formula holds them as they are.
  assert.ok(!BLANK_TEXT.includes('"') && !PREFIX.includes('"'));
});

/**
 * The trim pattern as JavaScript runs it. The pattern is written for Sheets (RE2); it uses
 * only escapes both engines read the same way, except \x{...}, which is \u{...} here.
 */
function sheetsTrim(text) {
  const pattern = L.kioskContactTrimPattern();
  // Every piece is one both engines know: anchors, a class, +, |, and these escapes.
  // No \p{...} class: Sheets' REGEXREPLACE gives #REF! for every one.
  assert.match(pattern, /^(?:[\^$+|[\]-]|\\[tnfr]|\\x\{[0-9A-F]+\})+$/);
  const js = new RegExp(pattern.replace(/\\x\{([0-9A-F]+)\}/g, "\\u{$1}"), "gu");
  return String(text).replace(js, "");
}

test("How to and the server agree on a blank contact: the formula trims what cellString trims", () => {
  // Every character in the Basic Multilingual Plane, alone and around a name.
  for (let code = 0; code <= 0xffff; code++) {
    if (code >= 0xd800 && code <= 0xdfff) continue;
    const ch = String.fromCharCode(code);
    assert.equal(sheetsTrim(ch), L.cellString(ch), "U+" + code.toString(16));
    const around = ch + "Pat Example" + ch;
    assert.equal(sheetsTrim(around), L.cellString(around), "U+" + code.toString(16));
  }
  const values = [
    "",
    " ",
    "\n",
    " \n ",
    "\n\n",
    "\r\n",
    "\t",
    "\u00a0",
    "\u2028",
    "\ufeff",
    "Pat Example\n",
    " Pat Example, pat@example.org ",
    "Pat Example\n 555-0100 \n",
    "Pat  Example",
    "Kiosk contact\u00a0",
  ];
  values.forEach((v) => {
    assert.equal(sheetsTrim(v), L.cellString(v), JSON.stringify(v));
    // Blank on the How to tab exactly when the windows add no contact line.
    assert.equal(sheetsTrim(v) === "", L.kioskContactNote(v) === "", JSON.stringify(v));
  });
  // A value of only line breaks and spaces is blank on both.
  assert.equal(sheetsTrim(" \n \n"), "");
  assert.equal(L.kioskContactNote(" \n \n"), "");
  // Inner spaces are kept as typed, as readSettings_ keeps them.
  assert.equal(sheetsTrim(" Pat  Example "), "Pat  Example");
});

test("kioskContactNote: the value's lines trimmed and joined, after the contact words", () => {
  assert.equal(L.kioskContactNote(""), "");
  assert.equal(L.kioskContactNote(undefined), "");
  assert.equal(L.kioskContactNote("  \n "), "");
  assert.equal(
    L.kioskContactNote("Pat Example, pat@example.org"),
    "If this keeps happening, contact: Pat Example, pat@example.org",
  );
  assert.ok(L.kioskContactNote("Pat Example\n 555-0100 \n").endsWith("Pat Example, 555-0100"));
  assert.equal(
    L.kioskContactNote("\nPat Example\r\n\n555-0100"),
    "If this keeps happening, contact: Pat Example, 555-0100",
  );
  assert.equal(L.withKioskContact("Boom.", ""), "Boom.");
  assert.equal(
    L.withKioskContact("Boom.", L.kioskContactNote("Pat Example")),
    "Boom. If this keeps happening, contact: Pat Example",
  );
});

test("the tablet never gets the contact: the web app and the page don't name it", () => {
  const tablet = [
    read("apps-script/Api.js"),
    ...readdirSync(new URL("src/", root))
      .filter((f) => /\.(ts|tsx)$/.test(f))
      .map((f) => read("src/" + f)),
  ];
  tablet.forEach((src) => assert.ok(!/kioskContact|Kiosk contact/.test(src)));
});
