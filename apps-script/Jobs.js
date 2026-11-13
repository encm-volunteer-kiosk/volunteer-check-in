/**
 * The daily jobs: functions that run on installable triggers rather than from the tablet
 * or the Kiosk admin menu. They are the weekly flags email (runFlagsEmail), which checks
 * every hour whether it is due, the auto clock-out (runAutoClockOut), which runs once a
 * day at about 4 AM Central and closes open rows nobody checked out of, and the nightly
 * Hours refresh (runHoursRefresh) at about 5 AM, which then runs the Log check. The Log
 * check also runs from the Kiosk admin menu (checkLogNow).
 *
 * One account owns the triggers. Signed in as it, someone runs setupDailyJobs once from
 * the Apps Script editor; the triggers then run as that account, which sends the email and writes the Log.
 * Google lets each account see and delete only its own triggers, so removeDailyJobs, run
 * as the owner, is how ownership moves to another account.
 *
 * Every public name here can also be called by the kiosk page through google.script.run,
 * so each checks its caller before it reads or writes anything (tests/admin.test.mjs
 * holds every public function here to it):
 *   - setupDailyJobs and removeDailyJobs run by hand from the editor and start with
 *     requireEditorRun_, as setupSheets does.
 *   - checkLogNow is a Kiosk admin menu item that opens no dialog, like refreshHoursNow:
 *     it checks requireEditorRun_ and SpreadsheetApp.getUi() (it throws anywhere but the
 *     spreadsheet's own UI) before it reads anything.
 *   - A trigger handler (runFlagsEmail, runAutoClockOut, runHoursRefresh) checks
 *     requireEditorRun_, then
 *     requireTriggerRun_:
 *     the event's triggerUid must be one of this account's triggers for that handler. A
 *     trigger's id is never sent anywhere, so the owner's own browser calling through the
 *     web app is refused too. Each handler does its work at most once per due time, so a
 *     caller who guessed an id could only move a run, never repeat it.
 * Everything else ends in _, so google.script.run can't call it.
 *
 * The rules are in Logic.js (dailyJobs, flagsEmailDue, flagsSummary, flagsEmailMessage,
 * and the Auto clock-out and Log check sections); this file reads and writes Settings, the
 * Log, the Shifts tab and the Flags tab through Sheets.js.
 */

// ---------------------------------------------------------------------------
// Run by hand from the editor

/**
 * Installs the daily jobs for the account running it: deletes this account's triggers in
 * this project whose handler is a daily job's, then creates one trigger for each entry of
 * dailyJobs (Logic.js) and nothing else, and writes the account into Settings "Daily jobs
 * installed by". Then it logs how many open rows the auto clock-out would close if it ran
 * now, since a first run may close a backlog. Running it again replaces this account's
 * triggers, so one account never has two copies. Runs only from the Apps Script editor.
 */
function setupDailyJobs() {
  requireEditorRun_();
  readSettings_(); // The Settings tab must be there before any trigger changes.
  const removed = deleteJobTriggers_();
  const jobs = dailyJobs();
  jobs.forEach(createJobTrigger_);
  const owner = Session.getEffectiveUser().getEmail();
  setSetting_("Daily jobs installed by", owner);
  console.log(
    "Daily jobs: removed " +
      removed +
      " old trigger(s) and installed " +
      jobs.map(jobLabel_).join("; ") +
      ", owned by " +
      owner +
      ".",
  );
  console.log(autoClockOutCountLine_(new Date()));
}

/**
 * Deletes this account's daily-job triggers in this project and clears Settings "Daily
 * jobs installed by" when it names this account. Another account's triggers can't be seen
 * or deleted from here: that account runs this itself. Runs only from the Apps Script
 * editor.
 */
function removeDailyJobs() {
  requireEditorRun_();
  const settings = readSettings_();
  const removed = deleteJobTriggers_();
  const me = Session.getEffectiveUser().getEmail();
  const installedBy = cellString(settings["Daily jobs installed by"]);
  const cleared = installedBy !== "" && installedBy.toLowerCase() === cellString(me).toLowerCase();
  if (cleared) setSetting_("Daily jobs installed by", "");
  console.log(
    "Daily jobs: removed " +
      removed +
      " trigger(s) owned by " +
      me +
      "." +
      (cleared
        ? ' Cleared "Daily jobs installed by".'
        : installedBy
          ? ' "Daily jobs installed by" names ' + installedBy + ", so it was left as it is."
          : ""),
  );
}

