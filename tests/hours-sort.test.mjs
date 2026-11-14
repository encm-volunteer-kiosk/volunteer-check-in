// Tests for the Hours tab's sort boxes: apps-script/HoursSort.js, the installable on-edit
// trigger runHoursSort and its installer ensureHoursSortTrigger_, and the pure plan in
// Logic.js (hoursSortPlan, hoursPivotSortKey). The server files are loaded into one global
// scope, as Apps Script loads them, over stand-ins for the spreadsheet, the advanced Sheets
// service, the document lock and the account's triggers. The stand-ins record every call
// in order, so the tests check what a run asks of Sheets:
//
// - An edit that isn't on a sort box of the kiosk's Hours tab ends asking no lock.
// - A run holds the document lock once and releases it in its finally; under it, it writes
//   only the boxes, their data validation, the boxed pivots and B1, then flushes. It never
//   writes a state cell, and on a tab that isn't built it reads no pivot and sends nothing.
// - After any run that gets past the build check, each box holds one of its own choices
//   with its own list's validation, and each pivot's sort is its box's choice, however the
//   runs of several edits take their turns.
// - Before the lock a run writes "Sorting..." into its boxes' status cells and flushes, and
//   only then stamps and shows its toast; under the lock a run with a newer stamp behind
//   it stops at once; the run that sorts blanks every status cell in its batch; the
//   newest run that can't sort says so, and takes it back if a newer run stamped.
// - After a re-sort the header notes are checked, and only a missing kiosk note is put back.
// - An abstract model of two and three runs, in every interleaving, never leaves a
//   "Sorting..." text behind (the ordering model, near the end).
//
// Which rows a pivot shows in which order is Sheets' work and can't be checked here; the
// release check does that on the TEST copy.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const root = new URL("../", import.meta.url);
const SERVER_FILES = [
  "Logic.js",
  "Sheets.js",
  "Api.js",
  "Admin.js",
  "Reports.js",
  "Jobs.js",
  "HoursSort.js",
].map((f) => [f, readFileSync(new URL("apps-script/" + f, root), "utf8")]);
const plain = (x) => JSON.parse(JSON.stringify(x));

const L = {};
vm.runInNewContext(readFileSync(new URL("apps-script/Logic.js", root), "utf8"), L);

const HOURS_ID = 300;
const DATA_ID = 301;
// 2026-11-13 9:14 AM Central.
const NOW = Date.UTC(2026, 10, 13, 15, 14);
const BUILT = [String(NOW), "complete", "", "", "", "built " + NOW];

const colLetters = (n) => {
  let s = "";
  for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};
const colNumber = (letters) =>
  letters.split("").reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);

const TABLES = plain(L.hoursSortChoices());
const texts = (table) => table.choices.map((c) => c.text);
const boxColumn = (table) => table.column + 1;
/** Row 7 (A to N) with each box holding the given text, or its starting choice. */
const row7 = (picks = []) => {
  const values = Array(14).fill("");
  TABLES.forEach((t, i) => (values[boxColumn(t) - 1] = picks[i] ?? t.start));
  return values;
};
/** The boxed pivots hoursPivots builds for row 7's values, by box column. */
const pivotsFor = (values) => {
  const built = plain(L.hoursPivots(L.hoursSourceRange(DATA_ID), L.hoursBoxChoices(values)));
  return TABLES.map((t, i) => built[i]);
};
/** A box's data validation as hoursSortPlan asks for it. */
const listOf = (table) => ({
  condition: {
    type: "ONE_OF_LIST",
    values: texts(table).map((userEnteredValue) => ({ userEnteredValue })),
  },
  strict: true,
  showCustomUi: true,
});

// ---------------------------------------------------------------------------
// Stand-ins

/**
 * A fresh server scope over a spreadsheet holding the kiosk's Hours tab (marked, with row 7
 * holding opts.boxes, A7:N7's values, the boxes' starting choices by default, and its
 * pivots as hoursPivots built them for those values unless opts.pivots gives them by box)
 * and Hours data (marked, its state cells opts.state, built by default), plus a Log tab.
 * opts.docBusy makes the document lock unavailable; opts.triggers is this account's
 * project triggers as [{uid, handler, eventType}], one on-edit runHoursSort trigger
 * "t-sort" by default. opts.oldLayout puts row 7's merges as they were before the status
 * cells (A7:C7, E7:I7, K7:N7). The document properties (props) and the Hours tab's notes
 * last across runs on one server. calls records, in order, every lock call, read of a
 * status cell, write, note, property, toast, Sheets call, flush, log line and trigger
 * change.
 */
