/**
 * The Kiosk admin menu in the Check-In Log spreadsheet: Add a shift for a volunteer who
 * forgot to check in and out, Fix a sign-out for an open row whose volunteer forgot to
 * check out, Remove a shift to move one Log row, found by its Shift ID, to the Removed
 * shifts tab, and Restore a shift to put one back. Each item opens a dialog from
 * AdminDialog.html, which calls the admin* functions below through google.script.run. The
 * menu's other items follow the same rule: Monthly report (Reports.js), Import past hours
 * (Import.js), Refresh Hours (refreshHoursNow, Reports.js) and Check the Log now
 * (checkLogNow, Jobs.js). Refresh Hours and Check the Log now open no dialog, so they need
 * no key: they check requireEditorRun_ and SpreadsheetApp.getUi() before they read
 * anything.
 *
 * The menu and google.script.run can only call public names (no trailing _), so the
 * kiosk page could name these functions too. Every public function here therefore checks
 * two things before it reads or writes anything (tests/admin.test.mjs holds every public
 * function to this):
 *   1. requireEditorRun_(): the person at the sheet runs it under their own account. An
 *      anonymous web-app caller is refused.
 *   2. A dialog key. The openers make one only after SpreadsheetApp.getUi() works (it
 *      throws anywhere but the spreadsheet's own UI), keep it in the script cache, and put
 *      it only into the dialog's HTML. No function returns a key. Every admin* function
 *      takes the key first and refuses with ADMIN_EXPIRED when the cache doesn't hold it.
 *      Check 1 alone would let the script owner's own browser through the web app; the
 *      key closes that.
 * onOpen runs as a simple trigger, where requireEditorRun_ can't pass. It calls getUi()
 * first and adds the menu before anything else: getUi() throws outside the spreadsheet's
 * own UI, so a call from the web app stops there, and a failure in what follows never costs
 * the menu. Then, in a try/catch, it notes on the Hours tab that opening didn't refresh it
 * (noteHoursOnOpen_ in Reports.js: one hold of the document lock, N1 and B1 only, no Log
 * read), and releases the lock in its own finally.
 *
 * The rules themselves are in Logic.js (decideAddShift, decideFixSignOut, decideRemove,
 * decideRestore); this file reads and writes the Log, the Removed shifts tab and the Flags
 * tab through Sheets.js, under the kiosk's lock.
 */

/**
 * Adds the Kiosk admin menu when the spreadsheet opens, then notes on the Hours tab that
 * opening didn't refresh it. From the web app it throws at getUi.
 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("Kiosk admin")
    .addItem("Add a shift…", "openAddShiftDialog")
    .addItem("Fix a sign-out…", "openFixSignOutDialog")
    .addItem("Remove a shift…", "openRemoveShiftDialog")
    .addItem("Restore a shift…", "openRestoreShiftDialog")
    .addItem("Monthly report…", "openMonthlyReportDialog")
    .addItem("Import past hours…", "openImportDialog")
    .addItem("Refresh Hours", "refreshHoursNow")
    .addItem("Check the Log now", "checkLogNow")
    .addToUi();
  const hold = hoursHold_();
  try {
    noteHoursOnOpen_(hold);
  } catch (err) {
    console.log("Hours note (open) failed: " + hoursMessage_(err));
  } finally {
    releaseHoursLock_(hold);
  }
}

function openAddShiftDialog() {
  openAdminDialog_("add", "Add a shift");
}

function openFixSignOutDialog() {
  openAdminDialog_("fix", "Fix a sign-out");
}

function openRemoveShiftDialog() {
  openAdminDialog_("remove", "Remove a shift");
}

function openRestoreShiftDialog() {
  openAdminDialog_("restore", "Restore a shift");
}

/** {ok: true, today, volunteers: [{id, label}]} for the volunteer picker, or a refusal. */
function adminRoster(key) {
  const denied = adminGuard_(key);
  if (denied) return denied;
  return {
    ok: true,
    today: centralDate_(new Date()),
    volunteers: adminRosterLabels(getProfiles_(readSettings_())),
  };
}

