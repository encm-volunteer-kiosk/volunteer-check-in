
/**
 * VOLUNTEER DAILY AUTO CHECK-OUT
 *
 * Spreadsheet:
 * 19n0bCTzql5YiOfZ-XxAf4aFo0MVo8kA_P5-LFmM54lc
 *
 * Shifts:
 *   A (1) = Day
 *   B (2) = Shift Schedule
 *   E (5) = Finish
 *
 * 2026-11 Log:
 *   E (5) = Check-In Recorded
 *   G (7) = Check-Out Recorded
 *   H (8) = Check-Out Stated
 *
 * Schedule: Daily during midnight hour
 */

const CONFIG = Object.freeze({
  SPREADSHEET_ID:
    "19n0bCTzql5YiOfZ-XxAf4aFo0MVo8kA_P5-LFmM54lc",

  LOG_SHEET: "2026-11 Log",
  SHIFTS_SHEET: "Shifts",

  // Numeric column indexes (1-based)
  SHIFT_DAY: 1,
  SHIFT_SCHEDULE: 2,
  SHIFT_FINISH: 5,

  LOG_CHECKIN: 5,
  LOG_CHECKOUT_RECORDED: 7,
  LOG_CHECKOUT_STATED: 8,

  HEADER_ROWS: 1,

  // -1 = previous day; 0 = current day
  DAY_OFFSET: -1,

  // Allow early check-in up to 2 hours.
  EARLY_CHECKIN_MINUTES: 120,

  // TRUE = Preview only, FALSE = Write changes
  DRY_RUN: false,

  // Verbose per-row diagnostics (disable after troubleshooting).
  DEBUG_ROWS: true,

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
    shiftsDayMatched: 0,
    completedShifts: 0,
    logRowsRead: 0,
    existingCheckout: 0,
    missingCheckIn: 0,
    differentDate: 0,
    invalidCheckInTime: 0,
    noShiftMatch: 0,
    ambiguous: 0,
    eligible: 0,
    updated: 0,
    previews: 0,
    errors: 0
  };
  const log = (level, event, details) => {
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
    if (CONFIG.DEBUG_ROWS) log("DEBUG", event, details);
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
    spreadsheetId: CONFIG.SPREADSHEET_ID,
    logSheet: CONFIG.LOG_SHEET,
    shiftsSheet: CONFIG.SHIFTS_SHEET,
    dayOffset: CONFIG.DAY_OFFSET,
    earlyCheckinMinutes: CONFIG.EARLY_CHECKIN_MINUTES,
    dryRun: CONFIG.DRY_RUN,
    debugRows: CONFIG.DEBUG_ROWS,
    verifyWrites: CONFIG.VERIFY_WRITES,
    columnIndexes: {
      shiftDay: CONFIG.SHIFT_DAY,
      shiftSchedule: CONFIG.SHIFT_SCHEDULE,
      shiftFinish: CONFIG.SHIFT_FINISH,
      logCheckIn: CONFIG.LOG_CHECKIN,
      logCheckOutRecorded: CONFIG.LOG_CHECKOUT_RECORDED,
      logCheckOutStated: CONFIG.LOG_CHECKOUT_STATED
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
    const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
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
    const targetDate = addDays(today, CONFIG.DAY_OFFSET);
    const weekdayNames = [
      "Sunday", "Monday", "Tuesday", "Wednesday",
      "Thursday", "Friday", "Saturday"
    ];
    const targetDay = weekdayNames[
      new Date(targetDate + "T12:00:00Z").getUTCDay()
    ];
    const currentLocal = Utilities.formatDate(now, timezone, "yyyy-MM-dd HH:mm");
    log("INFO", "SHEETS_OPENED", {
      spreadsheetName: ss.getName(),
      timezone: timezone,
      shiftsLastRow: shiftSheet.getLastRow(),
      logLastRow: logSheet.getLastRow()
    });
    log("INFO", "PROCESSING_DATE", {
      today: today,
      targetDate: targetDate,
      targetDay: targetDay,
      currentLocal: currentLocal,
      dayOffset: CONFIG.DAY_OFFSET,
      explanation: CONFIG.DAY_OFFSET === -1
        ? "Running today processes yesterday's check-ins."
        : "Processing based on configured DAY_OFFSET."
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

    if (shifts.length <= CONFIG.HEADER_ROWS || logs.length <= CONFIG.HEADER_ROWS) {
      log("WARN", "NO_DATA", {
        reason: "At least one sheet has no data rows after the header."
      });
      return;
    }
    const shiftDayIdx = CONFIG.SHIFT_DAY - 1;
    const scheduleIdx = CONFIG.SHIFT_SCHEDULE - 1;
    const finishIdx = CONFIG.SHIFT_FINISH - 1;
    const checkinIdx = CONFIG.LOG_CHECKIN - 1;
    const recordedIdx = CONFIG.LOG_CHECKOUT_RECORDED - 1;
    const statedIdx = CONFIG.LOG_CHECKOUT_STATED - 1;
    if (
      shiftText[0].length < Math.max(
        CONFIG.SHIFT_DAY, CONFIG.SHIFT_SCHEDULE, CONFIG.SHIFT_FINISH
      ) ||
      logs[0].length < Math.max(
        CONFIG.LOG_CHECKIN, CONFIG.LOG_CHECKOUT_RECORDED,
        CONFIG.LOG_CHECKOUT_STATED
      )
    ) {
      throw new Error("One or more configured columns do not exist.");
    }
    log("INFO", "COLUMN_VALIDATION_PASSED");

    currentPhase = "COLLECT_COMPLETED_SHIFTS";
    const completedShifts = [];
    for (let i = CONFIG.HEADER_ROWS; i < shifts.length; i++) {
      const shiftRow = i + 1;
      counts.shiftsRead++;
      const dayValue = shifts[i][shiftDayIdx];
      const dayText = String(shiftText[i][shiftDayIdx]).trim().toLowerCase();
      const scheduleText = shiftText[i][scheduleIdx];
      const finishText = shiftText[i][finishIdx];
      let isTargetDay =
        dayText === targetDay.toLowerCase() ||
        dayText === targetDay.substring(0, 3).toLowerCase() ||
        dayText === targetDate;
      if (dayValue instanceof Date && !isNaN(dayValue.getTime())) {
        const dateValue = Utilities.formatDate(dayValue, timezone, "yyyy-MM-dd");
        isTargetDay = isTargetDay || dateValue === targetDate;
      }
      debug("SHIFT_ROW_READ", {
        shiftRow: shiftRow, dayRaw: describe(dayValue), dayDisplayed: dayText,
        scheduleDisplayed: scheduleText, finishDisplayed: finishText,
        targetDay: targetDay, isTargetDay: isTargetDay
      });
      if (!isTargetDay) {
        debug("SHIFT_SKIPPED", { shiftRow: shiftRow, reason: "DAY_NOT_MATCHED" });
        continue;
      }
      counts.shiftsDayMatched++;
      const schedule = parseSchedule(scheduleText);
      if (!schedule) {
        log("WARN", "SHIFT_SKIPPED", {
          shiftRow: shiftRow, reason: "INVALID_SCHEDULE", scheduleDisplayed: scheduleText
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
      const overnight = finishMinutes <= schedule.start;
      const endMinutes = finishMinutes + (overnight ? 1440 : 0);
      const finishDate = overnight ? addDays(targetDate, 1) : targetDate;
      const scheduledFinish = finishDate + " " + formatMinutes(finishMinutes);
      debug("SHIFT_MATCHED_DAY", {
        shiftRow: shiftRow,
        startMinutes: schedule.start,
        scheduleEndMinutes: schedule.end,
        finishMinutes: finishMinutes,
        overnight: overnight,
        scheduledFinish: scheduledFinish,
        currentLocal: currentLocal,
        isCompleted: scheduledFinish <= currentLocal
      });
      if (scheduledFinish > currentLocal) {
        debug("SHIFT_SKIPPED", {
          shiftRow: shiftRow, reason: "SHIFT_NOT_FINISHED",
          scheduledFinish: scheduledFinish, currentLocal: currentLocal
        });
        continue;
      }
      completedShifts.push({
        start: schedule.start,
        end: endMinutes,
        finishMinutes: finishMinutes,
        shiftRow: shiftRow
      });
      counts.completedShifts++;
      log("INFO", "COMPLETED_SHIFT_ADDED", {
        shiftRow: shiftRow, scheduledFinish: scheduledFinish,
        startMinutes: schedule.start, endMinutes: endMinutes
      });
    }
    log("INFO", "SHIFT_COLLECTION_SUMMARY", {
      shiftsRead: counts.shiftsRead,
      shiftsDayMatched: counts.shiftsDayMatched,
      completedShifts: completedShifts.length
    });

    currentPhase = "PROCESS_LOG_ROWS";
    for (let i = CONFIG.HEADER_ROWS; i < logs.length; i++) {
      const row = logs[i];
      const logRow = i + 1;
      currentRow = logRow;
      counts.logRowsRead++;
      const checkin = row[checkinIdx];
      const existingRecorded = row[recordedIdx];
      const existingStated = row[statedIdx];
      debug("LOG_ROW_READ", {
        logRow: logRow, checkInColumn: CONFIG.LOG_CHECKIN,
        checkInRaw: describe(checkin),
        recordedColumn: CONFIG.LOG_CHECKOUT_RECORDED,
        recordedRaw: describe(existingRecorded),
        statedColumn: CONFIG.LOG_CHECKOUT_STATED,
        statedRaw: describe(existingStated)
      });
      // Preserve any existing checkout; same behavior as original.
      if (!isBlank(existingStated) || !isBlank(existingRecorded)) {
        counts.existingCheckout++;
        debug("LOG_ROW_SKIPPED", {
          logRow: logRow, reason: "CHECKOUT_ALREADY_PRESENT",
          recorded: describe(existingRecorded), stated: describe(existingStated)
        });
        continue;
      }
      if (!(checkin instanceof Date) || isNaN(checkin.getTime())) {
        counts.missingCheckIn++;
        debug("LOG_ROW_SKIPPED", {
          logRow: logRow, reason: "CHECKIN_NOT_VALID_DATE",
          checkInValue: describe(checkin), checkInType: typeof checkin
        });
        continue;
      }
      const checkinDate = Utilities.formatDate(checkin, timezone, "yyyy-MM-dd");
      if (checkinDate !== targetDate) {
        counts.differentDate++;
        debug("LOG_ROW_SKIPPED", {
          logRow: logRow, reason: "CHECKIN_DATE_NOT_TARGET_DATE",
          checkInDate: checkinDate, targetDate: targetDate
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
      const candidates = completedShifts.filter(shift => {
        const earliest = shift.start - CONFIG.EARLY_CHECKIN_MINUTES;
        const inWindow = checkinMinutes >= earliest && checkinMinutes <= shift.end;
        debug("SHIFT_CANDIDATE_COMPARISON", {
          logRow: logRow, shiftRow: shift.shiftRow,
          checkInTime: checkinTime, checkInMinutes: checkinMinutes,
          earliestMinutes: earliest, shiftEndMinutes: shift.end,
          inWindow: inWindow
        });
        return inWindow;
      });
      const uniqueShifts = new Map();
      candidates.forEach(shift => {
        const key = shift.start + "|" + shift.end + "|" + shift.finishMinutes;
        if (!uniqueShifts.has(key)) uniqueShifts.set(key, shift);
      });
      if (uniqueShifts.size === 0) {
        counts.noShiftMatch++;
        debug("LOG_ROW_SKIPPED", {
          logRow: logRow, reason: "NO_MATCHING_COMPLETED_SHIFT",
          checkInTime: checkinTime, completedShifts: completedShifts.length
        });
        continue;
      }
      if (uniqueShifts.size > 1) {
        counts.ambiguous++;
        log("WARN", "LOG_ROW_SKIPPED", {
          logRow: logRow, reason: "AMBIGUOUS_MULTIPLE_SHIFTS",
          matchingShiftRows: [...uniqueShifts.values()].map(s => s.shiftRow)
        });
        continue;
      }
      const matchedShift = [...uniqueShifts.values()][0];
      const checkoutTimeValue = matchedShift.finishMinutes / 1440;
      const timestamp = new Date();
      counts.eligible++;
      log("INFO", "BEFORE_UPDATE", {
        logRow: logRow, matchedShiftRow: matchedShift.shiftRow,
        currentRecordedColumn: CONFIG.LOG_CHECKOUT_RECORDED,
        currentRecorded: describe(existingRecorded),
        currentStatedColumn: CONFIG.LOG_CHECKOUT_STATED,
        currentStated: describe(existingStated),
        proposedStatedTime: formatMinutes(matchedShift.finishMinutes),
        proposedStatedNumericValue: checkoutTimeValue,
        proposedRecordedTimestamp: Utilities.formatDate(
          timestamp, timezone, "yyyy-MM-dd HH:mm:ss"
        ),
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
      // Original write order retained: H first, then G.
      logSheet.getRange(logRow, CONFIG.LOG_CHECKOUT_STATED)
        .setValue(checkoutTimeValue)
        .setNumberFormat("h:mm AM/PM");
      logSheet.getRange(logRow, CONFIG.LOG_CHECKOUT_RECORDED)
        .setValue(timestamp)
        .setNumberFormat("yyyy-mm-dd hh:mm:ss");
      log("INFO", "WRITE_SUBMITTED", {
        logRow: logRow, statedColumn: CONFIG.LOG_CHECKOUT_STATED,
        recordedColumn: CONFIG.LOG_CHECKOUT_RECORDED
      });
      if (CONFIG.VERIFY_WRITES) {
        currentPhase = "VERIFY_CHECKOUT";
        SpreadsheetApp.flush();
        const actualStated = logSheet.getRange(logRow, CONFIG.LOG_CHECKOUT_STATED);
        const actualRecorded = logSheet.getRange(logRow, CONFIG.LOG_CHECKOUT_RECORDED);
        const statedRaw = actualStated.getValue();
        const recordedRaw = actualRecorded.getValue();
        // Time-formatted Sheets cells can read back as Date objects or numbers.
        // Compare their displayed clock time to the intended finish time.
        const statedDisplayed = actualStated.getDisplayValue();
        const statedDisplayMinutes = parseTime(statedDisplayed);
        const statedMatches = statedDisplayMinutes === matchedShift.finishMinutes ||
          (typeof statedRaw === "number" &&
            Math.abs(statedRaw - checkoutTimeValue) < 1e-9);
        const recordedMatches = recordedRaw instanceof Date &&
          !isNaN(recordedRaw.getTime()) &&
          Math.abs(recordedRaw.getTime() - timestamp.getTime()) <= 1000;
        log("INFO", "AFTER_UPDATE", {
          logRow: logRow,
          statedRaw: describe(statedRaw),
          statedDisplayed: statedDisplayed,
          recordedRaw: describe(recordedRaw),
          recordedDisplayed: actualRecorded.getDisplayValue(),
          statedMatches: statedMatches,
          recordedMatches: recordedMatches
        });
        if (!statedMatches || !recordedMatches) {
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
        logRow: logRow, matchedShiftRow: matchedShift.shiftRow
      });
      currentPhase = "PROCESS_LOG_ROWS";
    }
    log("INFO", "SUMMARY", {
      targetDate: targetDate, targetDay: targetDay,
      mode: CONFIG.DRY_RUN ? "DRY_RUN" : "LIVE",
      ...counts,
      skipped: counts.existingCheckout + counts.missingCheckIn +
        counts.differentDate + counts.invalidCheckInTime + counts.noShiftMatch +
        counts.ambiguous,
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

/**
 * Diagnostic-only preflight. Does not update the sheet.
 */
function testCheckoutDiagnostics() {
  console.log("[SCHEDULE_CHECKOUT] DIAGNOSTIC_PREFLIGHT_START");
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  [CONFIG.SHIFTS_SHEET, CONFIG.LOG_SHEET].forEach(name => {
    const sheet = ss.getSheetByName(name);
    if (!sheet) throw new Error("Missing worksheet: " + name);
    console.log("[SCHEDULE_CHECKOUT] DIAGNOSTIC_PREFLIGHT_SHEET " +
      JSON.stringify({ name: name, rows: sheet.getLastRow(),
        columns: sheet.getLastColumn() }));
  });
  console.log("[SCHEDULE_CHECKOUT] DIAGNOSTIC_PREFLIGHT_END " +
    JSON.stringify({ timezone: ss.getSpreadsheetTimeZone(),
      dayOffset: CONFIG.DAY_OFFSET, dryRun: CONFIG.DRY_RUN }));
}


// ============================================
// HELPER FUNCTIONS
// ============================================

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
 * Parse Shift Schedule column B.
 *
 * Supported:
 * 9:00 AM - 1:00 PM
 * 09:00 - 13:00
 * 2 PM to 6 PM
 */
function parseSchedule(value) {

  const timePattern =
    String.raw`\d{1,2}(?::\d{2})?\s*(?:AM|PM)?`;

  const regex = new RegExp(
    "^\\s*(" + timePattern + ")" +
    "\\s*(?:-|–|—|to)\\s*" +
    "(" + timePattern + ")\\s*$",
    "i"
  );

  const match = String(value).trim()
    .match(regex);

  if (!match) return null;

  const start = parseTime(match[1]);
  const end = parseTime(match[2]);

  if (start === null || end === null) {
    return null;
  }

  return { start, end };
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
 * Run ONCE to install daily midnight trigger.
 */
function createMidnightTrigger() {

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
    .atHour(0)
    .everyDays(1)
    .create();

  console.log("[SCHEDULE_CHECKOUT] TRIGGER_CREATED " + JSON.stringify({
    functionName: functionName, schedule: "daily during midnight hour",
    timestamp: new Date().toISOString()
  }));
}
