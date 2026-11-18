/**
 * The web app: doGet serves the page, and the page calls the api* functions through
 * google.script.run.
 *
 * Every api* function takes the kiosk access code first and returns
 * {ok: true, ...result} or {ok: false, refusal, message}. It throws only on a real
 * failure (a Sheets error, a missing or repeated Log header, a bad setting). Log columns
 * are found by header on every call.
 *
 * What the page receives. It gets no phone number, User Token, Profiles row, start date,
 * row number, shift count or hours. The volunteer list carries, for every volunteer, the
 * one boolean of the missed check-out notice, and for a checked-in volunteer the Shift ID
 * of their open row (whatever the Log's cell holds: a random ID on kiosk and admin rows,
 * free text on a row staff typed), when that row leaves the window, and the minutes of
 * this shift at which a check-out would show a milestone, only those reachable this
 * shift. Those let the tablet show a check-in or check-out at the tap. It also carries
 * that row's Check-In Recorded, the latest arrival a Change on the check-out screen may
 * choose (apiChangeArrival). The list also carries one boolean, hoursRequests: whether the
 * welcome screen's Request my hours link shows (Settings "Hours requests" is Approve or
 * Auto, and Email hours is On). The tablet never receives the mode, and no call
 * sends it an email address or says whether a volunteer has one.
 *
 * A check-in or check-out the tablet already showed comes with a tap (readTap, Logic.js):
 * a tap ID, which is a check-in's Shift ID, the Shift ID a check-out closes, the tap's
 * age by the tablet's clock, the send count and what the tablet showed. The stated time
 * is the server's time less the tap's age. A later send of a tap that was saved finds its
 * row and writes nothing (replayed); a later send reads the whole Log when the cache
 * would answer from the map. What the tablet showed is compared with the server's
 * decision, and each difference is a Flags reason on the row written. A refusal of a
 * tapped save (other than BUSY) writes no Log cell and one Flags row naming the tap
 * (raiseTapRefusal_). A tap that can't be read is refused TAP_UNREADABLE before the lock,
 * with no Flags row.
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

/**
 * Serves the page shell, which holds no volunteer data. Its title is the one Settings value
 * it reads (pageTitle): when Settings can't be read, the title takes the brand's word, so
 * the title never stops the page loading.
 */