/** {ok: true, shifts: [{shiftId, label}]}: every open row with a Shift ID, newest first. */
function adminOpenShifts(key) {
  const denied = adminGuard_(key);
  if (denied) return denied;
  return { ok: true, shifts: openShiftChoices(readLog_(readLogColumns_()), adminClock_) };
}

/**
 * Adds a closed shift for a volunteer. form is {id, date, inTime, outTime, note,
 * initials}: date yyyy-MM-dd and times HH:mm, Central. {ok: true, row, name, hours} or a
 * refusal.
 */
function adminAddShift(key, form) {
  const denied = adminGuard_(key);
  if (denied) return denied;
  const f = form || {};
  return withLock_(() => {
    const now = new Date();
    const cols = readLogColumns_();
    const at = (time) => timeOnDate_(f.date, time);
    const inTime = at(f.inTime);
    const outTime = at(f.outTime);
    const decision = decideAddShift({
      volunteers: getProfiles_(readSettings_()),
      id: f.id,
      entries: readLog_(cols),
      todayDate: centralDate_(now),
      nowMs: now.getTime(),
      date: f.date,
      inMs: inTime.ms,
      inDate: inTime.date,
      outMs: outTime.ms,
      outDate: outTime.date,
      initials: f.initials,
      note: f.note,
      shiftId: Utilities.getUuid(),
    });
    if (decision.refusal) return adminRefusal_(decision);
    const row = appendLogRow_(decision.cells, cols);
    return {
      ok: true,
      row,
      name: volunteerFullName(decision.volunteer),
      hours: decision.hours,
    };
  });
}

/**
 * Closes an open row found by its Shift ID. form is {shiftId, outTime, note, initials};
 * the time is on the row's own Date. {ok: true, row, name, hours} or a refusal.
 */
function adminFixSignOut(key, form) {
  const denied = adminGuard_(key);
  if (denied) return denied;
  const f = form || {};
  return withLock_(() => {
    const now = new Date();
    const cols = readLogColumns_();
    const entries = readLog_(cols);
    const rows = openRowsById(entries, f.shiftId);
    const outTime = timeOnDate_(rows.length ? rowDate(rows[0].dateText) : "", f.outTime);
    const decision = decideFixSignOut({
      entries,
      shiftId: f.shiftId,
      nowMs: now.getTime(),
      outMs: outTime.ms,
      outDate: outTime.date,
      initials: f.initials,
      note: f.note,
    });
    if (decision.refusal) return adminRefusal_(decision);
    updateLogRow_(decision.open.row, decision.cells, cols);
    return {
      ok: true,
      row: decision.open.row,
      name: decision.open.name,
      hours: decision.hours,
    };
  });
}

/**
 * Remove a shift's list of rows: {ok: true, shifts: [{shiftId, row, label, detail}]}, or a
 * refusal. query is {shiftId} (the rows with that Shift ID) or {id, date} (that
 * volunteer's rows on that yyyy-MM-dd Date). Rows with no Shift ID aren't listed: the menu
 * acts by Shift ID, so staff delete such a row by hand. Reads only, and takes no lock.
 */
function adminFindShifts(key, query) {
  const denied = adminGuard_(key);
  if (denied) return denied;
  const q = query || {};
  const cols = readLogColumns_();
  const shiftId = cellString(q.shiftId);
  let rows;
  if (shiftId) {
    rows = logShiftIdRows_(cols, shiftId);
  } else {
    const volunteer = findVolunteer(getProfiles_(readSettings_()), q.id);
    if (!volunteer) return refusal("ADMIN_NOT_FOUND");
    const date = cellString(q.date);
    if (!date || parseStartDate(date) !== date) return refusal("ADMIN_BAD_TIME");
    rows = readLogTable_(volunteer.token)
      .entries.filter((e) => rowDate(e.dateText) === date && cellString(e.shiftId))
      .map((e) => e.row);
  }
  return { ok: true, shifts: shiftChoices_(readShiftRows_(rows, cols)) };
}

