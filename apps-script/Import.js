/**
 * Import past hours, the Kiosk admin menu's item for bringing shifts from an old hours
 * sheet into the Log. The dialog (ImportDialog.html) asks for the spreadsheet, the tab and
 * the admin's initials. Preview (adminImportPreview) reads and counts, writing nothing;
 * Import (adminImportRun) works the same list out again and writes it. It can be run again
 * at any time: the Import ledger tab remembers every source key brought in.
 *
 * The public functions follow the Kiosk admin menu's rule (Admin.js), and
 * tests/admin.test.mjs holds every public function here to it:
 *   - openImportDialog checks requireEditorRun_ and SpreadsheetApp.getUi() (it throws
 *     anywhere but the spreadsheet's own UI), then makes the dialog key.
 *   - adminImportPreview and adminImportRun take the key first and check it and
 *     requireEditorRun_ (adminGuard_) before reading anything.
 * Everything else ends in _, so google.script.run can't call it.
 *
 * Writes go in blocks of importBlockSize() rows. Each block takes the kiosk's lock,
 * checks the ledger and the Log's Shift IDs again, appends its Log rows in one write, then
 * its ledger lines, then the Flags rows of the unmatched names first seen in it, and lets
 * the lock go, so a tablet call waits at most one block. A run that stops part way leaves
 * whole blocks, and running it again finishes the rest. The rules are in Logic.js (Past
 * hours import).
 */

/** Opens the Import past hours dialog with a new key, prefilled from Settings. */
function openImportDialog() {
  requireEditorRun_();
  const ui = SpreadsheetApp.getUi();
  const settings = readSettings_();
  const key = Utilities.getUuid();
  CacheService.getScriptCache().put(adminKeyCacheKey(key), "1", adminKeySeconds());
  const page = HtmlService.createTemplateFromFile("ImportDialog");
  page.key = key;
  page.fileId = settings[importFileSetting()] || "";
  page.tab = settings[importTabSetting()] || importDefaultTab();
  ui.showModalDialog(page.evaluate().setWidth(560).setHeight(640), "Import past hours");
}

/**
 * What an import would do, writing nothing. form is {file, tab}: the spreadsheet's link or
 * ID and the tab's name. {ok: true, fileName, tab, summary} with summary as importSummary
 * (Logic.js), or a refusal.
 */
function adminImportPreview(key, form) {
  const denied = adminGuard_(key);
  if (denied) return denied;
  const job = importJob_(form);
  if (job.refusal) return job.refusal;
  return { ok: true, fileName: job.fileName, tab: job.tab, summary: importSummary(job.plan) };
}

/**
 * Imports what the preview listed. form is {file, tab, initials}. Replies {ok: true,
 * fileName, tab, summary, done, imported, matched, unmatched, hours, ledgerAdded, flags,
 * flagsFailed, remaining, message}: summary is the plan the run started from, the rest
 * what it wrote. done is false when it stopped part way (busy kiosk or the time limit);
 * message then says to run it again. Or a refusal, with nothing written.
 */
function adminImportRun(key, form) {
  const denied = adminGuard_(key);
  if (denied) return denied;
  const started = Date.now();
  const f = form || {};
  const initials = normalizeInitials(f.initials);
  if (!initials) return refusal("ADMIN_INITIALS");
  const job = importJob_(f);
  if (job.refusal) return job.refusal;
  const plan = job.plan;
  const reply = {
    ok: true,
    fileName: job.fileName,
    tab: job.tab,
    summary: importSummary(plan),
    done: true,
    imported: 0,
    matched: 0,
    unmatched: 0,
    hours: 0,
    ledgerAdded: 0,
    flags: 0,
    flagsFailed: 0,
    remaining: plan.toImport.length,
    message: "",
  };
  const source = { fileId: job.fileId, tab: job.tab, fileName: job.fileName, initials };
  const stop = (message) => {
    reply.done = false;
    reply.message = message;
  };

  // Rows on the Log whose ledger line is missing: a run died between its two writes.
  if (plan.onLog.length) {
    const repaired = withLock_(() => ({
      ok: true,
      added: writeLedgerRepairs_(plan.onLog, source),
    }));
    if (repaired.ok === false) stop(repaired.message);
    else reply.ledgerAdded += repaired.added;
  }

  const counts = importUnmatchedCounts(plan.toImport);
  const flagged = new Set();
  let hundredths = 0;
  const blocks = reply.done ? importBlocks(plan.toImport, importBlockSize()) : [];
  for (let i = 0; i < blocks.length; i++) {
    if (Date.now() - started > importTimeBudgetMs()) {
      stop("The import stopped before the time limit. Run it again to bring in the rest.");
      break;
    }
    const result = withLock_(() => writeImportBlock_(blocks[i], source, counts, flagged));
    if (result.ok === false) {
      stop(result.message + " The import stopped part way. Run it again to bring in the rest.");
      break;
    }
    reply.imported += result.written.length;
    reply.remaining -= blocks[i].length;
    reply.ledgerAdded += result.ledgerAdded;
    reply.flags += result.flags;
    reply.flagsFailed += result.flagsFailed;
    result.written.forEach(({ item }) => {
      if (item.volunteer) reply.matched++;
      else reply.unmatched++;
      hundredths += Math.round(item.hours * 100);
    });
  }
  reply.hours = hundredths / 100;
  if (reply.imported || reply.ledgerAdded) saveImportSettings_(job.fileId, job.tab);
  return reply;
}

