/**
 * The daily jobs: functions that run on installable triggers rather than from the tablet
 * or the Kiosk admin menu. They are the weekly flags email (runFlagsEmail), which checks
 * every hour whether it is due, the auto clock-out (runAutoClockOut), which runs once a
 * day at about 4 AM Central and closes open rows nobody checked out of, and the nightly
 * Hours refresh (runHoursRefresh) at about 5 AM, which then runs the Log check. The Log
 * check also runs from the Kiosk admin menu (checkLogNow). Apart from them, the hours
 * request job (runHoursRequests) runs every 15 minutes and, with Settings "Hours
 * requests" on Auto, emails volunteers who asked for their hours at the tablet. It has
 * its own installer, setupHoursRequestJob, and remover, removeHoursRequestJob, run by an
 * account that can open Volunteer Profiles; setupDailyJobs and removeDailyJobs leave it
 * alone.
 *
 * One account owns the triggers. Signed in as it, someone runs setupDailyJobs once from
 * the Apps Script editor; the triggers then run as that account, which sends the email and writes the Log.
 * Google lets each account see and delete only its own triggers, so removeDailyJobs, run
 * as the owner, is how ownership moves to another account. setupDailyJobs also installs
 * the Log change trigger (onSheetChange, Sheets.js) for the same account, and
 * removeDailyJobs deletes it with the jobs.
 *
 * Every public name here can also be called by the kiosk page through google.script.run,
 * so each checks its caller before it reads or writes anything (tests/admin.test.mjs
 * holds every public function here to it):
 *   - setupDailyJobs, removeDailyJobs, setupHoursRequestJob and removeHoursRequestJob run
 *     by hand from the editor and start with requireEditorRun_, as setupSheets does.
 *   - checkLogNow is a Kiosk admin menu item that opens no dialog, like refreshHoursNow:
 *     it checks requireEditorRun_ and SpreadsheetApp.getUi() (it throws anywhere but the
 *     spreadsheet's own UI) before it reads anything.
 *   - A trigger handler (runFlagsEmail, runAutoClockOut, runHoursRefresh,
 *     runHoursRequests) checks
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
 * Log, the Shifts tab and the Flags tab through Sheets.js. The hours request job's rules
 * are in Logic.js's "Hours requests" section; it also reads Volunteer Profiles and writes
 * the Hours requests and Hours emails tabs.
 */

// ---------------------------------------------------------------------------
// Run by hand from the editor

/**
 * Installs the daily jobs for the account running it: deletes this account's triggers in
 * this project whose handler is a daily job's, then creates one trigger for each entry of
 * dailyJobs (Logic.js) and nothing else, and writes the account into Settings "Daily jobs
 * installed by". It also makes sure this account has the Log change trigger
 * (ensureLogChangeTrigger_) and says in its log line whether it kept, installed or failed
 * to install it. Then it logs how many open rows the auto clock-out would close if it ran
 * now, since a first run may close a backlog. Running it again replaces this account's
 * triggers, so one account never has two copies. Runs only from the Apps Script editor.
 */
function setupDailyJobs() {
  requireEditorRun_();
  readSettings_(); // The Settings tab must be there before any trigger changes.
  const removed = deleteJobTriggers_();
  const jobs = dailyJobs();
  jobs.forEach(createJobTrigger_);
  const logTrigger = ensureLogChangeTrigger_();
  const owner = Session.getEffectiveUser().getEmail();
  setSetting_("Daily jobs installed by", owner);
  console.log(
    "Daily jobs: removed " +
      removed +
      " old trigger(s) and installed " +
      jobs.map(jobLabel_).join("; ") +
      ", owned by " +
      owner +
      ". " +
      logChangeTriggerLine_(logTrigger),
  );
  console.log(autoClockOutCountLine_(new Date()));
}

/**
 * Deletes this account's daily-job triggers and Log change triggers in this project and
 * clears Settings "Daily jobs installed by" when it names this account. Another account's
 * triggers can't be seen or deleted from here: that account runs this itself. Runs only
 * from the Apps Script editor.
 */
