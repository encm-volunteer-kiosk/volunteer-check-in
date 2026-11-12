/**
 * Reports on the Log: the Monthly Hours tab, the Log's filter views and soft warnings
 * (setupReports), and the Kiosk admin menu's Monthly report, which writes a frozen report
 * tab and offers it as a CSV or PDF download.
 *
 * Reports read the Log and never write a Log cell. On the Log tab, setupReports adds only
 * filter views titled "Kiosk: ..." and warning-only protections. Every Log read finds
 * columns through the header map. No report output holds a User Token.
 *
 * The public functions follow the Kiosk admin menu's rule (Admin.js), and
 * tests/admin.test.mjs holds every public function here to it:
 *   - setupReports runs by hand from the editor and starts with requireEditorRun_, as
 *     setupSheets does.
 *   - openMonthlyReportDialog checks requireEditorRun_ and SpreadsheetApp.getUi() (it
 *     throws anywhere but the spreadsheet's own UI), then makes the dialog key.
 *   - adminReportMonths and adminMonthlyReport take the key first and check it and
 *     requireEditorRun_ (adminGuard_) before reading anything.
 * Everything else ends in _, so google.script.run can't call it.
 *
 * What setupReports owns, found by the first words of each description
 * (reportProtectionPrefixes, Logic.js): the Monthly Hours tab except B1, the Log's filter
 * views titled "Kiosk: ...", the Log protections marked "Kiosk column:", and the Monthly
 * Hours tab's protection marked "Monthly Hours tab:". It rebuilds those from the current
 * header map on every run, so running it twice changes nothing. A report tab's protection
 * ("Report tab:") is made with the tab and setupReports never touches it.
 */

// ---------------------------------------------------------------------------
// Run by hand from the editor

/**
 * Makes or repairs the Monthly Hours tab, the Log's filter views and the soft warnings on
 * the Log's kiosk columns, from the Log's current header map. Throws the kiosk's message
 * when a column the kiosk needs is missing, before it changes anything. Runs only from the
 * Apps Script editor; the advanced Sheets service must be on (appsscript.json).
 */
function setupReports() {
  requireEditorRun_();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const log = sheet_(LOG_TAB);
  const cols = reportColumns(logHeaderRow_(log));
  setupMonthlyHours_(ss, cols);
  const views = setupFilterViews_(ss, log, cols);
  const warnings = setupKioskWarnings_(log, cols);
  console.log(setupReportsMessage({ views, warnings }));
}

/**
 * The Monthly Hours tab: every cell except B1 rewritten from monthlyHoursFormulas, B1 a
 * plain-text month picker over the month list, the helper columns hidden, and one
 * warning-only protection with B1 left open.
 */
function setupMonthlyHours_(ss, cols) {
  const plan = monthlyHoursFormulas(cols, LOG_TAB);
  const sheet = ss.getSheetByName(monthlyHoursTabName()) || ss.insertSheet(monthlyHoursTabName());
  if (sheet.getMaxRows() < plan.rowCount) {
    sheet.insertRowsAfter(sheet.getMaxRows(), plan.rowCount - sheet.getMaxRows());
  }
  const needed = Math.max(...plan.cells.map((c) => a1Column_(c.a1)));
  if (sheet.getMaxColumns() < needed) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), needed - sheet.getMaxColumns());
  }

  // Plain text first, so a picked "2026-11" stays text and is not read as a date.
  const picker = sheet.getRange(plan.picker.a1);
  picker.setNumberFormat("@");
  const month = pickerMonth(cellString(picker.getValue()), centralDate_(new Date()));
  picker.setValue(month);

  // The rest of the tab is setupReports' own: clear it, so nothing typed in a spill's way
  // stops a formula, then write every cell.
  sheet.getRange("A1:A").clearContent();
  sheet.getRange("B2:B").clearContent();
  sheet.getRange("C1:" + columnLetter(sheet.getMaxColumns() - 1)).clearContent();
  plan.formats.forEach((f) => sheet.getRange(f.range).setNumberFormat(f.format));
  plan.cells.forEach((c) => {
    const range = sheet.getRange(c.a1);
    if (String(c.value).charAt(0) === "=") range.setFormula(c.value);
    else range.setValue(c.value);
  });

  picker.setDataValidation(
    SpreadsheetApp.newDataValidation()
      .requireValueInRange(sheet.getRange(plan.picker.listRange), true)
      .setAllowInvalid(false)
      .build(),
  );
  plan.hiddenColumns.forEach((letter) => sheet.hideColumn(sheet.getRange(letter + "1")));

  const protections = sheet.getProtections(SpreadsheetApp.ProtectionType.SHEET);
  const owned = ownedProtectionPlan(
    ["sheet"],
    protections.map((p) => ({ key: "sheet", description: p.getDescription() })),
    reportProtectionPrefixes().monthlyHours,
  );
  owned.remove.forEach((i) => protections[i].remove());
  const protection = owned.keep.length ? protections[owned.keep[0]] : sheet.protect();
  protection.setDescription(monthlyHoursDescription());
  if (!protection.isWarningOnly()) protection.setWarningOnly(true);
  protection.setUnprotectedRanges([picker]);
}

