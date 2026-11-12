/**
 * Sheet access for the volunteer check-in kiosk: the Log and Settings tabs of the bound
 * Check-In Log spreadsheet, and Volunteer Profiles, which is only ever read.
 *
 * Every decision lives in Logic.js. Functions here read cells into plain values and
 * write values back. Names ending in _ are private to the server: the page can't call
 * them.
 */

const LOG_TAB = "Log";
/** Where setupSheets moves a Log tab still in the kiosk's old column layout. */
const OLD_LOG_TAB = "Log (old layout)";
const SETTINGS_TAB = "Settings";
const DATE_TIME_FORMAT = "yyyy-mm-dd h:mm am/pm";

// ---------------------------------------------------------------------------
// Run by hand from the editor

/**
 * Refuses a call unless the active user is known and is the account the script runs as
 * (the effective user). That holds in the Apps Script editor, where both are the owner,
 * and in the Kiosk admin menu and its dialogs, which run as the editor at the sheet. A
 * web-app caller's active user is empty (anonymous) or not the account the script runs
 * as, so it is refused. setupSheets and setupSampleProfiles have no trailing _ so the
 * editor's Run menu lists them, which also lets the page call them through
 * google.script.run without the access code; this check is what stops that.
 */
function requireEditorRun_() {
  const active = Session.getActiveUser().getEmail();
  if (!active || active !== Session.getEffectiveUser().getEmail()) {
    throw new Error("Run this from the Apps Script editor or the Kiosk admin menu.");
  }
}

/**
 * Creates or updates the Log and Settings tabs: the Log header, formats and any missing
 * Settings row (setupLog_ for the Log). Writes only empty cells and creates or renames
 * tabs; never changes a cell with text in it or deletes a row, so running it twice
 * changes nothing. Runs only from the Apps Script editor.
 */
function setupSheets() {
  requireEditorRun_();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss.getSpreadsheetTimeZone() !== kioskTimeZone()) {
    ss.setSpreadsheetTimeZone(kioskTimeZone());
  }

  setupLog_(ss);

  const settings = ss.getSheetByName(SETTINGS_TAB) || ss.insertSheet(SETTINGS_TAB);
  settings.getRange("A:B").setNumberFormat("@");
  const settingsHeader = settings.getRange(1, 1, 1, 2);
  if (settingsHeader.getValues()[0].every((v) => cellText_(v) === "")) {
    settingsHeader.setValues([["Setting", "Value"]]);
  }
  settings.setFrozenRows(1);
  const existing = readSettings_();
  const missing = settingsDefaults(centralDate_(new Date())).filter(
    (row) => !Object.prototype.hasOwnProperty.call(existing, row[0]),
  );
  if (missing.length) {
    settings.getRange(settings.getLastRow() + 1, 1, missing.length, 2).setValues(missing);
  }
}

/**
 * The Log part of setupSheets.
 * - No Log tab: create one with the full header.
 * - A Log in the kiosk's old layout (isOldLogLayout): rename it OLD_LOG_TAB and create a
 *   new Log with the full header. Its rows are not converted and count for nothing. If
 *   OLD_LOG_TAB already exists, stop and name it.
 * - Otherwise write the headers logHeaderWrites (Logic.js) names into empty cells of row 1.
 * Then set each kiosk column's format by its header and freeze row 1.
 */
function setupLog_(ss) {
  let log = ss.getSheetByName(LOG_TAB);
  if (log && isOldLogLayout(logHeaderRow_(log))) {
    if (ss.getSheetByName(OLD_LOG_TAB)) {
      throw new Error(
        'The Log tab is in the old layout and a "' +
          OLD_LOG_TAB +
          '" tab already exists. Rename or remove "' +
          OLD_LOG_TAB +
          '", then run setupSheets() again.',
      );
    }
    log.setName(OLD_LOG_TAB);
    log = null;
  }
  if (!log) log = ss.insertSheet(LOG_TAB);

  const writes = logHeaderWrites(logHeaderRow_(log));
  if (writes.length) {
    const first = writes[0].col;
    const last = writes[writes.length - 1].col;
    if (last > log.getMaxColumns()) {
      log.insertColumnsAfter(log.getMaxColumns(), last - log.getMaxColumns());
    }
    log
      .getRange(1, first, 1, writes.length)
      .setNumberFormat("@")
      .setValues([writes.map((w) => w.header)]);
  }
  logColumnFormats(logHeaderRow_(log)).forEach((f) =>
    log.getRange(1, f.col, log.getMaxRows(), 1).setNumberFormat(logFormat_(f.kind)),
  );
  log.setFrozenRows(1);
}

