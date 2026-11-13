/**
 * The web app: doGet serves the page, and the page calls the api* functions through
 * google.script.run.
 *
 * Every api* function takes the kiosk access code first and returns
 * {ok: true, ...result} or {ok: false, refusal, message}. It throws only on a real
 * failure (a Sheets error, a missing or repeated Log header, a bad setting). The page
 * never receives a phone number, a User Token, a Profiles row, a start date, or anyone's
 * shift count or hours. Log columns are found by header on every call.
 *
 * A check-in or check-out takes Settings once, before the lock, and uses them for the
 * access code and for everything inside the lock; a Settings edit made while the call
 * waits for the lock applies from the next call. It takes them from the script cache when
 * the cached copy was read from the tab after the last Settings edit and less than 5
 * minutes ago, else it reads the tab (cachedSettings_, Sheets.js). A code that doesn't
 * match the cached copy is checked against the tab before it is refused, so a new code
 * works at once and only a read of the tab refuses one (settingsForCode_). The volunteer
 * list and the code check always read the tab and refresh the cached copy. Inside the
 * lock a call finds the volunteer in Profiles first, so a wrong name or phone returns
 * without reading the Log. Then it reads the Log once, header and rows in one range, and
 * parses only that volunteer's rows (readLogTable_), the only rows the decisions look at.
 *
 * Each flag a check-in or check-out writes to Admin Alerts? is also copied to the Flags
 * tab (raiseFlags_), after the Log write and under the same lock. Every Flags read comes
 * before the Log write (planFlags_), so after that write the call only writes and
 * flushes and never waits on the recalculation the write starts. The Log row is the
 * record: a failed copy is logged and never changes the reply.
 */