function removeDailyJobs() {
  requireEditorRun_();
  const settings = readSettings_();
  const removed = deleteJobTriggers_();
  const removedLog = deleteLogChangeTriggers_();
  const me = Session.getEffectiveUser().getEmail();
  const installedBy = cellString(settings["Daily jobs installed by"]);
  const cleared = installedBy !== "" && installedBy.toLowerCase() === cellString(me).toLowerCase();
  if (cleared) setSetting_("Daily jobs installed by", "");
  console.log(
    "Daily jobs: removed " +
      removed +
      " trigger(s) and " +
      removedLog +
      " Log change trigger(s) owned by " +
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
 * unless Settings "Flags email" is On, "Flags email to" isn't blank and the due slot
 * (flagsEmailDue) has passed since "Flags email last run"; then counts the Flags tab and
 * sends, or records that there was nothing to send. When "Flags email to" holds no
 * address it can read, the due run records that in "Flags email last run" instead and
 * the next hourly run with an address sends. When the lock isn't free within 30
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

/**
 * The hours request job, run every 15 minutes by its own trigger (setupHoursRequestJob).
 * With Settings "Hours requests" on Auto it emails the volunteers whose requests are
 * waiting (hoursRequestRun_); otherwise it reads Settings and stops.
 */
function runHoursRequests(e) {
  requireEditorRun_();
  requireTriggerRun_(e, "runHoursRequests");
  hoursRequestRun_(new Date());
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
 * returns only the effective user's own triggers. The refusal names the installer to run:
 * setupHoursRequestJob for the hours request job, setupDailyJobs for the rest.
 */
function requireTriggerRun_(e, handler) {
  const uid = e && typeof e === "object" ? cellString(e.triggerUid) : "";
  const ok =
    uid !== "" &&
    ScriptApp.getProjectTriggers().some(
      (t) => t.getUniqueId() === uid && t.getHandlerFunction() === handler,
    );
  if (!ok) {
    const installer =
      handler === hoursRequestJobHandler() ? "setupHoursRequestJob" : "setupDailyJobs";
    throw new Error(
      handler + " runs only from its trigger. To install the triggers, run " + installer + ".",
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

/**
 * Makes sure this account has exactly one Log change trigger: an on-change trigger for
 * this spreadsheet that runs onSheetChange (Sheets.js), which stamps every change made by
 * hand so the Log cache is not used across it. One such trigger is kept; otherwise every
 * onSheetChange trigger of this account is deleted and one is created. Google lists only
 * this account's own triggers, so another account's is never touched. Never throws: a
 * failure comes back as {kind: "failed", message} for setupDailyJobs' log line; otherwise
 * {kind: "kept" or "installed"}.
 */
function ensureLogChangeTrigger_() {
  try {
    const mine = ScriptApp.getProjectTriggers().filter(
      (t) => t.getHandlerFunction() === "onSheetChange",
    );
    if (mine.length === 1 && mine[0].getEventType() === ScriptApp.EventType.ON_CHANGE) {
      return { kind: "kept" };
    }
    mine.forEach((t) => ScriptApp.deleteTrigger(t));
    ScriptApp.newTrigger("onSheetChange")
      .forSpreadsheet(SpreadsheetApp.getActiveSpreadsheet())
      .onChange()
      .create();
    return { kind: "installed" };
  } catch (err) {
    return { kind: "failed", message: (err && err.message) || String(err) };
  }
}

/** Deletes this account's onSheetChange triggers in this project. Returns how many. */
function deleteLogChangeTriggers_() {
  let removed = 0;
  ScriptApp.getProjectTriggers().forEach((t) => {
    if (t.getHandlerFunction() === "onSheetChange") {
      ScriptApp.deleteTrigger(t);
      removed++;
    }
  });
  return removed;
}

/** setupDailyJobs' words for ensureLogChangeTrigger_'s answer. */
function logChangeTriggerLine_(result) {
  if (result.kind === "kept") return "Kept the Log change trigger (onSheetChange).";
  if (result.kind === "installed") return "Installed the Log change trigger (onSheetChange).";
  return "The Log change trigger (onSheetChange) wasn't installed: " + result.message;
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

/**
 * The weekly email's run, once the guard has passed and under the script lock. Besides the
 * flags it counts the hours emails the hours request job sent or tried this week and the
 * hours requests waiting for staff, each from its own tab in its own try.
 */
function sendFlagsEmailIfDue_(now) {
  const settings = readSettings_();
  if (!parseFlagsEmailOn(settings["Flags email"])) return;
  const to = parseEmailAddresses(settings["Flags email to"]);
  if (!to.valid.length && !to.invalid.length) {
    console.log('Flags email: "Flags email to" has no email address; nothing sent.');
    return;
  }
  const nowText = wallClock_(now);
  const lastRun = settings["Flags email last run"] || "";
  // A run that was due but had no address to send to doesn't count as the slot's run once
  // an address can be read, so a fixed address sends at the next hourly run.
  const due =
    flagsEmailDue(
      nowText,
      lastRun,
      parseWeekdaySetting(settings["Flags email day"]),
      parseEmailHour(settings["Flags email hour"]),
    ) ||
    (to.valid.length > 0 && flagsEmailNotSent(lastRun));
  if (!due) return;
  if (!to.valid.length) {
    // Said in the sheet, where staff look, once a slot: the write makes the run not due
    // again until the next slot.
    console.log('Flags email: "Flags email to" has no valid email address; nothing sent.');
    setSetting_("Flags email last run", lastRunText(nowText, flagsEmailNoAddress()));
    return;
  }

  const flags = readFlags_();
  const message = flagsEmailMessage({
    summary: flagsSummary(flags.rows, now.getTime()),
    autoClockOut: autoClockOutCheck(settings["Auto clock-out last run"], nowText),
    flagsUrl: flags.url,
    skipped: to.invalid,
    autoSent: hoursAutoSentCount_(now),
    requestsWaiting: hoursRequestsWaiting_(settings, now),
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
 * How many hours emails the hours request job sent or tried in the 7 days before now
 * (hoursAutoSentCount), 0 with no Hours emails tab, or null when the tab can't be read.
 * Counting never stops the flags email, so a throw here is logged and gives null.
 */
function hoursAutoSentCount_(now) {
  try {
    return hoursAutoSentCount(readHoursEmailSends_() || [], now.getTime());
  } catch (err) {
    console.log("Flags email: the Hours emails tab couldn't be read: " + errorMessage_(err));
    return null;
  }
}

/**
 * How many hours requests need a person (hoursRequestsWaitingCount) by the mode in
 * settings, 0 with no Hours requests tab, or null when the tab can't be read, logged.
 */
function hoursRequestsWaiting_(settings, now) {
  try {
    const mode = hoursRequestsMode(settings);
    return hoursRequestsWaitingCount(readHoursRequests_() || [], mode, now.getTime());
  } catch (err) {
    console.log("Flags email: the Hours requests tab couldn't be read: " + errorMessage_(err));
    return null;
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

// ---------------------------------------------------------------------------
// The hours request job
//
// With Settings "Hours requests" on Auto, this job emails volunteers who asked for their
// hours at the tablet. It runs every 15 minutes on a trigger of its own, not one of
// dailyJobs(), because it opens Volunteer Profiles to read addresses and the daily jobs'
// account need not be able to. setupHoursRequestJob installs it for the account that runs
// it; setupDailyJobs and removeDailyJobs leave it alone.
//
// The rules a run keeps:
//   - It holds the script lock only to claim and to record, never across a read of
//     Profiles, the Log or Flags, and never across a send.
//   - Every email it may have sent has an Hours emails row written before the send: the
//     claim appends the row as sending first, then marks the request sending, and sends
//     only for requests whose two writes both landed.
//   - It finds its rows by Volunteer ID with Requested at or Send ID, under the lock, never
//     by a row number read before it.
//   - A request left sending by a run that stopped part way is held for a person, never
//     sent again, so a crash can't send twice.

/**
 * Installs the hours request job for the account running it. First opens Volunteer
 * Profiles the way Email hours does and refuses, naming the problem, when this account
 * can't. Then deletes this account's own runHoursRequests triggers, makes one that runs
 * every 15 minutes, and writes Settings "Hours requests last run" as "<time>, job
 * installed by <account>". Runs only from the Apps Script editor.
 */
function setupHoursRequestJob() {
  requireEditorRun_();
  const settings = readSettings_();
  try {
    profileEmails_(settings, []);
  } catch (err) {
    throw new Error("This account can't open Volunteer Profiles: " + errorMessage_(err));
  }
  const removed = deleteHoursRequestTriggers_();
  ScriptApp.newTrigger(hoursRequestJobHandler())
    .timeBased()
    .everyMinutes(hoursRequestJobMinutes())
    .create();
  const owner = Session.getEffectiveUser().getEmail();
  setSetting_(
    hoursRequestsLastRunSetting(),
    lastRunText(wallClock_(new Date()), "job installed by " + owner),
  );
  console.log(
    "Hours request job: removed " +
      removed +
      " old trigger(s) and installed " +
      hoursRequestJobHandler() +
      " every " +
      hoursRequestJobMinutes() +
      " minutes, owned by " +
      owner +
      ".",
  );
}

/**
 * Deletes this account's runHoursRequests triggers and writes Settings "Hours requests
 * last run" as "<time>, job removed by <account>". Another account's trigger can't be seen
 * from here: that account runs this itself. Runs only from the Apps Script editor.
 */
function removeHoursRequestJob() {
  requireEditorRun_();
  readSettings_(); // The Settings tab must be there before any trigger changes.
  const removed = deleteHoursRequestTriggers_();
  const me = Session.getEffectiveUser().getEmail();
  setSetting_(
    hoursRequestsLastRunSetting(),
    lastRunText(wallClock_(new Date()), "job removed by " + me),
  );
  console.log("Hours request job: removed " + removed + " trigger(s) owned by " + me + ".");
}

/** Deletes this account's runHoursRequests triggers in this project. Returns how many. */
function deleteHoursRequestTriggers_() {
  let removed = 0;
  ScriptApp.getProjectTriggers().forEach((t) => {
    if (t.getHandlerFunction() === hoursRequestJobHandler()) {
      ScriptApp.deleteTrigger(t);
      removed++;
    }
  });
  return removed;
}

/**
 * One run of the hours request job at now, once the guard has passed.
 *
 * Settings "Hours requests" not Auto, no Hours requests tab, or no request waiting or
 * stopped part way: it stops having written nothing and taken no lock. Otherwise:
 *   1. Reads, no lock, once, and decides each waiting request (decideHoursRequests_).
 *   2. Claims under the script lock (claimHoursRequests_).
 *   3. Sends, no lock (sendHoursRequests_).
 *   4. Records under the script lock (recordHoursRequests_).
 *   5. Writes "Hours requests last run" when it held, claimed, answered or recovered
 *      anything, so idle runs leave Settings alone, and logs one line.
 * A throw anywhere writes "<time>, failed: <message>" with any address taken out, and is
 * thrown again, so the owner gets Google's failure email.
 */
function hoursRequestRun_(now) {
  const settings = readSettings_();
  if (hoursRequestsMode(settings) !== "auto") return;
  const nowMs = now.getTime();
  // waiting counts the requests the run leaves waiting; held every request it holds.
  const run = {
    sent: 0,
    held: 0,
    waiting: 0,
    checkedIn: 0,
    quota: 0,
    answered: 0,
    recovered: 0,
    claimed: 0,
    holds: [],
    notRecorded: false,
  };
  try {
    const requests = readHoursRequests_();
    if (!requests) return;
    const queue = hoursRequestQueue(requests, nowMs);
    if (!queue.waiting.length && !queue.stale.length) return;
    const decided = queue.waiting.length
      ? decideHoursRequests_(settings, queue.waiting, now)
      : { holds: [], candidates: [], left: 0, checkedIn: 0, quota: 0 };
    run.checkedIn = decided.checkedIn;
    run.quota = decided.quota;
    const sendId = Utilities.getUuid().replace(/-/g, "").slice(0, 8);
    const claims = claimHoursRequests_(queue.stale, decided, sendId, nowMs, run);
    if (claims === null) {
      run.waiting = queue.waiting.length;
    } else {
      run.waiting += decided.left;
      run.claimed = claims.length;
      sendHoursRequests_(claims, nowMs);
      if (claims.length) recordHoursRequests_(claims, sendId, nowMs, run);
    }
  } catch (err) {
    const message = hoursEmailLogText(errorMessage_(err));
    console.log("Hours requests: the run failed: " + message);
    setSetting_(hoursRequestsLastRunSetting(), lastRunText(wallClock_(now), "failed: " + message));
    throw err;
  }
  if (run.held || run.claimed || run.answered || run.recovered) {
    setSetting_(
      hoursRequestsLastRunSetting(),
      lastRunText(wallClock_(now), hoursRequestRunText(run)),
    );
  }
  console.log(hoursRequestRunLog(run));
}

/**
 * The run's reads and decisions, with no lock. Reads once: the volunteer list, the
 * requesters' addresses (profileEmails_), the Log, the Flags tab (null when it throws, so
 * every request is held) and the remaining mail quota; a throw from any other read fails
 * the run with every request left waiting. Then decides each waiting request in order
 * (hoursRequestDecide), "checked in" by the tablet's own rule (findOpenShift with the
 * "Auto clock-out after hours" window). Returns {holds: [{request, code, reason}],
 * candidates (hoursRequestEmail_'s), left, checkedIn, quota}: left counts the requests left
 * waiting (checked in, past the quota, unreadable, or past the run's hoursEmailChunkSize()
 * emails), checkedIn and quota how many of those for each reason.
 */
function decideHoursRequests_(settings, waiting, now) {
  const nowMs = now.getTime();
  const volunteers = getProfiles_(settings);
  const found = [];
  waiting.forEach((r) => {
    const v = findVolunteer(volunteers, r.id);
    if (v && found.indexOf(v) < 0) found.push(v);
  });
  const emails = found.length ? profileEmails_(settings, found) : {};
  const entries = readReportLog_().entries;
  let flags = null;
  try {
    flags = readFlags_().rows;
  } catch (err) {
    console.log("Hours requests: the Flags tab couldn't be read: " + errorMessage_(err));
  }
  const quota = MailApp.getRemainingDailyQuota();
  const today = centralDate_(now);
  const base = {
    entries,
    flags,
    today,
    period: hoursEmailPeriod("this", today),
    listedTokens: volunteers.map((v) => v.token),
    contact: settings[hoursEmailContactSetting()] || "",
    signature: settings[hoursEmailSignatureSetting()] || "",
  };
  const windowMs = autoClockOutWindowMs(settings["Auto clock-out after hours"]);
  const wallClock = (ms) => wallClock_(new Date(ms));
  const out = { holds: [], candidates: [], left: 0, checkedIn: 0, quota: 0 };
  let quotaLow = false;
  waiting.forEach((request) => {
    if (quotaLow) {
      out.left++;
      out.quota++;
      return;
    }
    const volunteer = findVolunteer(volunteers, request.id);
    const address = volunteer ? emails[volunteer.id] || null : null;
    const decision = hoursRequestDecide({
      request,
      volunteer,
      address,
      contact: base.contact,
      flagsRead: flags !== null,
      openShift: volunteer ? findOpenShift(entries, volunteer.token, nowMs, windowMs, today) : null,
      nowMs,
      wallClock,
      quota,
    });
    if (decision.action === "hold") {
      out.holds.push({ request, code: decision.code, reason: decision.reason });
    } else if (decision.action === "quota") {
      quotaLow = true;
      out.left++;
      out.quota++;
    } else if (decision.action === "wait") {
      out.left++;
      if (decision.code === "checked-in") out.checkedIn++;
    } else if (out.candidates.length >= hoursEmailChunkSize()) {
      out.left++;
    } else {
      out.candidates.push(hoursRequestEmail_(base, request, volunteer, address));
    }
  });
  return out;
}

/**
 * One automatic email, built as Email hours builds one for this month with the file, from
 * the Log with the volunteer's unchecked shifts taken out (hoursRequestEntries), so the
 * totals, the month's list and the file agree; it adds the kiosk line and, when shifts
 * were left out, how many. Returns {request, id, name, to, subject, body, file, csv,
 * fileName, totals, unchecked, month, asOf}.
 */
function hoursRequestEmail_(base, request, volunteer, address) {
  const picked = hoursRequestEntries(base.entries, volunteer, base.flags, base.period.asOf);
  const plan = hoursEmailPlan({
    volunteer,
    entries: picked.entries,
    flags: base.flags,
    period: base.period,
    todayDate: base.today,
    listedTokens: base.listedTokens,
    attach: true,
  });
  const message = hoursEmailMessage({
    firstName: volunteer.firstName,
    plan,
    attach: true,
    contact: base.contact,
    signature: base.signature,
    request: {
      date: centralDate_(new Date(request.requestedMs)),
      unchecked: picked.unchecked,
    },
  });
  const file = hoursEmailHasFile(plan, true);
  return {
    request,
    id: volunteer.id,
    name: volunteerFullName(volunteer),
    to: address.email,
    subject: message.subject,
    body: message.body,
    file,
    csv: file ? hoursEmailCsv(plan.allShifts, adminClock_) : "",
    fileName: hoursEmailFileName(base.period.asOf),
    totals: {
      month: plan.month.hundredths,
      year: plan.year.hundredths,
      all: plan.all.hundredths,
    },
    unchecked: picked.unchecked,
    month: base.period.month,
    asOf: base.period.asOf,
  };
}

/**
 * Runs fn under the script lock, waiting up to waitMs, and flushes before it releases.
 * Returns {held: false} when the lock didn't come, else {held: true, value}.
 */
function hoursRequestLock_(waitMs, fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(waitMs)) return { held: false };
  try {
    const value = fn();
    return { held: true, value };
  } finally {
    try {
      SpreadsheetApp.flush();
    } finally {
      lock.releaseLock();
    }
  }
}

/**
 * The claim, under the script lock (30 s wait). Returns the claims to send, each a
 * candidate, or null when the lock didn't come: then nothing was written, claimed or sent.
 * Under the lock it reads the Hours requests and Hours emails tabs again, then:
 *   - each stale request still sending with the Send ID first read is held with the
 *     stopped-part-way reason, and its Hours emails rows with that Send ID and Volunteer
 *     ID still sending get Result stopped;
 *   - each hold is written on its request if that is still waiting with the same
 *     Volunteer ID and Requested at;
 *   - each candidate whose request is still waiting so: when an Hours emails row sent after
 *     Requested at answers it already, it becomes sent from that row; past the week or the
 *     day limit, counted with this claim's own rows, it is held; else it is claimed.
 * The claimed requests' Hours emails rows are appended first, Result sending, then their
 * requests are marked sending with this run's Send ID. When marking throws, each claimed
 * request is put back to waiting and its row's Result to not sent, as far as the sheet
 * allows, and the error is thrown: nothing is sent.
 */
function claimHoursRequests_(stale, decided, sendId, nowMs, run) {
  const done = hoursRequestLock_(hoursRequestClaimWaitMs(), () => {
    const tab = hoursRequestSheet_();
    const fresh = readHoursRequests_(tab);
    const sends = readHoursEmailSends_() || [];
    const R = hoursRequestResults();
    const by = hoursRequestAutoBy();
    const kinds = hoursRequestColumnKinds();
    const write = (r, changes) => writeRowCells_(tab.sheet, tab.cols, kinds, r.row, changes);
    let emailsTab = null;
    const writeResult = (row, result) => {
      emailsTab = emailsTab || hoursEmailSheet_();
      writeRowCells_(emailsTab.sheet, emailsTab.cols, hoursEmailColumnKinds(), row, {
        Result: result,
      });
    };
    const stillWaiting = (old) =>
      fresh.find(
        (r) => r.id === old.id && r.status === "waiting" && r.requestedMs === old.requestedMs,
      ) || null;
    const hold = (r, code, reason) => {
      write(r, { Status: "held", Reason: reason, "Done at": nowMs, "Done by": by });
      run.held++;
      run.holds.push({ id: r.id, code });
    };

    stale.forEach((old) => {
      const r = fresh.find(
        (x) =>
          x.id === old.id &&
          x.status === "sending" &&
          x.sendId === old.sendId &&
          hoursRequestStopped(x, nowMs),
      );
      if (!r) return;
      write(r, {
        Status: "held",
        Reason: hoursRequestHoldReason("stopped"),
        "Done at": nowMs,
        "Done by": by,
      });
      run.held++;
      run.recovered++;
      run.holds.push({ id: r.id, code: "stopped" });
      sends
        .filter(
          (s) =>
            s.sendId === old.sendId &&
            s.id === old.id &&
            hoursRequestStatus(s.result) === R.sending,
        )
        .forEach((s) => writeResult(s.row, R.stopped));
    });

    decided.holds.forEach((h) => {
      const r = stillWaiting(h.request);
      if (r) hold(r, h.code, h.reason);
    });

    const today = centralDate_(new Date(nowMs));
    const own = [];
    const claims = [];
    decided.candidates.forEach((c) => {
      const r = stillWaiting(c.request);
      if (!r) {
        console.log(
          "Hours requests: the request of volunteer " +
            c.id +
            " changed before the claim, so it was left as it is.",
        );
        return;
      }
      const answer = hoursRequestAnswer(sends, r.id, r.requestedMs);
      if (answer) {
        write(r, {
          Status: "sent",
          "Done at": answer.ms,
          "Done by": answer.by,
          "Send ID": answer.sendId,
        });
        run.answered++;
        return;
      }
      const limit = hoursRequestLimit(sends.concat(own), r.id, nowMs, today);
      if (limit) return hold(r, limit.code, limit.reason);
      own.push({ id: r.id, result: R.sending, ms: nowMs, date: today, by });
      claims.push(Object.assign(c, { row: r }));
    });
    if (!claims.length) return claims;

    const account = Session.getEffectiveUser().getEmail();
    const first = appendHoursEmailRows_(
      claims.map((c) =>
        hoursEmailRow({
          sentAtMs: nowMs,
          sendId,
          name: c.name,
          id: c.id,
          to: c.to,
          month: c.month,
          asOf: c.asOf,
          file: c.file,
          initials: by,
          account,
          result: R.sending,
          totals: c.totals,
        }),
      ),
    );
    try {
      claims.forEach((c) =>
        write(c.row, {
          Status: "sending",
          Reason: "",
          "Done at": nowMs,
          "Done by": by,
          "Send ID": sendId,
        }),
      );
    } catch (err) {
      claims.forEach((c, i) => {
        try {
          write(c.row, { Status: "waiting", "Done at": "", "Done by": "", "Send ID": "" });
        } catch (e) {
          console.error("Hours requests: volunteer " + c.id + "'s request not put back.");
        }
        try {
          writeResult(first + i, R.unclaimed);
        } catch (e) {
          console.error("Hours emails: row " + (first + i) + " not marked not sent.");
        }
      });
      throw err;
    }
    return claims;
  });
  if (!done.held) {
    console.log(
      "Hours requests: the script lock was busy; nothing was claimed or sent, and the next run will try again.",
    );
    return null;
  }
  return done.value;
}

/**
 * The sends, with no lock, in the claims' order, as Email hours sends: from the no-reply
 * address, the file attached when the email has one. Sets each claim's outcome for
 * hoursRequestRecordChanges: none starts once the run is 4 minutes old ("late"), nor while
 * Google's quota is at or under the reserve ("quota"); a send that throws is "failed".
 */
function sendHoursRequests_(claims, startMs) {
  claims.forEach((c) => {
    try {
      if (Date.now() - startMs >= hoursRequestSendBudgetMs()) {
        c.outcome = "late";
        return;
      }
      if (!hoursRequestQuotaOk(MailApp.getRemainingDailyQuota())) {
        c.outcome = "quota";
        return;
      }
    } catch (err) {
      c.outcome = "not-sent";
      c.message = errorMessage_(err);
      return;
    }
    const mail = {
      to: c.to,
      subject: c.subject,
      body: c.body,
      name: flagsEmailSenderName(),
      noReply: true,
    };
    if (c.file) mail.attachments = [Utilities.newBlob(c.csv, "text/csv", c.fileName)];
    try {
      MailApp.sendEmail(mail);
      c.outcome = "sent";
    } catch (err) {
      c.outcome = "failed";
      c.message = errorMessage_(err);
    }
    c.atMs = Date.now();
  });
}

/**
 * The record, under the script lock, waiting until the run is 5 minutes old. Reads both
 * tabs again and, for each claim, writes only the Hours requests row with this run's Send
 * ID, the claim's Volunteer ID and Status still sending, and the Hours emails row with
 * this Send ID and Volunteer ID and Result still sending (hoursRequestRecordChanges). A
 * row staff have changed since the claim is left as they left it, with a log line. When
 * the lock doesn't come, both rows stay sending: they count as sends, and a later run
 * holds the request as stopped part way.
 */
function recordHoursRequests_(claims, sendId, startMs, run) {
  const R = hoursRequestResults();
  const waitMs = Math.max(0, startMs + hoursRequestRecordByMs() - Date.now());
  const done = hoursRequestLock_(waitMs, () => {
    const tab = hoursRequestSheet_();
    const fresh = readHoursRequests_(tab);
    const sends = readHoursEmailSends_() || [];
    const emailsTab = hoursEmailSheet_();
    claims.forEach((c) => {
      const change = hoursRequestRecordChanges(
        c.outcome,
        c.message,
        c.unchecked,
        c.atMs || Date.now(),
      );
      const r = fresh.find((x) => x.sendId === sendId && x.id === c.id && x.status === R.sending);
      const row = sends.find(
        (s) => s.sendId === sendId && s.id === c.id && hoursRequestStatus(s.result) === R.sending,
      );
      if (r) {
        writeRowCells_(tab.sheet, tab.cols, hoursRequestColumnKinds(), r.row, change.request);
      } else {
        console.log(
          "Hours requests: the request of volunteer " +
            c.id +
            " changed during the run, so it was left as staff left it.",
        );
      }
      if (row) {
        writeRowCells_(emailsTab.sheet, emailsTab.cols, hoursEmailColumnKinds(), row.row, {
          Result: change.result,
        });
      } else {
        console.log(
          "Hours emails: the row of volunteer " +
            c.id +
            " (Send ID " +
            sendId +
            ") changed during the run, so it was left as staff left it.",
        );
      }
    });
  });
  claims.forEach((c) => {
    if (c.outcome === "sent") run.sent++;
    else if (c.outcome === "failed") {
      if (done.held) {
        run.held++;
        run.holds.push({ id: c.id, code: "send-failed" });
      }
    } else if (done.held) run.waiting++;
  });
  if (!done.held) run.notRecorded = true;
}