/** The 1-based column number of an A1 reference such as "N1" or "C7:C". */
function a1Column_(a1) {
  return /^[A-Z]+/
    .exec(a1)[0]
    .split("")
    .reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
}

/**
 * The Log's "Kiosk: ..." filter views, through the advanced Sheets service: a view whose
 * title is already there is updated in place, so its link keeps working; a missing one is
 * added. Returns {added, updated}.
 */
function setupFilterViews_(ss, log, cols) {
  const sheetId = log.getSheetId();
  const got = Sheets.Spreadsheets.get(ss.getId(), {
    fields: "sheets(properties(sheetId),filterViews(filterViewId,title))",
  });
  const tab = (got.sheets || []).find((s) => s.properties && s.properties.sheetId === sheetId);
  const requests = filterViewRequests(
    filterViewSpecs(cols, sheetId),
    (tab && tab.filterViews) || [],
  );
  if (requests.length) Sheets.Spreadsheets.batchUpdate({ requests }, ss.getId());
  const added = requests.filter((r) => r.addFilterView).length;
  return { added, updated: requests.length - added };
}

/**
 * The warning-only protections on the Log's kiosk columns, one whole-column range each so
 * new rows are covered. Returns {kept, added, removed}.
 */
function setupKioskWarnings_(log, cols) {
  const wanted = kioskWarnHeaders().map((h) => {
    const letter = logLetter(cols, h);
    return letter + ":" + letter;
  });
  const protections = log.getProtections(SpreadsheetApp.ProtectionType.RANGE);
  const plan = ownedProtectionPlan(
    wanted,
    protections.map((p) => ({
      key: p.getRange().getA1Notation(),
      description: p.getDescription(),
    })),
    reportProtectionPrefixes().kioskColumn,
  );
  plan.remove.forEach((i) => protections[i].remove());
  plan.keep.forEach((i) => {
    const p = protections[i];
    if (p.getDescription() !== kioskWarnDescription()) p.setDescription(kioskWarnDescription());
    if (!p.isWarningOnly()) p.setWarningOnly(true);
  });
  plan.add.forEach((a1) =>
    log.getRange(a1).protect().setDescription(kioskWarnDescription()).setWarningOnly(true),
  );
  return { kept: plan.keep.length, added: plan.add.length, removed: plan.remove.length };
}

// ---------------------------------------------------------------------------
// The Monthly report dialog

/** Opens the Monthly report dialog from Report.html with a new key in it. */
function openMonthlyReportDialog() {
  requireEditorRun_();
  const ui = SpreadsheetApp.getUi();
  const key = Utilities.getUuid();
  CacheService.getScriptCache().put(adminKeyCacheKey(key), "1", adminKeySeconds());
  const page = HtmlService.createTemplateFromFile("Report");
  page.key = key;
  ui.showModalDialog(page.evaluate().setWidth(460).setHeight(380), "Monthly report");
}