function server(opts = {}) {
  const calls = [];
  const logs = [];
  let fail = null;
  let watch = null;
  const rec = (entry) => {
    calls.push(entry);
    if (watch) watch(entry);
    if (fail && fail(entry)) {
      fail = null;
      throw new Error("injected");
    }
  };

  class Sheet {
    constructor(name, sheetId, mark) {
      Object.assign(this, { name, sheetId, mark });
      this.cells = new Map();
      this.validations = new Map(); // "row:col" -> rule
      this.pivots = new Map(); // col (1-based) -> pivotTable
      this.notes = new Map(); // "row:col" -> note
      this.merges = []; // [row, firstCol, lastCol], 1-based, one row each
    }
    get(r, c) {
      return this.cells.get(r + ":" + c) ?? "";
    }
    getName() {
      return this.name;
    }
    getSheetId() {
      return this.sheetId;
    }
    getRange(a, col, rows = 1, cols = 1) {
      if (typeof a === "number") return new Range(this, a, col, rows, cols);
      const m = /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/.exec(a);
      assert.ok(m, "A1 reference " + a);
      const c1 = colNumber(m[1]);
      const r1 = +m[2];
      const c2 = m[3] ? colNumber(m[3]) : c1;
      const r2 = m[3] ? +m[4] : r1;
      return new Range(this, r1, c1, r2 - r1 + 1, c2 - c1 + 1);
    }
  }
  class Range {
    constructor(sheet, row, col, rows, cols) {
      Object.assign(this, { sheet, row, col, rows, cols });
    }
    a1() {
      const first = colLetters(this.col) + this.row;
      if (this.rows === 1 && this.cols === 1) return first;
      return first + ":" + colLetters(this.col + this.cols - 1) + (this.row + this.rows - 1);
    }
    getSheet() {
      return this.sheet;
    }
    getRow() {
      return this.row;
    }
    getColumn() {
      return this.col;
    }
    getNumRows() {
      return this.rows;
    }
    getNumColumns() {
      return this.cols;
    }
    getLastColumn() {
      return this.col + this.cols - 1;
    }
    getValue() {
      rec({ op: "getValue", sheet: this.sheet.name, a1: this.a1() });
      return this.sheet.get(this.row, this.col);
    }
    isPartOfMerge() {
      rec({ op: "isPartOfMerge", sheet: this.sheet.name, a1: this.a1() });
      return this.sheet.merges.some(
        ([r, c1, c2]) => r === this.row && c1 <= this.col && this.col <= c2,
      );
    }
    getNotes() {
      rec({ op: "getNotes", sheet: this.sheet.name, a1: this.a1() });
      return Array.from({ length: this.rows }, (_, i) =>
        Array.from(
          { length: this.cols },
          (_, j) => this.sheet.notes.get(this.row + i + ":" + (this.col + j)) ?? "",
        ),
      );
    }
    setNote(note) {
      rec({ op: "setNote", sheet: this.sheet.name, a1: this.a1(), value: note });
      const at = this.row + ":" + this.col;
      if (note === "") this.sheet.notes.delete(at);
      else this.sheet.notes.set(at, note);
      return this;
    }
    getValues() {
      rec({ op: "getValues", sheet: this.sheet.name, a1: this.a1() });
      return Array.from({ length: this.rows }, (_, i) =>
        Array.from({ length: this.cols }, (_, j) => this.sheet.get(this.row + i, this.col + j)),
      );
    }
    setValue(v) {
      rec({ op: "setValue", sheet: this.sheet.name, a1: this.a1(), value: v });
      this.sheet.cells.set(this.row + ":" + this.col, v);
      return this;
    }
  }

  const hours = new Sheet("Hours", HOURS_ID, "hours");
  const data = new Sheet("Hours data", DATA_ID, "hours-data");
  const log = new Sheet("Log", 0, null);
  const sheets = [log, hours, data];
  (opts.state || BUILT).forEach((v, i) => data.cells.set("1:" + (12 + i), v));
  const boxes = opts.boxes || row7();
  boxes.forEach((v, i) => v !== "" && hours.cells.set("7:" + (i + 1), v));
  if (opts.oldLayout) {
    hours.merges = [
      [7, 1, 3],
      [7, 5, 9],
      [7, 11, 14],
    ];
  }
  const props = new Map(Object.entries(opts.props || {}));
  let uuids = 0;
  TABLES.forEach((t, i) => {
    // Each box's validation is on its box cell alone, as setupReports sets it.
    hours.validations.set("7:" + boxColumn(t), listOf(t));
    const given = opts.pivots ? opts.pivots[i] : pivotsFor(boxes)[i];
    if (given) hours.pivots.set(boxColumn(t), plain(given));
  });

  const triggers = (
    opts.triggers || [{ uid: "t-sort", handler: "runHoursSort", eventType: "ON_EDIT" }]
  ).map((t) => ({ ...t }));
  let made = 0;
  const asTrigger = (t) => ({
    getUniqueId: () => t.uid,
    getHandlerFunction: () => t.handler,
    getEventType: () => t.eventType,
  });

  const ss = {
    getId: () => "file-1",
    toast: (message, title, seconds) => rec({ op: "toast", value: [message, title, seconds] }),
    getSheetByName: (name) => sheets.find((s) => s.name === name) || null,
    createDeveloperMetadataFinder: () => {
      const finder = {
        withKey: (k) => (assert.equal(k, "kiosk-tab"), finder),
        find: () =>
          sheets
            .filter((s) => s.mark)
            .map((s) => ({
              getValue: () => s.mark,
              getLocation: () => ({ getSheet: () => s }),
            })),
      };
      return finder;
    },
  };

  const ctx = {
    console: { log: (text) => (rec({ op: "log", value: text }), logs.push(text)) },
    Session: { getEffectiveUser: () => ({ getEmail: () => "owner@example.org" }) },
    ScriptApp: {
      EventType: { CLOCK: "CLOCK", ON_EDIT: "ON_EDIT" },
      getProjectTriggers: () => triggers.map(asTrigger),
      deleteTrigger: (t) => {
        rec({ op: "trigger.delete", value: t.getUniqueId() });
        triggers.splice(
          triggers.findIndex((x) => x.uid === t.getUniqueId()),
          1,
        );
      },
      newTrigger: (handler) => ({
        forSpreadsheet: (file) => ({
          onEdit: () => ({
            create: () => {
              rec({ op: "trigger.create", value: handler });
              triggers.push({
                uid: "t-made-" + ++made,
                handler,
                eventType: "ON_EDIT",
                source: file.getId(),
              });
            },
          }),
        }),
      }),
    },
    LockService: {
      getDocumentLock: () => ({
        tryLock: (wait) => (rec({ op: "docLock.tryLock", value: wait }), !opts.docBusy),
        releaseLock: () => rec({ op: "docLock.release" }),
      }),
      getScriptLock: () => {
        throw new Error("the sort never takes the script lock");
      },
    },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ss,
      flush: () => rec({ op: "flush" }),
    },
    PropertiesService: {
      getDocumentProperties: () => ({
        getProperty: (key) => {
          rec({ op: "prop.get", key });
          return props.has(key) ? props.get(key) : null;
        },
        setProperty: (key, value) => {
          rec({ op: "prop.set", key, value });
          props.set(key, value);
        },
      }),
    },
    Sheets: {
      Spreadsheets: {
        get: (id, params) => {
          assert.equal(id, "file-1");
          rec({ op: "Sheets.get", value: params.ranges });
          assert.equal(params.fields, "sheets(data(startColumn,rowData(values(pivotTable))))");
          return {
            sheets: [
              {
                data: params.ranges.map((r) => {
                  const m = /^'Hours'!([A-Z]+)8$/.exec(r);
                  assert.ok(m, "a pivot's anchor on Hours: " + r);
                  const col = colNumber(m[1]);
                  const grid = { startRow: 7 };
                  // Sheets leaves out a zero.
                  if (col > 1) grid.startColumn = col - 1;
                  const pivot = hours.pivots.get(col);
                  if (pivot) grid.rowData = [{ values: [{ pivotTable: plain(pivot) }] }];
                  return grid;
                }),
              },
            ],
          };
        },
        batchUpdate: (body, id) => {
          assert.equal(id, "file-1");
          rec({ op: "batchUpdate", value: plain(body.requests) });
          // A batch applies whole or not at all: work it out first, then apply.
          const apply = body.requests.map((r) => {
            if (r.setDataValidation) {
              const g = r.setDataValidation.range;
              assert.equal(g.sheetId, HOURS_ID);
              return () => {
                for (let row = g.startRowIndex; row < g.endRowIndex; row++)
                  for (let c = g.startColumnIndex; c < g.endColumnIndex; c++)
                    hours.validations.set(row + 1 + ":" + (c + 1), plain(r.setDataValidation.rule));
              };
            }
            const u = r.updateCells;
            assert.ok(u, "only validations and cell updates: " + JSON.stringify(r));
            assert.equal(u.start.sheetId, HOURS_ID);
            const at = u.start.rowIndex + 1 + ":" + (u.start.columnIndex + 1);
            const cell = u.rows[0].values[0];
            if (u.fields === "pivotTable") {
              assert.equal(u.start.rowIndex, 7);
              return () => hours.pivots.set(u.start.columnIndex + 1, plain(cell.pivotTable));
            }
            assert.equal(u.fields, "userEnteredValue");
            // A cell with no value under the userEnteredValue mask blanks it.
            if (!cell.userEnteredValue) return () => hours.cells.delete(at);
            return () => hours.cells.set(at, cell.userEnteredValue.stringValue);
          });
          apply.forEach((f) => f());
        },
      },
    },
    Utilities: {
      getUuid: () => (++uuids).toString(16).padStart(8, "c") + "-0000-4000-8000-000000000000",
      formatDate: (date, tz, format) => {
        assert.equal(tz, "America/Chicago");
        assert.equal(format, "yyyy-MM-dd h:mm a");
        return "time " + date.getTime();
      },
    },
  };
  vm.createContext(ctx);
  for (const [file, source] of SERVER_FILES) vm.runInContext(source, ctx, { filename: file });
  // Who releases the lock: the function that called releaseHoursLock_.
  const release = ctx.releaseHoursLock_;
  ctx.releaseHoursLock_ = (hold) => {
    const caller = /at (\S+)/.exec(new Error().stack.split("\n")[2]);
    rec({ op: "release-by", value: caller ? caller[1].replace(/^Object\./, "") : "?" });
    return release(hold);
  };

  /** A person's edit: the cells change, then the trigger's event is made (not run). */
  const edit = (a1, value, sheet = hours) => {
    const range = sheet.getRange(a1);
    if (value !== undefined) {
      for (let r = 0; r < range.rows; r++)
        for (let c = 0; c < range.cols; c++) {
          const v = Array.isArray(value) ? value[c] : value;
          sheet.cells.set(range.row + r + ":" + (range.col + c), v);
        }
    }
    return { triggerUid: "t-sort", range };
  };
  const run = (e) => ctx.runHoursSort(e);
  return {
    ctx,
    calls,
    logs,
    props,
    hours,
    data,
    log,
    sheets,
    triggers,
    edit,
    run,
    failAt: (f) => (fail = f),
    // Called with every call as it is recorded, before any failAt.
    watch: (f) => (watch = f),
    clear: () => {
      calls.length = 0;
      logs.length = 0;
    },
  };
}

