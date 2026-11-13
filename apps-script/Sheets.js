/**
 * Sheet access for the volunteer check-in kiosk: the Log, Settings and Flags tabs of the
 * bound Check-In Log spreadsheet, and Volunteer Profiles, which is only ever read.
 *
 * Every decision lives in Logic.js. Functions here read cells into plain values and
 * write values back. Names ending in _ are private to the server: the page can't call
 * them.
 */

const LOG_TAB = "Log";
/** Where setupSheets moves a Log tab still in the kiosk's old column layout. */
const OLD_LOG_TAB = "Log (old layout)";
const SETTINGS_TAB = "Settings";
const FLAGS_TAB = "Flags";
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
 * Creates or updates the Log, Settings and Flags tabs: the Log header, formats and any
 * missing Settings row (setupLog_ for the Log), then the Flags tab (setupFlags_), so a
 * failure there leaves the Log and Settings set up, then the look of all three
 * (applyLooks_), last. Writes only empty cells, creates or renames tabs, sets formats, the
 * Flags tab's Reviewed checkbox and its "Flags: Unreviewed" view, and the look; never
 * changes a cell with text in it or deletes a row, so running it twice changes nothing.
 * Runs only from the Apps Script editor.
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

  setupFlags_(ss);
  applyLooks_(ss);
}

/**
 * The look (lookPlan, Logic.js) on the Log, Flags and Settings, from each tab's header as
 * it is now, on every run: header colours, row height and widths, one banding, the
 * kiosk's own conditional formats and the tab colour. Staff's conditional formats are
 * kept, first; any other banding on these tabs is replaced. When it fails, the tabs are
 * set up and the error says what to check.
 */
function applyLooks_(ss) {
  try {
    [
      [LOG_TAB, "log"],
      [FLAGS_TAB, "flags"],
      [SETTINGS_TAB, "settings"],
    ].forEach(([name, tab]) => {
      const sheet = sheet_(name);
      applyLook_(sheet, lookPlan(logHeaderRow_(sheet), tab));
    });
  } catch (e) {
    const message = cellString(e && e.message ? e.message : e).replace(/\.$/, "");
    throw new Error(
      "The tabs are set up, but their look could not be applied: " +
        message +
        ". Check that the Sheets API advanced service is on (it is in appsscript.json), then run setupSheets() again.",
    );
  }
}

/**
 * Puts a lookPlan on a tab through the advanced Sheets service: reads the tab's bandings
 * and conditional formats, then sends lookRequests (Logic.js) in one batchUpdate, so the
 * tab's look changes all at once or not at all.
 */
function applyLook_(sheet, plan) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheetId = sheet.getSheetId();
  const got = Sheets.Spreadsheets.get(ss.getId(), {
    fields: "sheets(properties(sheetId),bandedRanges(bandedRangeId),conditionalFormats)",
  });
  const tab = (got.sheets || []).find((s) => s.properties && s.properties.sheetId === sheetId);
  const existing = {
    bandings: ((tab && tab.bandedRanges) || []).map((b) => b.bandedRangeId),
    rules: (tab && tab.conditionalFormats) || [],
  };
  Sheets.Spreadsheets.batchUpdate({ requests: lookRequests(plan, sheetId, existing) }, ss.getId());
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

/**
 * The Flags part of setupSheets, in this order:
 * - No Flags tab: create it. Write the headers flagHeaderWrites (Logic.js) names into
 *   empty cells of row 1, so an empty row gets the full header.
 * - Set each Flags column's format by its header, put checkbox validation on the Reviewed
 *   column from row 2 to the tab's last row (that column only, so a validation staff set
 *   elsewhere stays), and freeze row 1.
 * - Last: add or update the "Flags: Unreviewed" filter view through the advanced Sheets
 *   service. A view with that title is updated in place; no other view is touched. When
 *   this step fails, everything above is already done, and the error says what to check.
 */