/**
 * Reads everything an import needs and works out its plan: Settings, the source tab,
 * Profiles, the Log's Shift IDs and the ledger. Returns {refusal} or {fileId, fileName,
 * tab, plan}. The launch date is checked first, before the source is opened.
 */
function importJob_(form) {
  const f = form || {};
  const settings = readSettings_();
  const launch = importLaunchDate(settings["Kiosk launch date"]);
  if (launch.refusal) return launch;
  const fileId = importFileId(f.file);
  if (!fileId) return { refusal: importRefusal("IMPORT_FILE_ID") };
  const tab = cellString(f.tab) || importDefaultTab();
  let file;
  try {
    file = SpreadsheetApp.openById(fileId);
  } catch (e) {
    return { refusal: importRefusal("IMPORT_FILE") };
  }
  const sheet = file.getSheetByName(tab);
  if (!sheet) return { refusal: importRefusal("IMPORT_TAB", tab) };
  const values = sheet.getDataRange().getValues();
  const zone = file.getSpreadsheetTimeZone() || kioskTimeZone();
  const ledger = readImportLedger_();
  const plan = importPlan({
    header: (values[0] || []).map(cellText_),
    rows: values.slice(1).map((cells) => cells.map((value) => importCell_(value, zone))),
    launchDate: launch.launch,
    todayDate: centralDate_(new Date()),
    volunteers: getProfiles_(settings),
    ledgerKeys: ledger.keys,
    logShiftIds: readLogShiftIds_(readLogColumns_()),
    hashFn: sha256Hex_,
  });
  if (plan.refusal) return plan;
  return { fileId, fileName: file.getName(), tab, plan };
}

/**
 * A source cell for importPlan: a date as yyyy-MM-dd, a number as it is, anything else as
 * text. A date cell holds midnight in the source spreadsheet's own time zone, so it is read
 * in that zone (zone); read in Central, a source set east of Central would land a day early.
 */
function importCell_(value, zone) {
  if (typeof value === "number") return value;
  if (isDate_(value)) return zoneDate_(value, zone);
  return cellText_(value);
}

/** Every Shift ID on the Log, from the Shift ID column alone. */
function readLogShiftIds_(cols) {
  const sheet = sheet_(LOG_TAB);
  const last = sheet.getLastRow();
  if (last < 2) return [];
  return sheet
    .getRange(2, cols[logHeaderNames().shiftId] + 1, last - 1, 1)
    .getValues()
    .map((cells) => cellText_(cells[0]))
    .filter((id) => id !== "");
}

/**
 * The ledger as {keys}: every Source key on the Import ledger tab. No tab, or a tab whose
 * row 1 is empty, is an empty ledger. Throws when row 1 has text but lacks a ledger header.
 */
function readImportLedger_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(importLedgerTab());
  if (!sheet) return { keys: [] };
  const header = logHeaderRow_(sheet);
  if (header.every((h) => h === "")) return { keys: [] };
  const cols = importLedgerColumns(header);
  const last = sheet.getLastRow();
  if (last < 2) return { keys: [] };
  const at = cols[importLedgerHeaderNames().key] + 1;
  return {
    keys: sheet
      .getRange(2, at, last - 1, 1)
      .getValues()
      .map((cells) => cellText_(cells[0]))
      .filter((k) => k !== ""),
  };
}