/**
 * Moves one Log row to the Removed shifts tab. form is {shiftId, row, reason, initials}:
 * row is the Log row the dialog showed, which picks among rows that share the Shift ID.
 * The row's Flags rows are ticked Reviewed (markShiftFlags_). {ok: true, name, date,
 * flagsMarked, flagsLeft, flagsFailed} or a refusal: flagsLeft counts the flags left for
 * another row that still has the Shift ID, and flagsFailed is true when the Flags step
 * threw after the row was moved, which is logged.
 */
function adminRemoveShift(key, form) {
  const denied = adminGuard_(key);
  if (denied) return denied;
  const f = form || {};
  return withLock_(() => {
    const now = new Date();
    const shiftId = cellString(f.shiftId);
    const log = sheet_(LOG_TAB);
    const logHeader = logHeaderRow_(log);
    const cols = logColumns(logHeader);
    const candidates = shiftId ? readShiftRows_(logShiftIdRows_(cols, shiftId), cols) : [];
    const decision = decideRemove({
      candidates,
      shiftId,
      row: f.row,
      reason: f.reason,
      initials: f.initials,
      logHeader,
    });
    if (decision.refusal) return adminRefusal_(decision);
    const target = decision.target;
    const removed = removedSheet_(logHeader);
    const removedRow = appendRemovedRow_(
      removed,
      logHeader,
      target.values,
      target.formats,
      decision.initials,
      decision.reason,
      now.getTime(),
    );
    SpreadsheetApp.flush();
    const idCell = log.getRange(target.row, cols[logHeaderNames().shiftId] + 1).getValues();
    if (cellText_(idCell[0][0]) !== shiftId) {
      removed.sheet.deleteRow(removedRow);
      return refusal("ADMIN_REMOVE_MOVED");
    }
    deleteLogRow_(target.row);
    const flags = markFlagsSafely_(shiftId, {
      tick: true,
      initials: decision.initials,
      note: removeFlagNote(decision.initials, decision.reason, centralDate_(now)),
      only: {
        row: target.row,
        date: target.entry.dateText,
        name: target.entry.name,
        remaining: decision.remaining,
      },
    });
    return {
      ok: true,
      name: target.entry.name,
      date: rowDate(target.entry.dateText) || target.entry.dateText,
      flagsMarked: flags.marked,
      flagsLeft: flags.left,
      flagsFailed: flags.failed,
    };
  });
}

/**
 * Restore a shift's list: {ok: true, shifts: [{shiftId, row, label, detail}]}, the
 * Removed shifts rows that have a Shift ID, newest Removed at first. No tab lists none.
 */
function adminRemovedShifts(key) {
  const denied = adminGuard_(key);
  if (denied) return denied;
  const removed = readRemoved_();
  if (!removed) return { ok: true, shifts: [] };
  const at = (r) => (isFinite(r.entry.removedAtMs) ? r.entry.removedAtMs : -Infinity);
  const rows = removed.rows
    .filter((r) => cellString(r.entry.shiftId))
    .sort((a, b) => at(b) - at(a) || b.row - a.row);
  return { ok: true, shifts: shiftChoices_(rows) };
}

/**
 * Puts a Removed shifts row back at the end of the Log, mapped by header, and deletes it
 * from the Removed tab. form is {shiftId, row, initials}. The Shift ID's Flags rows get a
 * note and are otherwise left as they are. {ok: true, name, date, logRow, flagsFailed} or
 * a refusal.
 */
