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
 * Creates or updates the Log, Settings and Flags tabs and the staff help: the Log header,
 * formats and any missing Settings row (setupLog_ for the Log), Settings' What it does
 * column, then the Flags tab (setupFlags_), so a failure there leaves the Log and Settings
 * set up, then the Log and Flags header notes, the look of all three (applyLooks_), and
 * the How to tab, last. Writes only empty cells, creates or renames tabs, sets formats,
 * the Flags tab's Reviewed checkbox and its "Flags: Unreviewed" view, and the look; never
 * changes a cell with text in it or deletes a row, except for the help it rewrites on
 * every run: Settings column C, the How to tab, and a header note that is empty or still
 * exactly one of the kiosk's own texts. So running it twice changes nothing. Runs only
 * from the Apps Script editor.
 */
function setupSheets() {
  requireEditorRun_();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss.getSpreadsheetTimeZone() !== kioskTimeZone()) {
    ss.setSpreadsheetTimeZone(kioskTimeZone());
  }

  setupLog_(ss);

  const settings = ss.getSheetByName(SETTINGS_TAB) || ss.insertSheet(SETTINGS_TAB);
  settings.getRange("A:C").setNumberFormat("@");
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
  settings.getRange(1, 3).setValue(settingsDescriptionHeader());
  writeSettingsDescriptions_(settings);
  protectOnce_(
    settings.getProtections(SpreadsheetApp.ProtectionType.RANGE),
    settingsDescriptionProtection(),
    () => settings.getRange("C2:C").protect(),
  );
  // The Settings writes reach the sheet before the stamp, so a read after it sees them.
  SpreadsheetApp.flush();
  markSettingsEdited_();

  setupFlags_(ss);
  writeHeaderNotes_(sheet_(LOG_TAB), logHeaderNames(), logHeaderNotes());
  writeHeaderNotes_(sheet_(FLAGS_TAB), flagHeaderNames(), flagHeaderNotes());
  applyLooks_(ss);
  setupHowTo_(ss);
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
  // Stamped first and last, even when a write throws, as the Log write helpers are, so no
  // log map read before or during this is used after it.
  markLogChanged_();
  try {
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
  } finally {
    markLogChanged_();
  }
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

/**
 * Settings as {name: text}; the first row with a name wins. Read from the tab on every
 * call; a check-in or check-out takes Settings from cachedSettings_ instead.
 */
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

/**
 * Writes one Settings value, found by its name in column A, appending the row if missing.
 * An appended row also gets its What it does text in column C; an existing row's C is
 * left as it is. Then flushes and stamps the Settings cache (markSettingsEdited_), so the
 * next check-in or check-out reads the new value.
 */
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
    const descriptions = settingsDescriptions();
    const what = Object.prototype.hasOwnProperty.call(descriptions, name) ? descriptions[name] : "";
    sheet.getRange(row, 3).setNumberFormat("@").setValue(what);
  }
  sheet.getRange(row, 2).setNumberFormat("@").setValue(value);
  // The write reaches the sheet before the stamp, so a read after the stamp sees it.
  SpreadsheetApp.flush();
  markSettingsEdited_();
}

// Settings in the script cache.
//
// A copy of Settings is kept in the script cache with the time it was read from the tab,
// and an edit stamp holds the time of the last Settings edit. A check-in or check-out
// uses the copy only when it was read after the last stamp and less than
// settingsCacheSeconds() (5 minutes) ago; otherwise it reads the tab, before the lock, and
// caches what it read. Every Settings write the script makes (setSetting_, setupSheets)
// stamps after its write reaches the sheet, and a staff member typing in a Settings cell
// stamps through onEdit, so such a change applies from the next tap. A change that fires
// no onEdit (a row inserted, deleted or sorted, a version restored, an edit by another
// script) applies at the next tab read: usually the tablet's list refresh, and 5 minutes
// at most. The time is taken before the read, so a read that started before an edit is
// never used after that edit's stamp. A copy can let a code in but never refuse one: a
// code that doesn't match the copy is checked against the tab (settingsForCode_, Api.js).
// A cache miss, a cache error, a copy that can't be read or Settings too big to cache all
// read the tab, as without the cache.

/**
 * Reads Settings from the tab, puts them in the cache with the time the read started, and
 * returns them. Settings too big to cache remove any older copy instead. A cache failure
 * is logged and changes nothing else.
 */
