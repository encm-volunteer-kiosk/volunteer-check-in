/**
 * The web app: doGet serves the page, and the page calls the api* functions through
 * google.script.run.
 *
 * Every api* function takes the kiosk access code first and returns
 * {ok: true, ...result} or {ok: false, refusal, message}. It throws only on a real
 * failure (a Sheets error, a missing or repeated Log header, a bad setting). The page
 * never receives a phone number, a User Token, a Profiles row, a start date, or anyone's
 * shift count or hours. Log columns are found by header on every call.
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
  return accessRefusal_(code) || { ok: true };
}

/**
 * {ok: true, volunteers: [{id, firstName, lastName, openShiftArrival, needsPhoneCheck}]}.
 * openShiftArrival is the ISO stated arrival of the volunteer's open row dated today,
 * else null. id is the hashed Volunteer ID; the raw User Token never leaves the server.
 */
function apiListVolunteers(code) {
  const denied = accessRefusal_(code);
  if (denied) return denied;
  const settings = readSettings_();
  const today = centralDate_(new Date());
  return {
    ok: true,
    volunteers: volunteerSummaries(
      getProfiles_(settings),
      readTodayLog_(today, readLogColumns_()),
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
 * {ok: true, id, shiftId, arrivedAt, tappedAt} or a refusal; id is the volunteer
 * checked in.
 */
function apiCheckIn(code, id, arrivalIso, digits) {
  const denied = accessRefusal_(code);
  if (denied) return denied;
  return withLock_(() => {
    const now = new Date();
    const today = centralDate_(now);
    const settings = readSettings_();
    const cols = readLogColumns_();
    const arrivedMs = arrivalMsFromIso(arrivalIso);
    const decision = decideCheckIn({
      volunteers: getProfiles_(settings),
      id,
      digits,
      entries: readTodayLog_(today, cols),
      todayDate: today,
      nowMs: now.getTime(),
      arrivedMs,
      arrivedDate: Number.isFinite(arrivedMs) ? centralDate_(new Date(arrivedMs)) : "",
      flagMinutes: parseFlagMinutes(settings["Arrival flag minutes"]),
    });
    if (decision.refusal) return refusal(decision.refusal);
    const shiftId = Utilities.getUuid();
    appendLogRow_(
      checkInCells(
        decision.volunteer,
        today,
        now.getTime(),
        decision.arrivedMs,
        decision.flag,
        shiftId,
      ),
      cols,
    );
    return {
      ok: true,
      id: decision.volunteer.id,
      shiftId,
      arrivedAt: new Date(decision.arrivedMs).toISOString(),
      tappedAt: now.toISOString(),
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
 * message} or null.
 */
function apiCheckOut(code, id, digits, checkOutIso) {
  const denied = accessRefusal_(code);
  if (denied) return denied;
  return withLock_(() => {
    const now = new Date();
    const settings = readSettings_();
    const cols = readLogColumns_();
    const outMs = arrivalMsFromIso(checkOutIso);
    const decision = decideCheckOut({
      volunteers: getProfiles_(settings),
      id,
      digits,
      entries: readLog_(cols),
      todayDate: centralDate_(now),
      nowMs: now.getTime(),
      outMs,
      outDate: Number.isFinite(outMs) ? centralDate_(new Date(outMs)) : "",
      flagMinutes: parseFlagMinutes(settings["Check-out flag minutes"]),
      launchDate: settings["Kiosk launch date"],
    });
    if (decision.refusal) return refusal(decision.refusal);
    updateLogRow_(decision.row, decision.cells, cols);
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
 * The ACCESS refusal, or null when the code is right. Runs before any lock is taken, so
 * calls without the code never hold the lock or make the tablet's call return BUSY.
 * A refused code waits one second. There is no lockout: a lockout would let anyone with
 * the link lock the real tablet out.
 */
function accessRefusal_(code) {
  if (!checkAccessCode(code, readSettings_()["Kiosk access code"])) return null;
  Utilities.sleep(1000);
  return refusal("ACCESS");
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