const ops = (calls) => calls.map((c) => c.op);
/** Each box's text, validation and its pivot's sort key, as left on the stand-in. */
const boxState = (s) =>
  TABLES.map((t) => ({
    text: s.hours.get(7, boxColumn(t)),
    validation: s.hours.validations.get("7:" + boxColumn(t)),
    sort: L.hoursPivotSortKey(s.hours.pivots.get(boxColumn(t))),
  }));
/** Checks the box rule and the sort rule: every box valid, listed, and its table sorted by it. */
const checkMatches = (s, label) => {
  TABLES.forEach((t, i) => {
    const box = boxState(s)[i];
    assert.ok(texts(t).includes(box.text), label + ": box " + i + " holds " + box.text);
    assert.deepEqual(box.validation, listOf(t), label + ": box " + i + "'s validation");
    const want = pivotsFor(row7(TABLES.map((u) => s.hours.get(7, boxColumn(u)))))[i];
    assert.deepEqual(s.hours.pivots.get(boxColumn(t)), want, label + ": pivot " + i);
  });
};

// ---------------------------------------------------------------------------
// The pure parts

test("a pivot's sort key reads its outer group's order and value, a stored empty bucket as value 0", () => {
  const key = (group) => L.hoursPivotSortKey({ rows: [group, { sortOrder: "ASCENDING" }] });
  assert.equal(
    key({ sortOrder: "DESCENDING", valueBucket: { valuesIndex: 1 } }),
    "DESCENDING by value 1",
  );
  assert.equal(key({ sortOrder: "DESCENDING", valueBucket: {} }), "DESCENDING by value 0");
  assert.equal(
    key({ sortOrder: "DESCENDING", valueBucket: {} }),
    key({ sortOrder: "DESCENDING", valueBucket: { valuesIndex: 0 } }),
  );
  assert.equal(key({ sortOrder: "ASCENDING" }), "ASCENDING");
  assert.notEqual(
    key({ sortOrder: "ASCENDING" }),
    key({ sortOrder: "ASCENDING", valueBucket: {} }),
  );
  assert.notEqual(key({ sortOrder: "ASCENDING" }), key({ sortOrder: "DESCENDING" }));
  assert.notEqual(
    key({ sortOrder: "DESCENDING", valueBucket: { valuesIndex: 1 } }),
    key({ sortOrder: "DESCENDING", valueBucket: { valuesIndex: 2 } }),
  );
  // Only the outer group counts.
  assert.equal(
    L.hoursPivotSortKey({ rows: [{ sortOrder: "ASCENDING" }, { sortOrder: "DESCENDING" }] }),
    "ASCENDING",
  );
  assert.equal(L.hoursPivotSortKey({ rows: [] }), "");
  assert.equal(L.hoursPivotSortKey(null), "");
});

const current = (pivots) => ({ hoursSheetId: HOURS_ID, dataSheetId: DATA_ID, pivots });
const kinds = (requests) =>
  requests.map((r) =>
    r.setDataValidation
      ? "validation " + r.setDataValidation.range.startColumnIndex
      : r.updateCells.fields === "pivotTable"
        ? "pivot " + r.updateCells.start.columnIndex
        : r.updateCells.rows[0].values[0].userEnteredValue
          ? "write-back " + r.updateCells.start.columnIndex
          : "status " + r.updateCells.start.columnIndex,
  );
const validationsAll = () => TABLES.map((t) => "validation " + t.column);
const statusAll = () => TABLES.map((t) => "status " + t.boxEnd);

test("hoursSortPlan: every choice of every box rewrites only that box's pivot, whole, from hoursPivots", () => {
  const start = pivotsFor(row7());
  TABLES.forEach((t, i) => {
    for (const text of texts(t)) {
      const picks = [];
      picks[i] = text;
      const values = row7(picks);
      const plan = plain(L.hoursSortPlan(values, current(start)));
      const label = i + " " + text;
      assert.equal(plan.choices[i].choice, text, label);
      assert.equal(plan.choices[i].writeBack, false, label);
      const want = pivotsFor(values)[i];
      const changed = L.hoursPivotSortKey(want) !== L.hoursPivotSortKey(start[i]);
      assert.equal(changed, text !== t.start, label + ": only the starting choice matches");
      assert.deepEqual(
        kinds(plan.requests),
        [...validationsAll(), ...statusAll(), ...(changed ? ["pivot " + t.column] : [])],
        label,
      );
      assert.equal(plan.resorted, changed ? 1 : 0, label);
      if (changed) {
        const u = plan.requests.at(-1).updateCells;
        assert.deepEqual(u.rows[0].values[0].pivotTable, want, label);
        assert.deepEqual(u.start, { sheetId: HOURS_ID, rowIndex: 7, columnIndex: t.column });
      }
      assert.match(plan.summary, new RegExp(t.key + " " + text.replace(/^Sort: /, "")), label);
    }
  });
});

test("hoursSortPlan: a blank or unknown box goes back to its starting choice with a write-back", () => {
  const start = pivotsFor(row7());
  for (const bad of ["", "Sort: sideways", "  ", 42]) {
    const values = row7(TABLES.map(() => bad));
    const plan = plain(L.hoursSortPlan(values, current(start)));
    TABLES.forEach((t, i) => {
      assert.equal(plan.choices[i].choice, t.start, JSON.stringify(bad));
      assert.equal(plan.choices[i].writeBack, true, JSON.stringify(bad));
    });
    // The pivots already follow the starting choices, so only the boxes change.
    assert.deepEqual(kinds(plan.requests), [
      ...validationsAll(),
      ...TABLES.map((t) => "write-back " + t.column),
      ...statusAll(),
    ]);
    plan.requests
      .filter((r) => r.updateCells && r.updateCells.rows[0].values[0].userEnteredValue)
      .forEach((r, i) => {
        assert.deepEqual(r.updateCells.rows[0].values[0].userEnteredValue, {
          stringValue: TABLES[i].start,
        });
        assert.equal(r.updateCells.start.rowIndex, 6);
      });
  }
});

test("hoursSortPlan: every plan carries each box's own validation, also when every pivot matches", () => {
  const plan = plain(L.hoursSortPlan(row7(), current(pivotsFor(row7()))));
  assert.equal(plan.resorted, 0);
  assert.deepEqual(kinds(plan.requests), [...validationsAll(), ...statusAll()]);
  plan.requests.slice(0, TABLES.length).forEach((r, i) => {
    const t = TABLES[i];
    assert.deepEqual(r.setDataValidation.rule, listOf(t));
    assert.deepEqual(r.setDataValidation.range, {
      sheetId: HOURS_ID,
      startRowIndex: 6,
      endRowIndex: 7,
      startColumnIndex: t.column,
      endColumnIndex: t.column + 1,
    });
  });
  // Each box's list is its own: no two boxes share one.
  assert.equal(new Set(TABLES.map((t) => JSON.stringify(texts(t)))).size, TABLES.length);
});

test("hoursSortPlan: only pivots whose sort differs are rewritten, a stored {} bucket read as value 0, a missing pivot left missing", () => {
  const start = pivotsFor(row7());
  // Every table picked away from its start, but the first pivot already sorted that way
  // and stored as Sheets stores it, with value 0's bucket as {}.
  const picks = TABLES.map((t) => t.choices.find((c) => c.text !== t.start).text);
  const want = pivotsFor(row7(picks));
  const stored = plain(want[0]);
  if (stored.rows[0].valueBucket && !stored.rows[0].valueBucket.valuesIndex) {
    stored.rows[0].valueBucket = {};
  }
  const plan = plain(L.hoursSortPlan(row7(picks), current([stored, start[1], null])));
  assert.deepEqual(kinds(plan.requests), [
    ...validationsAll(),
    ...statusAll(),
    "pivot " + TABLES[1].column,
  ]);
  assert.equal(plan.resorted, 1);
  // A choice sorting by value 0, against a pivot stored with {}: no rewrite.
  TABLES.forEach((t, i) => {
    t.choices.forEach((c) => {
      const values = row7(Object.assign([], { [i]: c.text }));
      const p = plain(pivotsFor(values)[i]);
      const bucket = p.rows[0].valueBucket;
      if (!bucket || bucket.valuesIndex !== 0) return;
      p.rows[0].valueBucket = {};
      const pivots = pivotsFor(row7());
      pivots[i] = p;
      const out = plain(L.hoursSortPlan(values, current(pivots)));
      assert.equal(out.resorted, 0, c.text);
    });
  });
});

