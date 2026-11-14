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
 * A check-out with no digits for a volunteer who shares a name reads the rows of every
 * member of the name, and acts only when the tapped member is the one of the name
 * checked in (checkOutTokens and resolveCheckOut, Logic.js).
 *
 * With the Log cache switched on (the LOG_CACHE script property, Sheets.js), the call
 * reads the Log's extent and row 1 and takes every volunteer's Log state from the cached
 * log map instead, when the map may be used (a hit; readLogState_, Sheets.js). A refusal
 * on a hit is never returned from the map: the call reads the whole Log and decides again.
 * A check-out on a hit still reads its row again before the write and decides again with
 * that row, so the cells written come from the sheet. When the map can't be used (a miss)
 * the call reads the whole Log, decides as without the cache, and builds the map from the
 * same read. Just before its Log write the call removes the map, and after the write is
 * flushed it stores the map with the write folded in. Each such call logs one "Log cache:"
 * line saying which path it took, and no volunteer data.
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
 * needsPhoneCheck}], longShiftHours}. checkedIn is true when the volunteer has an open row
 * the tablet can still check out: one checked in less than "Auto clock-out after hours"
 * ago, past midnight too, or one dated today whose check-in time can't be read.
 * openShiftArrival is the ISO stated arrival of that row, else null; it is also null when
 * the row's check-in time can't be read, and the volunteer is still checked in. id is the
 * hashed Volunteer ID; the raw User Token never leaves the server. longShiftHours is "Long
 * shift flag hours" (parseLongShiftHours), the time in past which the page marks a card.
 * Reads only yesterday's and today's rows.
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
    longShiftHours: parseLongShiftHours(settings["Long shift flag hours"]),
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
  const run = logCacheRun_();
  return withLock_(
    () =>
      withLogCacheLine_(run, () => {
        const now = new Date();
        const today = centralDate_(now);
        const volunteers = getProfiles_(settings);
        const who = resolveVolunteer(volunteers, id, digits);
        if (who.refusal) return refusal(who.refusal);
        const tokens = [who.volunteer.token];
        let log = kioskLogRead_(run, tokens, volunteers);
        const arrivedMs = arrivalMsFromIso(arrivalIso);
        const input = {
          volunteers,
          id,
          digits,
          todayDate: today,
          nowMs: now.getTime(),
          windowMs: autoClockOutWindowMs(settings["Auto clock-out after hours"]),
          arrivedMs,
          arrivedDate: Number.isFinite(arrivedMs) ? centralDate_(new Date(arrivedMs)) : "",
          flagMinutes: parseFlagMinutes(settings["Arrival flag minutes"]),
          launchDate: settings["Kiosk launch date"],
        };
        let decision = log.hit
          ? decideCheckIn({ ...input, states: log.map.states })
          : decideCheckIn({ ...input, entries: log.entries });
        if (decision.refusal && log.hit) {
          // A refusal is never answered from the map: read the whole Log and decide again.
          log = kioskFullRead_(run, tokens, volunteers, "refused " + decision.refusal);
          decision = decideCheckIn({ ...input, entries: log.entries });
        }
        if (decision.refusal) {
          keepLogMap_(run, log);
          return refusal(decision.refusal);
        }
        const flagPlan = planFlags_(decision.flags);
        const shiftId = Utilities.getUuid();
        const cells = checkInCells(
          decision.volunteer,
          today,
          now.getTime(),
          decision.arrivedMs,
          decision.flag,
          shiftId,
        );
        if (run.on) forgetLogMap_();
        const logRow = appendLogRow_(cells, log.cols, { kiosk: true });
        if (run.on) {
          run.put = logStateAfterCheckIn(log.map, logEntryFromCells(logRow, cells));
          run.why = "the row written is not the row after the map's last";
        }
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
      }),
    () => fillLogMap_(run),
  );
}

