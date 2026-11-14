/**
 * The Kiosk admin menu in the Check-In Log spreadsheet: Add a shift for a volunteer who
 * forgot to check in and out, Fix a sign-out for an open row whose volunteer forgot to
 * check out, Remove a shift to move one Log row, found by its Shift ID, to the Removed
 * shifts tab, and Restore a shift to put one back. Each item opens a dialog from
 * AdminDialog.html, which calls the admin* functions below through google.script.run. The
 * menu's other items follow the same rule: Monthly report (Reports.js), Email hours (below:
 * adminHoursPreview and adminSendHours), Import past hours (Import.js), Refresh Hours
 * (refreshHoursNow, Reports.js) and Check the Log now (checkLogNow, Jobs.js). Refresh Hours and Check the Log now open no dialog, so they need
 * no key: they check requireEditorRun_ and SpreadsheetApp.getUi() before they read
 * anything.
 *
 * The menu and google.script.run can only call public names (no trailing _), so the
 * kiosk page could name these functions too. Every public function here therefore checks
 * two things before it reads or writes anything (tests/admin.test.mjs holds every public
 * function to this):
 *   1. requireEditorRun_(): the person at the sheet runs it under their own account. An
 *      anonymous web-app caller is refused.
 *   2. A dialog key. The openers make one only after SpreadsheetApp.getUi() works (it
 *      throws anywhere but the spreadsheet's own UI), keep it in the script cache, and put
 *      it only into the dialog's HTML. No function returns a key. Every admin* function
 *      takes the key first and refuses with ADMIN_EXPIRED when the cache doesn't hold it.
 *      Check 1 alone would let the script owner's own browser through the web app; the
 *      key closes that.
 * onOpen runs as a simple trigger, where requireEditorRun_ can't pass. It calls getUi()
 * first and adds the menu before anything else: getUi() throws outside the spreadsheet's
 * own UI, so a call from the web app stops there, and a failure in what follows never costs
 * the menu. Then, in a try/catch, it notes on the Hours tab that opening didn't refresh it
 * (noteHoursOnOpen_ in Reports.js: one hold of the document lock, N1 and B1 only, no Log
 * read), and releases the lock in its own finally.
 *
 * The rules themselves are in Logic.js (decideAddShift, decideFixSignOut, decideRemove,
 * decideRestore); this file reads and writes the Log, the Removed shifts tab and the Flags
 * tab through Sheets.js, under the kiosk's lock.
 */

/**
 * Adds the Kiosk admin menu when the spreadsheet opens, then notes on the Hours tab that
 * opening didn't refresh it. From the web app it throws at getUi.
 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("Kiosk admin")
    .addItem("Add a shift…", "openAddShiftDialog")
    .addItem("Fix a sign-out…", "openFixSignOutDialog")
    .addItem("Remove a shift…", "openRemoveShiftDialog")
    .addItem("Restore a shift…", "openRestoreShiftDialog")
    .addItem("Monthly report…", "openMonthlyReportDialog")
    .addItem("Email hours…", "openEmailHoursDialog")
    .addItem("Import past hours…", "openImportDialog")
    .addItem("Refresh Hours", "refreshHoursNow")
    .addItem("Check the Log now", "checkLogNow")
    .addToUi();
  const hold = hoursHold_();
  try {
    noteHoursOnOpen_(hold);
  } catch (err) {
    console.log("Hours note (open) failed: " + hoursMessage_(err));
  } finally {
    releaseHoursLock_(hold);
  }
}

function openAddShiftDialog() {
  openAdminDialog_("add", "Add a shift");
}

function openFixSignOutDialog() {
  openAdminDialog_("fix", "Fix a sign-out");
}

function openRemoveShiftDialog() {
  openAdminDialog_("remove", "Remove a shift");
}

function openRestoreShiftDialog() {
  openAdminDialog_("restore", "Restore a shift");
}

function openEmailHoursDialog() {
  openAdminDialog_("email", "Email volunteers their hours", 720);
}

/** {ok: true, today, volunteers: [{id, label}]} for the volunteer picker, or a refusal. */
function adminRoster(key) {
  const denied = adminGuard_(key);
  if (denied) return denied;
  return {
    ok: true,
    today: centralDate_(new Date()),
    volunteers: adminRosterLabels(getProfiles_(readSettings_())),
  };
}

