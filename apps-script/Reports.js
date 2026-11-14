/**
 * Reports on the Log: the Hours tab and its hidden source Hours data, the Log's filter
 * views and soft warnings (setupReports), the Hours refresh (refreshHoursNow from the
 * Kiosk admin menu, runHoursRefresh nightly in Jobs.js), and the Kiosk admin menu's
 * Monthly report, which writes a frozen report tab and offers it as a CSV or PDF download.
 *
 * Reports read the Log and never write a Log cell. On the Log tab, setupReports adds only
 * filter views titled "Kiosk: ..." and warning-only protections. Every Log read finds
 * columns through the header map. No report output holds a User Token.
 *
 * The public functions follow the Kiosk admin menu's rule (Admin.js), and
 * tests/admin.test.mjs holds every public function here to it:
 *   - setupReports runs by hand from the editor and starts with requireEditorRun_, as
 *     setupSheets does.
 *   - openMonthlyReportDialog and refreshHoursNow check requireEditorRun_ and
 *     SpreadsheetApp.getUi() (it throws anywhere but the spreadsheet's own UI) before they
 *     read anything; the opener then makes the dialog key.
 *   - adminReportMonths and adminMonthlyReport take the key first and check it and
 *     requireEditorRun_ (adminGuard_) before reading anything.
 * Everything else ends in _, so google.script.run can't call it.
 *
 * What setupReports owns: the Hours and Hours data tabs, found by their developer
 * metadata marks (hoursTabMark, Logic.js), which it rebuilds whole on every run; the Log's
 * filter views titled "Kiosk: ..."; and the Log protections marked "Kiosk column:"
 * (reportProtectionPrefixes, Logic.js). It deletes the old Monthly Hours tab, but only one
 * carrying the "Monthly Hours tab:" protection, and only after Hours reads back filled. A
 * report tab's protection ("Report tab:") is made with the tab and setupReports never
 * touches it.
 */

// ---------------------------------------------------------------------------
// Run by hand from the editor

/**
 * Makes or repairs the Hours and Hours data tabs and fills them, the Log's filter views
 * and the soft warnings on the Log's kiosk columns, from the Log's current header map.
 * Before it changes anything it throws the kiosk's message when a column the kiosk needs
 * is missing, and names a tab called Hours or Hours data that isn't the kiosk's. Once Hours
 * is filled it installs the sort boxes' edit trigger for the account running it
 * (ensureHoursSortTrigger_, HoursSort.js), once. Runs only from the Apps Script editor;
 * the advanced Sheets service must be on (appsscript.json).
 */
function setupReports() {
  requireEditorRun_();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const log = sheet_(LOG_TAB);
  const cols = reportColumns(logHeaderRow_(log));
  const found = checkHoursTabs_(ss);
  const views = setupFilterViews_(ss, log, cols);
  const warnings = setupKioskWarnings_(log, cols);
  const hold = hoursHold_();
  let hours;
  try {
    hours = setupHoursTabs_(ss, found, hold);
  } finally {
    releaseHoursLock_(hold);
  }
  // The sort boxes' trigger goes in once Hours has read back built, outside the hold. Its
  // result is part of the finish message, so the message is logged after it.
  const trigger = ensureHoursSortTrigger_();
  console.log(setupReportsMessage({ views, warnings, hours, trigger }));
}

// ---------------------------------------------------------------------------
// The Hours tab
//
// The rule every write here follows is in Logic.js (the Hours tab section): one document
// lock per execution, asked for at most once through withHoursLock_ and released only in
// the entry point's finally (setupReports, refreshHoursNow, runHoursRefresh in Jobs.js);
// inside a hold, exactly the writes hoursNextState lists, in its order, one call per step
// (writeHours_); and the Hours tab's B1 written only by renderHoursLine_. Reading the Log
// and the Flags tab and the work in Logic.js take no lock, and nothing here asks for the
// kiosk's script lock.

/**
 * Refreshes Hours from the Kiosk admin menu and shows what happened in an alert; an error
 * ends with the Kiosk contact line.
 */
function refreshHoursNow() {
  requireEditorRun_();
  const ui = SpreadsheetApp.getUi();
  const hold = hoursHold_();
  try {
    const result = refreshHours_("menu", hold);
    console.log(hoursRunLog_("menu", result));
    // A result with a message is an error (withKioskContact, Logic.js, has the rule).
    const note = result.message ? kioskContactNote(kioskContact_()) : "";
    ui.alert(withKioskContact(hoursMenuText_(result), note));
  } finally {
    releaseHoursLock_(hold);
  }
}