function setupFlags_(ss) {
  const sheet = ss.getSheetByName(FLAGS_TAB) || ss.insertSheet(FLAGS_TAB);
  const writes = flagHeaderWrites(logHeaderRow_(sheet));
  if (writes.length) {
    const first = writes[0].col;
    const last = writes[writes.length - 1].col;
    if (last > sheet.getMaxColumns()) {
      sheet.insertColumnsAfter(sheet.getMaxColumns(), last - sheet.getMaxColumns());
    }
    sheet
      .getRange(1, first, 1, writes.length)
      .setNumberFormat("@")
      .setValues([writes.map((w) => w.header)]);
  }
  const header = logHeaderRow_(sheet);
  flagColumnFormats(header).forEach((f) => {
    const format = flagFormat_(f.kind);
    if (format) sheet.getRange(1, f.col, sheet.getMaxRows(), 1).setNumberFormat(format);
  });
  const cols = flagColumns(header);
  if (sheet.getMaxRows() >= 2) {
    sheet
      .getRange(2, cols[flagHeaderNames().reviewed] + 1, sheet.getMaxRows() - 1, 1)
      .setDataValidation(checkboxRule_());
  }
  sheet.setFrozenRows(1);

  try {
    const sheetId = sheet.getSheetId();
    const got = Sheets.Spreadsheets.get(ss.getId(), {
      fields: "sheets(properties(sheetId),filterViews(filterViewId,title))",
    });
    const tab = (got.sheets || []).find((s) => s.properties && s.properties.sheetId === sheetId);
    const found = ((tab && tab.filterViews) || []).find(
      (v) => cellString(v.title) === flagsViewTitle(),
    );
    Sheets.Spreadsheets.batchUpdate(
      { requests: flagFilterViewRequests(cols, sheetId, found ? found.filterViewId : null) },
      ss.getId(),
    );
  } catch (e) {
    const message = cellString(e && e.message ? e.message : e).replace(/\.$/, "");
    throw new Error(
      'The Flags tab is set up, but the "' +
        flagsViewTitle() +
        '" view could not be made: ' +
        message +
        ". Check that the Sheets API advanced service is on (it is in appsscript.json), then run setupSheets() again.",
    );
  }
}

/** The number format a Flags column of this kind (flagColumnKinds) gets; none for the checkbox. */
function flagFormat_(kind) {
  if (kind === "time") return DATE_TIME_FORMAT;
  if (kind === "number") return "0";
  if (kind === "checkbox") return "";
  return "@";
}

/** The Reviewed column's validation: a tickbox. */
function checkboxRule_() {
  return SpreadsheetApp.newDataValidation().requireCheckbox().build();
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
      clock: zoneClock_(value, kioskTimeZone()),
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
  return zoneDate_(date, kioskTimeZone());
}

/**
 * Utilities.formatDate(date, zone, "yyyy-MM-dd"), from the zone's offset for that hour
 * (zoneOffset_) when it has one.
 */
function zoneDate_(date, zone) {
  const offset = zoneOffset_(date.getTime(), zone);
  if (offset === null) return Utilities.formatDate(date, zone, "yyyy-MM-dd");
  const wall = new Date(date.getTime() + offset);
  return (
    padNumber_(wall.getUTCFullYear(), 4) +
    "-" +
    padNumber_(wall.getUTCMonth() + 1, 2) +
    "-" +
    padNumber_(wall.getUTCDate(), 2)
  );
}

/** Utilities.formatDate(date, zone, "HH:mm"), read as zoneDate_ reads the date. */
function zoneClock_(date, zone) {
  const offset = zoneOffset_(date.getTime(), zone);
  if (offset === null) return Utilities.formatDate(date, zone, "HH:mm");
  const wall = new Date(date.getTime() + offset);
  return padNumber_(wall.getUTCHours(), 2) + ":" + padNumber_(wall.getUTCMinutes(), 2);
}

/**
 * How many milliseconds zone's wall clock runs ahead of UTC at ms, or null when this run
 * reads that time with Utilities.formatDate itself.
 *
 * Each UTC hour's offset is read once, at the hour's start (hourOffset_), and kept for the
 * rest of the script run. That offset holds for the whole hour when the zone's clock can
 * only change on a whole UTC hour. America/Chicago, the kiosk's zone, does: from local
 * mean time to Central at 18:00 UTC in 1883, and since then whole-hour offsets changed at
 * a whole local hour. Any other zone may change at a half hour (America/St_Johns) or at
 * an odd second (a local mean time), so its hour is used only when the next hour's start
 * has the same offset; an hour with a change inside it is left to formatDate.
 */