/** {ok: true, shifts: [{shiftId, label}]}: every open row with a Shift ID, newest first. */
function adminOpenShifts(key) {
  const denied = adminGuard_(key);
  if (denied) return denied;
  return { ok: true, shifts: openShiftChoices(readLog_(readLogColumns_()), adminClock_) };
}

/**
 * Adds a closed shift for a volunteer. form is {id, date, inTime, outTime, note,
 * initials}: date yyyy-MM-dd and times HH:mm, Central. {ok: true, row, name, hours} or a
 * refusal.
 */
function adminAddShift(key, form) {
  const denied = adminGuard_(key);
  if (denied) return denied;
  const f = form || {};
  return withLock_(() => {
    const now = new Date();
    const cols = readLogColumns_();
    const at = (time) => timeOnDate_(f.date, time);
    const inTime = at(f.inTime);
    const outTime = at(f.outTime);
    const decision = decideAddShift({
      volunteers: getProfiles_(readSettings_()),
      id: f.id,
      entries: readLog_(cols),
      todayDate: centralDate_(now),
      nowMs: now.getTime(),
      date: f.date,
      inMs: inTime.ms,
      inDate: inTime.date,
      outMs: outTime.ms,
      outDate: outTime.date,
      initials: f.initials,
      note: f.note,
      shiftId: Utilities.getUuid(),
    });
    if (decision.refusal) return adminRefusal_(decision);
    const row = appendLogRow_(decision.cells, cols);
    return {
      ok: true,
      row,
      name: volunteerFullName(decision.volunteer),
      hours: decision.hours,
    };
  });
}

/**
 * Closes an open row found by its Shift ID. form is {shiftId, outTime, note, initials};
 * the time is on the row's own Date. {ok: true, row, name, hours} or a refusal.
 */
function adminFixSignOut(key, form) {
  const denied = adminGuard_(key);
  if (denied) return denied;
  const f = form || {};
  return withLock_(() => {
    const now = new Date();
    const cols = readLogColumns_();
    const entries = readLog_(cols);
    const rows = openRowsById(entries, f.shiftId);
    const outTime = timeOnDate_(rows.length ? rowDate(rows[0].dateText) : "", f.outTime);
    const decision = decideFixSignOut({
      entries,
      shiftId: f.shiftId,
      nowMs: now.getTime(),
      outMs: outTime.ms,
      outDate: outTime.date,
      initials: f.initials,
      note: f.note,
    });
    if (decision.refusal) return adminRefusal_(decision);
    updateLogRow_(decision.open.row, decision.cells, cols);
    return {
      ok: true,
      row: decision.open.row,
      name: decision.open.name,
      hours: decision.hours,
    };
  });
}

/**
 * Remove a shift's list of rows: {ok: true, shifts: [{shiftId, row, label, detail}]}, or a
 * refusal. query is {shiftId} (the rows with that Shift ID) or {id, date} (that
 * volunteer's rows on that yyyy-MM-dd Date). Rows with no Shift ID aren't listed: the menu
 * acts by Shift ID, so staff delete such a row by hand. Reads only, and takes no lock.
 */
function adminFindShifts(key, query) {
  const denied = adminGuard_(key);
  if (denied) return denied;
  const q = query || {};
  const cols = readLogColumns_();
  const shiftId = cellString(q.shiftId);
  let rows;
  if (shiftId) {
    rows = logShiftIdRows_(cols, shiftId);
  } else {
    const volunteer = findVolunteer(getProfiles_(readSettings_()), q.id);
    if (!volunteer) return refusal("ADMIN_NOT_FOUND");
    const date = cellString(q.date);
    if (!date || parseStartDate(date) !== date) return refusal("ADMIN_BAD_TIME");
    rows = readLogTable_(volunteer.token)
      .entries.filter((e) => rowDate(e.dateText) === date && cellString(e.shiftId))
      .map((e) => e.row);
  }
  return { ok: true, shifts: shiftChoices_(readShiftRows_(rows, cols)) };
}

