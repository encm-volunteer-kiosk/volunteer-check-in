/**
 * The daily jobs: functions that run on installable triggers rather than from the tablet
 * or the Kiosk admin menu. Today that is the weekly flags email (runFlagsEmail), which
 * checks every hour whether it is due.
 *
 * One account owns the triggers. Signed in as it, someone runs setupDailyJobs once from
 * the Apps Script editor; the triggers then run as that account, and it sends the email.
 * Google lets each account see and delete only its own triggers, so removeDailyJobs, run
 * as the owner, is how ownership moves to another account.
 *
 * Every public name here can also be called by the kiosk page through google.script.run,
 * so each checks its caller before it reads or writes anything (tests/admin.test.mjs
 * holds every public function here to it):
 *   - setupDailyJobs and removeDailyJobs run by hand from the editor and start with
 *     requireEditorRun_, as setupSheets does.
 *   - A trigger handler (runFlagsEmail) checks requireEditorRun_, then requireTriggerRun_:
 *     the event's triggerUid must be one of this account's triggers for that handler. A
 *     trigger's id is never sent anywhere, so the owner's own browser calling through the
 *     web app is refused too. Each handler does its work at most once per due time, so a
 *     caller who guessed an id could only move a run, never repeat it.
 * Everything else ends in _, so google.script.run can't call it.
 *
 * The rules are in Logic.js (dailyJobs, flagsEmailDue, flagsSummary, flagsEmailMessage);
 * this file reads and writes Settings and the Flags tab through Sheets.js.
 */

// ---------------------------------------------------------------------------
// Run by hand from the editor

/**
 * Installs the daily jobs for the account running it: deletes this account's triggers in
 * this project whose handler is a daily job's, then creates one trigger for each entry of
 * dailyJobs (Logic.js) and nothing else, and writes the account into Settings "Daily jobs
 * installed by". Running it again replaces this account's triggers, so one account never
 * has two copies. Runs only from the Apps Script editor.
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
 * The Flags tab's rows as {rows: [{date, name, shiftId, reason, raisedAtMs, reviewed}],
 * url}, url being the spreadsheet's link opened at the Flags tab. Throws when the tab or a
 * header the script writes is missing, so a broken tab fails the run instead of sending a
 * wrong count.
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
  }));
  const url = SpreadsheetApp.getActiveSpreadsheet().getUrl() + "#gid=" + sheet.getSheetId();
  return { rows, url };
}
