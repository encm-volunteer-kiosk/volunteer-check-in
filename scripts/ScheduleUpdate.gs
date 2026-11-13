
/**
 * VOLUNTEER DAILY AUTO CHECK-OUT
 *
 * Uses the spreadsheet bound to this Apps Script project.
 *
 * Shifts:
 *   A (1) = Shifts (weekday)
 *   B (2) = Shift Schedule (Morning/Afternoon/etc.)
 *   D (4) = Start
 *   E (5) = Finish
 *
 * Log:
 *   E/F = Check-In Recorded/Stated (never overwritten; prefer Stated)
 *   G/H = Check-Out Recorded/Stated (execution time/calculated sign-out)
 *   I/J = Hours Served (timestamps/stated)
 *   O = Status, Q = Check-Out Entered By
 *   Log columns are located by header, not position.
 *
 * Process blank sign-outs for every arrival date before today.
 * Retry hourly so overnight finishes and three-hour fallbacks are not written early.
 */

const CONFIG = Object.freeze({
  LOG_SHEET: "Log",
  SHIFTS_SHEET: "Shifts",

  // Numeric column indexes (1-based)
  SHIFT_DAY: 1,
  SHIFT_SCHEDULE: 2,
  SHIFT_START: 4,
  SHIFT_FINISH: 5,

  HEADER_ROWS: 1,

  FALLBACK_HOURS: 3,

  // TRUE = Preview only, FALSE = Write changes
  DRY_RUN: false,

  // Enable INFO, WARN, and per-row DEBUG logs only while troubleshooting.
  DEBUG: false,

  // Read written cells back after SpreadsheetApp.flush().
  VERIFY_WRITES: true
});


/**
 * MAIN FUNCTION
 * Automatically checks out eligible log records.
 */