function zoneOffset_(ms, zone) {
  if (!isFinite(ms)) return null;
  const hour = Math.floor(ms / 3600000);
  const offset = hourOffset_(zone, hour);
  if (offset === null || zone === "America/Chicago") return offset;
  return hourOffset_(zone, hour + 1) === offset ? offset : null;
}

/** Offsets by zone, then by UTC hour (ms / 3600000, floored); see zoneOffset_. */
const ZONE_OFFSETS_ = {};

/**
 * zone's offset at the start of UTC hour, or null when formatDate's text for it can't be
 * read back exactly. intlOffset_ reads it when it can; otherwise one Utilities.formatDate
 * call does (formatDateOffset_).
 */
function hourOffset_(zone, hour) {
  const offsets = ZONE_OFFSETS_[zone] || (ZONE_OFFSETS_[zone] = {});
  if (Object.prototype.hasOwnProperty.call(offsets, hour)) return offsets[hour];
  const start = hour * 3600000;
  let offset = intlOffset_(zone, start);
  if (offset === null) offset = formatDateOffset_(zone, start);
  offsets[hour] = offset;
  return offset;
}

/**
 * zone's offset at start from one Utilities.formatDate call, or null when its text can't
 * be read back exactly: a year before 1583 (Apps Script dates those on the Julian
 * calendar, JavaScript on the Gregorian) or after 9999.
 */
function formatDateOffset_(zone, start) {
  const text = Utilities.formatDate(new Date(start), zone, "yyyy-MM-dd HH:mm:ss");
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(text);
  if (!m || +m[1] < 1583) return null;
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  const back = new Date(wall).toISOString();
  return back.slice(0, 10) + " " + back.slice(11, 19) === text ? wall - start : null;
}

/**
 * The first moment intlOffset_ reads: 1883-11-18 00:00 UTC. Before it, zones ran on local
 * mean time, which Apps Script's formatDate and Intl don't always agree on.
 */
const INTL_FROM_MS_ = Date.UTC(1883, 10, 18);

/**
 * zone's offset at start from Intl.DateTimeFormat, or null to leave it to formatDate: a
 * zone other than America/Chicago, Intl missing or refusing the zone, a time before
 * INTL_FROM_MS_, an offset that isn't a whole minute (a mean time, again), or parts that
 * don't read back as one exact wall-clock time.
 *
 * Only the kiosk's zone is read this way. Its offsets from Intl were checked against
 * formatDate's; other zones' were not, and Intl and formatDate can carry different
 * releases of the time zone rules, or read the years before 1900 differently.
 */
function intlOffset_(zone, start) {
  if (!(start >= INTL_FROM_MS_)) return null;
  const format = zoneFormat_(zone);
  if (!format) return null;
  let parts;
  try {
    parts = format.formatToParts(new Date(start));
  } catch (e) {
    return null;
  }
  const f = {};
  for (let i = 0; i < parts.length; i++) {
    const type = parts[i].type;
    if (type === "literal") continue;
    if (!/^(year|month|day|hour|minute|second)$/.test(type)) return null;
    if (!/^[0-9]{1,4}$/.test(parts[i].value)) return null;
    f[type] = +parts[i].value;
  }
  if (!(f.year >= 1883 && f.hour <= 23)) return null;
  const wall = new Date(Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second));
  if (
    wall.getUTCFullYear() !== f.year ||
    wall.getUTCMonth() !== f.month - 1 ||
    wall.getUTCDate() !== f.day ||
    wall.getUTCHours() !== f.hour ||
    wall.getUTCMinutes() !== f.minute ||
    wall.getUTCSeconds() !== f.second
  ) {
    return null;
  }
  const offset = wall.getTime() - start;
  return offset % 60000 === 0 && Math.abs(offset) < 86400000 ? offset : null;
}

/** One Intl.DateTimeFormat per zone, null where it isn't used; see zoneFormat_. */
const ZONE_FORMATS_ = {};

/** An Intl.DateTimeFormat for zone's wall clock, 24-hour, or null; see intlOffset_. */
function zoneFormat_(zone) {
  if (Object.prototype.hasOwnProperty.call(ZONE_FORMATS_, zone)) return ZONE_FORMATS_[zone];
  let format = null;
  if (zone === "America/Chicago" && typeof Intl !== "undefined") {
    try {
      format = new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        hourCycle: "h23",
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
        second: "numeric",
      });
    } catch (e) {
      format = null;
    }
  }
  ZONE_FORMATS_[zone] = format;
  return format;
}