function refreshSettingsCache_() {
  const readAt = Date.now();
  const settings = readSettings_();
  try {
    const cache = CacheService.getScriptCache();
    const text = settingsCacheValue(settings, readAt);
    if (utf8Length(text) <= settingsCacheMaxBytes()) {
      cache.put(settingsCacheKey(), text, settingsCacheSeconds());
    } else {
      cache.remove(settingsCacheKey());
    }
  } catch (e) {
    console.error("Settings not cached: " + (e && e.message ? e.message : String(e)));
  }
  return settings;
}

/**
 * {settings, cached}: the cached copy of Settings when it may be used (settingsFromCache,
 * Logic.js), with cached true; else Settings read from the tab (refreshSettingsCache_),
 * with cached false. One cache call reads the copy and the edit stamp together. A cache
 * error counts as a miss.
 */
function cachedSettings_() {
  let hit = null;
  try {
    const got = CacheService.getScriptCache().getAll([settingsCacheKey(), settingsStampKey()]);
    hit = settingsFromCache(got[settingsCacheKey()], got[settingsStampKey()], Date.now());
  } catch (e) {
    console.error("Settings cache not read: " + (e && e.message ? e.message : String(e)));
    hit = null;
  }
  if (hit) return { settings: hit, cached: true };
  return { settings: refreshSettingsCache_(), cached: false };
}

/**
 * Stamps the time of a Settings edit, so no copy of Settings read before it is used again.
 * The stamp lasts twice settingsCacheSeconds(), longer than any copy read before it could
 * be used. A failure is logged and fails nothing: copies then expire on their own within
 * settingsCacheSeconds().
 */
function markSettingsEdited_() {
  try {
    CacheService.getScriptCache().put(
      settingsStampKey(),
      String(Date.now()),
      2 * settingsCacheSeconds(),
    );
  } catch (e) {
    console.error("Settings edit not stamped: " + (e && e.message ? e.message : String(e)));
  }
}

/**
 * The simple edit trigger: Sheets runs it after a person edits a cell. An edit on the
 * Settings tab stamps the Settings cache (markSettingsEdited_); an edit anywhere else
 * returns at once. It reads no cell. The page can name it through google.script.run, but
 * can't pass a range, so such a call returns or throws without stamping.
 */
function onEdit(e) {
  if (!e || !e.range) return;
  if (e.range.getSheet().getName() !== SETTINGS_TAB) return;
  markSettingsEdited_();
}

// ---------------------------------------------------------------------------
// Volunteer Profiles

/**
 * The kiosk list [{id, firstName, lastName, phoneLast4, startDate, needsPhoneCheck,
 * token, row}], from the cache when it holds one. On a cache miss it reads Profiles in one
 * call and rewrites the Settings "Profiles problems" value. Never writes to Profiles. The
 * cache key carries profilesCacheVersion(), so a list cached in an older shape is never
 * read. A cache error, or a cached list that can't be read, counts as a miss; a failed put
 * is logged and changes nothing else.
 */
function getProfiles_(settings) {
  const fileId = settings["Volunteer Profiles file ID"];
  const tabName = settings["Volunteer Profiles tab"] || "Volunteer Profiles";
  if (!fileId) throw new Error('The Settings value "Volunteer Profiles file ID" is empty.');

  const key = profilesCacheKey(fileId, tabName);
  try {
    const hit = CacheService.getScriptCache().get(key);
    if (hit) return JSON.parse(hit);
  } catch (e) {
    console.error("Profiles cache not read: " + (e && e.message ? e.message : String(e)));
  }

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
    try {
      CacheService.getScriptCache().put(key, json, profilesCacheSeconds());
    } catch (e) {
      console.error("Profiles not cached: " + (e && e.message ? e.message : String(e)));
    }
  }
  return parsed.volunteers;
}

/**
 * Each volunteer's address from the Email column of their own Profiles row, for Kiosk
 * admin > Email hours…: {id: {email, row, problem, text}} (profileEmailsFrom, Logic.js).
 * Opens the same file and tab getProfiles_ reads and reads the sheet in one call for the
 * whole set; the row is found by User Token, not by row number. Never reads through or
 * writes to the Profiles cache, whose list keeps no email, and never writes to Profiles.
 */
