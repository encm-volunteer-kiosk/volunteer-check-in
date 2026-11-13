// Tests for the staff help in apps-script/Logic.js: the Settings tab's What it does
// sentences, the Log and Flags header notes and the rule that decides when the kiosk may
// write one, and the How to tab's text. Logic.js is loaded as it is; Admin.js and the
// other server files are read as text, so the menu names and the settings the code writes
// are checked against the code itself.
//
// tests/header-notes-shipped.json is a record of every header note text a release has
// written to a live sheet. It is appended after a release, never edited to make a test
// pass: a cell on a live sheet may still carry any text in it, so each one must stay
// known to the kiosk (current, or listed in headerNotePastTexts()).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

/** Every text staff read: How to rows, Settings sentences and lines, header notes, warnings. */
function staffTexts() {
  return [
    ...plain(L.howToRows()).map((r) => r.text),
    ...values(L.settingsDescriptions()),
    L.settingsDescriptionHeader(),
    ...plain(L.settingsDescriptionColumn(["Kiosk access code", "Kiosk access code", "nope"])),
    L.settingsDescriptionProtection(),
    L.howToProtectionDescription(),
    ...currentNoteTexts(),
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