/**
 * Moves one Log row to the Removed shifts tab. form is {shiftId, row, reason, initials}:
 * row is the Log row the dialog showed, which picks among rows that share the Shift ID.
 * The row's Flags rows are ticked Reviewed (markShiftFlags_). {ok: true, name, date,
 * flagsMarked, flagsLeft, flagsFailed} or a refusal: flagsLeft counts the flags left for
 * another row that still has the Shift ID, and flagsFailed is true when the Flags step
 * threw after the row was moved, which is logged.
 */
function adminRemoveShift(key, form) {
  const denied = adminGuard_(key);
  if (denied) return denied;
  const f = form || {};
  return withLock_(() => {
    const now = new Date();
    const shiftId = cellString(f.shiftId);
    const log = sheet_(LOG_TAB);
    const logHeader = logHeaderRow_(log);
    const cols = logColumns(logHeader);
    const candidates = shiftId ? readShiftRows_(logShiftIdRows_(cols, shiftId), cols) : [];
    const decision = decideRemove({
      candidates,
      shiftId,
      row: f.row,
      reason: f.reason,
      initials: f.initials,
      logHeader,
    });
    if (decision.refusal) return adminRefusal_(decision);
    const target = decision.target;
    const removed = removedSheet_(logHeader);
    const removedRow = appendRemovedRow_(
      removed,
      logHeader,
      target.values,
      target.formats,
      decision.initials,
      decision.reason,
      now.getTime(),
    );
    SpreadsheetApp.flush();
    const idCell = log.getRange(target.row, cols[logHeaderNames().shiftId] + 1).getValues();
    if (cellText_(idCell[0][0]) !== shiftId) {
      removed.sheet.deleteRow(removedRow);
      return refusal("ADMIN_REMOVE_MOVED");
    }
    deleteLogRow_(target.row);
    const flags = markFlagsSafely_(shiftId, {
      tick: true,
      initials: decision.initials,
      note: removeFlagNote(decision.initials, decision.reason, centralDate_(now)),
      only: {
        row: target.row,
        date: target.entry.dateText,
        name: target.entry.name,
        remaining: decision.remaining,
      },
    });
    return {
      ok: true,
      name: target.entry.name,
      date: rowDate(target.entry.dateText) || target.entry.dateText,
      flagsMarked: flags.marked,
      flagsLeft: flags.left,
      flagsFailed: flags.failed,
    };
  });
}

/**
 * Restore a shift's list: {ok: true, shifts: [{shiftId, row, label, detail}]}, the
 * Removed shifts rows that have a Shift ID, newest Removed at first. No tab lists none.
 */
function adminRemovedShifts(key) {
  const denied = adminGuard_(key);
  if (denied) return denied;
  const removed = readRemoved_();
  if (!removed) return { ok: true, shifts: [] };
  const at = (r) => (isFinite(r.entry.removedAtMs) ? r.entry.removedAtMs : -Infinity);
  const rows = removed.rows
    .filter((r) => cellString(r.entry.shiftId))
    .sort((a, b) => at(b) - at(a) || b.row - a.row);
  return { ok: true, shifts: shiftChoices_(rows) };
}

/**
 * Puts a Removed shifts row back at the end of the Log, mapped by header, and deletes it
 * from the Removed tab. form is {shiftId, row, initials}. The Shift ID's Flags rows get a
 * note and are otherwise left as they are. {ok: true, name, date, logRow, flagsFailed} or
 * a refusal.
 */