/**
 * {ok: true, months: [{month, label}], defaultMonth} for the dialog's month list: every
 * month with a dated Log row up to the current one, plus the current one, newest first.
 * Reads the Date column without the lock: a half-written row can't change which months
 * exist.
 */
function adminReportMonths(key) {
  const denied = adminGuard_(key);
  if (denied) return denied;
  const log = sheet_(LOG_TAB);
  const cols = reportColumns(logHeaderRow_(log));
  const last = log.getLastRow();
  const dates =
    last < 2 ? [] : log.getRange(2, cols[logHeaderNames().date] + 1, last - 1, 1).getValues();
  const listed = reportMonths(
    dates.map((cells) => ({ dateText: cellText_(cells[0]) })),
    centralDate_(new Date()),
  );
  return {
    ok: true,
    months: listed.months.map((month) => ({ month, label: monthName(month) })),
    defaultMonth: listed.defaultMonth,
  };
}

/**
 * Writes a frozen report tab for one month. form is {month: "yyyy-MM", initials}. Reads
 * the Log under the kiosk's lock, then writes a new tab "Report yyyy-MM" (or "(2)", "(3)"
 * ... when taken); an existing report tab is never changed. Replies {ok: true, tabName,
 * csvUrl, pdfUrl}, each link a download of that tab only, or a refusal.
 */
function adminMonthlyReport(key, form) {
  const denied = adminGuard_(key);
  if (denied) return denied;
  const f = form || {};
  const initials = normalizeInitials(f.initials);
  if (!initials) return refusal("ADMIN_INITIALS");
  const now = new Date();
  const month = cellString(f.month);
  const bad = reportMonthRefusal(month, centralDate_(now));
  if (bad) return refusal(bad);

  const log = withLock_(readReportLog_);
  if (!log.entries) return log;

  const rateCents = parseMoneyCents(readSettings_()[volunteerHourValueSetting()] || "");
  const report = monthReport(log.entries, month, rateCents, log.cols);
  const madeAt = Utilities.formatDate(now, kioskTimeZone(), "yyyy-MM-dd h:mm a");
  const sheet = writeReportTab_(month, reportRows(report, month, initials, madeAt));
  const urls = reportDownloadUrls(
    SpreadsheetApp.getActiveSpreadsheet().getId(),
    sheet.getSheetId(),
  );
  return { ok: true, tabName: sheet.getName(), csvUrl: urls.csvUrl, pdfUrl: urls.pdfUrl };
}

/** The Log's header map and every row as a report entry, from one read of the tab. */
function readReportLog_() {
  const sheet = sheet_(LOG_TAB);
  const width = Math.max(sheet.getLastColumn(), 1);
  const values = sheet.getRange(1, 1, Math.max(sheet.getLastRow(), 1), width).getValues();
  const cols = reportColumns(values[0].map(cellText_));
  const read = logRead_();
  return {
    cols,
    entries: values.slice(1).map((cells, i) => reportEntry(cells, i + 2, cols, read)),
  };
}

/**
 * A new tab at the end holding rows ({values, formats}, reportRows), formats first, then
 * values, one call each; protected warning-only and made the active tab.
 */
function writeReportTab_(month, rows) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const name = reportTabName(
    month,
    ss.getSheets().map((s) => s.getName()),
  );
  const sheet = ss.insertSheet(name, ss.getNumSheets());
  const height = rows.values.length;
  const width = rows.values[0].length;
  if (sheet.getMaxRows() < height) {
    sheet.insertRowsAfter(sheet.getMaxRows(), height - sheet.getMaxRows());
  }
  if (sheet.getMaxColumns() < width) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), width - sheet.getMaxColumns());
  }
  const range = sheet.getRange(1, 1, height, width);
  range.setNumberFormats(rows.formats);
  range.setValues(rows.values);
  sheet.protect().setDescription(reportTabDescription()).setWarningOnly(true);
  ss.setActiveSheet(sheet);
  SpreadsheetApp.flush();
  return sheet;
}