/**
 * What opening the sheet does to Hours (onOpen): it doesn't refresh, it notes that it
 * didn't. Finds the tabs by their marks; takes the document lock (2 s; busy: log and
 * stop, nothing written); settles; sets N1 to the open's note-only note; renders B1 and
 * flushes. It reads no Log, writes no table, and logs one line. onOpen makes the hold and
 * releases it in its own finally. A full refresh on open was timed on a 20,000-row Log
 * at 19-23 s before any table write, too slow for onOpen's 30 s, so opening only notes.
 */
function noteHoursOnOpen_(hold) {
  const tabs = findHoursTabs_(SpreadsheetApp.getActiveSpreadsheet());
  let result;
  if (!tabs.hours || !tabs.data) {
    result = { kind: "no-tabs", message: "Run setupReports." };
  } else if (!withHoursLock_(hold, hoursLockWait_("open"))) {
    result = { kind: "busy" };
  } else {
    const run = hoursRun_("open", Date.now());
    run.heldAt = Date.now();
    const kind = hoursHoldStep_(tabs, run, { kind: "note-only" }, null);
    result = { kind, line: run.line, timing: { holdMs: Date.now() - run.heldAt } };
  }
  console.log(hoursRunLog_("open", result));
  return result;
}

/**
 * A full refresh on open, not wired: onOpen only notes (noteHoursOnOpen_). openedAtMs is
 * when onOpen began. Logs one line with the read, the work in Logic.js and the hold timed
 * apart. The caller makes the hold and releases it in its own finally.
 */
function refreshHoursOnOpen_(hold, openedAtMs) {
  const result = refreshHours_("open", hold, openedAtMs);
  console.log(hoursRunLog_("open", result));
  return result;
}

/**
 * How long each cause waits for the document lock: the menu 30 s, setupReports 60 s,
 * nightly 120 s, open 2 s.
 */
function hoursLockWait_(cause) {
  return { menu: 30000, setupReports: 60000, nightly: 120000, open: hoursOpenLockWaitMs() }[cause];
}

/**
 * What opening the sheet does to Hours, for row 2's text (hoursUsageText): "note", since
 * onOpen only notes that it didn't refresh (noteHoursOnOpen_). Change it with onOpen:
 * "refresh" when it refreshes, "none" when it writes nothing.
 */
function hoursOpenPath_() {
  return "note";
}

/** One execution's hold on the document lock: asked for at most once (withHoursLock_). */
function hoursHold_() {
  return { lock: null, asked: false, held: false };
}

/**
 * Asks for the document lock, waiting up to wait ms, the first time it is called for this
 * hold; every later call answers the first one's result without asking again. True when
 * the hold has the lock. Never the script lock.
 */
function withHoursLock_(hold, wait) {
  if (hold.asked) return hold.held;
  hold.asked = true;
  hold.lock = LockService.getDocumentLock();
  hold.held = hold.lock.tryLock(wait);
  return hold.held;
}

/** Releases the hold's lock if it has it. Only an entry point's finally calls this. */
function releaseHoursLock_(hold) {
  if (!hold.held) return;
  hold.held = false;
  hold.lock.releaseLock();
}

/**
 * The kiosk's Hours and Hours data tabs, found by their marks, as {hours, data}, each null
 * when no tab carries its mark. Throws when one mark is on two tabs (a copied tab keeps
 * its metadata), naming them.
 */
function findHoursTabs_(ss) {
  const mark = hoursTabMark();
  const found = { hours: [], data: [] };
  ss.createDeveloperMetadataFinder()
    .withKey(mark.key)
    .find()
    .forEach((md) => {
      const sheet = md.getLocation().getSheet();
      const which =
        md.getValue() === mark.hours ? "hours" : md.getValue() === mark.data ? "data" : null;
      if (!sheet || !which) return;
      if (!found[which].some((s) => s.getSheetId() === sheet.getSheetId())) {
        found[which].push(sheet);
      }
    });
  ["hours", "data"].forEach((which) => {
    if (found[which].length > 1) {
      throw new Error(
        "These tabs all carry the kiosk's " +
          (which === "hours" ? hoursTabName() : hoursDataTabName()) +
          " mark: " +
          found[which].map((s) => s.getName()).join(", ") +
          ". Delete the copies, then run setupReports again.",
      );
    }
  });
  return { hours: found.hours[0] || null, data: found.data[0] || null };
}

/**
 * setupReports' check before it changes anything: findHoursTabs_, and a tab named Hours or
 * Hours data that isn't the marked one stops it, named.
 */
