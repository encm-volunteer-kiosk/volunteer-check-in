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
 * only row 7's boxes, their data validation and the boxed pivots, then B1 through
 * renderHoursLine_, then flushes. It writes no state cell, no Hours data row and no row 3.
 * Each run reads every box, so whichever run holds last leaves every table matching its
 * box. Everything else ends in _, so google.script.run can't call it.
 */

/**
 * The installable on-edit trigger. An edit that doesn't touch a sort box on the Hours tab
 * ends at once, asking for no lock. Otherwise, holding the document lock (waiting up to 4
 * minutes), it sets every boxed pivot's sort to the order its box names (applyHoursSorts_).
 */
function runHoursSort(e) {
  try {
    requireTriggerRun_(e, "runHoursSort");
  } catch (err) {
    throw new Error("runHoursSort runs only from its trigger. To install it, run setupReports.");
  }
  // Cheap exit: the edit must be on a tab named Hours and cover a box cell in row 7. Most
  // edits anywhere in the spreadsheet end here, about a second of trigger time each.
  const range = e.range;
  if (!range || range.getSheet().getName() !== hoursTabName()) return;
  const top = range.getRow();
  const left = range.getColumn();
  const bottom = top + range.getNumRows() - 1;
  const right = left + range.getNumColumns() - 1;
  const onBox = hoursSortChoices().some((table) => {
    const column = table.column + 1;
    return left <= column && column <= right;
  });
  if (top > 7 || bottom < 7 || !onBox) return;

  const tabs = findHoursTabs_(SpreadsheetApp.getActiveSpreadsheet());
  const hold = hoursHold_();
  try {
    applyHoursSorts_(tabs, hold, e);
  } finally {
    releaseHoursLock_(hold);
  }
}

/**
 * One sort run, from the lock on, in hold, which runHoursSort's finally releases. Stops
 * before the lock when the edited tab isn't the marked Hours tab. Not free within 4
 * minutes: logs and stops, nothing written. Unless Hours data's build state reads built
 * (a cut-off setupReports leaves the tab half built), renders B1, flushes and logs, having
 * read no pivot and written nothing else. Otherwise reads row 7 and the boxed pivots,
 * sends hoursSortPlan's requests in one batchUpdate (they apply whole or not at all), then
 * renders B1, flushes and logs one line.
 */
function applyHoursSorts_(tabs, hold, e) {
  if (!tabs.hours || !tabs.data || tabs.hours.getSheetId() !== e.range.getSheet().getSheetId()) {
    console.log("Sort (edit): the edited tab isn't the kiosk's Hours tab; nothing changed.");
    return;
  }
  // As long as setupReports might hold the lock (up to about 4 minutes at 20,000 rows),
  // within the trigger's 6 minutes.
  if (!withHoursLock_(hold, 240000)) {
    console.log("Sort (edit): Hours stayed busy for 4 minutes; nothing changed.");
    return;
  }
  const heldAt = Date.now();
  const state = readHoursCells_(tabs.data);
  if (!state.build || state.build.kind !== "built") {
    renderHoursLine_(tabs);
    SpreadsheetApp.flush();
    console.log("Sort (edit): Hours isn't built; nothing sorted. Run setupReports.");
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
  });
  Sheets.Spreadsheets.batchUpdate({ requests: plan.requests }, ss.getId());
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
      " s",
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