/** Row 1 of a tab as text, at least one cell wide. */
function logHeaderRow_(sheet) {
  const width = Math.max(sheet.getLastColumn(), 1);
  return sheet.getRange(1, 1, 1, width).getValues()[0].map(cellText_);
}

/**
 * Development only: creates "Volunteer Profiles (sample)" from SampleData.js and points
 * Settings at it. Does nothing when Settings already names a Profiles file. Runs only
 * from the Apps Script editor.
 */
function setupSampleProfiles() {
  requireEditorRun_();
  if (readSettings_()["Volunteer Profiles file ID"]) {
    Logger.log("Settings already names a Volunteer Profiles file; nothing done.");
    return;
  }
  const rows = sampleProfileRows_();
  const file = SpreadsheetApp.create("Volunteer Profiles (sample)");
  const sheet = file.getSheets()[0];
  sheet.setName("Volunteer Profiles");
  sheet.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
  sheet.setFrozenRows(1);
  setSetting_("Volunteer Profiles file ID", file.getId());
  Logger.log("Created " + file.getUrl());
}

// ---------------------------------------------------------------------------
// Cells and time

function isDate_(value) {
  return Object.prototype.toString.call(value) === "[object Date]";
}

/** A cell as text: a Date as its Central yyyy-MM-dd, anything else trimmed. */
function cellText_(value) {
  if (isDate_(value)) return centralDate_(value);
  return cellString(value);
}

/**
 * A date-time cell as {ms, date, clock}: its milliseconds, its Central yyyy-MM-dd and its
 * Central "HH:mm". A date value has all three; Sheets keeps a time typed with no date as a
 * date on 1899-12-30, whose clock is the time as typed. Text that clockText (Logic.js)
 * reads as a time of day gives only the clock, with ms NaN and date empty; other text is
 * read by Date.parse, with clock empty. ms is NaN and date and clock empty when the cell
 * isn't a readable time.
 */
function cellTime_(value) {
  const none = { ms: NaN, date: "", clock: "" };
  if (isDate_(value)) {
    const ms = value.getTime();
    if (!isFinite(ms)) return none;
    return {
      ms,
      date: centralDate_(value),
      clock: Utilities.formatDate(value, kioskTimeZone(), "HH:mm"),
    };
  }
  const text = cellString(value);
  const clock = clockText(text);
  if (clock) return { ms: NaN, date: "", clock };
  const ms = text ? Date.parse(text) : NaN;
  return isFinite(ms) ? { ms, date: centralDate_(new Date(ms)), clock: "" } : none;
}

/**
 * A Central time on a date as {ms, date}: dateText yyyy-MM-dd and timeText "HH:mm". ms is
 * NaN and date '' when either can't be read. A time skipped when daylight time starts
 * reads as the later time Utilities.parseDate gives.
 */
function timeOnDate_(dateText, timeText) {
  const text = adminDateTimeText(dateText, timeText);
  if (!text) return { ms: NaN, date: "" };
  const parsed = Utilities.parseDate(text, kioskTimeZone(), "yyyy-MM-dd HH:mm");
  return { ms: parsed.getTime(), date: centralDate_(parsed) };
}

function centralDate_(date) {
  return Utilities.formatDate(date, kioskTimeZone(), "yyyy-MM-dd");
}

function sha256Hex_(text) {
  return bytesToHex(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8),
  );
}

// ---------------------------------------------------------------------------
// Settings

function sheet_(name) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sheet) throw new Error('The "' + name + '" tab is missing. Run setupSheets().');
  return sheet;
}

/** Settings as {name: text}; the first row with a name wins. */
function readSettings_() {
  const values = sheet_(SETTINGS_TAB).getDataRange().getValues();
  const settings = {};
  for (let i = 1; i < values.length; i++) {
    const name = cellText_(values[i][0]);
    if (name && !Object.prototype.hasOwnProperty.call(settings, name)) {
      settings[name] = cellText_(values[i][1]);
    }
  }
  return settings;
}

/** Writes one Settings value, found by its name in column A, appending the row if missing. */
function setSetting_(name, value) {
  const sheet = sheet_(SETTINGS_TAB);
  const names = sheet.getRange(1, 1, Math.max(sheet.getLastRow(), 1), 1).getValues();
  let row = 0;
  for (let i = 1; i < names.length; i++) {
    if (cellText_(names[i][0]) === name) {
      row = i + 1;
      break;
    }
  }
  if (!row) {
    row = sheet.getLastRow() + 1;
    sheet.getRange(row, 1).setNumberFormat("@").setValue(name);
  }
  sheet.getRange(row, 2).setNumberFormat("@").setValue(value);
}

// ---------------------------------------------------------------------------
// Volunteer Profiles