/** n as decimal digits, zero-padded on the left to at least width. */
function padNumber_(n, width) {
  let text = String(n);
  while (text.length < width) text = "0" + text;
  return text;
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
 * The Log's header map and one volunteer's rows from one range read, so both come from
 * one snapshot: {cols, entries, width}. cols is logColumns (Logic.js) of row 1, entries
 * the rows below it whose User Token is token (logRowHasToken), each as a log entry with
 * its row number, and width the number of columns read. Only those rows are parsed; a
 * blank token gives no entries. The kiosk's check-in and check-out read the Log with
 * this; the admin menu, the jobs and the reports use readLogColumns_ and readLog_.
 * Throws when a column the kiosk needs is missing or repeated, so an empty tab throws the
 * missing-column error.
 */
function readLogTable_(token) {
  const sheet = sheet_(LOG_TAB);
  const last = Math.max(sheet.getLastRow(), 1);
  const width = Math.max(sheet.getLastColumn(), 1);
  const values = sheet.getRange(1, 1, last, width).getValues();
  const cols = logColumns(values[0].map(cellText_));
  const read = logRead_();
  const entries = [];
  values.slice(1).forEach((cells, i) => {
    if (logRowHasToken(cells, cols, token, read)) entries.push(logEntry(cells, i + 2, cols, read));
  });
  return { cols, entries, width };
}

/**
 * One Log row as a log entry, read across the Log's full width in one range read, or null
 * when row is past the Log's last row. read is logRead_().
 */
function readLogRow_(row, cols, read) {
  const sheet = sheet_(LOG_TAB);
  if (row < 2 || row > sheet.getLastRow()) return null;
  const cells = sheet.getRange(row, 1, 1, sheet.getLastColumn()).getValues()[0];
  return logEntry(cells, row, cols, read);
}

/**
 * One Log row as a log entry, read again just before a write by its row number: one range
 * read of width columns (readLogTable_'s width), so it costs one round trip. Null when
 * the read throws, as it does for a row past the tab's last grid row; the error is logged
 * with shiftId, the Shift ID the caller expects there. A row past the last used row
 * inside the grid reads as blanks. cols and read are as for logEntry (Logic.js).
 */
function readLogRowAt_(row, width, cols, read, shiftId) {
  let cells;
  try {
    cells = sheet_(LOG_TAB).getRange(row, 1, 1, width).getValues()[0];
  } catch (e) {
    console.error(
      "Log row " +
        row +
        " not read again for Shift ID " +
        cellString(shiftId) +
        ": " +
        (e && e.message ? e.message : String(e)),
    );
    return null;
  }
  return logEntry(cells, row, cols, read);
}

/**
 * Log rows dated on any of dates (yyyy-MM-dd), in any row order. Reads the Date column
 * found by the header map, then only the block of rows from the first to the last of
 * those, across the full width. The kiosk list reads yesterday and today with it
 * (recentLogDates, Logic.js).
 */
function readRecentLog_(dates, cols) {
  const sheet = sheet_(LOG_TAB);
  const last = sheet.getLastRow();
  if (last < 2) return [];
  const wanted = {};
  (dates || []).forEach((d) => {
    if (d) wanted[d] = true;
  });
  const dateCells = sheet.getRange(2, cols[logHeaderNames().date] + 1, last - 1, 1).getValues();
  const rows = [];
  dateCells.forEach((cells, i) => {
    if (wanted[rowDate(cellText_(cells[0]))]) rows.push(i + 2);
  });
  if (!rows.length) return [];
  const first = rows[0];
  const values = sheet
    .getRange(first, 1, rows[rows.length - 1] - first + 1, sheet.getLastColumn())
    .getValues();
  const read = logRead_();
  return rows.map((row) => logEntry(values[row - first], row, cols, read));
}

/**
 * The Shifts tab's windows as shiftsTabWindows (Logic.js) gives them, {windows, problem},
 * read once. The tab is staff's and only ever read. A missing tab gives no windows and a
 * problem line; so does a tab with no Shifts, Start and Finish header row. Start and Finish
 * may be sheet times or text such as "9:00 AM", read like the Log's times.
 */
function readShifts_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(shiftsTab());
  if (!sheet) return { windows: [], problem: 'there is no "' + shiftsTab() + '" tab' };
  const values = sheet.getDataRange().getValues();
  return shiftsTabWindows(values, { text: cellText_, clock: (v) => cellTime_(v).clock });
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

/**
 * Appends many rows (cell maps) below the Log's last row in one write, for a batch such
 * as Import past hours; appendLogRow_ writes cell by cell and is far too slow for hundreds
 * of rows. Grows the tab first when the rows would pass its last grid row. Then one
 * setNumberFormats and one setValues across the full width: each kiosk column a map names
 * gets its column's format, staff's columns keep theirs, and cells the maps don't name are
 * left blank. Returns the first new row number; map i is on that row plus i.
 */
function appendLogRows_(cellMaps, cols) {
  const sheet = sheet_(LOG_TAB);
  const first = sheet.getLastRow() + 1;
  if (!cellMaps.length) return first;
  const width = logHeaderRow_(sheet).length;
  const last = first + cellMaps.length - 1;
  if (last > sheet.getMaxRows()) {
    sheet.insertRowsAfter(sheet.getMaxRows(), Math.max(50, last - sheet.getMaxRows()));
  }
  const range = sheet.getRange(first, 1, cellMaps.length, width);
  const formats = range.getNumberFormats();
  const values = cellMaps.map((cells, i) => {
    const line = Array.from({ length: width }, () => "");
    cellWrites(cells, cols).forEach((w) => {
      line[w.col - 1] = w.kind === "time" && w.value !== "" ? new Date(w.value) : w.value;
      formats[i][w.col - 1] = logFormat_(w.kind);
    });
    return line;
  });
  range.setNumberFormats(formats);
  range.setValues(values);
  return first;
}

// ---------------------------------------------------------------------------
// Flags

/**
 * Appends Flags rows (flagRows, Logic.js) below the tab's last row: planFlagRows_ for the
 * reads, then writeFlagRows_. Jobs.js and Import.js call this. Throws when the tab or a
 * header it needs is missing.
 */
function appendFlagRows_(rows) {
  if (!rows.length) return;
  writeFlagRows_(planFlagRows_(rows.length), rows);
}

/**
 * Every Flags read an append of count rows needs, so the write that follows reads
 * nothing: the tab, its header (placed by flagColumns, so columns may be in any order),
 * its last row and last grid row. Grows the tab first when the rows would pass its last
 * grid row, then reads the new range's number formats. Returns {sheet, cols, width,
 * first, formats}: first is the first new row, formats one line per row. A check-in or
 * check-out plans before its Log write, so it reads nothing after that write. Throws when
 * the tab or a header it needs is missing.
 */
function planFlagRows_(count) {
  const sheet = sheet_(FLAGS_TAB);
  const header = logHeaderRow_(sheet);
  const cols = flagColumns(header);
  const width = header.length;
  const first = sheet.getLastRow() + 1;
  const last = first + count - 1;
  if (last > sheet.getMaxRows()) {
    sheet.insertRowsAfter(sheet.getMaxRows(), Math.max(50, last - sheet.getMaxRows()));
  }
  const formats = sheet.getRange(first, 1, count, width).getNumberFormats();
  return { sheet, cols, width, first, formats };
}

/**
 * Writes Flags rows where plan (planFlagRows_, for as many rows) says, with no reads: one
 * setNumberFormats and one setValues across the full width, and the checkbox on the new
 * Reviewed cells, so the tickbox doesn't depend on what inserting rows copied.
 */
function writeFlagRows_(plan, rows) {
  const { sheet, cols, width, first } = plan;
  const kinds = flagColumnKinds();
  // Staff's columns keep the format they have; the script's get theirs.
  const formats = plan.formats.map((line) => line.slice());
  Object.keys(cols).forEach((h) => {
    const format = flagFormat_(kinds[h]);
    if (cols[h] >= 0 && format) formats.forEach((line) => (line[cols[h]] = format));
  });
  const raisedAt = cols[flagHeaderNames().raisedAt];
  const values = rows.map((cells) => {
    const line = flagRowValues(cells, cols, width);
    if (typeof line[raisedAt] === "number") line[raisedAt] = new Date(line[raisedAt]);
    return line;
  });
  const range = sheet.getRange(first, 1, rows.length, width);
  range.setNumberFormats(formats);
  range.setValues(values);
  sheet
    .getRange(first, cols[flagHeaderNames().reviewed] + 1, rows.length, 1)
    .setDataValidation(checkboxRule_());
}

/**
 * The Flags plan for a call's flag reasons, made before its Log write: planFlagRows_ for
 * the rows flagRows (Logic.js) will make, one per non-blank reason. null when there are
 * none. A plan that fails gives {error}, kept for raiseFlags_ to report after the Log
 * write, so a broken Flags tab never stops a check-in or check-out.
 */
function planFlags_(reasons) {
  const count = (reasons || []).filter((reason) => cellString(reason) !== "").length;
  if (!count) return null;
  try {
    return planFlagRows_(count);
  } catch (e) {
    return { error: e };
  }
}

/**
 * Copies a call's flags to the Flags tab, after the call's Log write and under the same
 * lock. base is as for flagRows (Logic.js), reasons the texts and plan the call's
 * planFlags_, made before the Log write; with no plan it plans here, as the jobs do.
 * With no reasons it does nothing and returns true. Otherwise it flushes first, outside
 * the try, so a Log write that fails still fails the call. Then, in one try: a failed plan
 * is rethrown; the rows are built, checked against the plan's count, written and flushed,
 * so a failed Flags write fails here and not at the lock's closing flush. Returns true, or
 * false after logging the Shift ID and the error. The Log row is the record: a failed
 * copy never undoes or retries it.
 */
function raiseFlags_(base, reasons, plan) {
  if (!reasons || !reasons.length) return true;
  SpreadsheetApp.flush();
  try {
    if (plan && plan.error) throw plan.error;
    const rows = flagRows(base, reasons);
    if (plan && plan.formats.length !== rows.length) {
      throw new Error(
        "Flags rows planned for " + plan.formats.length + " rows, built " + rows.length + ".",
      );
    }
    if (rows.length) writeFlagRows_(plan || planFlagRows_(rows.length), rows);
    SpreadsheetApp.flush();
    return true;
  } catch (e) {
    console.error(
      "Flags: not copied for Shift ID " +
        cellString(base && base.shiftId) +
        ": " +
        (e && e.message ? e.message : String(e)),
    );
    return false;
  }
}

// ---------------------------------------------------------------------------
// Removed shifts
//
// The reads and writes of Remove a shift… and Restore a shift… (Admin.js), made under the
// kiosk's lock: the Log rows that hold a Shift ID, the "Removed shifts" tab, and the
// Flags rows of a removed or restored row. The rules are in Logic.js ("Removed shifts").
// Both tabs are read and written by header.

/** The Log's Shift ID column as text, one item per row from row 2, in one column read. */
function readLogShiftIds_(cols) {
  const sheet = sheet_(LOG_TAB);
  const last = sheet.getLastRow();
  if (last < 2) return [];
  return sheet
    .getRange(2, cols[logHeaderNames().shiftId] + 1, last - 1, 1)
    .getValues()
    .map((cells) => cellText_(cells[0]));
}

/** The numbers of the Log rows whose Shift ID is shiftId, from one read of that column. */
function logShiftIdRows_(cols, shiftId) {
  const wanted = cellString(shiftId);
  if (!wanted) return [];
  const rows = [];
  readLogShiftIds_(cols).forEach((id, i) => {
    if (id === wanted) rows.push(i + 2);
  });
  return rows;
}

/** A log entry (Logic.js) plus inBy, the Check-In Entered By text, which the lists show. */
function shiftEntry_(cells, row, cols, read) {
  const entry = logEntry(cells, row, cols, read);
  const at = cols[logHeaderNames().inBy];
  entry.inBy = typeof at === "number" && at >= 0 ? cellText_(cells[at]) : "";
  return entry;
}

/**
 * Log rows read one at a time across the Log's full width, values and number formats, as
 * [{row, values, formats, entry}] with entry from shiftEntry_. Rows past the Log's last
 * row are left out.
 */
function readShiftRows_(rows, cols) {
  const sheet = sheet_(LOG_TAB);
  const last = sheet.getLastRow();
  const width = Math.max(sheet.getLastColumn(), 1);
  const read = logRead_();
  return (rows || [])
    .filter((row) => row >= 2 && row <= last)
    .map((row) => {
      const range = sheet.getRange(row, 1, 1, width);
      const values = range.getValues()[0];
      const formats = range.getNumberFormats()[0];
      return { row, values, formats, entry: shiftEntry_(values, row, cols, read) };
    });
}

/**
 * The Removed shifts tab as {sheet, header}, made on the first Remove: the Log's header
 * row as it is, then Removed by, Removed at and Removed reason, row 1 frozen, and one
 * warning-only protection. An existing tab gets any Log header it lacks to the right
 * (removedHeaderWrites, Logic.js). logHeader is the Log's row 1 as text.
 */
function removedSheet_(logHeader) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(removedTabName());
  const created = !sheet;
  if (created) sheet = ss.insertSheet(removedTabName());
  const writes = removedHeaderWrites(logHeader, created ? [] : logHeaderRow_(sheet));
  if (writes.length) {
    const first = writes[0].col;
    const last = writes[writes.length - 1].col;
    if (last > sheet.getMaxColumns()) {
      sheet.insertColumnsAfter(sheet.getMaxColumns(), last - sheet.getMaxColumns());
    }
    sheet
      .getRange(1, first, 1, writes.length)
      .setNumberFormat("@")
      .setValues([writes.map((w) => w.header)]);
  }
  if (created) {
    sheet.setFrozenRows(1);
    sheet.protect().setDescription(removedProtectionDescription()).setWarningOnly(true);
  }
  return { sheet, header: logHeaderRow_(sheet) };
}