// ---------------------------------------------------------------------------
// Trigger handlers

/**
 * The weekly flags email, run every hour by its trigger. Under the script lock: stops
 * unless Settings "Flags email" is On, "Flags email to" has an address and the due slot
 * (flagsEmailDue) has passed since "Flags email last run"; then counts the Flags tab and
 * sends, or records that there was nothing to send. When the lock isn't free within 30
 * seconds it logs one line and stops; the next hourly run catches up.
 */
function runFlagsEmail(e) {
  requireEditorRun_();
  requireTriggerRun_(e, "runFlagsEmail");
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    console.log("Flags email: the script lock was busy; the next hourly run will try again.");
    return;
  }
  try {
    sendFlagsEmailIfDue_(new Date());
  } finally {
    lock.releaseLock();
  }
}

/**
 * The auto clock-out, run once a day at about 4 AM Central by its trigger. Under the
 * script lock, closes every open row the run's time makes old enough (autoClockOutRows),
 * with a guessed time and a flag, and flags once each old row on which no time reads.
 * When the lock isn't free within 30 seconds it throws: the owner gets Google's failure
 * email and the next day's run catches up.
 */
function runAutoClockOut(e) {
  requireEditorRun_();
  requireTriggerRun_(e, "runAutoClockOut");
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    throw new Error("Auto clock-out: the script lock was busy; tomorrow's run will catch up.");
  }
  try {
    autoClockOut_(new Date());
  } finally {
    lock.releaseLock();
  }
}

/**
 * The nightly Hours refresh, run once a day at about 5 AM Central by its trigger, an hour
 * after the auto clock-out so the rows it closes show, and then the Log check.
 *
 * The refresh always rewrites the tables unless a newer whole table is already in, which
 * also undoes hand edits on Hours data (refreshHours_, Reports.js). It takes the document
 * lock, waiting up to 120 seconds, and releases it before anything else happens.
 *
 * Then the Log check (logCheck_) runs on the Log the refresh read, or reads the Log
 * itself when the refresh never read it (no Hours tabs, or the read threw). It asks for
 * the script lock only after the document lock is released, so this run never holds
 * both. It logs one line.
 *
 * Then the throws, so the owner gets Google's failure email. The refresh's outcome comes
 * first and is thrown exactly as it would be with no Log check: when the lock was busy,
 * the tabs are missing or the refresh failed (after its note is written), and also when
 * the refresh itself threw. Only when the refresh didn't throw does a busy or failed Log
 * check throw "Log check (nightly): ...".
 */
function runHoursRefresh(e) {
  requireEditorRun_();
  requireTriggerRun_(e, "runHoursRefresh");
  const hold = hoursHold_();
  const out = {};
  let hoursError = null;
  try {
    const result = refreshHours_("nightly", hold, undefined, out);
    console.log(hoursRunLog_("nightly", result));
    if (result.kind !== "write" && result.kind !== "newer-in") {
      hoursError = new Error("Hours refresh (nightly): " + hoursMenuText_(result));
    }
  } catch (err) {
    hoursError = err;
  } finally {
    releaseHoursLock_(hold);
  }
  let check;
  try {
    check = logCheck_(out.log ? out.log.entries : null, new Date());
    console.log(logCheckRunLog_("nightly", check));
  } finally {
    // Thrown from the finally, so nothing the Log check does can hide it.
    if (hoursError) throw hoursError;
  }
  if (check.kind !== "done") {
    throw new Error("Log check (nightly): " + logCheckMessage(check));
  }
}

// ---------------------------------------------------------------------------
// The Log check

/**
 * Kiosk admin > Check the Log now: runs the Log check (logCheck_) on a fresh read of the
 * Log and shows what it found in an alert; a failed run's alert ends with the Kiosk
 * contact line. Opens no dialog.
 */
function checkLogNow() {
  requireEditorRun_();
  const ui = SpreadsheetApp.getUi();
  const result = logCheck_(null, new Date());
  console.log(logCheckRunLog_("menu", result));
  // Only a failed run is an error (withKioskContact, Logic.js, has the rule).
  const note = result.kind === "failed" ? kioskContactNote(kioskContact_()) : "";
  ui.alert(withKioskContact(logCheckMessage(result), note));
}