function checkHoursTabs_(ss) {
  const found = findHoursTabs_(ss);
  [
    [hoursTabName(), found.hours],
    [hoursDataTabName(), found.data],
  ].forEach(([name, marked]) => {
    const named = ss.getSheetByName(name);
    if (named && (!marked || named.getSheetId() !== marked.getSheetId())) {
      throw new Error(
        'The tab "' +
          named.getName() +
          "\" isn't the kiosk's (setupReports didn't make it), so setupReports changed nothing. Rename or delete it, then run setupReports again.",
      );
    }
  });
  return found;
}

/** A new tab named name at the end, carrying the kiosk's mark value. */
function insertHoursTab_(ss, name, value) {
  const sheet = ss.insertSheet(name, ss.getNumSheets());
  sheet.addDeveloperMetadata(hoursTabMark().key, value);
  return sheet;
}

/**
 * setupReports' steps 3 to 7 on the Hours tabs, in one hold: take the lock (60 s; busy:
 * throw, having changed nothing on Hours); make or find Hours data and mark the tables not
 * whole (M1 "writing S", Q1 "building S"); read the Log and work out the table; lay out
 * Hours data with rows for that table, then Hours, reading the header notes before the
 * clear; Q1 "built S"; write the table inside the hold with mark S; write the header notes
 * (writeHoursNotes_, the last write to the Hours tab, keeping any staff note read before
 * the clear); flush and read Hours data back; and only when it
 * reads back built and whole at this run's read time with the rows written, delete the old
 * Monthly Hours tab. A throw, or a read-back that doesn't pass, marks the table stopped
 * (when this run's mark is still in M1), keeps Monthly Hours and throws with B1's text.
 * Returns {asOf, monthlyHours} for setupReportsMessage.
 */
function setupHoursTabs_(ss, found, hold) {
  const start = Date.now();
  if (!withHoursLock_(hold, hoursLockWait_("setupReports"))) {
    throw new Error("A refresh is writing Hours; run setupReports again in a minute.");
  }
  const run = hoursRun_("setupReports", start);
  const tabs = { hours: found.hours, data: found.data };
  try {
    if (!tabs.data) tabs.data = insertHoursTab_(ss, hoursDataTabName(), hoursTabMark().data);
    const data = tabs.data;
    if (data.getMaxColumns() < 17) {
      data.insertColumnsAfter(data.getMaxColumns(), 17 - data.getMaxColumns());
    }
    if (data.getMaxRows() < 2) data.insertRowsAfter(data.getMaxRows(), 2 - data.getMaxRows());
    data.getRange(hoursStateRange()).setNumberFormat("@");
    hoursHoldStep_(tabs, run, { kind: "setup-start" }, null);
    // Read before the layout, so Hours data has its rows before any pivot or slicer reads
    // it: on a new tab, adding some 20,000 rows under the pivots took minutes.
    run.t = Date.now();
    const read = readHoursTable_();
    run.digest = read.digest;
    run.rows = read.table.rows.length;
    layoutHoursData_(data, run.rows);

    if (!tabs.hours) tabs.hours = insertHoursTab_(ss, hoursTabName(), hoursTabMark().hours);
    const notesBefore = layoutHoursTab_(ss, tabs, run.rows);
    hoursHoldStep_(tabs, run, { kind: "setup-built" }, null);
    hoursHoldStep_(tabs, run, { kind: "read" }, read);
    writeHoursNotes_(tabs, notesBefore);

    SpreadsheetApp.flush();
    const state = readHoursCells_(data);
    const passed =
      state.build !== null &&
      state.build.kind === "built" &&
      state.build.ms === start &&
      state.table !== null &&
      state.table.kind === "complete" &&
      state.tableTime === run.t &&
      data.getLastRow() === run.rows + 1 &&
      data.getMaxRows() === Math.max(2, run.rows + 1);
    if (!passed) throw new Error("Hours data didn't read back as this run wrote it");
    return { asOf: hoursTime_(run.t), monthlyHours: deleteMonthlyHours_(ss) };
  } catch (err) {
    const message = hoursMessage_(err);
    if (!tabs.data) throw err;
    hoursHoldStep_(tabs, run, { kind: "failed", message }, null);
    throw new Error(
      "Hours was not filled (" +
        (run.line || message) +
        "); Monthly Hours was kept. Fix that and run setupReports again.",
    );
  }
}

/**
 * Hours data's header row; rows for the header and rows rows, added in one call; the
 * number formats (text, Shifts "0", Hours "0.00") on whole columns from row 2; tab colour;
 * hidden.
 */