/**
 * Checks a volunteer out. id and digits are as for apiCheckIn, but for one case: a
 * check-out with no digits for a volunteer who shares a name reads the rows of every
 * member of the name, and checks the tapped member out when they are the only one of the
 * name checked in; when another member is in it answers PHONE_NEEDED (PHONE_MISSING when
 * the tapped member has no usable phone), and NOT_IN when none is. checkOutIso is the
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
  const run = logCacheRun_();
  return withLock_(
    () =>
      withLogCacheLine_(run, () => {
        const now = new Date();
        const volunteers = getProfiles_(settings);
        const wanted = checkOutTokens(volunteers, id, digits);
        if (wanted.refusal) return refusal(wanted.refusal);
        let log = kioskLogRead_(run, wanted.tokens, volunteers);
        const outMs = arrivalMsFromIso(checkOutIso);
        const input = {
          volunteers,
          id,
          digits,
          todayDate: centralDate_(now),
          nowMs: now.getTime(),
          windowMs: autoClockOutWindowMs(settings["Auto clock-out after hours"]),
          outMs,
          outDate: Number.isFinite(outMs) ? centralDate_(new Date(outMs)) : "",
          flagMinutes: parseFlagMinutes(settings["Check-out flag minutes"]),
          longShiftHours: parseLongShiftHours(settings["Long shift flag hours"]),
          launchDate: settings["Kiosk launch date"],
        };
        let planned = null;
        if (log.hit) {
          const hit = checkOutOnHit_(input, log);
          if (hit.why) log = kioskFullRead_(run, wanted.tokens, volunteers, hit.why);
          else planned = hit;
        }
        if (!planned) {
          const decision = decideCheckOut({ ...input, entries: log.entries });
          if (decision.refusal) {
            keepLogMap_(run, log);
            return refusal(decision.refusal);
          }
          const flagPlan = planFlags_(decision.flags);
          // Staff may sort, insert or delete Log rows while the call runs, which moves rows
          // under their numbers. Read the row again, last before the write, and write only
          // if it is still the open row decided on; else BUSY, and a retry reads the Log
          // again.
          const openId = decision.open.shiftId;
          const current = readLogRowAt_(decision.row, log.width, log.cols, logRead_(), openId);
          if (!autoClockOutRowUnchanged(decision.open, current)) {
            console.error(
              "Check-out: Log row " +
                decision.row +
                " no longer holds open Shift ID " +
                cellString(openId) +
                "; answered BUSY and wrote nothing.",
            );
            keepLogMap_(run, log);
            return refusal("BUSY");
          }
          planned = { decision, flagPlan };
        }
        const { decision, flagPlan } = planned;
        const openId = decision.open.shiftId;
        // A row staff typed with no Shift ID gets one, as the auto clock-out gives it, so
        // its Flags rows can be written and find it.
        const shiftId = cellString(openId) || Utilities.getUuid();
        if (!cellString(openId)) decision.cells[logHeaderNames().shiftId] = sheetText(shiftId);
        if (run.on) forgetLogMap_();
        updateLogRow_(decision.row, decision.cells, log.cols, { kiosk: true });
        if (run.on) {
          run.put = logStateAfterCheckOut(log.map, decision);
          run.why = "the row closed is not open in the map";
        }
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
      }),
    () => fillLogMap_(run),
  );
}

/**
 * A check-out on a hit: {decision, flagPlan} to write, or {why} when the call must read
 * the whole Log and decide again. The first decision, on the map's states, picks the open
 * row and plans the flags; a refusal, or an open row with no Shift ID (one staff typed,
 * which can't be told from another such row without the whole Log), goes to the whole
 * Log. Then the row is read again, last before the write: it must still be open with the
 * same Shift ID and User Token, and a decision made again with that row in place of the
 * cached one must close the same row with the same flags. That second decision is the one
 * written, so its cells keep the row's Admin Alerts? and its Flags rows carry the row's
 * Name and Date.
 */
function checkOutOnHit_(input, log) {
  const first = decideCheckOut({ ...input, states: log.map.states });
  if (first.refusal) return { why: "refused " + first.refusal };
  if (!cellString(first.open.shiftId)) return { why: "no Shift ID" };
  const flagPlan = planFlags_(first.flags);
  const current = readLogRowAt_(first.row, log.width, log.cols, logRead_(), first.open.shiftId);
  if (!cachedOpenRowUnchanged(first.open, current)) return { why: "row changed" };
  const states = logStatesWithEntry(log.map.states, current);
  const second = states ? decideCheckOut({ ...input, states }) : null;
  if (!sameCheckOutPlan(first, second)) return { why: "decided differently" };
  return { decision: second, flagPlan };
}

/**
 * What a kiosk call does with the Log cache: on, whether the switch read on; line, the
 * "Log cache:" line it logs; put, the map to store after the flush; why, why put is null.
 */
function logCacheRun_() {
  return { on: false, line: "", put: null, why: "" };
}

/** Runs fn, then logs run's "Log cache:" line, if the call got that far, even on a throw. */
function withLogCacheLine_(run, fn) {
  try {
    return fn();
  } finally {
    if (run.line) console.log("Log cache: " + run.line);
  }
}

/**
 * The Log for a kiosk call's decision. Reads the switch once (logCacheSwitchOn_); off, the
 * whole Log for tokens as without the cache (readLogTable_). On, readLogState_: a hit
 * gives the map, a miss the whole Log and the map built from it.
 */
function kioskLogRead_(run, tokens, volunteers) {
  run.on = logCacheSwitchOn_();
  if (!run.on) {
    run.line = "off";
    return readLogTable_(tokens);
  }
  const log = readLogState_(tokens, volunteers);
  run.line = log.hit ? "hit" : "miss (" + log.reason + ")";
  return log;
}

/** After a hit that can't be used for why: the whole Log and the map built from it. */
function kioskFullRead_(run, tokens, volunteers, why) {
  run.line = "hit, then full read (" + why + ")";
  return { hit: false, ...readLogMiss_(tokens, volunteers) };
}

/**
 * A call that refused with nothing written stores the map built from its whole-Log read.
 * Every refusal comes after such a read: a refusal on a hit is decided again on one.
 */
function keepLogMap_(run, log) {
  if (run.on) run.put = log.map;
}

/** After the flush: stores run's map when the switch read on and the call has one to store. */
function fillLogMap_(run) {
  if (!run.on || (!run.put && !run.why)) return;
  putLogMap_(run.put, run.why);
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

/**
 * Runs fn under the script lock, or returns BUSY if the lock isn't free within 10 seconds.
 * Flushes before it releases the lock, whether fn returned or threw. after, when given,
 * runs only when fn returned and the flush went through, still under the lock; its errors
 * are logged and never change the reply.
 */
function withLock_(fn, after) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return refusal("BUSY");
  let returned = false;
  let result;
  try {
    result = fn();
    returned = true;
  } finally {
    try {
      SpreadsheetApp.flush();
      if (returned && after) {
        try {
          after(result);
        } catch (e) {
          console.error("After the write: " + (e && e.message ? e.message : String(e)));
        }
      }
    } finally {
      lock.releaseLock();
    }
  }
  return result;
}
