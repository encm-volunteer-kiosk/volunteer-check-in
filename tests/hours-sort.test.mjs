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
 * "t-sort" by default. calls records, in order, every lock call, write, Sheets call,
 * flush, log line and trigger change.
 */
function server(opts = {}) {
  const calls = [];
  const logs = [];
  let fail = null;
  const rec = (entry) => {
    calls.push(entry);
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
            return () => hours.cells.set(at, cell.userEnteredValue.stringValue);
          });
          apply.forEach((f) => f());
        },
      },
    },
    Utilities: {
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
    hours,
    data,
    log,
    sheets,
    triggers,
    edit,
    run,
    failAt: (f) => (fail = f),
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
        : "write-back " + r.updateCells.start.columnIndex,
  );
const validationsAll = () => TABLES.map((t) => "validation " + t.column);

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
        [...validationsAll(), ...(changed ? ["pivot " + t.column] : [])],
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
    ]);
    plan.requests
      .filter((r) => r.updateCells)
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
  assert.deepEqual(kinds(plan.requests), validationsAll());
  plan.requests.forEach((r, i) => {
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
  assert.deepEqual(kinds(plan.requests), [...validationsAll(), "pivot " + TABLES[1].column]);
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

test("a run holds the document lock once, released in runHoursSort's finally, and writes only boxes, pivots and B1", () => {
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
    writes.map((c) => c.sheet + "!" + c.a1),
    ["Hours!B1"],
    "no state cell, no Hours data row, no row 3",
  );
  const b1 = s.calls.indexOf(writes[0]);
  assert.ok(b1 > o.indexOf("batchUpdate"));
  assert.equal(o[b1 + 1], "flush", "B1 rendered, then flushed");
  assert.ok(o.lastIndexOf("flush") < release);
  assert.equal(
    s.hours.get(1, 2),
    L.hoursLine(L.hoursState(BUILT), (ms) => "time " + ms),
  );
  assert.match(s.logs[0], new RegExp("^Sort \\(edit\\): .*; 1 table re-sorted in \\d+\\.\\d s$"));
  checkMatches(s, "after one pick");
});

test("a run whose batch fails still releases the lock, and changes nothing", () => {
  const s = server();
  const second = TABLES[0].choices.find((c) => c.text !== TABLES[0].start).text;
  const e = s.edit(colLetters(boxColumn(TABLES[0])) + "7", second);
  const pivots = plain([...s.hours.pivots]);
  s.clear();
  s.failAt((c) => c.op === "batchUpdate");
  assert.throws(() => s.run(e), /injected/);
  assert.equal(ops(s.calls).filter((x) => x === "docLock.release").length, 1);
  assert.deepEqual(plain([...s.hours.pivots]), pivots);
});

test("a busy document lock: nothing read or written, and one line logged", () => {
  const s = server({ docBusy: true });
  const e = s.edit(colLetters(boxColumn(TABLES[0])) + "7", "");
  s.clear();
  s.run(e);
  assert.deepEqual(ops(s.calls), ["docLock.tryLock", "log", "release-by"]);
  assert.deepEqual(s.logs, ["Sort (edit): Hours stayed busy for 4 minutes; nothing changed."]);
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
    assert.deepEqual(
      s.calls.filter((c) => c.op === "setValue").map((c) => c.a1),
      ["B1"],
      q1,
    );
    const b1 = s.calls.findIndex((c) => c.op === "setValue");
    assert.deepEqual(o.slice(b1 + 1), ["flush", "log", "release-by", "docLock.release"], q1);
    assert.deepEqual(s.logs, ["Sort (edit): Hours isn't built; nothing sorted. Run setupReports."]);
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