function adminRestoreShift(key, form) {
  const denied = adminGuard_(key);
  if (denied) return denied;
  const f = form || {};
  return withLock_(() => {
    const now = new Date();
    const shiftId = cellString(f.shiftId);
    const removed = readRemoved_();
    const logHeader = logHeaderRow_(sheet_(LOG_TAB));
    const cols = logColumns(logHeader);
    const candidates =
      removed && shiftId ? removed.rows.filter((r) => cellString(r.entry.shiftId) === shiftId) : [];
    const picked = pickShiftRow(candidates, f.row);
    const tokenEntries =
      picked && isStatus(picked.entry, "open") ? readLogTable_(picked.entry.token).entries : [];
    const decision = decideRestore({
      candidates,
      shiftId,
      row: f.row,
      initials: f.initials,
      logShiftIds: readLogShiftIds_(cols),
      tokenEntries,
      removedHeader: removed ? removed.header : [],
      logHeader,
    });
    if (decision.refusal) return adminRefusal_(decision);
    const target = decision.target;
    const idAt = logHeaderIndexes(removed.header, logHeaderNames().shiftId)[0];
    const idCell = removed.sheet.getRange(target.row, idAt + 1).getValues();
    if (cellText_(idCell[0][0]) !== shiftId) return refusal("ADMIN_RESTORE_MOVED");
    const fromHeader = removed.header.map((h) => (isRemovedExtraHeader(h) ? "" : h));
    const width = logHeader.length;
    const logRow = appendLogValues_(
      headerMapCopy(fromHeader, target.values, logHeader, width),
      headerMapCopy(fromHeader, target.formats, logHeader, width),
      cols,
    );
    removed.sheet.deleteRow(target.row);
    const flags = markFlagsSafely_(shiftId, {
      tick: false,
      note: restoreFlagNote(decision.initials, centralDate_(now)),
    });
    return {
      ok: true,
      name: target.entry.name,
      date: rowDate(target.entry.dateText) || target.entry.dateText,
      logRow,
      flagsFailed: flags.failed,
    };
  });
}

/**
 * The Email hours… preview of the ticked volunteers. request is {ids, choice, attach}: ids
 * are deduplicated, choice is "this" or "last" (anything else is "this") and attach is
 * true or false. Reads once for the set, with no lock: Settings, the volunteer list, the
 * addresses (profileEmails_), the Log, Flags, the Hours emails tab's sends and the quota.
 * Returns {ok: true, from, month, asOf, volunteers: [{id, label, profilesRow, startDate,
 * to, subject, body, totals, attachment, warnings, problems, lastSent}], setProblems,
 * sendIds, chunkSize, ticket}, the volunteers in roster order; or a refusal.
 *
 * A volunteer with a problem (hoursEmailAddress, or not on the list) is shown and left out.
 * A problem for the whole set (no Email column, Hours email contact blank, nobody left to
 * send, the quota short) means no ticket (""). Otherwise one ticket goes in the script
 * cache for the sendable volunteers, kept as long as a dialog key, and its id comes back.
 */