function doGet() {
  let title;
  try {
    title = pageTitle(cachedSettings_().settings);
  } catch (e) {
    console.error("Settings not read for the page title: " + (e && e.message ? e.message : e));
    title = pageTitle(brandSettingsDefaults());
  }
  // From a file, not a template: the bundled page can contain the "<?" scriptlet marker.
  return HtmlService.createHtmlOutputFromFile("Index")
    .setTitle(title)
    .addMetaTag("viewport", "width=device-width, initial-scale=1")
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

/** {ok: true}, ACCESS or ZONE_NOT_SET. */
function apiCheckAccess(code) {
  return accessRefusal_(code, refreshSettingsCache_()) || { ok: true };
}

/**
 * {ok: true, volunteers: [{id, firstName, lastName, checkedIn, openShiftArrival,
 * needsPhoneCheck, missedSignOut, openShiftId, openUntil, openShiftTapped,
 * checkOutMilestones}],
 * longShiftHours, hoursRequests, milestones, serverNow}. checkedIn is true when the volunteer has an open
 * row the tablet can still check out: one checked in less than "Auto clock-out after
 * hours" ago, past midnight too, or one dated today whose check-in time can't be read.
 * openShiftArrival is the ISO stated arrival of that row, else null; it is also null when
 * the row's check-in time can't be read, and the volunteer is still checked in. id is the
 * hashed Volunteer ID; the raw User Token never leaves the server. missedSignOut,
 * openShiftId, openUntil, openShiftTapped and checkOutMilestones are as volunteerSummaries (Logic.js) gives
 * them. longShiftHours is "Long shift flag hours" (parseLongShiftHours), the time in past
 * which the page marks a card. hoursRequests is true when Settings "Hours requests" is
 * Approve or Auto and the Email hours switch is On (hoursRequestsMode), false otherwise.
 * milestones are [{id, title, message}], the texts the steps
 * name. words, organizationName, logoLink and switches are the page's Settings (pageSettings).
 * With the Milestones switch Off every checkOutMilestones holds the one step of no milestone.
 * serverNow is the server's clock in ms, taken last, so the page can tell how far its own
 * clock is off.
 *
 * Reads every row of every Profiles volunteer (listLogStates_), since the notice answer
 * and the milestone steps need the whole history.
 */
function apiListVolunteers(code) {
  const settings = refreshSettingsCache_();
  const denied = accessRefusal_(code, settings);
  if (denied) return denied;
  const volunteers = getProfiles_(settings);
  const states = listLogStates_(volunteers);
  const now = new Date();
  return {
    ok: true,
    volunteers: volunteerSummaries(
      volunteers,
      states,
      now.getTime(),
      autoClockOutWindowMs(settings["Auto clock-out after hours"]),
      kioskDate_(now),
      settings["Kiosk launch date"],
      kioskSwitches(settings).milestones,
    ),
    longShiftHours: parseLongShiftHours(settings["Long shift flag hours"]),
    hoursRequests: hoursRequestsMode(settings) !== "off",
    milestones: milestones().map((m) => ({ id: m.id, title: m.title, message: m.message })),
    ...pageSettings(settings),
    serverNow: Date.now(),
  };
}

/**
 * Records a volunteer's request for their hours, from the welcome screen's Request my
 * hours link. id is the list entry tapped and digits
 * the phone's last four or null, read by the check-in rule (resolveVolunteer), so in a
 * same-name group the digits pick who is asking. Returns {ok: true} or a refusal: ACCESS
 * for a wrong code; HOURS_REQUESTS_OFF when Settings "Hours requests" is Off or the Email
 * hours switch is Off (hoursRequestsMode);
 * NOT_FOUND, PHONE_NEEDED, PHONE_WRONG or PHONE_MISSING as for a check-in, with no Flags
 * row, since this isn't a tap; BUSY when the lock isn't free within 10 seconds.
 *
 * Settings come from the same copy a tap uses, so a change of mode applies from the next
 * request. The Hours requests tab is got or made before the lock. Under the lock the call
 * reads that tab and, unless the volunteer already has an open request (waiting, sending
 * or held), appends one row: Requested at now, the name, the hashed Volunteer ID, the mode
 * and Status waiting. Nothing else is read or written under it: no Email cell, no Log, no
 * Flags. The reply is the same for a new request and a repeat, and carries nothing about
 * the volunteer.
 */
function apiRequestHours(code, id, digits) {
  const { settings, denied } = settingsForCode_(code);
  if (denied) return denied;
  const mode = hoursRequestsMode(settings);
  if (mode === "off") return refusal("HOURS_REQUESTS_OFF");
  const found = resolveVolunteer(getProfiles_(settings), id, digits);
  if (found.refusal) return refusal(found.refusal);
  const volunteer = found.volunteer;
  const tab = hoursRequestSheet_();
  return withLock_(() => {
    const requests = readHoursRequests_(tab);
    if (!hoursRequestOpenFor(requests, volunteer.id)) {
      appendHoursRequestRows_(tab, [
        hoursRequestRow({
          requestedMs: Date.now(),
          name: volunteerFullName(volunteer),
          id: volunteer.id,
          mode,
        }),
      ]);
    }
    return { ok: true };
  });
}

/**
 * Every Profiles volunteer's Log state, for the list. With the Log cache off, one read of
 * the whole Log (readLogMiss_). With it on, readLogState_ with every Profiles token: the
 * cached map's states on a hit, the whole Log on a miss. The list stores no map: it holds
 * no lock, so a map it stored could miss a check-out written meanwhile; only the kiosk's
 * locked calls store one.
 */
function listLogStates_(volunteers) {
  if (!logCacheSwitchOn_()) return readLogMiss_([], volunteers).map.states;
  return readLogState_(
    volunteers.map((v) => v.token),
    volunteers,
  ).map.states;
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
 *
 * tap, when given, is a check-in the tablet already showed (readTap, Logic.js), sent with
 * arrivalIso and digits null. The arrival is the server's time less the tap's age, and the
 * new row's Shift ID is the tap's ID. When the volunteer already has a row with that ID,
 * nothing is written and the reply is {ok: true, id, shiftId, arrivedAt, tappedAt,
 * missedSignOut: false, replayed: true}, with that row's times (null when unreadable). A
 * notice the tablet showed that isn't the server's answer is flagged on the new row. A
 * refusal writes one Flags row (raiseTapRefusal_). TAP_UNREADABLE when the tap can't be
 * read, before the lock. ARRIVAL_CHANGES_OFF, before the lock, for a chosen arrival while
 * Settings switch Tablet arrival changes Off.
 */
function apiCheckIn(code, id, arrivalIso, digits, tap) {
  const { settings, denied } = settingsForCode_(code);
  if (denied) return denied;
  if (arrivalMsFromIso(arrivalIso) !== null && !kioskSwitches(settings).arrivalChanges) {
    return refusal("ARRIVAL_CHANGES_OFF");
  }
  const t = readTap(tap, "in");
  if (t && t.unreadable) return refusal("TAP_UNREADABLE");
  const run = logCacheRun_();
  return withLock_(
    () =>
      withLogCacheLine_(run, () => {
        const now = new Date();
        const today = kioskDate_(now);
        const volunteers = getProfiles_(settings);
        const who = resolveVolunteer(volunteers, id, digits);
        if (who.refusal) {
          return refuseTap_(t, "in", who.refusal, findVolunteer(volunteers, id), now.getTime());
        }
        const tokens = [who.volunteer.token];
        let log = kioskLogRead_(run, tokens, volunteers);
        // A later send may find the row its first send wrote, which only the whole Log holds.
        if (t && t.attempt > 1 && log.hit) {
          log = kioskFullRead_(run, tokens, volunteers, "retried tap");
        }
        const arrivedMs = t ? now.getTime() - t.ageMs : arrivalMsFromIso(arrivalIso);
        const input = {
          volunteers,
          id,
          digits,
          todayDate: today,
          nowMs: now.getTime(),
          windowMs: autoClockOutWindowMs(settings["Auto clock-out after hours"]),
          arrivedMs,
          arrivedDate: Number.isFinite(arrivedMs) ? kioskDate_(new Date(arrivedMs)) : "",
          flagMinutes: parseFlagMinutes(settings["Arrival flag minutes"]),
          launchDate: settings["Kiosk launch date"],
          tapShiftId: t ? t.tapId : null,
          shownMissed: t ? t.shown.missedSignOut : null,
        };
        let decision = log.hit
          ? decideCheckIn({ ...input, states: log.map.states })
          : decideCheckIn({ ...input, entries: log.entries });
        if (decision.refusal && log.hit) {
          // A refusal is never answered from the map: read the whole Log and decide again.
          log = kioskFullRead_(run, tokens, volunteers, "refused " + decision.refusal);
          decision = decideCheckIn({ ...input, entries: log.entries });
        }
        if (decision.replay) {
          keepLogMap_(run, log);
          const e = decision.replay;
          return {
            ok: true,
            id: decision.volunteer.id,
            shiftId: t.tapId,
            arrivedAt: isoOrNull_(shiftStartMs(e)),
            tappedAt: isoOrNull_(e.recordedInMs),
            missedSignOut: false,
            replayed: true,
          };
        }
        if (decision.refusal) {
          keepLogMap_(run, log);
          return refuseTap_(t, "in", decision.refusal, who.volunteer, now.getTime());
        }
        const flagPlan = planFlags_(decision.flags);
        const shiftId = t ? t.tapId : Utilities.getUuid();
        const cells = checkInCells(
          decision.volunteer,
          today,
          now.getTime(),
          decision.arrivedMs,
          decision.flags.reduce(appendText, ""),
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
    (reply) => afterTap_(run, settings, reply),
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
 *
 * tap, when given, is a check-out the tablet already showed (readTap, Logic.js), sent with
 * digits and checkOutIso null. It closes the row with the tap's Shift ID when that row was
 * open to the tablet at the tap, stating the server's time less the tap's age. When a
 * kiosk already closed that row, nothing is written and the reply is {ok: true, id,
 * signedOutAt, tappedAt, minutes, milestone: null, replayed: true}, with that row's times
 * and minutes (null when unreadable). A milestone the tablet showed that isn't the
 * server's is flagged on the row. A refusal other than BUSY writes one Flags row
 * (raiseTapRefusal_). TAP_UNREADABLE when the tap can't be read, before the lock.
 * CHECKOUT_CHANGES_OFF, before the lock, for a chosen check-out time while Settings switch
 * Tablet check-out changes Off. The Milestones switch Off means milestone null.
 */
function apiCheckOut(code, id, digits, checkOutIso, tap) {
  const { settings, denied } = settingsForCode_(code);
  if (denied) return denied;
  if (arrivalMsFromIso(checkOutIso) !== null && !kioskSwitches(settings).checkOutChanges) {
    return refusal("CHECKOUT_CHANGES_OFF");
  }
  const t = readTap(tap, "out");
  if (t && t.unreadable) return refusal("TAP_UNREADABLE");
  const run = logCacheRun_();
  return withLock_(
    () =>
      withLogCacheLine_(run, () => {
        const now = new Date();
        const volunteers = getProfiles_(settings);
        const tapped = findVolunteer(volunteers, id);
        const wanted = checkOutTokens(volunteers, id, digits);
        if (wanted.refusal) return refuseTap_(t, "out", wanted.refusal, tapped, now.getTime());
        let log = kioskLogRead_(run, wanted.tokens, volunteers);
        const outMs = t ? now.getTime() - t.ageMs : arrivalMsFromIso(checkOutIso);
        const tapInput = t
          ? { tapShiftId: t.shiftId, atMs: outMs, shownMilestone: t.shown.milestoneId }
          : {};
        const input = {
          volunteers,
          id,
          digits,
          todayDate: kioskDate_(now),
          nowMs: now.getTime(),
          windowMs: autoClockOutWindowMs(settings["Auto clock-out after hours"]),
          outMs,
          outDate: Number.isFinite(outMs) ? kioskDate_(new Date(outMs)) : "",
          flagMinutes: parseFlagMinutes(settings["Check-out flag minutes"]),
          longShiftHours: parseLongShiftHours(settings["Long shift flag hours"]),
          launchDate: settings["Kiosk launch date"],
          milestonesOn: kioskSwitches(settings).milestones,
          ...tapInput,
        };
        let planned = null;
        if (log.hit) {
          const hit = checkOutOnHit_(input, log);
          if (hit.why) log = kioskFullRead_(run, wanted.tokens, volunteers, hit.why);
          else planned = hit;
        }
        if (!planned) {
          const decision = decideCheckOut({ ...input, entries: log.entries });
          if (decision.replay) {
            keepLogMap_(run, log);
            const e = decision.replay;
            const hours = hoursCell(e.statedHours);
            return {
              ok: true,
              id: decision.volunteer.id,
              signedOutAt: isoOrNull_(e.statedOutMs),
              tappedAt: isoOrNull_(e.recordedOutMs),
              minutes: isFinite(hours) ? minutesFromHours(hours) : null,
              milestone: null,
              replayed: true,
            };
          }
          if (decision.refusal) {
            keepLogMap_(run, log);
            return refuseTap_(t, "out", decision.refusal, tapped, now.getTime());
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
            // The Log changed under the call, so the map its read built is not stored.
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
    (reply) => afterTap_(run, settings, reply),
  );
}

/**
 * Changes the arrival of a volunteer's open shift, from Change on the tablet's check-out
 * screen. id and digits are as for apiCheckOut, and who it is is found by the check-out's
 * rule (checkOutTokens). shiftId is the open row's Shift ID the screen showed, fromIso the
 * start it showed and arrivalIso the new arrival. Returns {ok: true, id, shiftId,
 * arrivedAt, changed} or a refusal: ACCESS, then ARRIVAL_CHANGES_OFF while Settings switch
 * Tablet arrival changes Off, before the lock; then, under it, NOT_FOUND, a
 * phone refusal, NOT_IN, ARRIVAL_ROW_CHANGED, ARRIVAL_UNCHANGEABLE, ARRIVAL_OTHER_DAY,
 * ARRIVAL_FUTURE or ARRIVAL_AFTER_CHECK_IN, in decideArrivalChange's order (Logic.js);
 * BUSY when the lock isn't free within 10 seconds, or when the row read again just before
 * the write isn't the one decided on. changed is false when the arrival was already the
 * row's start, and nothing is written then.
 *
 * A Change is never decided from the cached log map: the call always reads the whole Log
 * for the volunteer's rows, which costs about a second at the Log's size and is fine for
 * a rare call. With the Log cache on it removes the map just before the write and stores
 * none after it, so the next kiosk call reads the whole Log once. It writes only that
 * row's Check-In Stated, and Admin Alerts? when the new arrival is flagged, then that
 * flag's one Flags row (Source kiosk arrival change), with the Flags plan made before the
 * Log write, as a check-out does. Check-In Recorded is never written. No Email cell and no
 * other tab is read.
 */
function apiChangeArrival(code, id, digits, shiftId, fromIso, arrivalIso) {
  const { settings, denied } = settingsForCode_(code);
  if (denied) return denied;
  if (!kioskSwitches(settings).arrivalChanges) return refusal("ARRIVAL_CHANGES_OFF");
  const run = logCacheRun_();
  return withLock_(
    () =>
      withLogCacheLine_(run, () => {
        const now = new Date();
        const volunteers = getProfiles_(settings);
        const wanted = checkOutTokens(volunteers, id, digits);
        if (wanted.refusal) return refusal(wanted.refusal);
        run.on = logCacheSwitchOn_();
        let log;
        if (run.on) {
          run.line = "full read (arrival change)";
          log = readLogMiss_(wanted.tokens, volunteers);
        } else {
          run.line = "off";
          log = readLogTable_(wanted.tokens);
        }
        const fromMs = arrivalMsFromIso(fromIso);
        const arrivedMs = arrivalMsFromIso(arrivalIso);
        const decision = decideArrivalChange({
          volunteers,
          id,
          digits,
          entries: log.entries,
          todayDate: kioskDate_(now),
          nowMs: now.getTime(),
          windowMs: autoClockOutWindowMs(settings["Auto clock-out after hours"]),
          shiftId,
          fromMs: fromMs === null ? NaN : fromMs,
          arrivedMs: arrivedMs === null ? NaN : arrivedMs,
          flagMinutes: parseFlagMinutes(settings["Arrival flag minutes"]),
          dateOf: (ms) => kioskDate_(new Date(ms)),
          clockOf: (ms) => zoneClock_(new Date(ms), kioskTimeZone()),
        });
        if (decision.refusal) {
          keepLogMap_(run, log);
          return refusal(decision.refusal);
        }
        const reply = {
          ok: true,
          id: decision.volunteer.id,
          shiftId: tapShiftId(decision.open.shiftId),
          arrivedAt: new Date(decision.arrivedMs).toISOString(),
          changed: decision.changed,
        };
        if (!decision.changed) {
          keepLogMap_(run, log);
          return reply;
        }
        const reasons = decision.alert ? [decision.alert] : [];
        const flagPlan = planFlags_(reasons);
        // Staff may sort, insert or delete Log rows, or edit this one, while the call runs.
        // Read the row again, last before the write, and write only if it is still the open
        // row decided on, with the same start; else BUSY, and a retry reads the Log again.
        const openId = decision.open.shiftId;
        const current = readLogRowAt_(decision.row, log.width, log.cols, logRead_(), openId);
        if (!autoClockOutRowUnchanged(decision.open, current)) {
          console.error(
            "Arrival change: Log row " +
              decision.row +
              " no longer holds open Shift ID " +
              cellString(openId) +
              " as read; answered BUSY and wrote nothing.",
          );
          return refusal("BUSY");
        }
        // The cells come from the row just read, so Admin Alerts? keeps what it holds now.
        const cells = arrivalChangeCells(current, decision.arrivedMs, decision.alert);
        if (run.on) {
          forgetLogMap_();
          run.why = "an arrival change stores no map";
        }
        updateLogRow_(decision.row, cells, log.cols, { kiosk: true });
        raiseFlags_(
          {
            date: rowDate(current.dateText),
            name: current.name,
            shiftId: cellString(openId),
            raisedAtMs: now.getTime(),
            source: flagSources().arrivalChange,
            logRow: decision.row,
          },
          reasons,
          flagPlan,
        );
        return reply;
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
 * Name and Date. A tapped check-out passes its tap in input; the map holds the row it
 * names only while that row is open, so a row already closed is NOT_IN here and is found
 * on the whole Log.
 */
function checkOutOnHit_(input, log) {
  const first = decideCheckOut({ ...input, states: log.map.states });
  if (first.replay) return { why: "replay" };
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

/** ms as an ISO time, or null when it isn't a finite number. */
function isoOrNull_(ms) {
  return typeof ms === "number" && isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * The refusal of code; for a tapped save (t from readTap), first the Flags row of
 * raiseTapRefusal_. volunteer is the Profiles volunteer the tap named, or null.
 */
function refuseTap_(t, kind, code, volunteer, nowMs) {
  if (t) raiseTapRefusal_(t, kind, code, volunteer, nowMs);
  return refusal(code);
}

/**
 * One Flags row for a tapped save the server refused, after the tablet showed it saved,
 * under the call's lock and before the refusal is returned; no Log cell is written. Date
 * is the kiosk date of the tap, Name the Profiles name when the volunteer was found,
 * else the name the tablet sent; Shift ID the tap's ID for a check-in and the row it named
 * for a check-out; Log Row blank. The reason is tapRefusalReason (Logic.js). BUSY is
 * retried and ACCESS keeps the save on the tablet, so neither is flagged. A broken Flags
 * tab is logged and never changes the reply (raiseFlags_).
 */
function raiseTapRefusal_(t, kind, code, volunteer, nowMs) {
  if (code === "BUSY" || code === "ACCESS" || code === "TAP_UNREADABLE") return;
  const tapAt = new Date(nowMs - t.ageMs);
  const reasons = [tapRefusalReason(kind, clockLabel(zoneClock_(tapAt, kioskTimeZone())), code)];
  raiseFlags_(
    {
      date: kioskDate_(tapAt),
      name: volunteer ? volunteerFullName(volunteer) : t.name,
      shiftId: kind === "in" ? t.tapId : t.shiftId,
      raisedAtMs: nowMs,
      source: kind === "in" ? flagSources().checkIn : flagSources().checkOut,
      logRow: null,
    },
    reasons,
    planFlags_(reasons),
  );
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
 * Every refusal comes after such a read: a refusal on a hit is decided again on one. A
 * check-out's BUSY is the exception: the Log changed under that call, so its map is known
 * not to match the sheet and it stores nothing.
 */
function keepLogMap_(run, log) {
  if (run.on) run.put = log.map;
}

/**
 * withLock_'s after for a check-in or check-out, once the lock's flush is through: the log
 * map (fillLogMap_), then, for a reply that wrote a save, the time zone compare
 * (compareTimeZones_, Sheets.js), which writes the Time zone problem row only when its
 * text changes. Coming after the flush, it reads nothing between the Log write and it.
 */
function afterTap_(run, settings, reply) {
  try {
    fillLogMap_(run);
  } finally {
    if (reply && reply.ok && !reply.replayed) compareTimeZones_(settings);
  }
}

/** After the flush: stores run's map when the switch read on and the call has one to store. */
function fillLogMap_(run) {
  if (!run.on || (!run.put && !run.why)) return;
  putLogMap_(run.put, run.why);
}

/**
 * The ACCESS refusal, then ZONE_NOT_SET while the Time zone row is blank or isn't a time
 * zone (zoneRefusal, Logic.js), or null when the code is right and the kiosk has a zone.
 * settings are the Settings the call already read; without them this reads Settings
 * itself. Runs before any lock is taken, so calls without the code never hold the lock or
 * make the tablet's call return BUSY. A refused code waits one second. There is no
 * lockout: a lockout would let anyone with the link lock the real tablet out.
 */
function accessRefusal_(code, settings) {
  const s = settings || readSettings_();
  if (!checkAccessCode(code, s["Kiosk access code"])) return zoneRefusal(s);
  Utilities.sleep(1000);
  return refusal("ACCESS");
}

/**
 * {settings} when code is the kiosk access code and the kiosk has a time zone, else
 * {denied: the ACCESS or ZONE_NOT_SET refusal (accessRefusal_)}, for a
 * check-in or check-out, before any lock. Settings come from cachedSettings_ (Sheets.js).
 * A code the cached copy doesn't accept is checked again against Settings read from the
 * tab, which also refreshes the copy: a code changed since the copy was read works at
 * once, and a code is refused only after this call has read the tab.
 */
function settingsForCode_(code) {
  const first = cachedSettings_();
  if (!checkAccessCode(code, first.settings["Kiosk access code"])) {
    const zone = zoneRefusal(first.settings);
    return zone ? { denied: zone } : { settings: first.settings };
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