// ---------------------------------------------------------------------------
// The handler

test("runHoursSort refuses anything but its own trigger, naming setupReports", () => {
  const s = server();
  for (const e of [undefined, {}, { triggerUid: "forged" }]) {
    assert.throws(
      () => s.run(e),
      /^Error: runHoursSort runs only from its trigger\. To install it, run setupReports\.$/,
    );
  }
  assert.deepEqual(s.calls, []);
});

test("an edit off the boxes, or off the kiosk's Hours tab, ends without asking for the lock", () => {
  const box = TABLES.map(boxColumn);
  const gap = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14].find((c) => !box.includes(c));
  const cases = [
    ["a cell above the box", (s) => s.edit(colLetters(box[0]) + "6", "x")],
    ["a pivot cell", (s) => s.edit(colLetters(box[0]) + "9", "x")],
    ["row 7 between boxes", (s) => s.edit(colLetters(gap) + "7", "x")],
    ["the same cell on the Log", (s) => s.edit(colLetters(box[0]) + "7", "x", s.log)],
  ];
  for (const [label, make] of cases) {
    const s = server();
    const e = make(s);
    s.clear();
    s.run(e);
    assert.deepEqual(s.calls, [], label);
  }
  // A tab named Hours that isn't the marked one: found by its mark, stopped before the lock.
  const s = server();
  s.hours.name = "Hours (old)";
  const other = new s.hours.constructor("Hours", 999, null);
  s.sheets.push(other);
  const e = s.edit(colLetters(box[0]) + "7", TABLES[0].start, other);
  s.clear();
  s.run(e);
  assert.ok(!ops(s.calls).includes("docLock.tryLock"));
  assert.ok(!s.calls.some((c) => c.op === "setValue" || c.op.startsWith("Sheets")));
  assert.deepEqual(s.logs, [
    "Sort (edit): the edited tab isn't the kiosk's Hours tab; nothing changed.",
  ]);
});

test("a paste over row 7, or over rows around it, starts a run", () => {
  for (const a1 of ["A7:N7", "A5:N9", colLetters(boxColumn(TABLES.at(-1))) + "7"]) {
    const s = server();
    const e = s.edit(a1);
    s.clear();
    s.run(e);
    assert.ok(ops(s.calls).includes("batchUpdate"), a1);
  }
});

test("a run holds the document lock once, released in runHoursSort's finally, and writes only boxes, status cells, pivots and B1", () => {
  const s = server();
  const second = TABLES[0].choices.find((c) => c.text !== TABLES[0].start).text;
  const e = s.edit(colLetters(boxColumn(TABLES[0])) + "7", second);
  s.clear();
  s.run(e);
  const o = ops(s.calls);
  assert.deepEqual(
    s.calls.filter((c) => c.op === "docLock.tryLock").map((c) => c.value),
    [240000],
  );
  assert.equal(o.filter((x) => x === "docLock.release").length, 1);
  const release = o.indexOf("docLock.release");
  assert.deepEqual(s.calls[release - 1], { op: "release-by", value: "runHoursSort" });
  // Reads: the state cells, row 7 once, the pivots once; then one batch, B1, a flush.
  assert.deepEqual(
    s.calls
      .filter((c) => c.op === "getValues")
      .map((c) => c.sheet + "!" + c.a1)
      .filter((x, i, all) => all.indexOf(x) === i),
    ["Hours data!L1:Q1", "Hours!A7:N7"],
  );
  assert.equal(s.calls.filter((c) => c.op === "getValues" && c.a1 === "A7:N7").length, 1);
  assert.deepEqual(
    plain(s.calls.find((c) => c.op === "Sheets.get").value),
    TABLES.map((t) => "'Hours'!" + colLetters(boxColumn(t)) + "8"),
  );
  assert.equal(o.filter((x) => x === "batchUpdate").length, 1);
  const writes = s.calls.filter((c) => c.op === "setValue");
  assert.deepEqual(
    writes.map((c) => c.sheet + "!" + c.a1 + "=" + c.value),
    ["Hours!" + TABLES[0].status + "=" + L.hoursSortStatusText(), "Hours!B1=" + writes[1].value],
    "no state cell, no Hours data row, no row 3",
  );
  // Before the lock: the sorting text, a flush, then the stamp and the toast.
  assert.deepEqual(o.slice(0, o.indexOf("docLock.tryLock")), [
    "isPartOfMerge",
    "setValue",
    "flush",
    "prop.set",
    "toast",
  ]);
  // Holding: the stamp check first, then the state cells.
  assert.deepEqual(o.slice(o.indexOf("docLock.tryLock") + 1).slice(0, 2), [
    "prop.get",
    "getValues",
  ]);
  const b1 = s.calls.indexOf(writes[1]);
  assert.ok(b1 > o.indexOf("batchUpdate"));
  assert.equal(o[b1 + 1], "flush", "B1 rendered, then flushed");
  assert.ok(o.lastIndexOf("flush") < release);
  assert.equal(
    s.hours.get(1, 2),
    L.hoursLine(L.hoursState(BUILT), (ms) => "time " + ms),
  );
  // The batch blanked every status cell.
  assert.deepEqual(
    TABLES.map((t) => s.hours.get(7, colNumber(t.status.slice(0, -1)))),
    ["", "", ""],
  );
  const stamp = s.props.get("hoursSortStamp");
  assert.match(stamp, /^\d+-[0-9a-f]{8}$/);
  assert.match(
    s.logs[0],
    new RegExp(
      "^Sort \\(edit\\): .*; 1 table re-sorted in \\d+\\.\\d s\\. Stamp " +
        stamp +
        ", stored " +
        stamp +
        ", \\d+\\.\\d s from its start\\.$",
    ),
  );
  checkMatches(s, "after one pick");
});

test("a run whose batch fails says so in its status cell, renders B1 and flushes, then releases the lock and throws, changing no pivot", () => {
  const s = server();
  const second = TABLES[0].choices.find((c) => c.text !== TABLES[0].start).text;
  const e = s.edit(colLetters(boxColumn(TABLES[0])) + "7", second);
  const pivots = plain([...s.hours.pivots]);
  s.clear();
  s.failAt((c) => c.op === "batchUpdate");
  assert.throws(() => s.run(e), /injected/);
  const o = ops(s.calls);
  assert.equal(o.filter((x) => x === "docLock.release").length, 1);
  assert.deepEqual(plain([...s.hours.pivots]), pivots);
  assert.equal(s.hours.get(7, 2), L.hoursSortFailedText());
  const after = o.slice(o.indexOf("batchUpdate") + 1);
  assert.deepEqual(after, [
    "prop.get",
    "getValue",
    "setValue",
    "getValue",
    "getValue",
    // The render: the state cells, then B1; then the flush, before the release.
    "getValues",
    "setValue",
    "flush",
    "release-by",
    "docLock.release",
  ]);
  assert.equal(s.calls.filter((c) => c.op === "setValue").at(-1).a1, "B1");
});