/**
 * Appends a Log row to the Removed tab (removed is removedSheet_'s {sheet, header}), in
 * one setNumberFormats and one setValues: each cell under the Removed header that matches
 * its Log header (headerMapCopy, Logic.js), with the Log cell's format, then Removed by =
 * initials, Removed at = nowMs as a date-time and Removed reason. Columns with no match
 * are left blank with the format they have. Returns the new row's number.
 */
function appendRemovedRow_(removed, logHeader, values, formats, initials, reason, nowMs) {
  const { sheet, header } = removed;
  const width = header.length;
  const row = sheet.getLastRow() + 1;
  if (row > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), 50);
  const range = sheet.getRange(row, 1, 1, width);
  const kept = range.getNumberFormats()[0];
  const line = headerMapCopy(logHeader, values, header, width).map((v) => (v === null ? "" : v));
  const lineFormats = headerMapCopy(logHeader, formats, header, width).map((f, j) =>
    f === null || f === "" ? kept[j] : f,
  );
  const X = removedExtraHeaders();
  const put = (name, value, format) => {
    const at = logHeaderIndexes(header, name)[0];
    line[at] = value;
    lineFormats[at] = format;
  };
  put(X.by, sheetText(initials), "@");
  put(X.at, new Date(nowMs), DATE_TIME_FORMAT);
  put(X.reason, sheetText(reason), "@");
  range.setNumberFormats([lineFormats]);
  range.setValues([line]);
  return row;
}