function adminHoursPreview(key, request) {
  const denied = adminGuard_(key);
  if (denied) return denied;
  const r = request || {};
  const ids = hoursEmailIds(r.ids);
  const attach = r.attach === true;
  const now = new Date();
  const account = Session.getActiveUser().getEmail();
  const base = readHoursEmailBase_(ids, hoursEmailChoice(r.choice), attach, now);
  let sends = null;
  let sendsRead = true;
  try {
    sends = readHoursEmailSends_();
  } catch (err) {
    sendsRead = false;
    console.log("Hours emails not read: " + errorMessage_(err));
  }
  const quota = MailApp.getRemainingDailyQuota();

  const roster = adminRosterLabels(base.volunteers);
  const order = new Map(roster.map((v, i) => [v.id, i]));
  const labels = new Map(roster.map((v) => [v.id, v.label]));
  const at = (b) => (order.has(b.id) ? order.get(b.id) : roster.length);
  const built = ids
    .map((id, i) => Object.assign(hoursEmailBuild_(base, id), { asked: i }))
    .sort((a, b) => at(a) - at(b) || a.asked - b.asked);
  const sendable = built.filter((b) => !b.problem);

  const setProblems = hoursEmailSetProblems_(base);
  const noColumn = hoursEmailProblemText("no-email-column");
  if (!sendable.length && setProblems.indexOf(noColumn) < 0) {
    setProblems.push(hoursEmailNoneProblem());
  }
  const quotaProblem = hoursEmailQuotaProblem(sendable.length, quota);
  if (quotaProblem) setProblems.push(quotaProblem);

  let ticket = "";
  if (!setProblems.length) {
    ticket = Utilities.getUuid();
    const entries = {};
    sendable.forEach((b) => {
      entries[b.id] = {
        digest: b.digest,
        name: volunteerFullName(b.volunteer),
        label: labels.get(b.id) || volunteerFullName(b.volunteer),
        to: b.address.email,
      };
    });
    const stored = hoursEmailTicket({
      sendId: Utilities.getUuid().replace(/-/g, "").slice(0, 8),
      expiresMs: now.getTime() + adminKeySeconds() * 1000,
      choice: base.period.choice,
      month: base.period.month,
      asOf: base.period.asOf,
      attach,
      entries,
    });
    CacheService.getScriptCache().put(
      hoursEmailTicketKey(ticket),
      JSON.stringify(stored),
      adminKeySeconds(),
    );
  }

  return {
    ok: true,
    from: hoursEmailFromLine(account),
    month: base.period.month,
    asOf: base.period.asOf,
    volunteers: built.map((b) => {
      const v = b.volunteer;
      const plan = b.plan;
      return {
        id: b.id,
        label: labels.get(b.id) || "Not on the volunteer list",
        profilesRow: b.address && b.address.row ? b.address.row : v ? v.row : 0,
        startDate: v ? v.startDate || "" : "",
        to: b.problem ? "" : b.address.email,
        subject: b.message ? b.message.subject : "",
        body: b.message ? b.message.body : "",
        totals: plan
          ? {
              month: plan.month,
              year: plan.year,
              all: plan.all,
              paperHundredths: plan.paperHundredths,
              lines: hoursEmailTotalLines(plan),
            }
          : null,
        attachment: b.file
          ? { name: hoursEmailFileName(base.period.asOf), shifts: plan.all.shifts }
          : null,
        warnings: plan ? plan.warnings : [],
        problems: b.problem ? [b.problemText] : [],
        lastSent: sendsRead ? hoursEmailLastSent(sends || [], b.id) : "unknown",
      };
    }),
    setProblems,
    sendIds: sendable.map((b) => b.id),
    chunkSize: hoursEmailChunkSize(),
    ticket,
  };
}

/**
 * Sends the emails of up to hoursEmailChunkSize() volunteers of a preview's ticket.
 * request is {ticket, ids, initials}. Returns {ok: true, results: [{id, result}],
 * recordFailed}, one result per id in the call's order, or a refusal: ADMIN_INITIALS or
 * HOURS_EMAIL_TOO_MANY before anything is taken, BUSY when the lock isn't free to take, and
 * HOURS_EMAIL_STALE when the ticket is gone or past its time.
 *
 * The rules it keeps:
 * 1. Every entry the call takes from the ticket is in exactly one Hours emails row, written
 *    by this call at the end, whatever happened after the take. A row is built from the
 *    ticket, the entry and the call's own values, never from a read at Send.
 * 2. The ticket in the cache decides. An id whose entry it no longer holds gets "not sent:
 *    … already sent for them", with no mail and no row; a missing ticket refuses the call.
 * 3. Nothing is taken before the take's write returns; once something is taken, the call
 *    doesn't throw: reads, the rebuild and the send run inside a try, and the rows are
 *    written on every path.
 * 4. One volunteer's failure never stops the rest. A read that throws becomes the result
 *    of every volunteer taken, and nothing is sent.
 * 5. The lock is held only to take (step 3) and to write the rows (step 6), never across a
 *    read of the Log or a send.
 * 6. Every withLock_ return is read as a refusal or a success, and a throw from it (its
 *    flush or release, after the work) is read against what the work had already done.
 */