test("a busy document lock: no box or pivot read, one line logged, and the newest run says the sort failed", () => {
  const s = server({ docBusy: true });
  const e = s.edit(colLetters(boxColumn(TABLES[0])) + "7", "");
  s.clear();
  s.run(e);
  const o = ops(s.calls);
  assert.deepEqual(o.slice(o.indexOf("docLock.tryLock")), [
    "docLock.tryLock",
    "log",
    // Without the lock: its stamp is stored, so the failure text over the sorting text, a
    // flush, and a fresh read of the stamp, still its own.
    "prop.get",
    "getValue",
    "setValue",
    "getValue",
    "getValue",
    "flush",
    "prop.get",
    "release-by",
  ]);
  assert.match(
    s.logs[0],
    /^Sort \(edit\): Hours stayed busy for 4 minutes; nothing changed\. Stamp \d+-[0-9a-f]{8}, stored not read, \d+\.\d s from its start\.$/,
  );
  assert.equal(s.hours.get(7, 2), L.hoursSortFailedText());
  assert.ok(!s.calls.some((c) => c.op === "getValues" || c.op.startsWith("Sheets")));
});

test("Hours not built: B1 rendered and flushed, no pivot read, no batch, and it says to run setupReports", () => {
  for (const q1 of ["building " + NOW, "", "nonsense"]) {
    const s = server({ state: [String(NOW), "complete", "", "", "", q1] });
    const e = s.edit(colLetters(boxColumn(TABLES[0])) + "7", "");
    s.clear();
    s.run(e);
    const o = ops(s.calls);
    assert.ok(!o.some((x) => x.startsWith("Sheets") || x === "batchUpdate"), q1);
    assert.ok(!s.calls.some((c) => c.op === "getValues" && c.a1 === "A7:N7"), q1);
    // The sorting text before the lock; under it, all three status cells blanked, then B1.
    const held = o.indexOf("docLock.tryLock");
    assert.deepEqual(
      s.calls
        .filter((c, i) => c.op === "setValue" && i > held)
        .map((c) => c.a1 + "=" + (c.a1 === "B1" ? "B1" : c.value)),
      [...TABLES.map((t) => t.status + "="), "B1=B1"],
      q1,
    );
    const b1 = s.calls.findLastIndex((c) => c.op === "setValue");
    assert.deepEqual(o.slice(b1 + 1), ["flush", "log", "release-by", "docLock.release"], q1);
    assert.equal(s.logs.length, 1, q1);
    assert.match(
      s.logs[0],
      /^Sort \(edit\): Hours isn't built; nothing sorted\. Run setupReports\. Stamp /,
      q1,
    );
    assert.equal(s.hours.get(7, 2), "", q1);
    // The blank box stays blank: nothing but B1 is written on a half-built tab.
    assert.equal(s.hours.get(7, boxColumn(TABLES[0])), "", q1);
  }
});

test("a box carrying another box's validation, or none, gets its own back on the next run", () => {
  const s = server();
  const [a, b] = TABLES;
  s.hours.validations.set("7:" + boxColumn(a), listOf(b));
  s.hours.validations.delete("7:" + boxColumn(b));
  // A paste of the second box's value onto the first: not one of the first's choices.
  const foreign = texts(b).find((x) => !texts(a).includes(x));
  const e = s.edit(colLetters(boxColumn(a)) + "7", foreign);
  s.clear();
  s.run(e);
  assert.equal(s.hours.get(7, boxColumn(a)), a.start);
  assert.deepEqual(s.hours.validations.get("7:" + boxColumn(a)), listOf(a));
  assert.deepEqual(s.hours.validations.get("7:" + boxColumn(b)), listOf(b));
  checkMatches(s, "after a paste");
  assert.match(s.logs[0], /; 0 tables re-sorted in /);
});

test("two edits, their runs holding in either order, leave every pivot matching its box", () => {
  const [a, b] = TABLES;
  const pickA = texts(a).find((x) => x !== a.start);
  const pickB = texts(b).find((x) => x !== b.start);
  for (const order of [
    [0, 1],
    [1, 0],
  ]) {
    // Both edits land before either run holds the lock.
    const s = server();
    const events = [
      s.edit(colLetters(boxColumn(a)) + "7", pickA),
      s.edit(colLetters(boxColumn(b)) + "7", pickB),
    ];
    s.run(events[order[0]]);
    checkMatches(s, "after the first hold " + order);
    s.run(events[order[1]]);
    checkMatches(s, "after the second hold " + order);
    assert.equal(s.hours.get(7, boxColumn(a)), pickA);
    assert.equal(s.hours.get(7, boxColumn(b)), pickB);
  }
  // Two picks on one box: the box holds the later; whichever run holds last, the table follows it.
  const later = texts(a).filter((x) => x !== a.start)[1] || a.start;
  for (const order of [
    [0, 1],
    [1, 0],
  ]) {
    const s = server();
    const events = [
      s.edit(colLetters(boxColumn(a)) + "7", pickA),
      s.edit(colLetters(boxColumn(a)) + "7", later),
    ];
    s.run(events[order[0]]);
    s.run(events[order[1]]);
    assert.equal(s.hours.get(7, boxColumn(a)), later);
    checkMatches(s, "one box, two picks " + order);
  }
  // A pick, its run, then a pick on another box and its run.
  const s = server();
  s.run(s.edit(colLetters(boxColumn(a)) + "7", pickA));
  s.run(s.edit(colLetters(boxColumn(b)) + "7", pickB));
  checkMatches(s, "one after the other");
});

test("a sort made in the pivot editor is put back to the box's choice by the next pick on any box", () => {
  const [a, b] = TABLES;
  const s = server();
  const hand = plain(s.hours.pivots.get(boxColumn(a)));
  hand.rows[0].sortOrder = hand.rows[0].sortOrder === "ASCENDING" ? "DESCENDING" : "ASCENDING";
  s.hours.pivots.set(boxColumn(a), hand);
  s.run(
    s.edit(
      colLetters(boxColumn(b)) + "7",
      texts(b).find((x) => x !== b.start),
    ),
  );
  checkMatches(s, "after the next pick");
});

// ---------------------------------------------------------------------------
// The status cells, the stamp, the toast and the header notes

const STAMP = "hoursSortStamp";
const statusCol = (t) => colNumber(t.status.replace(/\d+$/, ""));
/** Each status cell's text, in table order. */
const statusOf = (s) => TABLES.map((t) => s.hours.get(7, statusCol(t)));
/** An edit picking a choice other than the start in table i's box (made, not run). */
const pick = (s, i) =>
  s.edit(
    colLetters(boxColumn(TABLES[i])) + "7",
    texts(TABLES[i]).find((x) => x !== TABLES[i].start),
  );
const SORTING = L.hoursSortStatusText();
const FAILED = L.hoursSortFailedText();

test("the sorting text goes only into the covered boxes' status cells, is flushed, and only then the stamp is written", () => {
  for (const [a1, covered] of [
    [colLetters(boxColumn(TABLES[1])) + "7", [1]],
    ["A7:" + colLetters(boxColumn(TABLES[1])) + "7", [0, 1]],
    ["A7:N7", [0, 1, 2]],
  ]) {
    const s = server({ docBusy: true });
    const e = s.edit(a1);
    s.clear();
    s.run(e);
    const before = s.calls.slice(
      0,
      s.calls.findIndex((c) => c.op === "docLock.tryLock"),
    );
    assert.deepEqual(
      before.filter((c) => c.op === "setValue").map((c) => c.a1 + "=" + c.value),
      covered.map((i) => TABLES[i].status + "=" + SORTING),
      a1,
    );
    const o = ops(before);
    assert.ok(o.lastIndexOf("setValue") < o.indexOf("flush"), a1);
    assert.ok(o.indexOf("flush") < o.indexOf("prop.set"), a1 + ": flushed before the stamp");
    assert.deepEqual(
      before.filter((c) => c.op === "prop.set").map((c) => c.key),
      [STAMP],
      a1,
    );
  }
});

test("a run stopped before the lock (off a box, or not the kiosk's Hours tab) writes no status, no stamp and no toast", () => {
  const s = server();
  const e = s.edit(TABLES[0].status, "typed");
  s.clear();
  s.run(e);
  assert.deepEqual(s.calls, [], "an edit on a status cell alone ends at the cheap exit");
  const t = server();
  t.hours.name = "Hours (old)";
  const other = new t.hours.constructor("Hours", 999, null);
  t.sheets.push(other);
  const e2 = t.edit(colLetters(boxColumn(TABLES[0])) + "7", TABLES[0].start, other);
  t.clear();
  t.run(e2);
  assert.deepEqual(ops(t.calls), ["log", "release-by"]);
  assert.equal(t.props.size, 0);
});