function layoutHoursData_(data, rows) {
  data.getRange(1, 1, 1, hoursDataHeaders().length).setValues([hoursDataHeaders()]);
  const max = data.getMaxRows();
  if (max < rows + 1) data.insertRowsAfter(max, rows + 1 - max);
  formatHoursRows_(data, 2, null);
  data.setTabColor(lookTabColours().hoursData);
  data.hideSheet();
}

/**
 * Hours data's number formats on rows from to to (null: to the sheet's last row), one
 * setNumberFormat per run of columns sharing a format, so the sheet keeps one format per
 * range and not one per cell.
 */
function formatHoursRows_(data, from, to) {
  const formats = hoursDataFormats();
  let first = 0;
  formats.forEach((format, i) => {
    if (formats[i + 1] === format) return;
    const a1 = columnLetter(first) + from + ":" + columnLetter(i) + (to === null ? "" : to);
    data.getRange(a1).setNumberFormat(format);
    first = i + 1;
  });
}

/**
 * The Hours tab laid out from hoursTabPlan: row 7's sort boxes read first, so each box
 * that holds one of its own choices keeps it (hoursBoxChoices; a new tab, or one laid out
 * before the boxes, gets the starting choices), and with them the header notes, which it
 * returns for writeHoursNotes_ (null when they couldn't be read: a failed read is logged
 * and never stops setupReports); every slicer, pivot, conditional format
 * rule, merge and data validation removed and the tab cleared whole (clear() leaves data
 * validation, so it is cleared on its own and no dropdown is left behind); rows for the
 * Shifts pivot (growHoursTab_) over rows rows, the table setupReports is about to write,
 * or over what Hours data holds now, whichever is more; A1's title, then B1 rendered, then
 * rows 2 to 7's text and the boxes' choices; then the formats, widths, heights, the boxes'
 * dropdowns, rules, pivots and slicers in one batchUpdate through the advanced Sheets
 * service; row 1 frozen; the tab colour. The status cells are written blank with the
 * other cells.
 */
function layoutHoursTab_(ss, tabs, rows) {
  const hours = tabs.hours;
  // A7:N7, or as much of it as the tab has.
  const boxRow =
    hours.getMaxRows() >= 7
      ? hours.getRange(7, 1, 1, Math.min(14, hours.getMaxColumns())).getValues()[0]
      : [];
  const choices = hoursBoxChoices(boxRow);
  let notesBefore = null;
  try {
    const cells = hours.getRange(hoursNoteCells().range);
    if (hours.getMaxRows() >= cells.getRow() && hours.getMaxColumns() >= cells.getLastColumn()) {
      notesBefore = cells.getNotes()[0];
    }
  } catch (err) {
    console.log("Hours: header notes not read: " + hoursMessage_(err));
  }
  hours.getSlicers().forEach((s) => s.remove());
  hours.getPivotTables().forEach((p) => p.remove());
  hours.clearConditionalFormatRules();
  const whole = hours.getRange(1, 1, hours.getMaxRows(), hours.getMaxColumns());
  whole.breakApart();
  whole.clearDataValidations();
  hours.clear();
  if (hours.getMaxColumns() < 16) {
    hours.insertColumnsAfter(hours.getMaxColumns(), 16 - hours.getMaxColumns());
  }
  // The pivots below list whatever Hours data holds as soon as they exist, and then the
  // table of rows rows lands, so the tab gets rows for the larger before they are made.
  growHoursTab_(hours, Math.max(rows, tabs.data.getLastRow() - 1));
  const plan = hoursTabPlan(hours.getSheetId(), tabs.data.getSheetId(), hoursOpenPath_(), choices);
  const [title, ...rest] = plan.cells;
  hours.getRange(title.a1).setValue(title.value);
  renderHoursLine_(tabs);
  rest.forEach((c) => hours.getRange(c.a1).setValue(c.value));
  Sheets.Spreadsheets.batchUpdate({ requests: plan.requests }, ss.getId());
  hours.setFrozenRows(plan.frozenRows);
  hours.setTabColor(plan.tabColor);
  return notesBefore;
}

/**
 * Puts the kiosk's note on each Hours header (hoursNoteCells) by the header-notes rule
 * (headerNotesRow, with the Hours lists): a cell whose note is empty or one of the kiosk's
 * own texts gets its header's note, and a note staff wrote is kept. before is the notes
 * read before the tab was changed, or null. It reads the notes now and takes, cell by
 * cell, the note now when it is a staff note, else the before note (hoursNotesExisting),
 * so a staff note that went missing in between is put back and one written since is
 * kept. Only cells whose note changes are written. Never throws: a failure is logged and
 * the caller, which has done its work, goes on.
 */