function adminSendHours(key, request) {
  const denied = adminGuard_(key);
  if (denied) return denied;
  const r = request || {};
  // 1. Initials. Nothing is taken.
  const initials = normalizeInitials(r.initials);
  if (!initials) return refusal("ADMIN_INITIALS");
  // 2. The ids and the account. Nothing is taken; a throw here goes back as it is.
  const ids = hoursEmailIds(r.ids);
  if (ids.length > hoursEmailChunkSize()) return refusal("HOURS_EMAIL_TOO_MANY");
  const account = Session.getActiveUser().getEmail();
  const ticketKey = hoursEmailTicketKey(r.ticket);
  const R = hoursEmailResults();

  // 3. The take, under the lock. took is set only once the cache write has returned.
  let took = null;
  let held;
  try {
    held = withLock_(() => {
      const cache = CacheService.getScriptCache();
      const nowMs = Date.now();
      const ticket = hoursEmailTicketRead(ticketKey ? cache.get(ticketKey) : null, nowMs);
      if (!ticket) return refusal("HOURS_EMAIL_STALE");
      const split = hoursEmailTake(ticket, ids, nowMs);
      if (split.taken.length) {
        if (split.rest) cache.put(ticketKey, JSON.stringify(split.rest), split.seconds);
        else cache.remove(ticketKey);
      }
      took = { ticket, taken: split.taken };
      return { ok: true };
    });
  } catch (err) {
    if (!took) throw err;
    console.error(
      "Hours email: the lock ended with an error after the take (Send ID " +
        took.ticket.sendId +
        "): " +
        errorMessage_(err),
    );
  }
  if (!took) return held;

  const ticket = took.ticket;
  const results = {};
  let recordFailed = false;
  if (took.taken.length) {
    const takenIds = took.taken.map((t) => t.id);
    const settle = (id, result, totals, reason) => {
      results[id] = { result, totals: totals || null, reason: reason || "" };
      console.log(hoursEmailLogLine(id, result, reason));
    };
    // 4 and 5. Reads, then each volunteer, inside one try.
    try {
      const base = readHoursEmailBase_(takenIds, ticket.choice, ticket.attach === true, new Date());
      const setProblems = hoursEmailSetProblems_(base);
      if (setProblems.length) {
        takenIds.forEach((id) => settle(id, "not sent: " + setProblems[0]));
      } else {
        took.taken.forEach(({ id, entry }) => {
          try {
            const b = hoursEmailBuild_(base, id);
            if (b.problem) return settle(id, "not sent: " + b.problemText, null, b.problem);
            if (b.digest !== entry.digest) return settle(id, R.changed);
            const totals = {
              month: b.plan.month.hundredths,
              year: b.plan.year.hundredths,
              all: b.plan.all.hundredths,
            };
            const mail = {
              to: b.address.email,
              subject: b.message.subject,
              body: b.message.body,
              name: flagsEmailSenderName(),
              noReply: true,
            };
            if (b.file) {
              mail.attachments = [
                Utilities.newBlob(b.csv, "text/csv", hoursEmailFileName(base.period.asOf)),
              ];
            }
            if (!(MailApp.getRemainingDailyQuota() >= 1)) return settle(id, R.quota);
            try {
              MailApp.sendEmail(mail);
            } catch (err) {
              return settle(id, "failed: " + errorMessage_(err), totals);
            }
            return settle(id, R.sent, totals);
          } catch (err) {
            if (!results[id]) settle(id, "not sent: " + errorMessage_(err));
          }
        });
      }
    } catch (err) {
      takenIds.forEach((id) => {
        if (!results[id]) settle(id, "not sent: " + errorMessage_(err));
      });
    }

    // 6. The rows, one per taken entry, in one write under the lock, on every path.
    let wrote = false;
    let failure = "";
    try {
      const sentAtMs = Date.now();
      const rows = took.taken.map(({ id, entry }) =>
        hoursEmailRow({
          sentAtMs,
          sendId: ticket.sendId,
          name: entry.name,
          id,
          to: entry.to,
          month: ticket.month,
          asOf: ticket.asOf,
          attach: ticket.attach === true,
          initials,
          account,
          result: results[id].result,
          totals: results[id].totals,
        }),
      );
      const done = withLock_(() => {
        appendHoursEmailRows_(rows);
        wrote = true;
        return { ok: true };
      });
      if (!done || done.ok !== true) failure = (done && done.message) || "no reply";
    } catch (err) {
      if (wrote) {
        console.error(
          "Hours emails: rows written for Send ID " +
            ticket.sendId +
            ", then the lock ended with an error: " +
            errorMessage_(err),
        );
      } else {
        failure = errorMessage_(err);
      }
    }
    if (failure) {
      recordFailed = true;
      console.error(
        "Hours emails: rows not written for Send ID " +
          ticket.sendId +
          " (" +
          failure +
          "). Type them in by hand: " +
          takenIds
            .map((id) => {
              const res = results[id];
              const said = res.reason ? "not sent: " + res.reason : hoursEmailLogText(res.result);
              return "volunteer " + id + ": " + said;
            })
            .join("; "),
      );
    }
  }

  // 7. One result per id of the call, in its order.
  return {
    ok: true,
    results: ids.map((id) => ({ id, result: results[id] ? results[id].result : R.taken })),
    recordFailed,
  };
}