test("a stale stamp stops the run under the lock after a render and a flush: no box read, no Sheets call, no status write", () => {
  const s = server();
  const e = pick(s, 0);
  s.clear();
  // A newer pick's run stamps while this one waits for the lock.
  s.watch((c) => c.op === "docLock.tryLock" && s.props.set(STAMP, "9999999999999-0000beef"));
  s.run(e);
  const o = ops(s.calls);
  assert.deepEqual(o.slice(o.indexOf("docLock.tryLock")), [
    "docLock.tryLock",
    "prop.get",
    "getValues", // the render reads the state cells
    "setValue",
    "flush",
    "log",
    "release-by",
    "docLock.release",
  ]);
  assert.equal(s.calls.filter((c) => c.op === "setValue").at(-1).a1, "B1");
  assert.ok(!o.some((x) => x.startsWith("Sheets") || x === "batchUpdate"));
  assert.match(
    s.logs[0],
    /^Sort \(edit\): a newer pick is waiting; this run stopped\. Stamp \d+-[0-9a-f]{8}, stored 9999999999999-0000beef, \d+\.\d s from its start\.$/,
  );
  // Its text stays for the newer run, which owes the clear.
  assert.equal(statusOf(s)[0], SORTING);
});

test("a run whose stamp write fails runs as before stamps: it never stops, sorts and clears", () => {
  const s = server();
  const e = pick(s, 0);
  s.clear();
  s.failAt((c) => c.op === "prop.set");
  s.watch((c) => c.op === "docLock.tryLock" && s.props.set(STAMP, "9999999999999-0000beef"));
  s.run(e);
  assert.ok(s.logs.includes("Sort (edit): the stamp wasn't written: injected"));
  assert.match(s.logs.at(-1), /1 table re-sorted in .* Stamp none, stored 9999999999999-0000beef,/);
  assert.deepEqual(statusOf(s), ["", "", ""]);
  checkMatches(s, "no stamp");
});

test("a newer pick that stamps and sorts while an older run waits: the older run stops, every table follows its box, no sorting text left", () => {
  const s = server();
  const older = pick(s, 0);
  const newer = pick(s, 1);
  s.clear();
  let nested = false;
  s.watch((c) => {
    if (c.op === "docLock.tryLock" && !nested) {
      nested = true;
      s.run(newer);
    }
  });
  s.run(older);
  assert.equal(s.logs.length, 2);
  assert.match(s.logs[0], /2 tables re-sorted/);
  assert.match(s.logs[1], /a newer pick is waiting; this run stopped/);
  assert.deepEqual(statusOf(s), ["", "", ""]);
  checkMatches(s, "after both runs");
});

test("a throw while holding: the newest run writes the failure text before its batch was sent and a blank after; a run no longer newest writes no status", () => {
  // After the batch: a sorting text a newer run wrote before it stamped is blanked, since
  // the sort is done.
  const after = server();
  const e = pick(after, 0);
  after.clear();
  after.failAt((c) => {
    if (c.op !== "setValue" || c.a1 !== "B1") return false;
    after.hours.cells.set("7:" + statusCol(TABLES[1]), SORTING);
    return true;
  });
  assert.throws(() => after.run(e), /injected/);
  assert.deepEqual(statusOf(after), ["", "", ""]);
  const o = ops(after.calls);
  assert.deepEqual(o.slice(-4), ["setValue", "flush", "release-by", "docLock.release"]);
  // Before the batch, but a newer run has stamped meanwhile: nothing but B1 and a flush.
  const stale = server();
  const e2 = pick(stale, 0);
  stale.clear();
  stale.failAt((c) => {
    if (c.op !== "batchUpdate") return false;
    stale.props.set(STAMP, "9999999999999-0000beef");
    return true;
  });
  assert.throws(() => stale.run(e2), /injected/);
  assert.equal(statusOf(stale)[0], SORTING, "left for the newer run");
  const o2 = ops(stale.calls);
  assert.deepEqual(o2.slice(o2.indexOf("batchUpdate") + 1), [
    "prop.get",
    "getValues",
    "setValue",
    "flush",
    "release-by",
    "docLock.release",
  ]);
});

test("a busy run: newest writes the failure text and takes it back when a newer stamp is stored by its fresh read; no stamp blanks; not newest writes nothing", () => {
  // Newest at the first read, but a newer run stamps before the fresh read.
  const back = server({ docBusy: true });
  const e = pick(back, 0);
  back.clear();
  let failed = false;
  back.watch((c) => {
    if (c.op === "setValue" && c.value === FAILED) failed = true;
    if (c.op === "flush" && failed) back.props.set(STAMP, "9999999999999-0000beef");
  });
  back.run(e);
  const o = ops(back.calls);
  assert.deepEqual(o.slice(o.indexOf("log") + 1), [
    "prop.get",
    "getValue",
    "setValue",
    "getValue",
    "getValue",
    "flush",
    "prop.get",
    "getValue",
    "setValue",
    "flush",
    "release-by",
  ]);
  assert.deepEqual(statusOf(back), ["", "", ""]);
  // No stamp: it can't tell whether a newer run sorted, so it blanks the sorting texts.
  const none = server({ docBusy: true });
  const e2 = pick(none, 0);
  none.hours.cells.set("7:" + statusCol(TABLES[2]), SORTING);
  none.clear();
  none.failAt((c) => c.op === "prop.set");
  none.run(e2);
  assert.deepEqual(statusOf(none), ["", "", ""]);
  assert.ok(!none.calls.some((c) => c.value === FAILED));
  // Not newest: a newer run stamped while it waited, and owes the clear.
  const older = server({ docBusy: true });
  const e3 = pick(older, 0);
  older.clear();
  older.watch(
    (c) => c.op === "docLock.tryLock" && older.props.set(STAMP, "9999999999999-0000beef"),
  );
  older.run(e3);
  const o3 = ops(older.calls);
  assert.deepEqual(o3.slice(o3.indexOf("log") + 1), ["prop.get", "release-by"]);
  assert.equal(statusOf(older)[0], SORTING);
});

test("on row 7's old layout a run writes no status anywhere, and its batch carries no status blank", () => {
  const s = server({ oldLayout: true });
  const e = pick(s, 0);
  s.clear();
  s.run(e);
  assert.equal(s.calls.filter((c) => c.op === "isPartOfMerge").length, 1);
  assert.deepEqual(
    s.calls.filter((c) => c.op === "setValue").map((c) => c.a1),
    ["B1"],
  );
  const batch = s.calls.find((c) => c.op === "batchUpdate").value;
  assert.ok(
    !batch.some(
      (r) => r.updateCells && TABLES.some((t) => r.updateCells.start.columnIndex === t.boxEnd),
    ),
  );
  assert.ok(s.props.has(STAMP));
  checkMatches(s, "old layout");
  // Busy on the old layout: no failure write either.
  const busy = server({ oldLayout: true, docBusy: true });
  const e2 = pick(busy, 0);
  busy.clear();
  busy.run(e2);
  assert.ok(!busy.calls.some((c) => c.op === "setValue" || c.op === "getValue"));
  // Not built on the old layout: no blanks, B1 only.
  const half = server({ oldLayout: true, state: [String(NOW), "complete", "", "", "", ""] });
  const e3 = pick(half, 0);
  half.clear();
  half.run(e3);
  assert.deepEqual(
    half.calls.filter((c) => c.op === "setValue").map((c) => c.a1),
    ["B1"],
  );
  // A failed layout check is taken as the new layout.
  const unread = server();
  const e4 = pick(unread, 0);
  unread.clear();
  unread.failAt((c) => c.op === "isPartOfMerge");
  unread.run(e4);
  assert.ok(unread.logs.includes("Sort (edit): row 7's layout wasn't read: injected"));
  assert.ok(unread.calls.some((c) => c.op === "setValue" && c.value === SORTING));
});