function writeHoursNotes_(tabs, before) {
  try {
    const cells = hoursNoteCells();
    const range = tabs.hours.getRange(cells.range);
    const now = range.getNotes()[0].map((n) => (n === null || n === undefined ? "" : String(n)));
    const kiosk = hoursHeaderNoteKioskTexts();
    const existing = hoursNotesExisting(now, before, kiosk);
    const want = headerNotesRow(cells.row, cells.names, cells.notes, existing, kiosk);
    want.forEach((note, i) => {
      if (note !== now[i]) tabs.hours.getRange(range.getRow(), range.getColumn() + i).setNote(note);
    });
  } catch (err) {
    console.log("Hours: header notes not written: " + hoursMessage_(err));
  }
}

/**
 * Gives the Hours tab hoursTabRows(rows) rows, in one call, when it has fewer, so the
 * Shifts pivot (one line per shift) never has to add rows to its tab while a table lands.
 * Never deletes a row.
 */
function growHoursTab_(hours, rows) {
  const max = hours.getMaxRows();
  const need = hoursTabRows(rows);
  if (max < need) hours.insertRowsAfter(max, need - max);
}

/**
 * The old Monthly Hours tab, deleted when it carries the kiosk's "Monthly Hours tab:"
 * protection: "deleted", "unmarked" (a tab of that name without it, left alone) or
 * "none".
 */
function deleteMonthlyHours_(ss) {
  const sheet = ss.getSheetByName(monthlyHoursTabName());
  if (!sheet) return "none";
  const prefix = reportProtectionPrefixes().monthlyHours;
  const marked = sheet
    .getProtections(SpreadsheetApp.ProtectionType.SHEET)
    .some((p) => cellString(p.getDescription()).indexOf(prefix) === 0);
  if (!marked) return "unmarked";
  ss.deleteSheet(sheet);
  return "deleted";
}

/**
 * One refresh of Hours for cause ("menu", "nightly" or "open"; setupReports refreshes
 * inside its own hold), in hold, which the caller's finally releases. Finds the tabs by
 * their marks; reads the Log and the Flags tab and works out the table holding no lock;
 * for an open, checks the budget (openedAtMs is when onOpen began); takes the lock with
 * the cause's wait; then writes what hoursNextState lists. A throw after the tabs are
 * found is caught and noted per the rule (failHoursRefresh_). Returns {kind, line,
 * message, timing}: kind is hoursNextState's decision, or "no-tabs", "busy" (the lock
 * wasn't free; nothing written) or "busy-failed" (a failure whose note couldn't be
 * written); line is B1's text as last rendered. out, when given, gets out.log, the Log as
 * readReportLog_ read it, as soon as the read is done, so the nightly Log check can use the
 * same read; a refresh that never read the Log leaves out.log unset.
 */
function refreshHours_(cause, hold, openedAtMs, out) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let tabs;
  try {
    tabs = findHoursTabs_(ss);
  } catch (err) {
    return { kind: "no-tabs", message: hoursMessage_(err) };
  }
  if (!tabs.hours || !tabs.data) return { kind: "no-tabs", message: "Run setupReports." };
  const run = hoursRun_(cause, Date.now());
  try {
    const read = readHoursTable_();
    if (out) out.log = read.log;
    run.digest = read.digest;
    run.rows = read.table.rows.length;
    run.timing.readMs = read.readMs;
    run.timing.workMs = read.workMs;
    if (cause === "open") {
      run.budget = hoursBudget(Date.now() - openedAtMs, readHoursCells_(tabs.data), run.rows);
    }
    if (!withHoursLock_(hold, hoursLockWait_(cause))) return { kind: "busy", timing: run.timing };
    run.heldAt = Date.now();
    const decision = hoursHoldStep_(tabs, run, { kind: "read" }, read);
    run.timing.holdMs = Date.now() - run.heldAt;
    return { kind: decision, line: run.line, timing: run.timing };
  } catch (err) {
    return failHoursRefresh_(tabs, hold, run, err);
  }
}

/**
 * A refresh's catch. Without the lock yet (the throw came before it), asks for it now with
 * the cause's wait, as this execution's one request; busy: "busy-failed", nothing
 * written. Then writes the failure's note as hoursNextState lists it (failed-write when
 * this run's mark is still in M1, failed-read, or nothing when a newer whole table is in),
 * renders and flushes. Never releases the lock.
 */