/** Deletes one Log row; the rows below it move up. */
function deleteLogRow_(row) {
  sheet_(LOG_TAB).deleteRow(row);
}

/**
 * The Removed shifts tab as {sheet, header, rows}, or null when there is no such tab.
 * Each row is {row, values, formats, entry}: entry is shiftEntry_ through a column map
 * built from the tab's own header (each Log header's leftmost column, -1 when missing),
 * plus removedBy, removedAtMs, removedAtDate (Central yyyy-MM-dd) and removedReason.
 * One read of the values and one of the formats.
 */
function readRemoved_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(removedTabName());
  if (!sheet) return null;
  const header = logHeaderRow_(sheet);
  const last = sheet.getLastRow();
  if (last < 2) return { sheet, header, rows: [] };
  const range = sheet.getRange(2, 1, last - 1, header.length);
  const values = range.getValues();
  const formats = range.getNumberFormats();
  const cols = {};
  logHeaders().forEach((h) => {
    const found = logHeaderIndexes(header, h);
    cols[h] = found.length ? found[0] : -1;
  });
  const X = removedExtraHeaders();
  const extra = (cells, name) => {
    const at = logHeaderIndexes(header, name);
    return at.length ? cells[at[0]] : "";
  };
  const read = logRead_();
  const rows = values.map((cells, i) => {
    const entry = shiftEntry_(cells, i + 2, cols, read);
    const when = cellTime_(extra(cells, X.at));
    entry.removedBy = cellText_(extra(cells, X.by));
    entry.removedAtMs = when.ms;
    entry.removedAtDate = when.date;
    entry.removedReason = cellText_(extra(cells, X.reason));
    return { row: i + 2, values: cells, formats: formats[i], entry };
  });
  return { sheet, header, rows };
}