/**
 * The reads Email hours… makes once per call, with no lock, for the volunteers ids names:
 * Settings, the volunteer list, those volunteers' addresses, the Log as report entries and
 * the Flags rows (null when that read throws), with the period worked out from now.
 */
function readHoursEmailBase_(ids, choice, attach, now) {
  const settings = readSettings_();
  const volunteers = getProfiles_(settings);
  const found = ids.map((id) => findVolunteer(volunteers, id)).filter((v) => v);
  const emails = found.length ? profileEmails_(settings, found) : {};
  const entries = readReportLog_().entries;
  let flags = null;
  try {
    flags = readFlags_().rows;
  } catch (err) {
    console.log("Flags not read for the hours email: " + errorMessage_(err));
    flags = null;
  }
  const todayDate = centralDate_(now);
  return {
    volunteers,
    emails,
    entries,
    flags,
    todayDate,
    period: hoursEmailPeriod(choice, todayDate),
    attach: attach === true,
    listedTokens: volunteers.map((v) => v.token),
    contact: settings[hoursEmailContactSetting()] || "",
    signature: settings[hoursEmailSignatureSetting()] || "",
  };
}

/** The problems that stop the whole set: no Email column, Hours email contact blank. */
function hoursEmailSetProblems_(base) {
  const problems = [];
  const noColumn = Object.keys(base.emails).some(
    (id) => base.emails[id].problem === "no-email-column",
  );
  if (noColumn) problems.push(hoursEmailProblemText("no-email-column"));
  if (cellString(base.contact) === "") problems.push(hoursEmailContactProblem());
  return problems;
}

/**
 * One volunteer's email as the preview shows it and the send rebuilds it: {id, volunteer,
 * address, problem, problemText, plan, message, file, csv, digest}. A volunteer not on the
 * list has problem not-found and no plan. file is whether the email carries the shifts
 * file (the box ticked and at least one counted shift); csv is "" without it. digest is ""
 * with a problem.
 */