function failHoursRefresh_(tabs, hold, run, err) {
  const message = hoursMessage_(err);
  if (!hold.held) {
    if (!withHoursLock_(hold, hoursLockWait_(run.cause))) {
      return { kind: "busy-failed", message, timing: run.timing };
    }
    run.heldAt = Date.now();
  }
  const decision = hoursHoldStep_(tabs, run, { kind: "failed", message }, null);
  run.timing.holdMs = Date.now() - run.heldAt;
  return { kind: decision, line: run.line, message, timing: run.timing };
}

/** A run's record for hoursNextState and writeHours_; t is when its read starts. */
function hoursRun_(cause, t) {
  return {
    cause,
    t,
    mark: t,
    held: false,
    markWritten: false,
    digest: null,
    rows: 0,
    budget: null,
    heldAt: null,
    writeStart: null,
    line: "",
    timing: {},
  };
}

/**
 * One call of hoursNextState on the cells read back now, and its steps written. After the
 * first call in a hold, run.held is true, so the hold is settled once. Returns the
 * decision.
 */
function hoursHoldStep_(tabs, run, outcome, read) {
  const next = hoursNextState(
    readHoursCells_(tabs.data),
    Object.assign({}, run, { w: Date.now() }),
    outcome,
  );
  run.held = true;
  writeHours_(tabs, next.steps, run, read);
  return next.decision;
}

/**
 * Runs hoursNextState's steps in order, one call per step. Only with the document lock
 * held. read is readHoursTable_'s answer for a table write, else null.
 */
function writeHours_(tabs, steps, run, read) {
  const data = tabs.data;
  const rows = read ? read.table.rows : [];
  const width = hoursDataHeaders().length;
  steps.forEach((step) => {
    switch (step.op) {
      case "set": {
        const value = step.timing
          ? hoursTimingCell({
              readMs: read.readMs,
              workMs: read.workMs,
              writeMs: Date.now() - run.writeStart,
              rows: rows.length,
            })
          : step.value;
        data.getRange(step.cell).setValue(value);
        if (step.cell === "M1" && value === "writing " + run.mark) run.markWritten = true;
        break;
      }
      case "render":
        run.line = renderHoursLine_(tabs);
        break;
      case "flush":
        SpreadsheetApp.flush();
        break;
      case "grow": {
        run.writeStart = Date.now();
        growHoursTab_(tabs.hours, rows.length);
        const max = data.getMaxRows();
        const need = rows.length + 1;
        if (max < need) {
          data.insertRowsAfter(max, need - max);
          formatHoursRows_(data, max + 1, need);
        }
        break;
      }
      case "values":
        if (rows.length) data.getRange(2, 1, rows.length, width).setValues(rows);
        break;
      case "clear":
        data.getRange(2, 1, 1, width).clearContent();
        break;
      case "trim": {
        const keep = Math.max(2, rows.length + 1);
        const max = data.getMaxRows();
        if (max > keep) data.deleteRows(keep + 1, max - keep);
        break;
      }
      case "counts":
        tabs.hours.getRange("A3").setValue(read.table.countsLine);
        break;
      default:
        throw new Error("Unknown Hours step: " + step.op);
    }
  });
}

/**
 * Writes the Hours tab's B1, hoursLine of the state cells read back, and returns it. The
 * only writer of B1; only with the document lock held. No Hours tab yet: writes nothing.
 */
function renderHoursLine_(tabs) {
  if (!tabs.hours) return "";
  const line = hoursLine(readHoursCells_(tabs.data), hoursTime_);
  tabs.hours.getRange("B1").setValue(line);
  return line;
}

/** hoursState of Hours data's L1:Q1. */
function readHoursCells_(data) {
  return hoursState(data.getRange(hoursStateRange()).getValues()[0]);
}

/**
 * The Log and the Flags tab read and the table worked out, holding no lock: {table
 * (hoursTable's), digest (P1's text), readMs, workMs, log (readReportLog_'s answer)}. A
 * missing Log column throws the kiosk's message; a missing or broken Flags tab leaves its
 * count unknown.
 */
function readHoursTable_() {
  const readStart = Date.now();
  const log = readReportLog_();
  let flags = null;
  try {
    flags = readFlags_().rows;
  } catch (err) {
    flags = null;
  }
  const workStart = Date.now();
  const table = hoursTable(log.entries, flags, (ms) => zoneClock_(new Date(ms), kioskTimeZone()));
  const digest = hoursDigestCell(sha256Hex_(table.digestText));
  return { table, digest, readMs: workStart - readStart, workMs: Date.now() - workStart, log };
}

/** A Central "yyyy-MM-dd h:mm a", B1's time. */
function hoursTime_(ms) {
  return Utilities.formatDate(new Date(ms), kioskTimeZone(), "yyyy-MM-dd h:mm a");
}