function updateDailyCheckOuts() {
  const executionId = Utilities.getUuid();
  const startedAt = new Date();
  let lockAcquired = false;
  let currentRow = null;
  let currentPhase = "INITIALIZATION";
  const counts = {
    shiftsRead: 0,
    usableShifts: 0,
    logRowsRead: 0,
    existingCheckout: 0,
    missingCheckIn: 0,
    differentDate: 0,
    invalidCheckInTime: 0,
    fallbacks: 0,
    ambiguous: 0,
    notDue: 0,
    eligible: 0,
    updated: 0,
    previews: 0,
    errors: 0
  };
  const log = (level, event, details) => {
    if (level !== "ERROR" && !CONFIG.DEBUG) return;
    const entry = {
      timestamp: new Date().toISOString(),
      executionId: executionId,
      level: level,
      event: event,
      details: details || {}
    };
    // Dates in details are serialized to ISO. All log entries are searchable.
    const line = "[SCHEDULE_CHECKOUT] " + JSON.stringify(entry);
    if (level === "ERROR") console.error(line);
    else if (level === "WARN") console.warn(line);
    else console.log(line);
  };
  const debug = (event, details) => {
    log("DEBUG", event, details);
  };
  const describe = value => {
    if (value === "") return "<EMPTY STRING>";
    if (value === null || value === undefined) return "<BLANK>";
    if (value instanceof Date) {
      return isNaN(value.getTime()) ? "<INVALID DATE>" : value.toISOString();
    }
    return String(value);
  };

  log("INFO", "START", {
    functionName: "updateDailyCheckOuts",
    startedAt: startedAt.toISOString(),
    logSheet: CONFIG.LOG_SHEET,
    shiftsSheet: CONFIG.SHIFTS_SHEET,
    fallbackHours: CONFIG.FALLBACK_HOURS,
    dryRun: CONFIG.DRY_RUN,
    debug: CONFIG.DEBUG,
    verifyWrites: CONFIG.VERIFY_WRITES,
    columnIndexes: {
      shiftDay: CONFIG.SHIFT_DAY,
      shiftSchedule: CONFIG.SHIFT_SCHEDULE,
      shiftStart: CONFIG.SHIFT_START,
      shiftFinish: CONFIG.SHIFT_FINISH
    }
  });

  const lock = LockService.getScriptLock();
  try {
    currentPhase = "LOCK";
    log("INFO", "LOCK_WAIT", { timeoutMs: 30000 });
    if (!lock.tryLock(30000)) {
      throw new Error("Another checkout process is running.");
    }
    lockAcquired = true;
    log("INFO", "LOCK_ACQUIRED");

    currentPhase = "OPEN_SHEETS";
    const ss = getCheckoutSpreadsheet_();
    const logSheet = ss.getSheetByName(CONFIG.LOG_SHEET);
    const shiftSheet = ss.getSheetByName(CONFIG.SHIFTS_SHEET);
    if (!logSheet || !shiftSheet) {
      log("ERROR", "MISSING_SHEET", {
        logSheetFound: Boolean(logSheet),
        shiftsSheetFound: Boolean(shiftSheet)
      });
      throw new Error("Required worksheet not found.");
    }
    const timezone = ss.getSpreadsheetTimeZone();
    const now = new Date();
    const today = Utilities.formatDate(now, timezone, "yyyy-MM-dd");
    const weekdayNames = [
      "Sunday", "Monday", "Tuesday", "Wednesday",
      "Thursday", "Friday", "Saturday"
    ];
    const currentLocal = Utilities.formatDate(now, timezone, "yyyy-MM-dd HH:mm");
    log("INFO", "SHEETS_OPENED", {
      spreadsheetId: ss.getId(),
      spreadsheetName: ss.getName(),
      timezone: timezone,
      shiftsLastRow: shiftSheet.getLastRow(),
      logLastRow: logSheet.getLastRow()
    });
    log("INFO", "PROCESSING_DATE", {
      today: today,
      arrivalDateBefore: today,
      currentLocal: currentLocal,
      explanation: "Processing all earlier arrivals using each row's arrival date and weekday."
    });

    currentPhase = "READ_SHEETS";
    const shiftRange = shiftSheet.getDataRange();
    const logRange = logSheet.getDataRange();
    const shifts = shiftRange.getValues();
    const shiftText = shiftRange.getDisplayValues();
    const logs = logRange.getValues();
    log("INFO", "DATA_READ", {
      shiftRowsIncludingHeaders: shifts.length,
      shiftColumns: shiftText[0] ? shiftText[0].length : 0,
      logRowsIncludingHeaders: logs.length,
      logColumns: logs[0] ? logs[0].length : 0
    });

    if (logs.length <= CONFIG.HEADER_ROWS) {
      log("WARN", "NO_DATA", {
        reason: "Log has no data rows after the header."
      });
      return;
    }
    const shiftDayIdx = CONFIG.SHIFT_DAY - 1;
    const scheduleIdx = CONFIG.SHIFT_SCHEDULE - 1;
    const startIdx = CONFIG.SHIFT_START - 1;
    const finishIdx = CONFIG.SHIFT_FINISH - 1;
    if (
      shiftText[0].length < Math.max(
        CONFIG.SHIFT_DAY, CONFIG.SHIFT_SCHEDULE, CONFIG.SHIFT_START,
        CONFIG.SHIFT_FINISH
      )
    ) {
      throw new Error("One or more configured columns do not exist.");
    }
    const logColumns = getCheckoutLogColumns_(logs[0]);
    [
      [CONFIG.SHIFT_DAY, "Shifts"],
      [CONFIG.SHIFT_SCHEDULE, "Shift Schedule"],
      [CONFIG.SHIFT_START, "Start"],
      [CONFIG.SHIFT_FINISH, "Finish"]
    ].forEach(([column, expected]) => {
      const actual = String(shiftText[0][column - 1]).trim().replace(/\s+/g, " ");
      if (normalizeCheckoutHeader_(actual) !== normalizeCheckoutHeader_(expected)) {
        throw new Error(
          CONFIG.SHIFTS_SHEET + " column " + column + ' must be "' + expected +
          '", not "' + actual + '".'
        );
      }
    });
    log("INFO", "COLUMN_VALIDATION_PASSED", { logColumns: logColumns });

    currentPhase = "COLLECT_SHIFTS";
    const availableShifts = [];
    for (let i = CONFIG.HEADER_ROWS; i < shifts.length; i++) {
      const shiftRow = i + 1;
      counts.shiftsRead++;
      const dayValue = shifts[i][shiftDayIdx];
      const dayText = String(shiftText[i][shiftDayIdx]).trim().toLowerCase();
      const scheduleText = shiftText[i][scheduleIdx];
      const startText = shiftText[i][startIdx];
      const finishText = shiftText[i][finishIdx];
      const dayDate = dayValue instanceof Date && !isNaN(dayValue.getTime())
        ? Utilities.formatDate(dayValue, timezone, "yyyy-MM-dd")
        : null;
      debug("SHIFT_ROW_READ", {
        shiftRow: shiftRow, dayRaw: describe(dayValue), dayDisplayed: dayText,
        scheduleDisplayed: scheduleText, startDisplayed: startText,
        finishDisplayed: finishText
      });
      const startMinutes = parseTime(startText);
      if (startMinutes === null) {
        log("WARN", "SHIFT_SKIPPED", {
          shiftRow: shiftRow, reason: "INVALID_START_TIME", startDisplayed: startText
        });
        continue;
      }
      const finishMinutes = parseTime(finishText);
      if (finishMinutes === null) {
        log("WARN", "SHIFT_SKIPPED", {
          shiftRow: shiftRow, reason: "INVALID_FINISH_TIME", finishDisplayed: finishText
        });
        continue;
      }
      const overnight = finishMinutes <= startMinutes;
      const endMinutes = finishMinutes + (overnight ? 1440 : 0);
      availableShifts.push({
        day: dayText,
        date: dayDate,
        start: startMinutes,
        end: endMinutes,
        finishMinutes: finishMinutes,
        overnight: overnight,
        shiftRow: shiftRow
      });
      counts.usableShifts++;
      log("INFO", "SHIFT_ADDED", {
        shiftRow: shiftRow, day: dayText,
        startMinutes: startMinutes, endMinutes: endMinutes
      });
    }
    log("INFO", "SHIFT_COLLECTION_SUMMARY", {
      shiftsRead: counts.shiftsRead,
      usableShifts: availableShifts.length
    });

    currentPhase = "PROCESS_LOG_ROWS";
    for (let i = CONFIG.HEADER_ROWS; i < logs.length; i++) {
      const row = logs[i];
      const logRow = i + 1;
      currentRow = logRow;
      counts.logRowsRead++;
      const recordedCheckin = row[logColumns.recordedIn - 1];
      const statedCheckin = row[logColumns.statedIn - 1];
      const useStatedCheckin = isCheckoutDate_(statedCheckin);
      const checkin = useStatedCheckin ? statedCheckin : recordedCheckin;
      const checkinColumn = useStatedCheckin ? logColumns.statedIn : logColumns.recordedIn;
      const existingRecordedCheckout = row[logColumns.recordedOut - 1];
      const existingCheckout = row[logColumns.statedOut - 1];
      debug("LOG_ROW_READ", {
        logRow: logRow, checkInColumn: checkinColumn,
        checkInRaw: describe(checkin),
        recordedCheckoutColumn: logColumns.recordedOut,
        recordedCheckoutRaw: describe(existingRecordedCheckout),
        checkoutColumn: logColumns.statedOut,
        checkoutRaw: describe(existingCheckout)
      });
      if (!isBlank(existingRecordedCheckout) || !isBlank(existingCheckout)) {
        counts.existingCheckout++;
        debug("LOG_ROW_SKIPPED", {
          logRow: logRow, reason: "CHECKOUT_ALREADY_PRESENT",
          recordedCheckout: describe(existingRecordedCheckout),
          statedCheckout: describe(existingCheckout)
        });
        continue;
      }
      if (!isCheckoutDate_(checkin)) {
        counts.missingCheckIn++;
        debug("LOG_ROW_SKIPPED", {
          logRow: logRow, reason: "CHECKIN_NOT_VALID_DATE",
          checkInValue: describe(checkin), checkInType: typeof checkin
        });
        continue;
      }
      const checkinDate = Utilities.formatDate(checkin, timezone, "yyyy-MM-dd");
      if (checkinDate >= today) {
        counts.differentDate++;
        debug("LOG_ROW_SKIPPED", {
          logRow: logRow, reason: "CHECKIN_DATE_NOT_BEFORE_TODAY",
          checkInDate: checkinDate, arrivalDateBefore: today
        });
        continue;
      }
      const checkinTime = Utilities.formatDate(checkin, timezone, "HH:mm");
      const checkinMinutes = parseTime(checkinTime);
      if (checkinMinutes === null) {
        counts.invalidCheckInTime++;
        debug("LOG_ROW_SKIPPED", {
          logRow: logRow, reason: "INVALID_CHECKIN_TIME",
          checkInTime: checkinTime
        });
        continue;
      }
      const checkinDay = weekdayNames[
        new Date(checkinDate + "T12:00:00Z").getUTCDay()
      ];
      const candidates = availableShifts.filter(shift => {
        const dayMatches =
          shift.day === checkinDay.toLowerCase() ||
          shift.day === checkinDay.substring(0, 3).toLowerCase() ||
          shift.day === checkinDate ||
          shift.date === checkinDate;
        const inWindow = dayMatches &&
          checkinMinutes >= shift.start && checkinMinutes < shift.end;
        debug("SHIFT_CANDIDATE_COMPARISON", {
          logRow: logRow, shiftRow: shift.shiftRow,
          checkInDate: checkinDate, checkInDay: checkinDay,
          shiftDay: shift.day, dayMatches: dayMatches,
          checkInTime: checkinTime, checkInMinutes: checkinMinutes,
          shiftStartMinutes: shift.start, shiftEndMinutes: shift.end,
          inWindow: inWindow
        });
        return inWindow;
      });
      const exactStarts = candidates.filter(shift => shift.start === checkinMinutes);
      const preferred = exactStarts.length ? exactStarts : candidates;
      const latestStart = preferred.length
        ? Math.max(...preferred.map(shift => shift.start))
        : null;
      const uniqueShifts = new Map();
      preferred.filter(shift => shift.start === latestStart).forEach(shift => {
        const key = shift.start + "|" + shift.end;
        if (!uniqueShifts.has(key)) uniqueShifts.set(key, shift);
      });
      if (uniqueShifts.size > 1) {
        counts.ambiguous++;
        log("WARN", "LOG_ROW_SKIPPED", {
          logRow: logRow, reason: "AMBIGUOUS_MULTIPLE_SHIFTS",
          matchingShiftRows: [...uniqueShifts.values()].map(s => s.shiftRow)
        });
        continue;
      }
      const matchedShift = uniqueShifts.size ? [...uniqueShifts.values()][0] : null;
      let checkout;
      if (matchedShift) {
        const finishDate = matchedShift.overnight
          ? addDays(checkinDate, 1)
          : checkinDate;
        checkout = Utilities.parseDate(
          finishDate + " " + formatMinutes(matchedShift.finishMinutes),
          timezone, "yyyy-MM-dd HH:mm"
        );
      } else {
        checkout = new Date(checkin.getTime() + CONFIG.FALLBACK_HOURS * 60 * 60 * 1000);
      }
      if (!matchedShift) {
        counts.fallbacks++;
        log("INFO", "FALLBACK_CHECKOUT_SELECTED", {
          logRow: logRow, reason: "NO_MATCHING_SHIFT",
          checkInDate: checkinDate,
          checkInTime: checkinTime, fallbackHours: CONFIG.FALLBACK_HOURS,
          proposedCheckout: checkout.toISOString()
        });
      }
      if (checkout.getTime() > now.getTime()) {
        counts.notDue++;
        log("INFO", "LOG_ROW_SKIPPED", {
          logRow: logRow, reason: "CHECKOUT_NOT_DUE",
          proposedCheckout: checkout.toISOString(), currentTime: now.toISOString()
        });
        continue;
      }
      counts.eligible++;
      const recordedHours = checkoutHours_(recordedCheckin, now);
      const statedHours = checkoutHours_(checkin, checkout);
      const updates = [
        { column: logColumns.recordedOut, value: now, format: "yyyy-mm-dd h:mm am/pm" },
        { column: logColumns.statedOut, value: checkout, format: "yyyy-mm-dd h:mm am/pm" },
        { column: logColumns.recordedHours, value: recordedHours, format: "0.00" },
        { column: logColumns.statedHours, value: statedHours, format: "0.00" },
        { column: logColumns.status, value: "closed", format: "@" },
        { column: logColumns.outBy, value: "auto-checkout", format: "@" }
      ];
      log("INFO", "BEFORE_UPDATE", {
        logRow: logRow, matchedShiftRow: matchedShift ? matchedShift.shiftRow : null,
        checkInDate: checkinDate, checkInDay: checkinDay,
        checkoutColumn: logColumns.statedOut,
        currentCheckout: describe(existingCheckout),
        proposedCheckout: Utilities.formatDate(
          checkout, timezone, "yyyy-MM-dd HH:mm:ss"
        ),
        proposedRecordedCheckout: now.toISOString(),
        recordedHours: recordedHours, statedHours: statedHours,
        mode: CONFIG.DRY_RUN ? "DRY_RUN" : "LIVE"
      });
      if (CONFIG.DRY_RUN) {
        counts.previews++;
        log("INFO", "UPDATE_PREVIEW_ONLY", {
          logRow: logRow, reason: "CONFIG.DRY_RUN=true; no cells were written"
        });
        continue;
      }
      currentPhase = "WRITE_CHECKOUT";
      updates.forEach(update => {
        logSheet.getRange(logRow, update.column)
          .setNumberFormat(update.format)
          .setValue(update.value);
      });
      log("INFO", "WRITE_SUBMITTED", {
        logRow: logRow, columns: updates.map(update => update.column)
      });
      if (CONFIG.VERIFY_WRITES) {
        currentPhase = "VERIFY_CHECKOUT";
        SpreadsheetApp.flush();
        const verification = updates.map(update => {
          const cell = logSheet.getRange(logRow, update.column);
          const actual = cell.getValue();
          const matches = isCheckoutDate_(update.value)
            ? isCheckoutDate_(actual) &&
              Math.abs(actual.getTime() - update.value.getTime()) <= 1000
            : actual === update.value;
          return {
            column: update.column,
            expected: describe(update.value),
            actual: describe(actual),
            displayed: cell.getDisplayValue(),
            matches: matches
          };
        });
        const checkoutMatches = verification.every(cell => cell.matches);
        log(checkoutMatches ? "INFO" : "ERROR", "AFTER_UPDATE", {
          logRow: logRow,
          cells: verification,
          checkoutMatches: checkoutMatches
        });
        if (!checkoutMatches) {
          throw new Error(
            "Checkout write verification failed at log row " + logRow +
            ". Review AFTER_UPDATE log for actual cell values."
          );
        }
      } else {
        log("INFO", "AFTER_UPDATE_UNVERIFIED", {
          logRow: logRow, reason: "VERIFY_WRITES=false"
        });
      }
      counts.updated++;
      log("INFO", "ROW_UPDATE_SUCCESS", {
        logRow: logRow, matchedShiftRow: matchedShift ? matchedShift.shiftRow : null
      });
      currentPhase = "PROCESS_LOG_ROWS";
    }
    log("INFO", "SUMMARY", {
      arrivalDateBefore: today,
      mode: CONFIG.DRY_RUN ? "DRY_RUN" : "LIVE",
      ...counts,
      skipped: counts.existingCheckout + counts.missingCheckIn +
        counts.differentDate + counts.invalidCheckInTime + counts.ambiguous +
        counts.notDue,
      durationMs: Date.now() - startedAt.getTime()
    });
  } catch (error) {
    counts.errors++;
    log("ERROR", "EXECUTION_FAILED", {
      phase: currentPhase, row: currentRow,
      message: error.message, stack: error.stack || String(error),
      counts: counts,
      durationMs: Date.now() - startedAt.getTime()
    });
    throw error;
  } finally {
    if (lockAcquired) {
      lock.releaseLock();
      log("INFO", "LOCK_RELEASED");
    }
    log("INFO", "END", {
      durationMs: Date.now() - startedAt.getTime(),
      ...counts
    });
  }
}

