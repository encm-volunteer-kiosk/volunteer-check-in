/**
 * Sheet access for the volunteer check-in kiosk: the Log and Settings tabs of the bound
 * Check-In Log spreadsheet, and Volunteer Profiles, which is only ever read.
 *
 * Every decision lives in Logic.js. Functions here read cells into plain values and
 * write values back. Names ending in _ are private to the server: the page can't call
 * them.
 */

const LOG_TAB = 'Log';
const SETTINGS_TAB = 'Settings';
const DATE_TIME_FORMAT = 'yyyy-mm-dd h:mm am/pm';

// ---------------------------------------------------------------------------
// Run by hand from the editor

/**
 * Creates the Log and Settings tabs, the Log header, formats and any missing Settings
 * row. Never overwrites a non-empty cell or deletes a row, so running it twice changes
 * nothing.
 */
function setupSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss.getSpreadsheetTimeZone() !== kioskTimeZone()) {
    ss.setSpreadsheetTimeZone(kioskTimeZone());
  }

  const log = ss.getSheetByName(LOG_TAB) || ss.insertSheet(LOG_TAB);
  const headers = logHeaders();
  const header = log.getRange(1, 1, 1, headers.length);
  ['A:E', 'J:L'].forEach((a1) => log.getRange(a1).setNumberFormat('@'));
  log.getRange('F:H').setNumberFormat(DATE_TIME_FORMAT);
  log.getRange('I:I').setNumberFormat('0.00');
  if (header.getValues()[0].every((v) => cellText_(v) === '')) {
    header.setValues([headers]);
  }
  log.setFrozenRows(1);

  const settings = ss.getSheetByName(SETTINGS_TAB) || ss.insertSheet(SETTINGS_TAB);
  settings.getRange('A:B').setNumberFormat('@');
  const settingsHeader = settings.getRange(1, 1, 1, 2);
  if (settingsHeader.getValues()[0].every((v) => cellText_(v) === '')) {
    settingsHeader.setValues([['Setting', 'Value']]);
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
 * Development only: creates "Volunteer Profiles (sample)" from SampleData.js and points
 * Settings at it. Does nothing when Settings already names a Profiles file.
 */
function setupSampleProfiles() {
  if (readSettings_()['Volunteer Profiles file ID']) {
    Logger.log('Settings already names a Volunteer Profiles file; nothing done.');
    return;
  }
  const rows = sampleProfileRows_();
  const file = SpreadsheetApp.create('Volunteer Profiles (sample)');
  const sheet = file.getSheets()[0];
  sheet.setName('Volunteer Profiles');
  sheet.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
  sheet.setFrozenRows(1);
  setSetting_('Volunteer Profiles file ID', file.getId());
  Logger.log('Created ' + file.getUrl());
}

// ---------------------------------------------------------------------------
// Cells and time

function isDate_(value) {
  return Object.prototype.toString.call(value) === '[object Date]';
}

/** A cell as text: a Date as its Central yyyy-MM-dd, anything else trimmed. */
function cellText_(value) {
  if (isDate_(value)) return centralDate_(value);
  return cellString(value);
}

/** A date-time cell as milliseconds, NaN when it isn't a readable time. */
function cellMs_(value) {
  if (isDate_(value)) return value.getTime();
  const s = cellString(value);
  return s ? Date.parse(s) : NaN;
}

function centralDate_(date) {
  return Utilities.formatDate(date, kioskTimeZone(), 'yyyy-MM-dd');
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
    sheet.getRange(row, 1).setNumberFormat('@').setValue(name);
  }
  sheet.getRange(row, 2).setNumberFormat('@').setValue(value);
}

// ---------------------------------------------------------------------------
// Volunteer Profiles

/**
 * The kiosk list [{id, firstName, lastName, phoneLast4, startDate, needsPhoneCheck}],
 * from the cache when it holds one. On a cache miss it reads Profiles in one call and
 * rewrites the Settings "Profiles problems" value. Never writes to Profiles.
 */