function profileEmails_(settings, volunteers) {
  const fileId = settings["Volunteer Profiles file ID"];
  const tabName = settings["Volunteer Profiles tab"] || "Volunteer Profiles";
  if (!fileId) throw new Error('The Settings value "Volunteer Profiles file ID" is empty.');
  const sheet = SpreadsheetApp.openById(fileId).getSheetByName(tabName);
  if (!sheet) throw new Error('Volunteer Profiles has no tab named "' + tabName + '".');
  const values = sheet
    .getDataRange()
    .getValues()
    .map((row) => row.map(cellText_));
  return profileEmailsFrom(values[0] || [], values.slice(1), volunteers);
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
 * The Log's header map and the rows of one or more volunteers from one range read, so
 * both come from one snapshot: {cols, entries, width}. tokens is one User Token or a list
 * of them (checkOutTokens, Logic.js). cols is logColumns (Logic.js) of row 1, entries the
 * rows below it whose User Token is any of the tokens (logRowHasToken), each as a log
 * entry with its row number, and width the number of columns read. Only those rows are
 * parsed; a blank token keeps no row. The kiosk's check-in and check-out read the Log
 * with this; the admin menu, the jobs and the reports use readLogColumns_ and readLog_.
 * Throws when a column the kiosk needs is missing or repeated, so an empty tab throws the
 * missing-column error.
 */
function readLogTable_(tokens) {
  const wanted = Array.isArray(tokens) ? tokens : [tokens];
  // The data range runs from A1 to the last used row and column, and is A1 on an empty
  // tab, so the extent needs no getLastRow or getLastColumn call.
  const values = sheet_(LOG_TAB).getDataRange().getValues();
  const width = values[0].length;
  const cols = logColumns(values[0].map(cellText_));
  const read = logRead_();
  const entries = [];
  values.slice(1).forEach((cells, i) => {
    if (wanted.some((token) => logRowHasToken(cells, cols, token, read))) {
      entries.push(logEntry(cells, i + 2, cols, read));
    }
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

/**
 * Runs write, a Log write, between two Log changed stamps (markLogChanged_): one before
 * its first Log call and one after its last, even when it throws, so no log map read
 * before or during the write is used after it. opts {kiosk: true} writes no stamp: only
 * the kiosk's check-in and check-out pass it, since they forget and fill the map
 * themselves. Every shared Log write helper goes through this. Returns what write returns.
 */
function stampedLogWrite_(opts, write) {
  const kiosk = Boolean(opts && opts.kiosk);
  if (!kiosk) markLogChanged_();
  try {
    return write();
  } finally {
    if (!kiosk) markLogChanged_();
  }
}

/**
 * Writes a new row (a cell map) on the next empty Log row. Returns the row number. Stamps
 * the Log changed unless opts is {kiosk: true} (stampedLogWrite_).
 */
function appendLogRow_(cells, cols, opts) {
  return stampedLogWrite_(opts, () => {
    const sheet = sheet_(LOG_TAB);
    const row = sheet.getLastRow() + 1;
    if (row > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), 50);
    writeLogCells_(sheet, row, cells, cols);
    return row;
  });
}

/**
 * Writes a cell map onto an existing Log row. Stamps the Log changed unless opts is
 * {kiosk: true} (stampedLogWrite_).
 */
function updateLogRow_(row, cells, cols, opts) {
  stampedLogWrite_(opts, () => writeLogCells_(sheet_(LOG_TAB), row, cells, cols));
}

/**
 * Appends many rows (cell maps) below the Log's last row in one write, for a batch such
 * as Import past hours; appendLogRow_ writes cell by cell and is far too slow for hundreds
 * of rows. Grows the tab first when the rows would pass its last grid row. Then one
 * setNumberFormats and one setValues across the full width: each kiosk column a map names
 * gets its column's format, staff's columns keep theirs, and cells the maps don't name are
 * left blank. Returns the first new row number; map i is on that row plus i. Stamps the
 * Log changed (stampedLogWrite_).
 */
function appendLogRows_(cellMaps, cols, opts) {
  return stampedLogWrite_(opts, () => {
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
  });
}

// ---------------------------------------------------------------------------
// Log cache
//
// With the LOG_CACHE script property set to exactly "on", check-in and check-out read each
// volunteer's Log state from one script-cache item, the log map (Logic.js, "Log cache"),
// instead of the whole Log. The switch is read once per kiosk call; off, the call reads,
// decides and writes as it did before the cache, and touches neither the map nor the
// stamp. Only the developer changes it, from the Apps Script editor, with logCacheOn() and
// logCacheOff(); no tab, Settings row, menu or dialog shows it.
//
// The Log changed stamp is the script property logStampProperty(): the time of the last
// change to the spreadsheet a script writer or the change trigger saw. A map is used only
// when its whole-Log read started more than logCacheMarginMs() after the stamp. Every Log
// write helper stamps before and after its write (stampedLogWrite_), setupLog_ stamps
// first and last, and onSheetChange, the installable change trigger, stamps on every
// change anyone makes by hand. The kiosk's own write instead removes the map just before
// it writes and puts it back, with the write folded in, after the write is flushed.
//
// Every cache and property call is in its own try/catch: a read that fails is a miss, a
// put or remove that fails is logged and changes nothing else. The one failure that stops
// a tap is the kiosk failing both to remove the map and to stamp before its write.

/**
 * Writes the Log changed stamp, the time now, so no log map whose read started before now
 * is used again. Returns true, or false after logging when the write failed.
 */
function markLogChanged_() {
  try {
    PropertiesService.getScriptProperties().setProperty(logStampProperty(), String(Date.now()));
    return true;
  } catch (e) {
    console.error("Log change not stamped: " + (e && e.message ? e.message : String(e)));
    return false;
  }
}

/**
 * The installable change trigger: Sheets runs it after any change anyone makes by hand,
 * in any tab, of any kind (an edit, a paste, a row or column inserted or removed, a sort).
 * Its first and only work is the Log changed stamp: it reads nothing from the event or the
 * spreadsheet. It has no trigger check, since one would come before the stamp; the page
 * can name it through google.script.run, and such a call only makes the next tap read the
 * whole Log.
 */
function onSheetChange(e) {
  markLogChanged_();
}

/**
 * True when the Log cache switch reads on (logCacheSwitchOn, Logic.js). A read that fails
 * is logged and reads as off.
 */
function logCacheSwitchOn_() {
  try {
    return logCacheSwitchOn(
      PropertiesService.getScriptProperties().getProperty(logCacheSwitchProperty()),
    );
  } catch (e) {
    console.error("Log cache switch not read: " + (e && e.message ? e.message : String(e)));
    return false;
  }
}

/**
 * The Log as a kiosk call with the cache on needs it, for tokens (the User Tokens the
 * decision reads) and volunteers (the Profiles list). First the Log's extent and row 1, a
 * cache get of the map and a read of the stamp; when the map may be used (logCacheRead,
 * Logic.js) that is all: {hit: true, map, cols, width}. Otherwise the whole Log
 * (readLogMiss_) with the reason: {hit: false, reason, map, cols, width, entries}. A cache
 * or stamp read that fails is a miss with reason "error", logged.
 */
function readLogState_(tokens, volunteers) {
  const sheet = sheet_(LOG_TAB);
  // The data range runs from A1 to the last used row and column, as readLogTable_ reads it.
  const extent = sheet.getDataRange();
  const lastRow = extent.getLastRow();
  const width = extent.getLastColumn();
  const cols = logColumns(sheet.getRange(1, 1, 1, width).getValues()[0].map(cellText_));
  // The map and the stamp, each read in its own try: either failing is a miss.
  let text = null;
  let stamp = null;
  let failed = false;
  try {
    text = CacheService.getScriptCache().get(logCacheKey());
  } catch (e) {
    console.error("Log cache not read: " + (e && e.message ? e.message : String(e)));
    failed = true;
  }
  if (!failed) {
    try {
      stamp = PropertiesService.getScriptProperties().getProperty(logStampProperty());
    } catch (e) {
      console.error("Log cache not read: " + (e && e.message ? e.message : String(e)));
      failed = true;
    }
  }
  const got = failed
    ? { miss: "error" }
    : logCacheRead(text, stamp, Date.now(), logLayout(cols), lastRow, tokens);
  if (got.miss) return { hit: false, reason: got.miss, ...readLogMiss_(tokens, volunteers) };
  return { hit: true, map: got, cols, width };
}

/**
 * The whole Log in one range read, as readLogTable_ reads it, and in the same pass the
 * log map built from it: {cols, width, entries, map}. entries are the rows of tokens,
 * exactly what readLogTable_(tokens) keeps, so a decision on them is the one made without
 * the cache. map is {readAt, layout, lastRow, states} with every Profiles token's state
 * (logTableStates, Logic.js); readAt is the time taken before the read. The map is stored
 * only after the call's own write is flushed, never here.
 */
function readLogMiss_(tokens, volunteers) {
  const readAt = Date.now();
  const values = sheet_(LOG_TAB).getDataRange().getValues();
  const width = values[0].length;
  const cols = logColumns(values[0].map(cellText_));
  const built = logTableStates(
    values,
    cols,
    logRead_(),
    tokens,
    volunteers.map((v) => v.token),
  );
  return {
    cols,
    width,
    entries: built.entries,
    map: { readAt, layout: logLayout(cols), lastRow: values.length, states: built.states },
  };
}

/**
 * Removes the log map just before a kiosk Log write, so no stored map lacks the write.
 * When the remove fails it stamps instead, which makes every stored map unusable; when that
 * fails too it throws, before anything is written.
 */
function forgetLogMap_() {
  try {
    CacheService.getScriptCache().remove(logCacheKey());
    return;
  } catch (e) {
    console.error("Log cache not removed: " + (e && e.message ? e.message : String(e)));
  }
  if (!markLogChanged_()) {
    throw new Error(
      "The Log cache could not be cleared before the Log write, so nothing was written.",
    );
  }
}

/**
 * Stores map, the log map with the call's own write folded in, after the write is flushed.
 * A map whose text is over logCacheMaxBytes() isn't stored: the stored one is removed and
 * every tap reads the whole Log. map null stores nothing; why says why in the log line.
 * Every failure is logged as "Log cache: not stored (<why>)" and changes nothing else.
 */
function putLogMap_(map, why) {
  if (!map) {
    console.log("Log cache: not stored (" + (why || "no map") + ")");
    return;
  }
  const text = encodeLogMap(map);
  const size = utf8Length(text);
  try {
    if (size <= logCacheMaxBytes()) {
      CacheService.getScriptCache().put(logCacheKey(), text, logCacheSeconds());
      return;
    }
    console.log("Log cache: not stored (" + size + " bytes, over the limit)");
    CacheService.getScriptCache().remove(logCacheKey());
  } catch (e) {
    console.log("Log cache: not stored (" + (e && e.message ? e.message : String(e)) + ")");
  }
}

/** Removes the log map; a failure is logged. Returns true when the remove went through. */
function removeLogMap_() {
  try {
    CacheService.getScriptCache().remove(logCacheKey());
    return true;
  } catch (e) {
    console.error("Log cache not removed: " + (e && e.message ? e.message : String(e)));
    return false;
  }
}

/**
 * Run from the Apps Script editor after changing the Log in a way the change trigger
 * doesn't see (another script, version history, the test copy's kit): stamps the Log
 * changed and removes the log map, so the next tap reads the whole Log. Leaves the switch
 * as it is.
 */
function clearLogCache() {
  requireEditorRun_();
  const stamped = markLogChanged_();
  const removed = removeLogMap_();
  console.log(
    "clearLogCache: stamp " +
      (stamped ? "written" : "not written") +
      ", map " +
      (removed ? "removed" : "not removed"),
  );
}

/**
 * Turns the Log cache on, run from the Apps Script editor. Stamps first, then sets the
 * switch, so no map stored before this run is ever used. A stamp that fails throws before
 * the switch is set. Run it only after every kiosk page was reloaded on the deployment.
 */
function logCacheOn() {
  requireEditorRun_();
  if (!markLogChanged_()) {
    throw new Error("The Log changed stamp wasn't written, so the Log cache stays off.");
  }
  console.log("logCacheOn: stamp written");
  PropertiesService.getScriptProperties().setProperty(logCacheSwitchProperty(), "on");
  console.log("logCacheOn: the Log cache is on");
}

/**
 * Turns the Log cache off, run from the Apps Script editor; it is also the rollback. Under
 * the script lock, so no kiosk call is under way: deletes the switch, which throws through
 * when it fails, then stamps and removes the map. Its stamp keeps every map stored before
 * it from being used, even when the switch is later set to on by hand. A lock that isn't
 * free within 30 seconds throws and changes nothing.
 */
function logCacheOff() {
  requireEditorRun_();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error("Kiosk busy, run it again");
  try {
    PropertiesService.getScriptProperties().deleteProperty(logCacheSwitchProperty());
    console.log("logCacheOff: the Log cache is off");
    if (markLogChanged_()) {
      console.log("logCacheOff: stamp written");
    } else {
      console.log("logCacheOff: stamp not written; turn the cache on again only with logCacheOn()");
    }
    console.log("logCacheOff: map " + (removeLogMap_() ? "removed" : "not removed"));
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Flags

/**
 * Appends Flags rows (flagRows, Logic.js) below the last row in use: planFlagRows_ for the
 * reads, then writeFlagRows_. Jobs.js and Import.js call this. Throws when the tab or a
 * header it needs is missing.
 */
function appendFlagRows_(rows) {
  if (!rows.length) return;
  writeFlagRows_(planFlagRows_(rows.length), rows);
}

/**
 * The last Flags row in use (flagRowUsed, Logic.js), or 1 when no row below the header
 * is. One read of rows 2 to the last row across width. setupSheets puts an unticked box on
 * every row, so the tab's last row is often far below the last flag; a new flag goes
 * right under the last one instead.
 */
function lastFlagRow_(sheet, cols, width) {
  const last = sheet.getLastRow();
  if (last < 2) return 1;
  const values = sheet.getRange(2, 1, last - 1, width).getValues();
  for (let i = values.length - 1; i >= 0; i--) {
    if (flagRowUsed(values[i], cols)) return i + 2;
  }
  return 1;
}

/**
 * Every Flags read an append of count rows needs, so the write that follows reads
 * nothing: the tab, its header (placed by flagColumns, so columns may be in any order),
 * its rows (lastFlagRow_) and last grid row. The new rows start right under the last row
 * in use. Grows the tab first when the rows would pass its last grid row, then reads the
 * new range's number formats. Returns {sheet, cols, width, first, formats}: first is the
 * first new row, formats one line per row. A check-in or check-out plans before its Log
 * write, so it reads nothing after that write. Throws when the tab or a header it needs
 * is missing.
 */
function planFlagRows_(count) {
  const sheet = sheet_(FLAGS_TAB);
  const header = logHeaderRow_(sheet);
  const cols = flagColumns(header);
  const width = header.length;
  const first = lastFlagRow_(sheet, cols, width) + 1;
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
  const line = headerMapCopy(logHeader, values, header, width).map(cellBack_);
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

/** Deletes one Log row; the rows below it move up. Stamps the Log changed (stampedLogWrite_). */
function deleteLogRow_(row, opts) {
  stampedLogWrite_(opts, () => sheet_(LOG_TAB).deleteRow(row));
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
 * Returns the new row's number. Stamps the Log changed (stampedLogWrite_).
 */
function appendLogValues_(values, formats, cols, opts) {
  return stampedLogWrite_(opts, () => {
    const sheet = sheet_(LOG_TAB);
    const width = values.length;
    const row = sheet.getLastRow() + 1;
    if (row > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), 50);
    const range = sheet.getRange(row, 1, 1, width);
    const kept = range.getNumberFormats()[0];
    const lineFormats = formats.map((f, j) => (f === null || f === "" ? kept[j] : f));
    const kinds = logColumnKinds();
    Object.keys(cols).forEach((h) => {
      const c = cols[h];
      if (c < 0 || c >= width) return;
      const format = logFormat_(kinds[h]);
      // A real date in a text column (pasted in by hand) keeps the format it came with, so
      // it still reads as that date rather than as a serial number under plain text.
      if (format === "@" && isDateValue_(values[c]) && lineFormats[c] !== kept[c]) return;
      lineFormats[c] = format;
    });
    range.setNumberFormats([lineFormats]);
    range.setValues([values.map(cellBack_)]);
    return row;
  });
}

/** True when v is a Date, from any script context. */
function isDateValue_(v) {
  return Object.prototype.toString.call(v) === "[object Date]";
}

/**
 * A cell value read with getValues, as it is written back by setValues so the cell reads
 * the same: null is blank, text goes through sheetText (so text starting with "=" or an
 * apostrophe stays text), and numbers, booleans and dates are written as they are. A
 * formula is not kept: its value is written.
 */
function cellBack_(v) {
  if (v === null) return "";
  return typeof v === "string" ? sheetText(v) : v;
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

// ---------------------------------------------------------------------------
// Hours emails
//
// The tab Kiosk admin > Email hours… (Admin.js) writes one row on for each volunteer a send
// takes, and reads back for the preview's Last emailed line. Nothing else reads it. It is
// read and written by header; the row's cells come from hoursEmailRow (Logic.js).

/**
 * The Hours emails tab, made on the first write, as {sheet, cols}: the header in plain
 * text, row 1 frozen, and one warning-only protection (protectOnce_, so a later write adds
 * no second). A tab whose row 1 is empty gets the header.
 */
function hoursEmailSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(hoursEmailTab()) || ss.insertSheet(hoursEmailTab());
  let header = logHeaderRow_(sheet);
  if (header.every((h) => h === "")) {
    const headers = hoursEmailHeaders();
    sheet.getRange(1, 1, 1, headers.length).setNumberFormat("@").setValues([headers]);
    sheet.setFrozenRows(1);
    header = headers;
  }
  protectOnce_(
    sheet.getProtections(SpreadsheetApp.ProtectionType.SHEET),
    hoursEmailProtectionDescription(),
    () => sheet.protect(),
  );
  return { sheet, cols: hoursEmailColumns(header) };
}

/**
 * Appends Hours emails rows (hoursEmailRow maps) below the tab's last row, in one
 * setNumberFormats and one setValues: Sent at as a date-time, the hours as numbers with
 * 0.00, every other column of the tab's own as plain text. Columns staff added keep their
 * format and get a blank.
 */
function appendHoursEmailRows_(rows) {
  if (!rows.length) return;
  const { sheet, cols } = hoursEmailSheet_();
  const width = logHeaderRow_(sheet).length;
  const first = sheet.getLastRow() + 1;
  const last = first + rows.length - 1;
  if (last > sheet.getMaxRows()) {
    sheet.insertRowsAfter(sheet.getMaxRows(), Math.max(50, last - sheet.getMaxRows()));
  }
  const range = sheet.getRange(first, 1, rows.length, width);
  const formats = range.getNumberFormats();
  const kinds = hoursEmailColumnKinds();
  const format = { date: DATE_TIME_FORMAT, hours: "0.00", text: "@" };
  const values = rows.map((row, i) => {
    const line = new Array(width).fill("");
    Object.keys(cols).forEach((h) => {
      formats[i][cols[h]] = format[kinds[h]];
      line[cols[h]] = kinds[h] === "date" ? new Date(row[h]) : row[h];
    });
    return line;
  });
  range.setNumberFormats(formats);
  range.setValues(values);
}

/**
 * The Hours emails tab's rows as [{id, result, ms, date, by}] for the Last emailed line,
 * or null when there is no tab. Sent at is read as a time (ms NaN when it can't be) and
 * date is its Central yyyy-MM-dd, or the cell's text when it isn't a time. Throws when
 * row 1 lacks a header.
 */
function readHoursEmailSends_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(hoursEmailTab());
  if (!sheet) return null;
  const header = logHeaderRow_(sheet);
  if (header.every((h) => h === "")) return [];
  const cols = hoursEmailColumns(header);
  const last = sheet.getLastRow();
  if (last < 2) return [];
  return sheet
    .getRange(2, 1, last - 1, header.length)
    .getValues()
    .map((cells) => {
      const t = cellTime_(cells[cols["Sent at"]]);
      return {
        id: cellText_(cells[cols["Volunteer ID"]]),
        result: cellText_(cells[cols.Result]),
        ms: t.ms,
        date: t.date || cellText_(cells[cols["Sent at"]]),
        by: cellText_(cells[cols["Sent by"]]),
      };
    });
}

// ---------------------------------------------------------------------------
// Staff help
//
// setupSheets writes the help staff read in the sheet; the text is in Logic.js ("Staff
// help"). Settings column C and the How to tab are the kiosk's and rewritten whole; a
// header note is written only where the cell's note is empty or still exactly a kiosk text.

/**
 * Settings column C from row 2 down: one settingsDescriptionColumn (Logic.js) text per row
 * down to the last row with a name, each name read by cellText_ as readSettings_ reads it,
 * in one setValues. C below that row, down to the tab's last row, is cleared, so text left
 * by a deleted row never sits beside the next appended setting. Writes no other column.
 */
function writeSettingsDescriptions_(settings) {
  const last = settings.getLastRow();
  if (last < 2) return;
  const names = settings
    .getRange(2, 1, last - 1, 1)
    .getValues()
    .map((r) => cellText_(r[0]));
  let named = 0;
  names.forEach((name, i) => {
    if (name !== "") named = i + 1;
  });
  if (named) {
    settings
      .getRange(2, 3, named, 1)
      .setValues(settingsDescriptionColumn(names.slice(0, named)).map((t) => [t]));
  }
  if (named + 1 < last) settings.getRange(named + 2, 3, last - named - 1, 1).clearContent();
}

/**
 * Adds a warning-only protection with this description unless one of existing (a tab's
 * protections) already has it, so a rerun never stacks a second. protect makes the
 * protection on the right range or tab.
 */
function protectOnce_(existing, description, protect) {
  if ((existing || []).some((p) => p.getDescription() === description)) return;
  protect().setDescription(description).setWarningOnly(true);
}

/**
 * The header notes on a Log or Flags tab's row 1, from A to the header's width: one
 * getNotes, then headerNotesRow (Logic.js) with headerNoteKioskTexts(), and a setNote only
 * on each cell whose note changes. A note the rule keeps, a staff note above all, is never
 * written back, so it can't be altered by a round trip through Sheets.
 */
function writeHeaderNotes_(sheet, names, notes) {
  const header = logHeaderRow_(sheet);
  const existing = sheet.getRange(1, 1, 1, header.length).getNotes()[0];
  const wanted = headerNotesRow(header, names, notes, existing, headerNoteKioskTexts());
  wanted.forEach((note, i) => {
    if (note !== existing[i]) sheet.getRange(1, i + 1).setNote(note);
  });
}

/**
 * The tab carrying the kiosk's How to mark (howToTabMark, Logic.js), or null. Found by
 * its developer metadata, never by name, so a renamed or moved tab is still the kiosk's.
 * Two marked tabs (a duplicated tab carries the mark) stop it, both named.
 */
function findHowToTabs_(ss) {
  const mark = howToTabMark();
  const found = [];
  ss.createDeveloperMetadataFinder()
    .withKey(mark.key)
    .find()
    .forEach((md) => {
      const sheet = md.getLocation().getSheet();
      if (!sheet || md.getValue() !== mark.value) return;
      if (!found.some((s) => s.getSheetId() === sheet.getSheetId())) found.push(sheet);
    });
  if (found.length > 1) {
    throw new Error(
      "These tabs all carry the kiosk's " +
        howToTabName() +
        " mark: " +
        found.map((s) => s.getName()).join(", ") +
        ". Delete the copy, then run setupSheets again.",
    );
  }
  return found[0] || null;
}

/**
 * The How to tab, setupSheets' last step.
 * - A marked tab (findHowToTabs_) is rewritten where it is, under the name it has now; it
 *   is never moved or renamed, and other tabs' names aren't looked at.
 * - With no marked tab, a tab named "How to" in any capitals is someone else's, and it
 *   stops, named, since Sheets won't hold two names that differ only in capitals.
 *   Otherwise a new tab is inserted first in the tab bar and marked. So a deleted How to
 *   comes back at the next run.
 * Then: one warning-only protection on the tab (protectOnce_), the tab cleared, column A
 * as plain text, howToRows (Logic.js) in one setValues with howToStyles' formats, then
 * each row with a formula (the Kiosk contact line) set to the General format and given
 * its formula, column A 820 px and wrapped, row 1 frozen and the tab colour. The clear at
 * the start removes the last run's formula, so a second run gives the same tab.
 */
function setupHowTo_(ss) {
  let sheet = findHowToTabs_(ss);
  if (!sheet) {
    const name = howToTabName();
    const clash = ss.getSheets().find((s) => s.getName().toLowerCase() === name.toLowerCase());
    if (clash) {
      throw new Error(
        'A tab named "' +
          clash.getName() +
          "\" is already there and isn't the kiosk's. Rename it, then run setupSheets again.",
      );
    }
    sheet = ss.insertSheet(name, 0);
    sheet.addDeveloperMetadata(howToTabMark().key, howToTabMark().value);
  }
  protectOnce_(
    sheet.getProtections(SpreadsheetApp.ProtectionType.SHEET),
    howToProtectionDescription(),
    () => sheet.protect(),
  );

  const rows = howToRows();
  const styles = howToStyles();
  const pick = (field) => rows.map((r) => [styles[r.kind][field]]);
  sheet.clear();
  if (sheet.getMaxRows() < rows.length) {
    sheet.insertRowsAfter(sheet.getMaxRows(), rows.length - sheet.getMaxRows());
  }
  sheet.getRange("A:A").setNumberFormat("@");
  sheet
    .getRange(1, 1, rows.length, 1)
    .setValues(rows.map((r) => [r.text]))
    .setFontWeights(pick("weight"))
    .setFontSizes(pick("size"))
    .setFontColors(pick("colour"))
    .setBackgrounds(pick("background"))
    .setFontStyles(pick("style"));
  rows.forEach((r, i) => {
    if (!r.formula) return;
    sheet
      .getRange(i + 1, 1)
      .setNumberFormat("General")
      .setFormula(r.formula);
  });
  sheet.setColumnWidth(1, 820);
  sheet.getRange("A:A").setWrap(true);
  sheet.setFrozenRows(1);
  sheet.setTabColor(lookTabColours().howTo);
}

/**
 * The Settings value "Kiosk contact" as readSettings_ reads it, or "" when the read throws
 * (logged), so a missing Settings tab never stops a Kiosk admin window opening or an
 * alert showing. Read from the tab on every call, never from a cache.
 */
function kioskContact_() {
  try {
    return readSettings_()[kioskContactSetting()] || "";
  } catch (err) {
    console.log("Kiosk contact not read: " + ((err && err.message) || String(err)));
    return "";
  }
}