function adminRestoreShift(key, form) {
  const denied = adminGuard_(key);
  if (denied) return denied;
  const f = form || {};
  return withLock_(() => {
    const now = new Date();
    const shiftId = cellString(f.shiftId);
    const removed = readRemoved_();
    const logHeader = logHeaderRow_(sheet_(LOG_TAB));
    const cols = logColumns(logHeader);
    const candidates =
      removed && shiftId ? removed.rows.filter((r) => cellString(r.entry.shiftId) === shiftId) : [];
    const picked = pickShiftRow(candidates, f.row);
    const tokenEntries =
      picked && isStatus(picked.entry, "open") ? readLogTable_(picked.entry.token).entries : [];
    const decision = decideRestore({
      candidates,
      shiftId,
      row: f.row,
      initials: f.initials,
      logShiftIds: readLogShiftIds_(cols),
      tokenEntries,
      removedHeader: removed ? removed.header : [],
      logHeader,
    });
    if (decision.refusal) return adminRefusal_(decision);
    const target = decision.target;
    const idAt = logHeaderIndexes(removed.header, logHeaderNames().shiftId)[0];
    const idCell = removed.sheet.getRange(target.row, idAt + 1).getValues();
    if (cellText_(idCell[0][0]) !== shiftId) return refusal("ADMIN_RESTORE_MOVED");
    const fromHeader = removed.header.map((h) => (isRemovedExtraHeader(h) ? "" : h));
    const width = logHeader.length;
    const logRow = appendLogValues_(
      headerMapCopy(fromHeader, target.values, logHeader, width),
      headerMapCopy(fromHeader, target.formats, logHeader, width),
      cols,
    );
    removed.sheet.deleteRow(target.row);
    const flags = markFlagsSafely_(shiftId, {
      tick: false,
      note: restoreFlagNote(decision.initials, centralDate_(now)),
    });
    return {
      ok: true,
      name: target.entry.name,
      date: rowDate(target.entry.dateText) || target.entry.dateText,
      logRow,
      flagsFailed: flags.failed,
    };
  });
}

/** The list items Remove and Restore show, [{shiftId, row, label, detail}], from rows. */
function shiftChoices_(rows) {
  return rows.map((r) => {
    const shown = shiftChoiceLabel(r.entry, adminClock_);
    return { shiftId: r.entry.shiftId, row: r.row, label: shown.label, detail: shown.detail };
  });
}

/**
 * markShiftFlags_ after the Log write, as {marked, left, failed}. The row has already
 * moved, so a Flags step that throws is logged with the Shift ID and doesn't undo it.
 */
function markFlagsSafely_(shiftId, opts) {
  try {
    const done = markShiftFlags_(shiftId, opts);
    return { marked: done.marked, left: done.left, failed: false };
  } catch (e) {
    console.error(
      "Flags: not marked for Shift ID " + shiftId + ": " + (e && e.message ? e.message : String(e)),
    );
    return { marked: 0, left: 0, failed: true };
  }
}

/**
 * The two checks every admin* function makes before anything else: null when both pass,
 * else the ADMIN_EXPIRED refusal. Throws when the caller isn't the person at the sheet.
 */
function adminGuard_(key) {
  requireEditorRun_();
  const k = cellString(key);
  if (!k || !CacheService.getScriptCache().get(adminKeyCacheKey(k))) {
    return refusal("ADMIN_EXPIRED");
  }
  return null;
}

/**
 * Opens a dialog from AdminDialog.html with a new key in it. mode is "add", "fix",
 * "remove" or "restore".
 */
function openAdminDialog_(mode, title) {
  requireEditorRun_();
  const ui = SpreadsheetApp.getUi();
  const key = Utilities.getUuid();
  CacheService.getScriptCache().put(adminKeyCacheKey(key), "1", adminKeySeconds());
  const page = HtmlService.createTemplateFromFile("AdminDialog");
  page.key = key;
  page.mode = mode;
  ui.showModalDialog(page.evaluate().setWidth(480).setHeight(600), title);
}

/**
 * A refusal reply; an overlap names the row it conflicts with, and a header refusal the
 * column it can't move.
 */
function adminRefusal_(decision) {
  if (decision.header) {
    const r = refusal(decision.refusal);
    return {
      ok: false,
      refusal: r.refusal,
      message: r.message + ' Column: "' + decision.header + '".',
    };
  }
  if (decision.refusal !== "ADMIN_OVERLAP") return refusal(decision.refusal);
  return overlapRefusal(decision.conflict, adminClock_, decision.openStartMs);
}

/** A Central clock time such as "9:00 AM". */
function adminClock_(ms) {
  return Utilities.formatDate(new Date(ms), kioskTimeZone(), "h:mm a");
}