/**
 * Writes a restored row on the row after the Log's last, growing the tab by 50 when it is
 * full, as appendLogRow_ does, in one setNumberFormats and one setValues. values and
 * formats are one Log-width line each, already mapped to the Log's header (headerMapCopy,
 * Logic.js), with null where nothing maps. Kiosk columns (cols, logColumns) get their
 * kind's format; staff columns get the copied one, or keep theirs where none was copied.
 * Returns the new row's number.
 */
function appendLogValues_(values, formats, cols) {
  const sheet = sheet_(LOG_TAB);
  const width = values.length;
  const row = sheet.getLastRow() + 1;
  if (row > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), 50);
  const range = sheet.getRange(row, 1, 1, width);
  const kept = range.getNumberFormats()[0];
  const lineFormats = formats.map((f, j) => (f === null || f === "" ? kept[j] : f));
  const kinds = logColumnKinds();
  Object.keys(cols).forEach((h) => {
    if (cols[h] >= 0 && cols[h] < width) lineFormats[cols[h]] = logFormat_(kinds[h]);
  });
  range.setNumberFormats([lineFormats]);
  range.setValues([values.map((v) => (v === null ? "" : v))]);
  return row;
}

/**
 * Acts on the Flags rows whose Shift ID is shiftId, after one read of the tab. opts is
 * {tick, initials, note, only}. When only is given, a row is acted on only when
 * removeFlagMatches (Logic.js) says it belongs to the removed row; the rest are counted as
 * left. Each row acted on gets, with tick, Reviewed ticked and Reviewed By set to initials
 * when it is blank; and note added after its Notes (appendText) when the tab has a Notes
 * column. Returns {marked, left}. No Flags tab, or a blank Shift ID, marks nothing.
 */