function hoursMessage_(err) {
  return cellString(err && err.message) || String(err);
}

/** The menu's alert for a refresh's result. */
function hoursMenuText_(result) {
  const busy = "Another refresh or setupReports is writing Hours. Try again in a minute.";
  const newer = "Another refresh already put in newer tables. ";
  const failed = () => "This refresh failed: " + hoursSentence(result.message) + " ";
  switch (result.kind) {
    case "no-tabs":
      return result.message;
    case "busy":
      return busy;
    case "busy-failed":
      return failed() + busy;
    case "newer-in":
      return newer + result.line;
    case "quiet":
      return failed() + newer + result.line;
    default:
      return result.line;
  }
}

/**
 * One log line for a refresh: its cause and outcome, and the read, the work in Logic.js
 * and the hold timed apart, in ms. A failed run's hold runs from the lock to its failure
 * note.
 */
function hoursRunLog_(cause, result) {
  const t = result.timing || {};
  const ms = (n) => (n === undefined ? "-" : Math.round(n) + " ms");
  return (
    "Hours refresh (" +
    cause +
    "): " +
    result.kind +
    "; read " +
    ms(t.readMs) +
    ", Logic.js " +
    ms(t.workMs) +
    ", hold " +
    ms(t.holdMs) +
    "." +
    (result.message ? " " + result.message : "") +
    (result.line ? " B1: " + result.line : "")
  );
}

/**
 * The Log's "Kiosk: ..." filter views, through the advanced Sheets service: a view whose
 * title is already there is updated in place, so its link keeps working; a missing one is
 * added. Returns {added, updated}.
 */
function setupFilterViews_(ss, log, cols) {
  const sheetId = log.getSheetId();
  const got = Sheets.Spreadsheets.get(ss.getId(), {
    fields: "sheets(properties(sheetId),filterViews(filterViewId,title))",
  });
  const tab = (got.sheets || []).find((s) => s.properties && s.properties.sheetId === sheetId);
  const requests = filterViewRequests(
    filterViewSpecs(cols, sheetId),
    (tab && tab.filterViews) || [],
  );
  if (requests.length) Sheets.Spreadsheets.batchUpdate({ requests }, ss.getId());
  const added = requests.filter((r) => r.addFilterView).length;
  return { added, updated: requests.length - added };
}

/**
 * The warning-only protections on the Log's kiosk columns, one whole-column range each so
 * new rows are covered. Returns {kept, added, removed}.
 */
function setupKioskWarnings_(log, cols) {
  const wanted = kioskWarnHeaders().map((h) => {
    const letter = logLetter(cols, h);
    return letter + ":" + letter;
  });
  const protections = log.getProtections(SpreadsheetApp.ProtectionType.RANGE);
  const plan = ownedProtectionPlan(
    wanted,
    protections.map((p) => ({
      key: p.getRange().getA1Notation(),
      description: p.getDescription(),
    })),
    reportProtectionPrefixes().kioskColumn,
  );
  plan.remove.forEach((i) => protections[i].remove());
  plan.keep.forEach((i) => {
    const p = protections[i];
    if (p.getDescription() !== kioskWarnDescription()) p.setDescription(kioskWarnDescription());
    if (!p.isWarningOnly()) p.setWarningOnly(true);
  });
  plan.add.forEach((a1) =>
    log.getRange(a1).protect().setDescription(kioskWarnDescription()).setWarningOnly(true),
  );
  return { kept: plan.keep.length, added: plan.add.length, removed: plan.remove.length };
}

// ---------------------------------------------------------------------------
// The Monthly report dialog

/** Opens the Monthly report dialog from Report.html with a new key and the contact line in it. */
function openMonthlyReportDialog() {
  requireEditorRun_();
  const ui = SpreadsheetApp.getUi();
  const key = Utilities.getUuid();
  CacheService.getScriptCache().put(adminKeyCacheKey(key), "1", adminKeySeconds());
  const page = HtmlService.createTemplateFromFile("Report");
  page.key = key;
  page.contactNote = kioskContactNote(kioskContact_());
  ui.showModalDialog(page.evaluate().setWidth(460).setHeight(380), "Monthly report");
}

/**
 * {ok: true, months: [{month, label}], defaultMonth} for the dialog's month list: every
 * month with a dated Log row up to the current one, plus the current one, newest first.
 * Reads the Date column without the lock: a half-written row can't change which months
 * exist.
 */