test("the toast: once per run, naming the covered tables; one that fails is logged and the sort goes on", () => {
  const s = server();
  const e = s.edit("A7:" + colLetters(boxColumn(TABLES[1])) + "7");
  s.clear();
  s.run(e);
  assert.deepEqual(
    s.calls.filter((c) => c.op === "toast").map((c) => plain(c.value)),
    [[L.hoursSortToast([TABLES[0].title, TABLES[1].title]), "Sort box", L.hoursSortSeconds()]],
  );
  const o = ops(s.calls);
  assert.ok(o.indexOf("prop.set") < o.indexOf("toast"));
  assert.ok(o.indexOf("toast") < o.indexOf("docLock.tryLock"));
  const f = server();
  const e2 = pick(f, 0);
  f.clear();
  f.failAt((c) => c.op === "toast");
  f.run(e2);
  assert.ok(f.logs.includes("Sort (edit): the toast wasn't shown: injected"));
  checkMatches(f, "after a failed toast");
});

/** The kiosk's notes on row 8, A to N, as setupReports leaves them. */
const kioskNotes = () =>
  plain(
    L.headerNotesRow(
      L.hoursHeaderRow(),
      L.hoursHeaderNames(),
      L.hoursHeaderNotes(),
      [],
      L.hoursHeaderNoteKioskTexts(),
    ),
  );
const putNotes = (s, notes) =>
  notes.forEach((n, i) =>
    n === "" ? s.hours.notes.delete("8:" + (i + 1)) : s.hours.notes.set("8:" + (i + 1), n),
  );
const notesOf = (s) =>
  Array.from({ length: 14 }, (_, i) => s.hours.notes.get("8:" + (i + 1)) ?? "");

test("after a re-sort the header notes are checked and found in place; a kiosk note deleted by hand comes back; no re-sort, no notes read", () => {
  const s = server();
  putNotes(s, kioskNotes());
  const e = pick(s, 0);
  s.clear();
  s.run(e);
  const o = ops(s.calls);
  assert.equal(o.filter((x) => x === "getNotes").length, 1);
  assert.ok(o.indexOf("batchUpdate") < o.indexOf("getNotes"));
  assert.ok(o.indexOf("getNotes") < s.calls.findIndex((c) => c.op === "setValue" && c.a1 === "B1"));
  assert.ok(!o.includes("setNote"));
  // A kiosk note deleted by hand comes back at the next re-sort.
  s.hours.notes.delete("8:2");
  s.clear();
  s.run(pick(s, 1));
  assert.deepEqual(
    s.calls.filter((c) => c.op === "setNote").map((c) => c.a1),
    ["B8"],
  );
  assert.deepEqual(notesOf(s), kioskNotes());
  // A pick that rewrites no pivot reads no notes.
  s.clear();
  s.run(s.edit(colLetters(boxColumn(TABLES[2])) + "7"));
  assert.match(s.logs.at(-1), /0 tables re-sorted/);
  assert.ok(!ops(s.calls).includes("getNotes"));
});

test("a header notes failure after the batch is logged, and the run ends as a sort", () => {
  for (const op of ["getNotes", "setNote"]) {
    const s = server();
    putNotes(
      s,
      kioskNotes().map((n, i) => (i === 0 ? "" : n)),
    );
    const e = pick(s, 0);
    s.clear();
    s.failAt((c) => c.op === op);
    s.run(e);
    assert.ok(s.logs.includes("Hours: header notes not written: injected"), op);
    assert.match(s.logs.at(-1), /^Sort \(edit\): .*; 1 table re-sorted in /, op);
    const o = ops(s.calls);
    assert.deepEqual(o.slice(-3), ["log", "release-by", "docLock.release"], op);
    assert.deepEqual(statusOf(s), ["", "", ""], op);
    checkMatches(s, op);
  }
});

test("writeHoursNotes_ writes only the cells whose note changes and never replaces a staff note, one written after the early read included", () => {
  const s = server();
  const kiosk = kioskNotes();
  const staffBefore = "Staff: B8 checked by hand.";
  const staffNow = "Staff: C8 written after the early read.";
  const before = kiosk.slice();
  before[1] = staffBefore; // B8's staff note, since dropped
  before[2] = kiosk[2];
  const now = kiosk.slice();
  now[1] = ""; // dropped
  now[2] = staffNow; // written after the early read
  now[3] = kiosk[0]; // a kiosk text in the D gap
  now[11] = "Old wording."; // a staff note, as far as the kiosk knows
  putNotes(s, now);
  s.clear();
  s.ctx.writeHoursNotes_({ hours: s.hours }, before);
  assert.deepEqual(
    s.calls.filter((c) => c.op === "setNote").map((c) => c.a1 + "=" + c.value),
    ["B8=" + staffBefore, "D8="],
  );
  const want = kiosk.slice();
  want[1] = staffBefore;
  want[2] = staffNow;
  want[11] = "Old wording.";
  assert.deepEqual(notesOf(s), want);
  // Run again with nothing changed: no write.
  s.clear();
  s.ctx.writeHoursNotes_({ hours: s.hours }, null);
  assert.ok(!ops(s.calls).includes("setNote"));
});

// ---------------------------------------------------------------------------
// The ordering model
//
// The status cells are right only if every run's writes keep a certain order against
// every other run's: a run's sorting text must be in the sheet before its stamp, and every
// clear comes after the clearing run's own stamp. Real runs are separate executions, so
// their steps interleave in ways one process can't replay. This model runs two and three
// runs as sequences of events, in every interleaving each run's own order allows, with the
// document lock letting one hold run at a time:
//
//   pick       the edit: the box takes the run's value
//   text       the run's sorting text lands in its box's status cell. It may land at any
//              point up to the run's flush, which comes before its stamp: a slow write
//   stamp      the stamp is stored, replacing any other
//   check      holding the lock: a run whose stamp isn't the stored one stops and lets
//              go; otherwise it reads every box
//   batch      the pivots take the boxes it read, and every status cell is blanked; the
//              lock is let go
//   fail       a throw while holding, before the batch: the newest run writes the failure
//              text over every sorting text; the lock is let go
//   busy       the lock wait ran out: read the stamp; if it is the run's own, the failure
//              text over every sorting text; read the stamp again; if a newer run stamped,
//              blank each cell where it put the failure text and that still holds it.
//              With no stamp: blank every sorting text
//
// Every interleaving must end with no status cell holding the sorting text, every pivot
// matching its box when no run failed, and no failure text left once a run that stamped
// after the failed run has sorted. The same model with the text written after the stamp
// must find a sorting text left for good, so the model is shown to catch that order.

const MODEL_BOXES = 3;

/** One run's events, in its own order, for its kind and the write order under test. */
function modelEvents(kind, textFirst) {
  const stamped = kind !== "noStamp" && kind !== "busyNoStamp";
  const before = !stamped
    ? ["pick", "text"]
    : textFirst
      ? ["pick", "text", "stamp"]
      : ["pick", "stamp", "text"];
  const rest = {
    normal: ["check", "batch"],
    noStamp: ["check", "batch"],
    throw: ["check", "fail"],
    busy: ["read1", "failWrite", "read2", "takeBack"],
    busyNoStamp: ["blankAll"],
  }[kind];
  return before.concat(rest);
}

function modelClone(st) {
  return {
    boxes: st.boxes.slice(),
    pivots: st.pivots.slice(),
    status: st.status.map((c) => ({ ...c })),
    stored: st.stored,
    lock: st.lock,
    step: st.step,
    runs: st.runs.map((r) => ({
      ...r,
      put: r.put.slice(),
      snapshot: r.snapshot && r.snapshot.slice(),
    })),
    batches: st.batches.slice(),
  };
}

/**
 * Explores every interleaving of the runs ([{kind, box}]) and calls visit with each final
 * state. Returns how many final states there were.
 */