function markShiftFlags_(shiftId, opts) {
  const o = opts || {};
  const out = { marked: 0, left: 0 };
  const wanted = cellString(shiftId);
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(FLAGS_TAB);
  if (!wanted || !sheet) return out;
  const header = logHeaderRow_(sheet);
  const cols = flagColumns(header);
  const F = flagHeaderNames();
  const last = sheet.getLastRow();
  if (last < 2) return out;
  const values = sheet.getRange(2, 1, last - 1, header.length).getValues();
  const cell = (cells, name) => (cols[name] >= 0 ? cells[cols[name]] : "");
  values.forEach((cells, i) => {
    if (cellText_(cell(cells, F.shiftId)) !== wanted) return;
    const flag = {
      date: cellText_(cell(cells, F.date)),
      name: cellText_(cell(cells, F.name)),
      reason: cellText_(cell(cells, F.reason)),
      source: cellText_(cell(cells, F.source)),
      logRow: cell(cells, F.logRow),
    };
    if (o.only && !removeFlagMatches(flag, o.only)) {
      out.left++;
      return;
    }
    out.marked++;
    const row = i + 2;
    if (o.tick) {
      sheet.getRange(row, cols[F.reviewed] + 1).setValue(true);
      if (
        cols[F.reviewedBy] >= 0 &&
        cellString(o.initials) &&
        cellText_(cell(cells, F.reviewedBy)) === ""
      ) {
        sheet.getRange(row, cols[F.reviewedBy] + 1).setValue(sheetText(o.initials));
      }
    }
    if (cols[F.notes] >= 0 && cellString(o.note)) {
      sheet
        .getRange(row, cols[F.notes] + 1)
        .setValue(sheetText(appendText(cell(cells, F.notes), o.note)));
    }
  });
  return out;
}
