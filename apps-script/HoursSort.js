/**
 * The Hours tab's sort boxes: row 7 holds a dropdown above each boxed pivot, and picking
 * an order in one re-sorts its table. runHoursSort is an installable on-edit trigger,
 * which setupReports installs (ensureHoursSortTrigger_) for the account running it. It
 * runs as that account for every editor's edit, with six minutes to wait out a refresh
 * or setupReports holding the document lock, and it can use the advanced Sheets service,
 * which a simple onEdit can't. Script writes fire no trigger, so the kiosk and the
 * script's own writes never start it.
 *
 * The guard. runHoursSort checks requireTriggerRun_ (Jobs.js) before it reads anything:
 * the event's triggerUid must be one of this account's triggers for runHoursSort, so a
 * google.script.run caller is refused. It doesn't check requireEditorRun_, which wants
 * the person at the sheet to be the account the script runs as: an edit trigger runs as
 * its installer while the editor is someone else, so that check would refuse every other
 * editor's pick. Any edit already needs edit access, and the most a replayed event could
 * do is set the pivots' sorts to what the boxes name, which any editor can do by hand.
 * tests/admin.test.mjs holds this file to that rule.
 *
 * Under the lock it follows the Hours tab's rule (Logic.js and Reports.js): one hold,
 * asked for once through withHoursLock_ and released in runHoursSort's finally; it writes
 * only row 7's boxes, their data validation, the status cells and the boxed pivots, then
 * B1 through renderHoursLine_, then flushes. It writes no state cell, no Hours data row and
 * no row 3. Each run reads every box, so whichever run holds last leaves every table
 * matching its box. Everything else ends in _, so google.script.run can't call it.
 *
 * The status cells and the stamp. Before it waits for the lock, a run writes "Sorting..."
 * (hoursSortStatusText) into the status cell of each box its edit covered and flushes,
 * and only then writes its stamp into the document property hoursSortStamp, then shows
 * the editor who picked a toast. Holding the lock, a run whose stamp is no longer the one
 * stored stops at once: a newer pick's run is waiting, will read every box after it, and
 * owes the clear. The run that sorts blanks all three status cells in its batch. So a
 * "Sorting..." text stays only while the run that will clear it is still to come: the
 * text is in the sheet before its stamp, every clear comes after the clearing run's own
 * stamp, and the run whose stamp is stored last never stops. If the newest run can't
 * sort, it writes "Not sorted. Pick again." (hoursSortFailedText) over the sorting texts
 * instead, under the lock, or without it after a fresh read of the stamp, taking the text
 * back if a newer run has stamped meanwhile. A run with no stamp (its write failed) never
 * stops, and blanks rather than claims a failure, since it can't tell whether a newer run
 * sorted. On a tab still laid out with row 7's old merges, where a write into a status
 * cell is silently dropped, a run writes no status at all.
 */

/**
 * The installable on-edit trigger. An edit that doesn't touch a sort box on the Hours tab
 * ends at once, asking for no lock. Otherwise it says a sort is coming (status cells,
 * stamp, toast) and, holding the document lock (waiting up to 4 minutes), sets every boxed
 * pivot's sort to the order its box names (applyHoursSorts_). Its finally writes the
 * failure text when the newest run couldn't sort (finishHoursSort_), then releases.
 */
function runHoursSort(e) {
  try {
    requireTriggerRun_(e, "runHoursSort");
  } catch (err) {
    throw new Error("runHoursSort runs only from its trigger. To install it, run setupReports.");
  }
  // Cheap exit: the edit must be on a tab named Hours and cover a box cell in row 7. Most
  // edits anywhere in the spreadsheet end here, about a second of trigger time each. An
  // edit on a status cell alone ends here too: it covers no box's first column.
  const range = e.range;
  if (!range || range.getSheet().getName() !== hoursTabName()) return;
  const top = range.getRow();
  const left = range.getColumn();
  const bottom = top + range.getNumRows() - 1;
  const right = left + range.getNumColumns() - 1;
  const covered = hoursSortChoices().filter((table) => {
    const column = table.column + 1;
    return left <= column && column <= right;
  });
  if (top > 7 || bottom < 7 || covered.length === 0) return;

  const run = {
    startedAt: Date.now(),
    tables: covered,
    past: false, // past the tab check, so it may owe or clear a status text
    oldLayout: false,
    stamp: null,
    stored: null,
    busy: false,
    sent: false,
  };
  const tabs = findHoursTabs_(SpreadsheetApp.getActiveSpreadsheet());
  const hold = hoursHold_();
  let threw = true;
  try {
    applyHoursSorts_(tabs, hold, e, run);
    threw = false;
  } finally {
    finishHoursSort_(tabs, hold, run, threw);
    releaseHoursLock_(hold);
  }
}