function modelExplore(specs, textFirst, visit) {
  const plans = specs.map((sp) => modelEvents(sp.kind, textFirst));
  const start = {
    boxes: Array(MODEL_BOXES).fill(0),
    pivots: Array(MODEL_BOXES).fill(0),
    status: Array.from({ length: MODEL_BOXES }, () => ({ text: "", by: -1 })),
    stored: null,
    lock: null,
    step: 0,
    runs: specs.map(() => ({
      pc: 0,
      done: false,
      stampAt: -1,
      snapshot: null,
      newest: false,
      put: [],
    })),
    batches: [],
  };
  const newest = (st, r) => specs[r].kind === "noStamp" || st.stored === r;
  const apply = (st, r, ev) => {
    const run = st.runs[r];
    const box = specs[r].box;
    st.step++;
    run.pc++;
    if (run.pc === plans[r].length) run.done = true;
    if (ev === "pick") st.boxes[box] = r + 1;
    else if (ev === "text") st.status[box] = { text: "sorting", by: r };
    else if (ev === "stamp") {
      st.stored = r;
      run.stampAt = st.step;
    } else if (ev === "check") {
      st.lock = r;
      if (!newest(st, r)) {
        st.lock = null;
        run.done = true;
      } else run.snapshot = st.boxes.slice();
    } else if (ev === "batch") {
      st.pivots = run.snapshot.slice();
      st.status = st.status.map(() => ({ text: "", by: r }));
      st.batches.push({ run: r, stampAt: run.stampAt });
      st.lock = null;
    } else if (ev === "fail") {
      if (newest(st, r)) {
        st.status = st.status.map((c) => (c.text === "sorting" ? { text: "failed", by: r } : c));
      }
      st.lock = null;
    } else if (ev === "read1") run.newest = st.stored === r;
    else if (ev === "failWrite") {
      if (run.newest) {
        st.status.forEach((c, i) => {
          if (c.text === "sorting") {
            st.status[i] = { text: "failed", by: r };
            run.put.push(i);
          }
        });
      }
    } else if (ev === "read2") run.takeBack = run.newest && st.stored !== r;
    else if (ev === "takeBack") {
      if (run.takeBack) {
        run.put.forEach((i) => {
          if (st.status[i].text === "failed") st.status[i] = { text: "", by: r };
        });
      }
    } else if (ev === "blankAll") {
      st.status = st.status.map((c) => (c.text === "sorting" ? { text: "", by: r } : c));
    }
  };
  let ends = 0;
  const go = (st) => {
    let moved = false;
    st.runs.forEach((run, r) => {
      if (run.done) return;
      const ev = plans[r][run.pc];
      // One hold at a time: a check waits while another run holds the lock.
      if (ev === "check" && st.lock !== null) return;
      const next = modelClone(st);
      apply(next, r, ev);
      moved = true;
      go(next);
    });
    if (!moved) {
      assert.ok(
        st.runs.every((run) => run.done),
        "every run finishes",
      );
      ends++;
      visit(st);
    }
  };
  go(start);
  return ends;
}

/** What is wrong with a final state, or null: the three rules above. */
function modelProblem(specs, st) {
  if (st.status.some((c) => c.text === "sorting")) return "a sorting text is left";
  const failing = specs.some((sp) => sp.kind !== "normal" && sp.kind !== "noStamp");
  if (!failing && st.pivots.some((p, i) => p !== st.boxes[i]))
    return "a pivot doesn't follow its box";
  for (const c of st.status) {
    if (c.text !== "failed") continue;
    const failedStamp = st.runs[c.by].stampAt;
    if (st.batches.some((b) => b.stampAt > failedStamp)) {
      return "a failure text is left after a newer run sorted";
    }
  }
  return null;
}

const MODEL_KINDS = ["normal", "noStamp", "throw", "busy", "busyNoStamp"];

test("the ordering model: two runs of every kind, in every interleaving, leave no sorting text, every table sorted, and no stale failure text", () => {
  let checked = 0;
  for (const a of MODEL_KINDS)
    for (const b of MODEL_KINDS)
      for (const boxes of [
        [0, 0],
        [0, 1],
      ]) {
        const specs = [
          { kind: a, box: boxes[0] },
          { kind: b, box: boxes[1] },
        ];
        checked += modelExplore(specs, true, (st) => {
          const problem = modelProblem(specs, st);
          assert.equal(problem, null, JSON.stringify(specs) + ": " + problem);
        });
      }
  assert.ok(checked > 10000, "interleavings checked: " + checked);
});

test("the ordering model: three runs, in every interleaving, leave no sorting text and every table sorted", () => {
  for (const specs of [
    [
      { kind: "normal", box: 0 },
      { kind: "normal", box: 0 },
      { kind: "normal", box: 1 },
    ],
    [
      { kind: "normal", box: 0 },
      { kind: "noStamp", box: 1 },
      { kind: "busy", box: 0 },
    ],
    // A busy run's failure text can land on a third run's text after a newer run sorted:
    // the take-back must remove it.
    [
      { kind: "busy", box: 0 },
      { kind: "normal", box: 1 },
      { kind: "busyNoStamp", box: 2 },
    ],
    [
      { kind: "throw", box: 0 },
      { kind: "busy", box: 1 },
      { kind: "normal", box: 0 },
    ],
  ]) {
    const ends = modelExplore(specs, true, (st) => {
      const problem = modelProblem(specs, st);
      assert.equal(problem, null, JSON.stringify(specs) + ": " + problem);
    });
    assert.ok(ends > 1000, JSON.stringify(specs) + ": " + ends);
  }
});

test("the ordering model catches a sorting text left for good when the text is written after the stamp", () => {
  const specs = [
    { kind: "normal", box: 0 },
    { kind: "normal", box: 0 },
  ];
  let stuck = 0;
  modelExplore(specs, false, (st) => {
    if (modelProblem(specs, st) === "a sorting text is left") stuck++;
  });
  assert.ok(stuck > 0);
});

// ---------------------------------------------------------------------------
// The installer

test("ensureHoursSortTrigger_ keeps one on-edit trigger, replaces two or a wrong kind, and creates one when none", () => {
  const other = { uid: "t-hours", handler: "runHoursRefresh", eventType: "CLOCK" };
  const cases = [
    ["one kept", [{ uid: "t-sort", handler: "runHoursSort", eventType: "ON_EDIT" }], "kept", []],
    ["none", [], "installed", ["trigger.create"]],
    [
      "two",
      [
        { uid: "t-1", handler: "runHoursSort", eventType: "ON_EDIT" },
        { uid: "t-2", handler: "runHoursSort", eventType: "ON_EDIT" },
      ],
      "installed",
      ["trigger.delete", "trigger.delete", "trigger.create"],
    ],
    [
      "a wrong kind",
      [{ uid: "t-1", handler: "runHoursSort", eventType: "CLOCK" }],
      "installed",
      ["trigger.delete", "trigger.create"],
    ],
  ];
  for (const [label, mine, kind, changes] of cases) {
    const s = server({ triggers: [other, ...mine] });
    const result = plain(s.ctx.ensureHoursSortTrigger_());
    assert.deepEqual(result, { kind, account: "owner@example.org" }, label);
    assert.deepEqual(ops(s.calls), changes, label);
    const sort = s.triggers.filter((t) => t.handler === "runHoursSort");
    assert.equal(sort.length, 1, label);
    assert.equal(sort[0].eventType, "ON_EDIT", label);
    if (kind === "installed") assert.equal(sort[0].source, "file-1", label);
    // Another job's trigger is never touched.
    assert.ok(
      s.triggers.some((t) => t.uid === "t-hours"),
      label,
    );
  }
});

test("ensureHoursSortTrigger_ answers a failure instead of throwing", () => {
  const s = server({ triggers: [] });
  s.failAt((c) => c.op === "trigger.create");
  assert.deepEqual(plain(s.ctx.ensureHoursSortTrigger_()), {
    kind: "failed",
    message: "injected",
  });
});