function hoursEmailBuild_(base, id) {
  const volunteer = findVolunteer(base.volunteers, id);
  if (!volunteer) {
    return {
      id,
      volunteer: null,
      address: null,
      problem: "not-found",
      problemText: hoursEmailProblemText("not-found"),
      plan: null,
      message: null,
      file: false,
      csv: "",
      digest: "",
    };
  }
  const address = base.emails[volunteer.id] || {
    email: "",
    row: 0,
    problem: "not-found",
    text: hoursEmailProblemText("not-found"),
  };
  const plan = hoursEmailPlan({
    volunteer,
    entries: base.entries,
    flags: base.flags,
    period: base.period,
    todayDate: base.todayDate,
    listedTokens: base.listedTokens,
    attach: base.attach,
  });
  const message = hoursEmailMessage({
    firstName: volunteer.firstName,
    plan,
    attach: base.attach,
    contact: base.contact,
    signature: base.signature,
  });
  const file = hoursEmailHasFile(plan, base.attach);
  const csv = file ? hoursEmailCsv(plan.allShifts, adminClock_) : "";
  const digest = address.problem
    ? ""
    : sha256Hex_(
        hoursEmailDigestText({
          id: volunteer.id,
          to: address.email,
          choice: base.period.choice,
          month: base.period.month,
          asOf: base.period.asOf,
          attach: base.attach,
          subject: message.subject,
          body: message.body,
          csv,
        }),
      );
  return {
    id,
    volunteer,
    address,
    problem: address.problem,
    problemText: address.text,
    plan,
    message,
    file,
    csv,
    digest,
  };
}

/** An error's message, or the error as text. */
function errorMessage_(err) {
  return (err && err.message) || String(err);
}

/** The list items Remove and Restore show, [{shiftId, row, label, detail}], from rows. */
function shiftChoices_(rows) {
  return rows.map((r) => {
    const shown = shiftChoiceLabel(r.entry, adminClock_);
    return { shiftId: r.entry.shiftId, row: r.row, label: shown.label, detail: shown.detail };
  });
}

/**
 * markShiftFlags_ after the Log write, as {marked, left, failed}. The row has already
 * moved, so a Flags step that throws is logged with the Shift ID and doesn't undo it.
 */
function markFlagsSafely_(shiftId, opts) {
  try {
    const done = markShiftFlags_(shiftId, opts);
    return { marked: done.marked, left: done.left, failed: false };
  } catch (e) {
    console.error(
      "Flags: not marked for Shift ID " + shiftId + ": " + (e && e.message ? e.message : String(e)),
    );
    return { marked: 0, left: 0, failed: true };
  }
}

/**
 * The two checks every admin* function makes before anything else: null when both pass,
 * else the ADMIN_EXPIRED refusal. Throws when the caller isn't the person at the sheet.
 */
function adminGuard_(key) {
  requireEditorRun_();
  const k = cellString(key);
  if (!k || !CacheService.getScriptCache().get(adminKeyCacheKey(k))) {
    return refusal("ADMIN_EXPIRED");
  }
  return null;
}

/**
 * Opens a dialog from AdminDialog.html with a new key and the Kiosk contact line
 * (kioskContactNote) in it. mode is "add", "fix", "remove", "restore" or "email". The
 * dialog is 480 wide and height tall, 600 when height isn't given.
 */
function openAdminDialog_(mode, title, height) {
  requireEditorRun_();
  const ui = SpreadsheetApp.getUi();
  const key = Utilities.getUuid();
  CacheService.getScriptCache().put(adminKeyCacheKey(key), "1", adminKeySeconds());
  const page = HtmlService.createTemplateFromFile("AdminDialog");
  page.key = key;
  page.mode = mode;
  page.contactNote = kioskContactNote(kioskContact_());
  ui.showModalDialog(
    page
      .evaluate()
      .setWidth(480)
      .setHeight(height || 600),
    title,
  );
}

/**
 * A refusal reply; an overlap names the row it conflicts with, and a header refusal the
 * column it can't move.
 */
function adminRefusal_(decision) {
  if (decision.header) {
    const r = refusal(decision.refusal);
    return {
      ok: false,
      refusal: r.refusal,
      message: r.message + ' Column: "' + decision.header + '".',
    };
  }
  if (decision.refusal !== "ADMIN_OVERLAP") return refusal(decision.refusal);
  return overlapRefusal(decision.conflict, adminClock_, decision.openStartMs);
}

/** A Central clock time such as "9:00 AM". */
function adminClock_(ms) {
  return Utilities.formatDate(new Date(ms), kioskTimeZone(), "h:mm a");
}