/**
 * The kiosk list [{id, firstName, lastName, phoneLast4, startDate, needsPhoneCheck,
 * token, row}], from the cache when it holds one. On a cache miss it reads Profiles in one
 * call and rewrites the Settings "Profiles problems" value. Never writes to Profiles. The
 * cache key carries profilesCacheVersion(), so a list cached in an older shape is never
 * read.
 */
function getProfiles_(settings) {
  const fileId = settings["Volunteer Profiles file ID"];
  const tabName = settings["Volunteer Profiles tab"] || "Volunteer Profiles";
  if (!fileId) throw new Error('The Settings value "Volunteer Profiles file ID" is empty.');

  const cache = CacheService.getScriptCache();
  const key = profilesCacheKey(fileId, tabName);
  const hit = cache.get(key);
  if (hit) return JSON.parse(hit);

  const sheet = SpreadsheetApp.openById(fileId).getSheetByName(tabName);
  if (!sheet) throw new Error('Volunteer Profiles has no tab named "' + tabName + '".');
  const values = sheet
    .getDataRange()
    .getValues()
    .map((row) => row.map(cellText_));
  const parsed = parseProfiles(values[0] || [], values.slice(1), sha256Hex_);

  const problems = parsed.problems.map((p) => p.text).join("\n");
  if (problems !== (settings["Profiles problems"] || "")) {
    setSetting_("Profiles problems", problems);
  }

  const json = JSON.stringify(parsed.volunteers);
  if (utf8Length(json) <= profilesCacheMaxBytes()) {
    cache.put(key, json, profilesCacheSeconds());
  }
  return parsed.volunteers;
}

// ---------------------------------------------------------------------------
// Log

/**
 * The read functions logEntry (Logic.js) uses to turn cells into text and times, and to
 * put a time with no date on the row's Date.
 */
function logRead_() {
  return { text: cellText_, time: cellTime_, at: timeOnDate_ };
}

/** The number format a Log column of this kind (logColumnKinds) gets. */
function logFormat_(kind) {
  if (kind === "time") return DATE_TIME_FORMAT;
  if (kind === "hours") return "0.00";
  return "@";
}

/**
 * The Log's header map (logColumns, Logic.js), from row 1 read once. Throws when a
 * column the kiosk needs is missing or repeated.
 */
function readLogColumns_() {
  const sheet = sheet_(LOG_TAB);
  const width = Math.max(sheet.getLastColumn(), 1);
  return logColumns(sheet.getRange(1, 1, 1, width).getValues()[0].map(cellText_));
}

/** Every Log row as a log entry (Logic.js), read across the Log's full width. */
function readLog_(cols) {
  const sheet = sheet_(LOG_TAB);
  const last = sheet.getLastRow();
  if (last < 2) return [];
  const values = sheet.getRange(2, 1, last - 1, sheet.getLastColumn()).getValues();
  const read = logRead_();
  return values.map((cells, i) => logEntry(cells, i + 2, cols, read));
}

/**
 * Log rows dated today, in any row order. Reads the Date column found by the header
 * map, then only the block of rows from the first to the last of today's, across the
 * full width.
 */
function readTodayLog_(todayDate, cols) {
  const sheet = sheet_(LOG_TAB);
  const last = sheet.getLastRow();
  if (last < 2) return [];
  const dates = sheet.getRange(2, cols[logHeaderNames().date] + 1, last - 1, 1).getValues();
  const today = [];
  dates.forEach((cells, i) => {
    if (isRowToday(cellText_(cells[0]), todayDate)) today.push(i + 2);
  });
  if (!today.length) return [];
  const first = today[0];
  const values = sheet
    .getRange(first, 1, today[today.length - 1] - first + 1, sheet.getLastColumn())
    .getValues();
  const read = logRead_();
  return today.map((row) => logEntry(values[row - first], row, cols, read));
}

/**
 * Writes a cell map (Logic.js) on one row. Each cell gets its column's format before its
 * value, in case staff reformatted the column; times go in as Dates. Columns the map
 * doesn't name are left alone.
 */
function writeLogCells_(sheet, row, cells, cols) {
  cellWrites(cells, cols).forEach((w) => {
    const value = w.kind === "time" && w.value !== "" ? new Date(w.value) : w.value;
    sheet.getRange(row, w.col).setNumberFormat(logFormat_(w.kind)).setValue(value);
  });
}

/** Writes a new row (a cell map) on the next empty Log row. Returns the row number. */
function appendLogRow_(cells, cols) {
  const sheet = sheet_(LOG_TAB);
  const row = sheet.getLastRow() + 1;
  if (row > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), 50);
  writeLogCells_(sheet, row, cells, cols);
  return row;
}

/** Writes a cell map onto an existing Log row. */
function updateLogRow_(row, cells, cols) {
  writeLogCells_(sheet_(LOG_TAB), row, cells, cols);
}