function getCheckoutSpreadsheet_() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) {
    throw new Error(
      "No active spreadsheet. Open the sheet, choose Extensions > Apps Script, " +
      "and run this script from that sheet-bound project."
    );
  }
  return spreadsheet;
}

/** Run from a sheet-bound project to log its spreadsheet ID without changing cells. */
function showSpreadsheetId() {
  const spreadsheet = getCheckoutSpreadsheet_();
  console.log("[SCHEDULE_CHECKOUT] SPREADSHEET_ID " +
    JSON.stringify({ spreadsheetId: spreadsheet.getId() }));
}

/**
 * Diagnostic-only preflight. Does not update the sheet.
 */
function testCheckoutDiagnostics() {
  console.log("[SCHEDULE_CHECKOUT] DIAGNOSTIC_PREFLIGHT_START");
  const ss = getCheckoutSpreadsheet_();
  const timezone = ss.getSpreadsheetTimeZone();
  [CONFIG.SHIFTS_SHEET, CONFIG.LOG_SHEET].forEach(name => {
    const sheet = ss.getSheetByName(name);
    if (!sheet) throw new Error("Missing worksheet: " + name);
    console.log("[SCHEDULE_CHECKOUT] DIAGNOSTIC_PREFLIGHT_SHEET " +
      JSON.stringify({ name: name, rows: sheet.getLastRow(),
        columns: sheet.getLastColumn() }));
  });
  console.log("[SCHEDULE_CHECKOUT] DIAGNOSTIC_PREFLIGHT_END " +
    JSON.stringify({ spreadsheetId: ss.getId(), timezone: timezone,
      arrivalDateBefore: Utilities.formatDate(new Date(), timezone, "yyyy-MM-dd"),
      dryRun: CONFIG.DRY_RUN }));
}