function adminReportMonths(key) {
  const denied = adminGuard_(key);
  if (denied) return denied;
  const log = sheet_(LOG_TAB);
  const cols = reportColumns(logHeaderRow_(log));
  const last = log.getLastRow();
  const dates =
    last < 2 ? [] : log.getRange(2, cols[logHeaderNames().date] + 1, last - 1, 1).getValues();
  const listed = reportMonths(
    dates.map((cells) => ({ dateText: cellText_(cells[0]) })),
    centralDate_(new Date()),
  );
  return {
    ok: true,
    months: listed.months.map((month) => ({ month, label: monthName(month) })),
    defaultMonth: listed.defaultMonth,
  };
}

/**
 * Writes a frozen report tab for one month. form is {month: "yyyy-MM", initials}. Reads
 * the Log under the kiosk's lock, then writes a new tab "Report yyyy-MM" (or "(2)", "(3)"
 * ... when taken); an existing report tab is never changed. Replies {ok: true, tabName,
 * csvUrl, pdfUrl}, each link a download of that tab only, or a refusal.
 */
function adminMonthlyReport(key, form) {
  const denied = adminGuard_(key);
  if (denied) return denied;
  const f = form || {};
  const initials = normalizeInitials(f.initials);
  if (!initials) return refusal("ADMIN_INITIALS");
  const now = new Date();
  const month = cellString(f.month);
  const bad = reportMonthRefusal(month, centralDate_(now));
  if (bad) return refusal(bad);

  const log = withLock_(readReportLog_);
  if (!log.entries) return log;

  const rateCents = parseMoneyCents(readSettings_()[volunteerHourValueSetting()] || "");
  const report = monthReport(log.entries, month, rateCents, log.cols);
  const madeAt = Utilities.formatDate(now, kioskTimeZone(), "yyyy-MM-dd h:mm a");
  const sheet = writeReportTab_(month, reportRows(report, month, initials, madeAt));
  const urls = reportDownloadUrls(
    SpreadsheetApp.getActiveSpreadsheet().getId(),
    sheet.getSheetId(),
  );
  return { ok: true, tabName: sheet.getName(), csvUrl: urls.csvUrl, pdfUrl: urls.pdfUrl };
}

/** The Log's header map and every row as a report entry, from one read of the tab. */
function readReportLog_() {
  const sheet = sheet_(LOG_TAB);
  const width = Math.max(sheet.getLastColumn(), 1);
  const values = sheet.getRange(1, 1, Math.max(sheet.getLastRow(), 1), width).getValues();
  const cols = reportColumns(values[0].map(cellText_));
  const read = logRead_();
  return {
    cols,
    entries: values.slice(1).map((cells, i) => reportEntry(cells, i + 2, cols, read)),
  };
}

/**
 * A new tab at the end holding rows ({values, formats, kinds}, reportRows), formats
 * first, then values, one call each; styled once by reportTabLook (Logic.js); protected
 * warning-only and made the active tab. A report tab is never styled again.
 */
function writeReportTab_(month, rows) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const name = reportTabName(
    month,
    ss.getSheets().map((s) => s.getName()),
  );
  const sheet = ss.insertSheet(name, ss.getNumSheets());
  const height = rows.values.length;
  const width = rows.values[0].length;
  if (sheet.getMaxRows() < height) {
    sheet.insertRowsAfter(sheet.getMaxRows(), height - sheet.getMaxRows());
  }
  if (sheet.getMaxColumns() < width) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), width - sheet.getMaxColumns());
  }
  const range = sheet.getRange(1, 1, height, width);
  range.setNumberFormats(rows.formats);
  range.setValues(rows.values);
  styleReportTab_(sheet, reportTabLook(rows));
  sheet.protect().setDescription(reportTabDescription()).setWarningOnly(true);
  ss.setActiveSheet(sheet);
  SpreadsheetApp.flush();
  return sheet;
}

/** Applies a reportTabLook to a new report tab: one range list per style, then widths and the tab colour. */
function styleReportTab_(sheet, look) {
  look.styles.forEach((style) => {
    const list = sheet.getRangeList(style.ranges);
    if (style.background) list.setBackground(style.background);
    if (style.fontColor) list.setFontColor(style.fontColor);
    if (style.fontSize) list.setFontSize(style.fontSize);
    if (style.bold) list.setFontWeight("bold");
    if (style.bottomBorder) {
      list.setBorder(
        null,
        null,
        true,
        null,
        null,
        null,
        style.bottomBorder,
        SpreadsheetApp.BorderStyle.SOLID,
      );
    }
  });
  look.widths.forEach((w) => sheet.setColumnWidth(w.col, w.px));
  sheet.setTabColor(look.tabColour);
}