/**
 * One sort run, from the tab check on, in hold, which runHoursSort's finally releases.
 * Stops before the lock when the edited tab isn't the marked Hours tab. Then, before the
 * lock: the old-layout check, the sorting text in the covered boxes' status cells and a
 * flush, the stamp, the toast; each catches and logs its own error and none stops the
 * sort. Not free within 4 minutes: logs and stops. Holding the lock: a run whose stamp
 * isn't the stored one renders B1, flushes, logs and stops, having read no box and no
 * pivot. Unless Hours data's build state reads built (a cut-off setupReports leaves the
 * tab half built), blanks the status cells, renders B1, flushes and logs, having read no
 * pivot. Otherwise reads row 7 and the boxed pivots, sends hoursSortPlan's requests in one
 * batchUpdate (they apply whole or not at all, the status blanks with them), puts the
 * header notes back if a pivot was rewritten (writeHoursNotes_, which never throws), then
 * renders B1, flushes and logs one line.
 */
function applyHoursSorts_(tabs, hold, e, run) {
  if (!tabs.hours || !tabs.data || tabs.hours.getSheetId() !== e.range.getSheet().getSheetId()) {
    console.log("Sort (edit): the edited tab isn't the kiosk's Hours tab; nothing changed.");
    return;
  }
  run.past = true;
  run.oldLayout = hoursSortOldLayout_(tabs);
  if (!run.oldLayout) {
    try {
      setHoursSortStatus_(
        tabs,
        run.tables.map((t) => t.status),
        hoursSortStatusText(),
        null,
      );
      SpreadsheetApp.flush();
    } catch (err) {
      // Taken as not made: the run still stamps. A write left pending can land at a later
      // flush, after a newer run's blank, and then stays until the next pick; README tells
      // staff to pick again if "Sorting..." stays.
      console.log("Sort (edit): the status text wasn't written: " + hoursMessage_(err));
    }
  }
  // Only after the flush: a newer run's stamp, and so its blank, comes after this text.
  stampHoursSort_(run);
  toastHoursSort_(run);

  // As long as setupReports might hold the lock (up to about 4 minutes at 20,000 rows),
  // within the trigger's 6 minutes.
  if (!withHoursLock_(hold, 240000)) {
    run.busy = true;
    console.log(
      "Sort (edit): Hours stayed busy for 4 minutes; nothing changed. " + hoursSortTail_(run),
    );
    return;
  }
  const heldAt = Date.now();
  if (!hoursSortNewest_(run)) {
    renderHoursLine_(tabs);
    SpreadsheetApp.flush();
    console.log("Sort (edit): a newer pick is waiting; this run stopped. " + hoursSortTail_(run));
    return;
  }
  const state = readHoursCells_(tabs.data);
  if (!state.build || state.build.kind !== "built") {
    if (!run.oldLayout) {
      setHoursSortStatus_(
        tabs,
        hoursSortChoices().map((t) => t.status),
        "",
        null,
      );
    }
    renderHoursLine_(tabs);
    SpreadsheetApp.flush();
    console.log(
      "Sort (edit): Hours isn't built; nothing sorted. Run setupReports. " + hoursSortTail_(run),
    );
    return;
  }
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const boxes = tabs.hours.getRange("A7:N7").getValues()[0];
  const tables = hoursSortChoices();
  const name = "'" + tabs.hours.getName().replace(/'/g, "''") + "'!";
  const got = Sheets.Spreadsheets.get(ss.getId(), {
    ranges: tables.map((table) => name + columnLetter(table.column) + hoursPivotRow()),
    fields: "sheets(data(startColumn,rowData(values(pivotTable))))",
  });
  // One GridData per range asked for; startColumn is left out when it is 0.
  const pivotAt = {};
  (got.sheets || []).forEach((sheet) =>
    (sheet.data || []).forEach((grid) => {
      const cell = grid.rowData && grid.rowData[0] && grid.rowData[0].values;
      pivotAt[grid.startColumn || 0] = (cell && cell[0] && cell[0].pivotTable) || null;
    }),
  );
  const plan = hoursSortPlan(boxes, {
    hoursSheetId: tabs.hours.getSheetId(),
    dataSheetId: tabs.data.getSheetId(),
    pivots: tables.map((table) => pivotAt[table.column] || null),
    oldLayout: run.oldLayout,
  });
  Sheets.Spreadsheets.batchUpdate({ requests: plan.requests }, ss.getId());
  run.sent = true;
  if (plan.resorted > 0) writeHoursNotes_(tabs, null);
  renderHoursLine_(tabs);
  SpreadsheetApp.flush();
  console.log(
    "Sort (edit): " +
      plan.summary +
      "; " +
      plan.resorted +
      (plan.resorted === 1 ? " table" : " tables") +
      " re-sorted in " +
      ((Date.now() - heldAt) / 1000).toFixed(1) +
      " s. " +
      hoursSortTail_(run),
  );
}

/**
 * runHoursSort's finally, before the release; each write in its own try, so nothing here
 * hides the run's own error. Holding the lock after a throw: if the run is still the
 * newest, every status cell holding the sorting text gets the failure text when the
 * batch wasn't sent (a batch that throws counts as not sent), or a blank when it was (the
 * sort is done); then B1 is rendered and flushed, as every hold ends. Without the lock
 * (busy, or a throw before it was held): a run with no stamp blanks the sorting texts; a
 * run whose stamp is stored writes the failure text over them, flushes, reads the stamp
 * again and, if a newer run has stamped meanwhile, blanks each cell it put the failure
 * text in that still holds it; a run that isn't the newest writes nothing, since the run
 * whose stamp replaced its own owes the clear.
 */
function finishHoursSort_(tabs, hold, run, threw) {
  const all = hoursSortChoices().map((t) => t.status);
  const sorting = hoursSortStatusText();
  const failed = hoursSortFailedText();
  if (hold.held) {
    if (!threw) return;
    if (!run.oldLayout) {
      try {
        if (hoursSortNewest_(run)) {
          setHoursSortStatus_(tabs, all, run.sent ? "" : failed, sorting);
        }
      } catch (err) {
        console.log("Sort (edit): the failure text wasn't written: " + hoursMessage_(err));
      }
    }
    try {
      renderHoursLine_(tabs);
      SpreadsheetApp.flush();
    } catch (err) {
      console.log("Sort (edit): B1 wasn't rendered after the error: " + hoursMessage_(err));
    }
    return;
  }
  if (!run.past || run.oldLayout || !(threw || run.busy)) return;
  try {
    if (run.stamp === null) {
      setHoursSortStatus_(tabs, all, "", sorting);
      SpreadsheetApp.flush();
      return;
    }
    if (!hoursSortNewest_(run)) return;
    const put = setHoursSortStatus_(tabs, all, failed, sorting);
    SpreadsheetApp.flush();
    if (put.length > 0 && !hoursSortNewest_(run)) {
      setHoursSortStatus_(tabs, put, "", failed);
      SpreadsheetApp.flush();
    }
  } catch (err) {
    console.log("Sort (edit): the failure text wasn't written: " + hoursMessage_(err));
  }
}

/**
 * Writes text into each of the status cells (A1 references on the Hours tab), or, when
 * onlyIf isn't null, only into those that hold exactly onlyIf now. Returns the cells
 * written.
 */
function setHoursSortStatus_(tabs, cells, text, onlyIf) {
  return cells.filter((a1) => {
    const range = tabs.hours.getRange(a1);
    if (onlyIf !== null && range.getValue() !== onlyIf) return false;
    range.setValue(text);
    return true;
  });
}

/**
 * Whether row 7 is still laid out with the old box merges, which cover the status cells:
 * a write into a merged cell other than its first is silently dropped there, so such a
 * run writes no status. setupReports lays row 7 out anew. A failed check is logged and
 * taken as the new layout, where every status write lands.
 */
function hoursSortOldLayout_(tabs) {
  try {
    return tabs.hours.getRange(hoursSortChoices()[0].status).isPartOfMerge();
  } catch (err) {
    console.log("Sort (edit): row 7's layout wasn't read: " + hoursMessage_(err));
    return false;
  }
}

/** The document property that holds the newest sort run's stamp. */
function hoursSortStampKey_() {
  return "hoursSortStamp";
}

/**
 * Writes this run's stamp, unique to it: its start in ms, a dash and 8 hex digits. It
 * takes no lock. If the write fails the run has no stamp, never stops at the check and
 * otherwise runs as before stamps existed.
 */
function stampHoursSort_(run) {
  try {
    const stamp = run.startedAt + "-" + Utilities.getUuid().replace(/-/g, "").slice(0, 8);
    PropertiesService.getDocumentProperties().setProperty(hoursSortStampKey_(), stamp);
    run.stamp = stamp;
  } catch (err) {
    console.log("Sort (edit): the stamp wasn't written: " + hoursMessage_(err));
  }
}

/**
 * Reads the stored stamp into run.stored and answers whether this run is the newest: the
 * stored stamp is its own, or one of the two is missing (hoursStampStale).
 */
function hoursSortNewest_(run) {
  const stored = PropertiesService.getDocumentProperties().getProperty(hoursSortStampKey_());
  run.stored = stored === null || stored === undefined ? "" : String(stored);
  return !hoursStampStale(run.stored, run.stamp);
}

/** The toast in the window of the editor who picked. A failure is logged, never thrown. */
function toastHoursSort_(run) {
  try {
    SpreadsheetApp.getActiveSpreadsheet().toast(
      hoursSortToast(run.tables.map((t) => t.title)),
      "Sort box",
      hoursSortSeconds(),
    );
  } catch (err) {
    console.log("Sort (edit): the toast wasn't shown: " + hoursMessage_(err));
  }
}

/** The end of each log line after the stamp: this run's stamp, the stored one, its time. */
function hoursSortTail_(run) {
  return (
    "Stamp " +
    (run.stamp || "none") +
    ", stored " +
    (run.stored === null ? "not read" : run.stored || "none") +
    ", " +
    ((Date.now() - run.startedAt) / 1000).toFixed(1) +
    " s from its start."
  );
}

/**
 * Makes sure this account has exactly one runHoursSort trigger, an on-edit one for this
 * spreadsheet: one such trigger is kept; otherwise every runHoursSort trigger of this
 * account is deleted and one is created. Google lists only this account's own triggers,
 * so another account's is never touched. Never throws: a failure comes back as {kind:
 * "failed", message} for setupReports' finish message, and Hours stands. Otherwise
 * {kind: "kept" or "installed", account}, the account the boxes run as.
 */
function ensureHoursSortTrigger_() {
  try {
    const account = Session.getEffectiveUser().getEmail();
    const mine = ScriptApp.getProjectTriggers().filter(
      (t) => t.getHandlerFunction() === "runHoursSort",
    );
    if (mine.length === 1 && mine[0].getEventType() === ScriptApp.EventType.ON_EDIT) {
      return { kind: "kept", account };
    }
    mine.forEach((t) => ScriptApp.deleteTrigger(t));
    ScriptApp.newTrigger("runHoursSort")
      .forSpreadsheet(SpreadsheetApp.getActiveSpreadsheet())
      .onEdit()
      .create();
    return { kind: "installed", account };
  } catch (err) {
    return { kind: "failed", message: hoursMessage_(err) };
  }
}