// ============================================
// HELPER FUNCTIONS
// ============================================

function normalizeCheckoutHeader_(value) {
  return String(value === null || value === undefined ? "" : value)
    .trim().replace(/\s+/g, " ").toLowerCase();
}

function getCheckoutLogColumns_(headers) {
  const required = {
    recordedIn: "Check-In Recorded (timestamp)",
    statedIn: "Check-In Stated (user)",
    recordedOut: "Check-Out Recorded (timestamp)",
    statedOut: "Check-Out Stated (user)",
    recordedHours: "Hours Served (timestamps)",
    statedHours: "Hours Served (stated)",
    status: "Status",
    outBy: "Check-Out Entered By"
  };
  const normalized = headers.map(normalizeCheckoutHeader_);
  const columns = {};
  Object.keys(required).forEach(key => {
    const expected = required[key];
    const matches = [];
    normalized.forEach((header, i) => {
      if (header === normalizeCheckoutHeader_(expected)) matches.push(i);
    });
    if (matches.length !== 1) {
      throw new Error(
        CONFIG.LOG_SHEET + ' must contain exactly one "' + expected +
        '" column; found ' + matches.length + "."
      );
    }
    columns[key] = matches[0] + 1;
  });
  return columns;
}

function isCheckoutDate_(value) {
  return value instanceof Date && !isNaN(value.getTime());
}