/**
 * One run of the Log check at now. It reports and fixes nothing: each problem the rules
 * find (logCheckProblems, Logic.js) gets one Flags row, Source "log check", unless a row
 * for it is already on the Flags tab, Reviewed or not.
 *
 * entries is the Log as readReportLog_ gives it; null reads it here. The read and the
 * rules take no lock. Then, under the script lock (30 s wait), it reads the whole Flags
 * tab, keeps the problems not already there (logCheckPlan), at most logCheckMaxNewFlags
 * of them, and appends them. Reading the Flags tab under the lock is what keeps two runs
 * from flagging one problem twice. Problems past the cap are flagged by the next run.
 *
 * Never throws. Returns the Result logCheckMessage reads: {kind: "done" | "busy" |
 * "failed", checked, found, already, flagged, left, byLabel, ms, message}. A missing Log
 * or Flags tab, or any other throw, is "failed" with its message.
 */
function logCheck_(entries, now) {
  const start = Date.now();
  let checked = 0;
  let counted = {};
  const result = (kind, counts, message) => ({
    kind,
    checked,
    found: counts.found || 0,
    already: counts.already || 0,
    flagged: counts.flagged || 0,
    left: counts.left || 0,
    byLabel: counts.byLabel || {},
    ms: Date.now() - start,
    message: message || "",
  });
  try {
    const rows = entries || readReportLog_().entries;
    checked = logCheckRowCount(rows);
    const problems = logCheckProblems(rows, adminClock_);
    const found = logCheckPlan(problems, [], 0, 0);
    counted = { found: found.found, byLabel: found.byLabel };
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(30000)) return result("busy", counted);
    try {
      const plan = logCheckPlan(problems, readFlags_().rows, now.getTime(), logCheckMaxNewFlags());
      appendFlagRows_(plan.newRows);
      SpreadsheetApp.flush();
      return result("done", plan);
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return result("failed", counted, cellString(err && err.message) || String(err));
  }
}

/**
 * One log line for a Log check run from cause ("nightly" or "menu"): "Log check
 * (nightly): done; checked 1200 rows, found 3, already flagged 2, flagged 1 new, 0 left
 * for the next run; 850 ms." then the count per label in logCheckReasons order, and the
 * message of a failed run.
 */
function logCheckRunLog_(cause, result) {
  const byLabel = result.byLabel || {};
  const reasons = logCheckReasons();
  const order = Object.keys(reasons).map((code) => reasons[code]);
  const labels = order
    .concat(Object.keys(byLabel).filter((label) => order.indexOf(label) < 0))
    .filter((label) => byLabel[label] > 0)
    .map((label) => label + " " + byLabel[label]);
  return (
    "Log check (" +
    cause +
    "): " +
    result.kind +
    "; checked " +
    result.checked +
    " rows, found " +
    result.found +
    ", already flagged " +
    result.already +
    ", flagged " +
    result.flagged +
    " new, " +
    result.left +
    " left for the next run; " +
    Math.round(result.ms) +
    " ms." +
    (labels.length ? " " + labels.join("; ") + "." : "") +
    (result.message ? " " + result.message : "")
  );
}

// ---------------------------------------------------------------------------
// Guard and triggers

/**
 * Refuses a call unless it comes from one of this account's triggers in this project for
 * handler: e.triggerUid must be the unique id of such a trigger. getProjectTriggers
 * returns only the effective user's own triggers.
 */
function requireTriggerRun_(e, handler) {
  const uid = e && typeof e === "object" ? cellString(e.triggerUid) : "";
  const ok =
    uid !== "" &&
    ScriptApp.getProjectTriggers().some(
      (t) => t.getUniqueId() === uid && t.getHandlerFunction() === handler,
    );
  if (!ok) {
    throw new Error(
      handler + " runs only from its trigger. To install the triggers, run setupDailyJobs.",
    );
  }
}

/** Deletes this account's triggers whose handler is a daily job's. Returns how many. */
function deleteJobTriggers_() {
  const handlers = dailyJobs().map((job) => job.handler);
  let removed = 0;
  ScriptApp.getProjectTriggers().forEach((t) => {
    if (handlers.indexOf(t.getHandlerFunction()) >= 0) {
      ScriptApp.deleteTrigger(t);
      removed++;
    }
  });
  return removed;
}

