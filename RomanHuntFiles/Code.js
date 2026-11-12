/**
 * ENCM volunteer check-in kiosk: server side (Google Apps Script).
 *
 * Data lives in two tabs of the spreadsheet this script is attached to:
 *   Volunteers: one row per person (first initial + last name only)
 *   Shifts:     one row per check-in; check_out is filled at check-out
 *
 * Column order matches schema.sql so the tabs can be imported into
 * SQLite/Postgres later. Don't reorder or rename the columns.
 */

const VOLUNTEERS = 'Volunteers';
const SHIFTS = 'Shifts';
const V_HEADERS = ['id', 'first_initial', 'last_name', 'hint', 'active', 'needs_review', 'created_at'];
const S_HEADERS = ['id', 'volunteer_id', 'name', 'check_in', 'check_out', 'hours', 'status', 'note'];
const AUTO_CLOSE_HOUR = 23; // nightly sweep of forgotten check-outs, 11 pm local time

/** Run once from the Apps Script editor: creates the tabs and the nightly trigger. */
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  PropertiesService.getScriptProperties().setProperty('SHEET_ID', ss.getId());
  ss.setSpreadsheetTimeZone(Session.getScriptTimeZone());

  makeSheet_(ss, VOLUNTEERS, V_HEADERS, ['G:G']);
  const shifts = makeSheet_(ss, SHIFTS, S_HEADERS, ['D:E']);
  shifts.getRange('F:F').setNumberFormat('0.00');

  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'autoCloseOpenShifts')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('autoCloseOpenShifts').timeBased().everyDays(1).atHour(AUTO_CLOSE_HOUR).create();
}

function makeSheet_(ss, name, headers, dateColumns) {
  const sh = ss.getSheetByName(name) || ss.insertSheet(name);
  sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
  sh.setFrozenRows(1);
  dateColumns.forEach(a1 => sh.getRange(a1).setNumberFormat('yyyy-mm-dd hh:mm:ss'));
  return sh;
}

/** Serves the kiosk page. */
function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('ENCM Volunteer Check-In')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** Active volunteers plus whether each is checked in right now. */
function getRoster() {
  const openSince = {};
  rows_(SHIFTS).forEach(s => {
    if (s.status === 'open') openSince[s.volunteer_id] = fmtTime_(s.check_in);
  });
  return rows_(VOLUNTEERS)
    .filter(v => v.active !== false)
    .map(v => ({
      id: v.id,
      name: displayName_(v),
      last: String(v.last_name),
      hint: String(v.hint || ''),
      inSince: openSince[v.id] || null,
    }));
}

/**
 * Checks the volunteer in, or out if they already have an open shift today.
 * The server decides which, so a stale screen can't create two open shifts.
 */
function toggleShift(volunteerId) {
  return withLock_(() => {
    const v = rows_(VOLUNTEERS).find(r => r.id === volunteerId);
    if (!v) throw new Error('Volunteer not found. Please ask a coordinator.');
    const sh = sheet_(SHIFTS);
    const shifts = rows_(SHIFTS);
    const now = new Date();
    const open = shifts.find(s => s.volunteer_id === volunteerId && s.status === 'open');

    if (open && sameDay_(open.check_in, now)) {
      // check_out (col 5), status (col 7); hours (col 6) is a formula
      sh.getRange(open._row, 5).setValue(now);
      sh.getRange(open._row, 7).setValue('closed');
      const hours = Math.round((now - open.check_in) / 36e5 * 100) / 100;
      return { action: 'out', name: displayName_(v), hours: hours };
    }

    if (open) autoClose_(sh, open); // left open from an earlier day

    sh.appendRow([nextId_(shifts), volunteerId, displayName_(v), now, '', '', 'open', '']);
    sh.getRange(sh.getLastRow(), 6)
      .setFormulaR1C1('=IF(R[0]C[-1]="","",ROUND((R[0]C[-1]-R[0]C[-2])*24,2))');
    return { action: 'in', name: displayName_(v), time: fmtTime_(now) };
  });
}

/** Self-registration from the kiosk. Flagged needs_review for the coordinator. */
function addVolunteer(initial, lastName, hint) {
  initial = String(initial || '').trim().charAt(0).toUpperCase();
  lastName = String(lastName || '').trim();
  hint = String(hint || '').trim();
  if (!initial || !lastName) throw new Error('Please enter your first initial and last name.');

  return withLock_(() => {
    const id = nextId_(rows_(VOLUNTEERS));
    sheet_(VOLUNTEERS).appendRow([id, initial, lastName, hint, true, true, new Date()]);
    return id;
  });
}

/** Nightly trigger: close anything still open, with no hours, for the coordinator to fix. */
function autoCloseOpenShifts() {
  withLock_(() => {
    const sh = sheet_(SHIFTS);
    rows_(SHIFTS).filter(s => s.status === 'open').forEach(s => autoClose_(sh, s));
  });
}

function autoClose_(sh, shift) {
  // status (col 7), note (col 8). check_out stays blank, so hours stays blank.
  sh.getRange(shift._row, 7, 1, 2).setValues([['auto_closed', 'Forgot to check out: enter real check_out, set status to closed']]);
}

// ---- helpers ----

function sheet_(name) {
  const id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  return SpreadsheetApp.openById(id).getSheetByName(name);
}

/** Reads a tab as objects keyed by header; _row is the sheet row number. */
function rows_(name) {
  const values = sheet_(name).getDataRange().getValues();
  const headers = values.shift();
  return values
    .map((r, i) => {
      const o = { _row: i + 2 };
      headers.forEach((h, j) => (o[h] = r[j]));
      return o;
    })
    .filter(o => o.id !== '');
}

function nextId_(rows) {
  return rows.reduce((max, r) => Math.max(max, Number(r.id) || 0), 0) + 1;
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function displayName_(v) {
  return v.first_initial + '. ' + v.last_name;
}

function fmtTime_(d) {
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'h:mm a');
}

function sameDay_(a, b) {
  const tz = Session.getScriptTimeZone();
  return Utilities.formatDate(a, tz, 'yyyy-MM-dd') === Utilities.formatDate(b, tz, 'yyyy-MM-dd');
}