function getProfiles_(settings) {
  const fileId = settings['Volunteer Profiles file ID'];
  const tabName = settings['Volunteer Profiles tab'] || 'Volunteer Profiles';
  if (!fileId) throw new Error('The Settings value "Volunteer Profiles file ID" is empty.');

  const cache = CacheService.getScriptCache();
  const key = 'profiles:' + fileId + ':' + tabName;
  const hit = cache.get(key);
  if (hit) return JSON.parse(hit);

  const sheet = SpreadsheetApp.openById(fileId).getSheetByName(tabName);
  if (!sheet) throw new Error('Volunteer Profiles has no tab named "' + tabName + '".');
  const values = sheet
    .getDataRange()
    .getValues()
    .map((row) => row.map(cellText_));
  const parsed = parseProfiles(values[0] || [], values.slice(1), sha256Hex_);

  const problems = parsed.problems.map((p) => p.text).join('\n');
  if (problems !== (settings['Profiles problems'] || '')) {
    setSetting_('Profiles problems', problems);
  }

  const json = JSON.stringify(parsed.volunteers);
  if (utf8Length(json) <= profilesCacheMaxBytes()) {
    cache.put(key, json, profilesCacheSeconds());
  }
  return parsed.volunteers;
}

// ---------------------------------------------------------------------------
// Log

function logEntry_(cells, row) {
  return {
    row,
    id: cellText_(cells[1]),
    dateText: cellText_(cells[4]),
    tappedMs: cellMs_(cells[5]),
    arrivedMs: cellMs_(cells[6]),
    hours: cells[8] === '' ? NaN : Number(cells[8]),
    status: cellText_(cells[9]),
  };
}

/** Every Log row as a log entry (Logic.js). */
function readLog_() {
  const sheet = sheet_(LOG_TAB);
  const last = sheet.getLastRow();
  if (last < 2) return [];
  const values = sheet.getRange(2, 1, last - 1, logHeaders().length).getValues();
  return values.map((cells, i) => logEntry_(cells, i + 2));
}

/**
 * Log rows dated today, in any row order. Reads the Date column, then only the block
 * of rows from the first to the last of today's.
 */
function readTodayLog_(todayDate) {
  const sheet = sheet_(LOG_TAB);
  const last = sheet.getLastRow();
  if (last < 2) return [];
  const dates = sheet.getRange(2, 5, last - 1, 1).getValues();
  const today = [];
  dates.forEach((cells, i) => {
    if (isRowToday(cellText_(cells[0]), todayDate)) today.push(i + 2);
  });
  if (!today.length) return [];
  const first = today[0];
  const values = sheet
    .getRange(first, 1, today[today.length - 1] - first + 1, logHeaders().length)
    .getValues();
  return today.map((row) => logEntry_(values[row - first], row));
}

/** Writes an open shift on the next empty Log row. Returns the shift ID. */
function writeCheckIn_(volunteer, todayDate, tapped, arrived, flag) {
  const sheet = sheet_(LOG_TAB);
  const row = sheet.getLastRow() + 1;
  if (row > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), 50);
  const shiftId = Utilities.getUuid();
  sheet.getRangeList(['A' + row + ':E' + row, 'J' + row + ':K' + row]).setNumberFormat('@');
  sheet.getRange(row, 6, 1, 2).setNumberFormat(DATE_TIME_FORMAT);
  sheet
    .getRange(row, 1, 1, 11)
    .setValues([
      [
        shiftId,
        volunteer.id,
        sheetText(volunteer.firstName),
        sheetText(volunteer.lastName),
        todayDate,
        tapped,
        arrived,
        '',
        '',
        'open',
        flag,
      ],
    ]);
  return shiftId;
}

/** Closes a shift: Signed out at, Hours, Status closed. */
function writeCheckOut_(row, signedOut, hours) {
  const sheet = sheet_(LOG_TAB);
  sheet.getRange(row, 8).setNumberFormat(DATE_TIME_FORMAT);
  sheet.getRange(row, 10).setNumberFormat('@');
  sheet.getRange(row, 8, 1, 3).setValues([[signedOut, hours, 'closed']]);
}