/** Creates the trigger for one dailyJobs entry: every few hours, or daily at an hour Central. */
function createJobTrigger_(job) {
  const time = ScriptApp.newTrigger(job.handler).timeBased();
  if (job.everyHours) {
    time.everyHours(job.everyHours).create();
  } else {
    time.atHour(job.atHour).everyDays(1).inTimezone(kioskTimeZone()).create();
  }
}

/** A dailyJobs entry for the log: "runFlagsEmail every 1 hour(s)". */
function jobLabel_(job) {
  return job.everyHours
    ? job.handler + " every " + job.everyHours + " hour(s)"
    : job.handler + " daily at " + job.atHour + ":00 Central";
}

// ---------------------------------------------------------------------------
// Weekly flags email

/** The Central wall-clock time of a Date as "yyyy-MM-dd HH:mm". */
function wallClock_(date) {
  return Utilities.formatDate(date, kioskTimeZone(), "yyyy-MM-dd HH:mm");
}

/** The weekly email's run, once the guard has passed and under the script lock. */
function sendFlagsEmailIfDue_(now) {
  const settings = readSettings_();
  if (!parseFlagsEmailOn(settings["Flags email"])) return;
  const to = parseEmailAddresses(settings["Flags email to"]);
  if (!to.valid.length) {
    console.log('Flags email: "Flags email to" has no email address; nothing sent.');
    return;
  }
  const nowText = wallClock_(now);
  const lastRun = settings["Flags email last run"] || "";
  const due = flagsEmailDue(
    nowText,
    lastRun,
    parseWeekdaySetting(settings["Flags email day"]),
    parseEmailHour(settings["Flags email hour"]),
  );
  if (!due) return;

  const flags = readFlags_();
  const message = flagsEmailMessage({
    summary: flagsSummary(flags.rows, now.getTime()),
    autoClockOut: autoClockOutCheck(settings["Auto clock-out last run"], nowText),
    flagsUrl: flags.url,
    skipped: to.invalid,
  });
  if (!message) {
    setSetting_("Flags email last run", lastRunText(nowText, "nothing to send"));
    return;
  }

  // The last run is written before sending, so a Settings write that fails can't make
  // every hourly run send again. A send that fails puts the old value back and throws, so
  // the owner gets Google's failure email and the next hourly run tries again.
  setSetting_("Flags email last run", lastRunText(nowText, "sent to " + to.valid.length));
  SpreadsheetApp.flush();
  try {
    MailApp.sendEmail({
      to: to.valid.join(","),
      subject: message.subject,
      body: message.body,
      htmlBody: message.htmlBody,
      name: flagsEmailSenderName(),
      noReply: true,
    });
  } catch (err) {
    setSetting_("Flags email last run", lastRun);
    SpreadsheetApp.flush();
    throw err;
  }
}

/**
 * The Flags tab's rows as {rows: [{date, name, shiftId, reason, raisedAtMs, reviewed,
 * source}], url}, url being the spreadsheet's link opened at the Flags tab. Every row from
 * 2 to the tab's last row is read, so the Log check sees every flag it ever wrote. Throws
 * when the tab or a header the script writes is missing, so a broken tab fails the run
 * instead of sending a wrong count or flagging a problem twice.
 */
function readFlags_() {
  const sheet = sheet_(FLAGS_TAB);
  const header = logHeaderRow_(sheet);
  const cols = flagColumns(header);
  const F = flagHeaderNames();
  const last = sheet.getLastRow();
  const values = last < 2 ? [] : sheet.getRange(2, 1, last - 1, header.length).getValues();
  const rows = values.map((cells) => ({
    date: cellText_(cells[cols[F.date]]),
    name: cellText_(cells[cols[F.name]]),
    shiftId: cellText_(cells[cols[F.shiftId]]),
    reason: cellText_(cells[cols[F.reason]]),
    raisedAtMs: cellTime_(cells[cols[F.raisedAt]]).ms,
    reviewed: isTicked(cells[cols[F.reviewed]]),
    source: cellText_(cells[cols[F.source]]),
  }));
  const url = SpreadsheetApp.getActiveSpreadsheet().getUrl() + "#gid=" + sheet.getSheetId();
  return { rows, url };
}

// ---------------------------------------------------------------------------
// Auto clock-out