/** The Import ledger tab, made with its header when missing or empty, as {sheet, cols}. */
function importLedgerSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(importLedgerTab()) || ss.insertSheet(importLedgerTab());
  let header = logHeaderRow_(sheet);
  if (header.every((h) => h === "")) {
    const headers = importLedgerHeaders();
    sheet.getRange(1, 1, 1, headers.length).setNumberFormat("@").setValues([headers]);
    sheet.setFrozenRows(1);
    header = headers;
  }
  return { sheet, cols: importLedgerColumns(header) };
}

/** Appends ledger lines (importLedgerLine maps) below the tab's last row in one write. */
function appendLedgerLines_(lines) {
  if (!lines.length) return;
  const { sheet, cols } = importLedgerSheet_();
  const width = logHeaderRow_(sheet).length;
  const first = sheet.getLastRow() + 1;
  const last = first + lines.length - 1;
  if (last > sheet.getMaxRows()) {
    sheet.insertRowsAfter(sheet.getMaxRows(), Math.max(50, last - sheet.getMaxRows()));
  }
  const range = sheet.getRange(first, 1, lines.length, width);
  const formats = range.getNumberFormats();
  const at = cols[importLedgerHeaderNames().importedAt];
  const values = lines.map((line, i) => {
    Object.keys(cols).forEach(
      (h) => (formats[i][cols[h]] = cols[h] === at ? DATE_TIME_FORMAT : "@"),
    );
    const row = importLedgerValues(line, cols, width);
    row[at] = new Date(row[at]);
    return row;
  });
  range.setNumberFormats(formats);
  range.setValues(values);
}

/** Under the lock: the ledger lines for items already on the Log, skipping keys now in it. */
function writeLedgerRepairs_(items, source) {
  const inLedger = new Set(readImportLedger_().keys);
  const missing = items.filter((item) => !inLedger.has(item.key));
  const now = Date.now();
  appendLedgerLines_(
    missing.map((item) => importLedgerLine(item, now, source.initials, source.fileId, source.tab)),
  );
  return missing.length;
}

/**
 * Under the lock: writes one block. Reads the ledger and the Log's Shift IDs again and
 * skips what is now in either (a key on the Log only gets its ledger line), so two runs at
 * once write nothing twice. Appends the Log rows, then their ledger lines, flushes, then
 * copies the Flags rows of the unmatched names first seen in this block. Returns {ok:
 * true, written: [{item, row}], ledgerAdded, flags, flagsFailed}.
 */
function writeImportBlock_(items, source, counts, flagged) {
  const cols = readLogColumns_();
  const inLedger = new Set(readImportLedger_().keys);
  const onLog = new Set(readLogShiftIds_(cols));
  const fresh = items.filter((item) => !inLedger.has(item.key));
  const toWrite = fresh.filter((item) => !onLog.has(item.shiftId));
  const repairs = fresh.filter((item) => onLog.has(item.shiftId));
  const withNotes = cols[logHeaderNames().notes] >= 0;
  const now = Date.now();
  const first = appendLogRows_(
    toWrite.map((item) =>
      importCells(
        item,
        withNotes ? importNote(source.initials, source.fileName, source.tab, item) : "",
      ),
    ),
    cols,
  );
  const written = toWrite.map((item, i) => ({ item, row: first + i }));
  appendLedgerLines_(
    toWrite
      .concat(repairs)
      .map((item) => importLedgerLine(item, now, source.initials, source.fileId, source.tab)),
  );
  SpreadsheetApp.flush();
  const flagRowsToWrite = importFlagRows(written, counts, flagged, now);
  let flagsFailed = 0;
  if (flagRowsToWrite.length) {
    try {
      appendFlagRows_(flagRowsToWrite);
      SpreadsheetApp.flush();
    } catch (e) {
      flagsFailed = flagRowsToWrite.length;
      console.error(
        "Flags: not copied for " +
          flagsFailed +
          " imported names: " +
          (e && e.message ? e.message : String(e)),
      );
    }
  }
  return {
    ok: true,
    written,
    ledgerAdded: repairs.length,
    flags: flagRowsToWrite.length - flagsFailed,
    flagsFailed,
  };
}

/** Saves the file ID and tab a writing run used, so the dialog offers them next time. */
function saveImportSettings_(fileId, tab) {
  const settings = readSettings_();
  if (settings[importFileSetting()] !== fileId) setSetting_(importFileSetting(), fileId);
  if (settings[importTabSetting()] !== tab) setSetting_(importTabSetting(), tab);
}