function checkoutHours_(start, finish) {
  if (!isCheckoutDate_(start) || !isCheckoutDate_(finish)) return "";
  return Math.max(0, Math.round(
    (finish.getTime() - start.getTime()) / 3600000 * 100
  ) / 100);
}

function isBlank(value) {
  return value === "" ||
    value === null ||
    value === undefined;
}


/**
 * Parse time strings:
 * 9 AM
 * 9:00 AM
 * 13:00
 * 5:30 PM
 */
function parseTime(value) {

  const text = String(value).trim();

  const match = text.match(
    /^(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*(AM|PM)?$/i
  );

  if (!match) return null;

  let hour = Number(match[1]);
  const minute = Number(match[2] || 0);
  const meridiem = (
    match[3] || ""
  ).toUpperCase();

  if (minute > 59) return null;

  if (meridiem) {

    if (hour < 1 || hour > 12) return null;

    hour = hour % 12;

    if (meridiem === "PM") {
      hour += 12;
    }

  } else if (hour > 23) {
    return null;
  }

  return hour * 60 + minute;
}


/**
 * Add calendar days safely using UTC date math.
 */
function addDays(dateString, days) {

  const d = new Date(
    dateString + "T12:00:00Z"
  );

  d.setUTCDate(
    d.getUTCDate() + days
  );

  return Utilities.formatDate(
    d, "UTC", "yyyy-MM-dd"
  );
}


/**
 * Convert minutes to 24-hour HH:mm.
 */
function formatMinutes(totalMinutes) {

  const hours = String(
    Math.floor(totalMinutes / 60)
  ).padStart(2, "0");

  const minutes = String(
    totalMinutes % 60
  ).padStart(2, "0");

  return hours + ":" + minutes;
}


// ============================================
// AUTOMATION TRIGGER
// ============================================

/**
 * Run ONCE to replace this job's triggers with hourly past-date retries.
 */
function createCheckoutTrigger() {
  const spreadsheet = getCheckoutSpreadsheet_();

  const functionName = "updateDailyCheckOuts";

  // Remove duplicate triggers.
  ScriptApp.getProjectTriggers()
    .filter(
      trigger =>
        trigger.getHandlerFunction() ===
        functionName
    )
    .forEach(
      trigger =>
        ScriptApp.deleteTrigger(trigger)
    );

  ScriptApp.newTrigger(functionName)
    .timeBased()
    .everyHours(1)
    .create();

  if (CONFIG.DEBUG) {
    console.log("[SCHEDULE_CHECKOUT] TRIGGER_CREATED " + JSON.stringify({
      functionName: functionName,
      spreadsheetId: spreadsheet.getId(),
      schedule: "hourly; all arrivals before today; wait until checkout is due",
      timestamp: new Date().toISOString()
    }));
  }
}

/** Legacy installer name; hourly retries also cover finishes after midnight. */
function createMidnightTrigger() {
  createCheckoutTrigger();
}