/**
 * The auto clock-out's run at now, once the guard has passed and under the script lock.
 * Reads Settings, the whole Log and the Shifts tab once. Closes rows one by one, oldest
 * first, each with its Log write and then its Flags row, then flags the rows it skips.
 * Before each write it reads that row again and leaves it for the next run, with one log
 * line, when it is no longer the open row it read at the start (autoClockOutRowUnchanged):
 * staff may sort, insert or delete Log rows during the run, and a write by the old row
 * number would land on another row. The lock keeps out the kiosk, not hand edits.
 * Status is read under the lock, so a second run closes nothing twice, and a run that
 * dies part way leaves the rest for the next. It starts no new row after
 * autoClockOutBudgetMs and leaves the rest for the next day. At the end it writes "Auto
 * clock-out last run" with how many rows it closed; a run that dies before that leaves
 * the old value, which the weekly email watches.
 */
function autoClockOut_(now) {
  const settings = readSettings_();
  const launch = autoClockOutLaunchDate(settings["Kiosk launch date"]);
  const nowMs = now.getTime();
  const cols = readLogColumns_();
  const entries = readLog_(cols);
  const plan = autoClockOutRows(
    entries,
    nowMs,
    autoClockOutWindowMs(settings["Auto clock-out after hours"]),
    centralDate_(now),
    launch,
  );
  const shifts = plan.close.length ? readShifts_() : { windows: [], problem: "" };
  if (shifts.problem) {
    console.log("Auto clock-out: " + shifts.problem + "; its windows weren't used.");
  }
  const read = logRead_();
  const outOfTime = () => Date.now() - nowMs >= autoClockOutBudgetMs();
  let closed = 0;
  let skipped = 0;
  let left = 0;
  const stillThere = (row) => {
    if (autoClockOutRowUnchanged(row, readLogRow_(row.row, cols, read))) return true;
    console.log(
      "Auto clock-out: Log row " +
        row.row +
        (cellString(row.shiftId) ? " (Shift ID " + cellString(row.shiftId) + ")" : "") +
        " changed during the run, so it was left for the next run.",
    );
    return false;
  };
  plan.close.forEach((row) => {
    if (outOfTime()) {
      left++;
      return;
    }
    if (!stillThere(row)) return;
    const shiftId = cellString(row.shiftId) || Utilities.getUuid();
    const guess = autoClockOutGuess(entries, row, nowMs, shifts.windows, read);
    const alert = autoClockOutAlert(row, guess, read);
    updateLogRow_(row.row, autoClockOutCells(row, guess, alert, shiftId), cols);
    raiseFlags_(autoClockOutFlagBase(row, shiftId, nowMs), [alert]);
    closed++;
  });
  plan.skip.forEach((row) => {
    if (outOfTime()) {
      left++;
      return;
    }
    if (!stillThere(row)) return;
    const shiftId = cellString(row.shiftId) || Utilities.getUuid();
    updateLogRow_(row.row, autoClockOutSkipCells(row, shiftId), cols);
    raiseFlags_(autoClockOutFlagBase(row, shiftId, nowMs), [autoClockOutSkippedAlert()]);
    skipped++;
  });
  setSetting_("Auto clock-out last run", lastRunText(wallClock_(now), "closed " + closed));
  console.log(
    "Auto clock-out: closed " +
      closed +
      " row(s), flagged " +
      skipped +
      " whose check-in time can't be read" +
      (left ? "; out of time, " + left + " row(s) left for the next run" : "") +
      ".",
  );
}

/**
 * setupDailyJobs's line about the Log: how many open rows a run now would close, and how
 * many it would flag as unreadable. Never throws: a Log or Settings it can't read is named
 * in the line instead, since the run will then fail and the owner will hear of it.
 */
function autoClockOutCountLine_(now) {
  try {
    const settings = readSettings_();
    const launch = autoClockOutLaunchDate(settings["Kiosk launch date"]);
    const plan = autoClockOutRows(
      readLog_(readLogColumns_()),
      now.getTime(),
      autoClockOutWindowMs(settings["Auto clock-out after hours"]),
      centralDate_(now),
      launch,
    );
    return (
      "Auto clock-out: a run now would close " +
      plan.close.length +
      " open row(s) and flag " +
      plan.skip.length +
      " whose check-in time can't be read."
    );
  } catch (err) {
    return (
      "Auto clock-out: couldn't count the open rows: " + (err && err.message ? err.message : err)
    );
  }
}
