/**
 * The Kiosk admin menu in the Check-In Log spreadsheet: Add a shift for a volunteer who
 * forgot to check in and out, and Fix a sign-out for an open row whose volunteer forgot
 * to check out. Each item opens a dialog from AdminDialog.html, which calls the admin*
 * functions below through google.script.run. The menu's third item, Monthly report, is in
 * Reports.js, and its fourth, Import past hours, in Import.js; both follow the same rule.
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
 * onOpen only adds the menu: it reads and writes nothing, and runs as a simple trigger,
 * where requireEditorRun_ can't pass.
 *
 * The rules themselves are in Logic.js (decideAddShift, decideFixSignOut); this file reads
 * and writes the Log through Sheets.js, under the kiosk's lock.
 */

/** Adds the Kiosk admin menu when the spreadsheet opens. From the web app it throws at getUi. */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("Kiosk admin")
    .addItem("Add a shift…", "openAddShiftDialog")
    .addItem("Fix a sign-out…", "openFixSignOutDialog")
    .addItem("Monthly report…", "openMonthlyReportDialog")
    .addItem("Import past hours…", "openImportDialog")
    .addToUi();
}

function openAddShiftDialog() {
  openAdminDialog_("add", "Add a shift");
}

function openFixSignOutDialog() {
  openAdminDialog_("fix", "Fix a sign-out");
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

/** Opens a dialog from AdminDialog.html with a new key in it. mode is "add" or "fix". */
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

/** A refusal reply; an overlap names the row it conflicts with. */
function adminRefusal_(decision) {
  if (decision.refusal !== "ADMIN_OVERLAP") return refusal(decision.refusal);
  return overlapRefusal(decision.conflict, adminClock_, decision.openStartMs);
}

/** A Central clock time such as "9:00 AM". */
function adminClock_(ms) {
  return Utilities.formatDate(new Date(ms), kioskTimeZone(), "h:mm a");
}