/** Serves the page shell, which holds no volunteer data. */
function doGet() {
  // From a file, not a template: the bundled page can contain the "<?" scriptlet marker.
  return HtmlService.createHtmlOutputFromFile("Index")
    .setTitle("Volunteer Check-In")
    .addMetaTag("viewport", "width=device-width, initial-scale=1")
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

/** {ok: true} or ACCESS. */
function apiCheckAccess(code) {
  return accessRefusal_(code, refreshSettingsCache_()) || { ok: true };
}

/**
 * {ok: true, volunteers: [{id, firstName, lastName, checkedIn, openShiftArrival,
 * needsPhoneCheck}]}. checkedIn is true when the volunteer has an open row the tablet can
 * still check out: one checked in less than "Auto clock-out after hours" ago, past
 * midnight too, or one dated today whose check-in time can't be read. openShiftArrival is
 * the ISO stated arrival of that row, else null; it is also null when the row's check-in
 * time can't be read, and the volunteer is still checked in. id is the hashed Volunteer
 * ID; the raw User Token never leaves the server. Reads only yesterday's and today's rows.
 */
function apiListVolunteers(code) {
  const settings = refreshSettingsCache_();
  const denied = accessRefusal_(code, settings);
  if (denied) return denied;
  const now = new Date();
  const today = centralDate_(now);
  return {
    ok: true,
    volunteers: volunteerSummaries(
      getProfiles_(settings),
      readRecentLog_(recentLogDates(today), readLogColumns_()),
      now.getTime(),
      autoClockOutWindowMs(settings["Auto clock-out after hours"]),
      today,
    ),
  };
}

/**
 * Checks a volunteer in. id is the list entry the volunteer tapped. arrivalIso is the
 * arrival time the volunteer chose, or null when they didn't choose one; then the
 * arrival is the server's time of the call, the same as Check-In Recorded. digits is the
 * phone's last four as a string, or null. In a same-name group the digits pick the
 * member, so the volunteer checked in can be another member than the one tapped.
 * {ok: true, id, shiftId, arrivedAt, tappedAt, missedSignOut} or a refusal; id is the
 * volunteer checked in. missedSignOut is true when the volunteer's last check-out was one
 * they didn't make (missedSignOut, Logic.js), so the page can remind them; it is about
 * the volunteer just checked in and says nothing else. ALREADY_IN while the volunteer has
 * an open row checked in less than "Auto clock-out after hours" ago.
 */
function apiCheckIn(code, id, arrivalIso, digits) {
  const { settings, denied } = settingsForCode_(code);
  if (denied) return denied;
  return withLock_(() => {
    const now = new Date();
    const today = centralDate_(now);
    const volunteers = getProfiles_(settings);
    const who = resolveVolunteer(volunteers, id, digits);
    if (who.refusal) return refusal(who.refusal);
    const log = readLogTable_(who.volunteer.token);
    const arrivedMs = arrivalMsFromIso(arrivalIso);
    const decision = decideCheckIn({
      volunteers,
      id,
      digits,
      entries: log.entries,
      todayDate: today,
      nowMs: now.getTime(),
      windowMs: autoClockOutWindowMs(settings["Auto clock-out after hours"]),
      arrivedMs,
      arrivedDate: Number.isFinite(arrivedMs) ? centralDate_(new Date(arrivedMs)) : "",
      flagMinutes: parseFlagMinutes(settings["Arrival flag minutes"]),
      launchDate: settings["Kiosk launch date"],
    });
    if (decision.refusal) return refusal(decision.refusal);
    const flagPlan = planFlags_(decision.flags);
    const shiftId = Utilities.getUuid();
    const logRow = appendLogRow_(
      checkInCells(
        decision.volunteer,
        today,
        now.getTime(),
        decision.arrivedMs,
        decision.flag,
        shiftId,
      ),
      log.cols,
    );
    raiseFlags_(
      {
        date: today,
        name: volunteerFullName(decision.volunteer),
        shiftId,
        raisedAtMs: now.getTime(),
        source: flagSources().checkIn,
        logRow,
      },
      decision.flags,
      flagPlan,
    );
    return {
      ok: true,
      id: decision.volunteer.id,
      shiftId,
      arrivedAt: new Date(decision.arrivedMs).toISOString(),
      tappedAt: now.toISOString(),
      missedSignOut: decision.missedSignOut,
    };
  });
}

/**
 * Checks a volunteer out. id and digits are as for apiCheckIn. checkOutIso is the
 * check-out time the volunteer chose, or null when they didn't choose one; then the
 * check-out is the server's time of the call. It comes last so a page loaded before the
 * check-out picker existed, which sends three arguments, still checks out at server time.
 * {ok: true, id, signedOutAt, tappedAt, minutes, milestone} or a refusal: id is the
 * volunteer checked out, signedOutAt the stated check-out, tappedAt the server time of
 * the call, minutes the whole minutes of stated hours, and milestone {id, title,
 * message} or null. The open row is the one checked in less than "Auto clock-out after
 * hours" ago, so an evening shift checks out past midnight; NOT_IN when there is none. A
 * check-out whose stated hours are more than "Long shift flag hours" is flagged. BUSY
 * when the open row, read again just before the write, is no longer the row decided on
 * (staff sorted, inserted or deleted Log rows meanwhile); nothing is written then.
 */
function apiCheckOut(code, id, digits, checkOutIso) {
  const { settings, denied } = settingsForCode_(code);
  if (denied) return denied;
  return withLock_(() => {
    const now = new Date();
    const volunteers = getProfiles_(settings);
    const who = resolveVolunteer(volunteers, id, digits);
    if (who.refusal) return refusal(who.refusal);
    const log = readLogTable_(who.volunteer.token);
    const outMs = arrivalMsFromIso(checkOutIso);
    const decision = decideCheckOut({
      volunteers,
      id,
      digits,
      entries: log.entries,
      todayDate: centralDate_(now),
      nowMs: now.getTime(),
      windowMs: autoClockOutWindowMs(settings["Auto clock-out after hours"]),
      outMs,
      outDate: Number.isFinite(outMs) ? centralDate_(new Date(outMs)) : "",
      flagMinutes: parseFlagMinutes(settings["Check-out flag minutes"]),
      longShiftHours: parseLongShiftHours(settings["Long shift flag hours"]),
      launchDate: settings["Kiosk launch date"],
    });
    if (decision.refusal) return refusal(decision.refusal);
    const flagPlan = planFlags_(decision.flags);
    // Staff may sort, insert or delete Log rows while the call runs, which moves rows
    // under their numbers. Read the row again, last before the write, and write only if
    // it is still the open row decided on; else BUSY, and a retry reads the Log again.
    const shiftId = decision.open.shiftId;
    const current = readLogRowAt_(decision.row, log.width, log.cols, logRead_(), shiftId);
    if (!autoClockOutRowUnchanged(decision.open, current)) {
      console.error(
        "Check-out: Log row " +
          decision.row +
          " no longer holds open Shift ID " +
          cellString(shiftId) +
          "; answered BUSY and wrote nothing.",
      );
      return refusal("BUSY");
    }
    updateLogRow_(decision.row, decision.cells, log.cols);
    raiseFlags_(
      {
        date: rowDate(decision.open.dateText),
        name: decision.open.name,
        shiftId,
        raisedAtMs: now.getTime(),
        source: flagSources().checkOut,
        logRow: decision.row,
      },
      decision.flags,
      flagPlan,
    );
    return {
      ok: true,
      id: decision.volunteer.id,
      signedOutAt: new Date(decision.statedOutMs).toISOString(),
      tappedAt: now.toISOString(),
      minutes: decision.minutes,
      milestone: decision.milestone,
    };
  });
}

/**
 * The ACCESS refusal, or null when the code is right. settings are the Settings the call
 * already read; without them this reads Settings itself. Runs before any lock is taken, so
 * calls without the code never hold the lock or make the tablet's call return BUSY.
 * A refused code waits one second. There is no lockout: a lockout would let anyone with
 * the link lock the real tablet out.
 */
function accessRefusal_(code, settings) {
  const stored = (settings || readSettings_())["Kiosk access code"];
  if (!checkAccessCode(code, stored)) return null;
  Utilities.sleep(1000);
  return refusal("ACCESS");
}

/**
 * {settings} when code is the kiosk access code, else {denied: the ACCESS refusal}, for a
 * check-in or check-out, before any lock. Settings come from cachedSettings_ (Sheets.js).
 * A code the cached copy doesn't accept is checked again against Settings read from the
 * tab, which also refreshes the copy: a code changed since the copy was read works at
 * once, and a code is refused only after this call has read the tab.
 */
function settingsForCode_(code) {
  const first = cachedSettings_();
  if (!checkAccessCode(code, first.settings["Kiosk access code"])) {
    return { settings: first.settings };
  }
  const settings = first.cached ? refreshSettingsCache_() : first.settings;
  const denied = accessRefusal_(code, settings);
  return denied ? { denied } : { settings };
}

/** Runs fn under the script lock, or returns BUSY if the lock isn't free within 10 seconds. */
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return refusal("BUSY");
  try {
    return fn();
  } finally {
    try {
      SpreadsheetApp.flush();
    } finally {
      lock.releaseLock();
    }
  }
}
