/**
 * Pure logic for the volunteer check-in kiosk.
 *
 * Plain functions on plain values (times in milliseconds, dates as yyyy-MM-dd strings).
 * Nothing here calls a Google service, so the Node tests load this file as it is and
 * reach every decision. Sheets.js and Api.js only read and write the sheets and pass
 * values in and out of these functions.
 *
 * Constants are functions because a top-level const is not visible to the tests.
 */

// ---------------------------------------------------------------------------
// Constants

function kioskTimeZone() {
  return "America/Chicago";
}

/** A Settings access code shorter than this, after normalizeCode, counts as not set. */
function minCodeLetters() {
  return 16;
}

/** How far ahead of server time an arrival may be and still be accepted as now. */
function arrivalGraceMinutes() {
  return 5;
}

function defaultFlagMinutes() {
  return 15;
}

function profilesCacheSeconds() {
  return 300;
}

/**
 * The shape of the cached Profiles list. Raise it whenever the fields parseProfiles
 * keeps for a volunteer change: the cache key carries it, so a list cached by older code
 * is never read by newer code. The tests pin the shape that goes with each version.
 */
function profilesCacheVersion() {
  return 2;
}

/** The script cache key for one Profiles file and tab. */
function profilesCacheKey(fileId, tabName) {
  return "profiles:v" + profilesCacheVersion() + ":" + fileId + ":" + tabName;
}

/** The Profiles list is cached only when its JSON is at most this many UTF-8 bytes. */
function profilesCacheMaxBytes() {
  return 100000;
}

/** Settings rows setupSheets creates when missing, as [name, default value]. */
function settingsDefaults(todayDate) {
  const rows = [
    ["Kiosk access code", ""],
    ["Volunteer Profiles file ID", ""],
    ["Volunteer Profiles tab", "Volunteer Profiles"],
    ["Kiosk launch date", todayDate],
    ["Arrival flag minutes", String(defaultFlagMinutes())],
    ["Check-out flag minutes", String(defaultFlagMinutes())],
    ["Profiles problems", ""],
  ];
  ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"].forEach((day) =>
    rows.push(["Closing time " + day, "17:00"]),
  );
  return rows;
}

/**
 * Profiles headers the kiosk needs, after normalizeHeader. Email is never read. The
 * token is found separately, under one of profileTokenHeaders().
 */
function requiredProfileHeaders() {
  return {
    firstName: "volunteer first name",
    lastName: "volunteer last name",
    phone: "volunteer phone",
    startDate: "start date mm/dd/yyyy",
  };
}

/**
 * The two names the User Token column goes by in Profiles, after normalizeHeader. ENCM
 * calls it Onboarding Token today and may rename it User Token; exactly one must be there.
 */
function profileTokenHeaders() {
  return ["onboarding token", "user token"];
}

function refusalMessages() {
  return {
    ACCESS: "This kiosk needs to be set up. Please ask a board member.",
    NOT_FOUND: "We couldn't find your profile. Please see a board member.",
    ALREADY_IN: "You're already checked in today.",
    NOT_IN: "You're not checked in today.",
    ARRIVAL_FUTURE: "Your arrival time can't be in the future. Please choose an earlier time.",
    ARRIVAL_OTHER_DAY: "Please choose a time from today.",
    PHONE_NEEDED: "Please enter the last four digits of your phone number.",
    PHONE_WRONG: "Those digits don't match our records. Please try again or see a board member.",
    PHONE_MISSING: "We need to confirm who you are. Please see a board member.",
    CHECKOUT_FUTURE: "Your check-out time can't be in the future. Please choose an earlier time.",
    CHECKOUT_OTHER_DAY: "Please choose a time from today.",
    CHECKOUT_BEFORE_ARRIVAL:
      "Your check-out time can't be before your arrival time. Please choose a later time.",
    BUSY: "The kiosk is busy. Please try again.",
    ADMIN_EXPIRED: "This window has expired. Close it and open the Kiosk admin menu again.",
    ADMIN_INITIALS: "Please enter your initials, letters only.",
    ADMIN_NOTE_TOO_LONG: "Please keep the note to 500 characters or fewer.",
    ADMIN_NOT_FOUND:
      "That volunteer is no longer in Volunteer Profiles. Close this window and open it again.",
    ADMIN_BAD_TIME: "Please enter a valid date and time.",
    ADMIN_FUTURE: "That date or time is in the future.",
    ADMIN_OUT_BEFORE_IN: "The check-out time can't be before the check-in time.",
    ADMIN_OPEN_SHIFT:
      "This volunteer has an open shift on that date. Use Fix a sign-out to close it.",
    ADMIN_OVERLAP: "This shift overlaps another shift for this volunteer on that date.",
    ADMIN_NOT_OPEN:
      "That shift is no longer open. Close this window and open Fix a sign-out again.",
    ADMIN_DUPLICATE_SHIFT:
      "More than one open row in the Log has this Shift ID. Fix the extra row in the sheet first.",
    ADMIN_BAD_ROW:
      "That row's date or check-in time can't be read, so its hours can't be worked out. Fix the row in the sheet first.",
  };
}

/** Kiosk-logged milestones, checked in this order. */
function milestones() {
  return [
    {
      id: "shift-1",
      title: "First completed shift",
      message: "Your first day making a difference. Welcome to the neighborhood!",
      kind: "shifts",
      threshold: 1,
      sinceLaunchOnly: true,
    },
    {
      id: "shift-10",
      title: "10 shifts",
      message: "10 shifts checked in here. Thank you for showing up for your neighbors!",
      kind: "shifts",
      threshold: 10,
      sinceLaunchOnly: false,
    },
    {
      id: "shift-25",
      title: "25 shifts",
      message: "25 shifts checked in here. That's something special.",
      kind: "shifts",
      threshold: 25,
      sinceLaunchOnly: false,
    },
    {
      id: "hours-50",
      title: "50 hours",
      message: "50 hours logged here. 50 hours of care, kindness, and community.",
      kind: "hours",
      threshold: 50,
      sinceLaunchOnly: false,
    },
    {
      id: "hours-100",
      title: "100 hours",
      message: "100 hours logged here, making East Nashville stronger.",
      kind: "hours",
      threshold: 100,
      sinceLaunchOnly: false,
    },
  ];
}

// ---------------------------------------------------------------------------
// Text

function cellString(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

/** Newlines and runs of spaces become one space, trimmed, lower-cased. */
function normalizeHeader(text) {
  return cellString(text).replace(/\s+/g, " ").toLowerCase();
}

function normalizeName(text) {
  return cellString(text).replace(/\s+/g, " ").toLowerCase();
}

/** Lower-case letters only, so a passphrase typed on the letter keyboard matches the sheet. */
function normalizeCode(text) {
  return cellString(text)
    .toLowerCase()
    .replace(/[^a-z]/g, "");
}

/**
 * Text written into a sheet cell. A leading '=' would make Sheets read the value as a
 * formula, so such text gets the apostrophe that marks a cell as plain text.
 */
function sheetText(text) {
  const s = cellString(text);
  return s.charAt(0) === "=" ? "'" + s : s;
}

function utf8Length(text) {
  let bytes = 0;
  for (const ch of String(text)) {
    const code = ch.codePointAt(0);
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/** Signed bytes, as Utilities.computeDigest returns them, to lowercase hex. */
function bytesToHex(bytes) {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += ((bytes[i] + 256) % 256).toString(16).padStart(2, "0");
  }
  return hex;
}

/** The kiosk's Volunteer ID: the first 16 hex characters of the token's SHA-256. */
function idFromHash(hex) {
  return String(hex).toLowerCase().slice(0, 16);
}

/** Last four digits of a phone number, ignoring a trailing extension; empty if fewer than four. */
function phoneLast4(text) {
  const withoutExtension = cellString(text).replace(/\s*(?:ext\.?|x|#)\s*\d+\s*$/i, "");
  const digits = withoutExtension.replace(/\D/g, "");
  return digits.length >= 4 ? digits.slice(-4) : "";
}

/** Accepts yyyy-MM-dd and m/d/yyyy; returns yyyy-MM-dd, or empty for anything else. */
function parseStartDate(text) {
  const s = cellString(text);
  let year;
  let month;
  let day;
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) {
    year = Number(m[1]);
    month = Number(m[2]);
    day = Number(m[3]);
  } else {
    m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
    if (!m) return "";
    month = Number(m[1]);
    day = Number(m[2]);
    year = Number(m[3]);
  }
  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    return "";
  }
  return year + "-" + String(month).padStart(2, "0") + "-" + String(day).padStart(2, "0");
}

/**
 * True when a Log Date cell is today. The cell arrives as text (a Date cell already
 * formatted as yyyy-MM-dd); a date-time text counts by its date part.
 */
function isRowToday(cellText, todayDate) {
  if (!todayDate) return false;
  return rowDate(cellText) === todayDate;
}

/** A Log Date cell's date as yyyy-MM-dd (a date-time counts by its date part), or empty. */
function rowDate(cellText) {
  return parseStartDate(cellString(cellText).split(/[\sT]/)[0]);
}

/** English weekday of a yyyy-MM-dd date, Monday to Sunday; empty for anything else. */
function weekdayName(dateText) {
  const date = parseStartDate(dateText);
  if (!date) return "";
  const [year, month, day] = date.split("-").map(Number);
  const names = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  return names[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
}

/**
 * A Settings flag minutes value ("Arrival flag minutes" or "Check-out flag minutes"), or
 * the default when blank or not a number of 0 or more.
 */
function parseFlagMinutes(text) {
  const s = cellString(text);
  const n = Number(s);
  return s !== "" && isFinite(n) && n >= 0 ? n : defaultFlagMinutes();
}

// ---------------------------------------------------------------------------
// Volunteer Profiles

function rowList(rowNumbers) {
  return (rowNumbers.length === 1 ? "row " : "rows ") + rowNumbers.join(", ");
}

/**
 * The index of the Profiles User Token column. It is the "onboarding token" or the
 * "user token" column, and exactly one of them: with both, or neither, nobody could say
 * which tokens the Log holds, so this throws naming both.
 */
function profileTokenColumn(headers) {
  const names = profileTokenHeaders();
  const found = names.map((name) => headers.indexOf(name));
  const quoted = '"' + names[0] + '" or "' + names[1] + '"';
  if (found[0] >= 0 && found[1] >= 0) {
    throw new Error(
      'Volunteer Profiles has both an "' +
        names[0] +
        '" and a "' +
        names[1] +
        '" column. Keep one of them.',
    );
  }
  if (found[0] < 0 && found[1] < 0) {
    throw new Error("Volunteer Profiles has no " + quoted + " column.");
  }
  return found[0] >= 0 ? found[0] : found[1];
}

/**
 * Builds the kiosk list from the Profiles header row and data rows (all cells already
 * strings). Data row i is sheet row i + 2. hashFn(token) returns SHA-256 hex.
 *
 * Every row with a first and last name either is listed with an ID of its own, or gets
 * a problem line saying why it can't check in. Rows without both names are skipped.
 * A same-name member whose phone can't confirm them (none, or the same last four as
 * another member) is listed with phoneLast4 '' so checkPhone returns PHONE_MISSING.
 * Returns {volunteers: [{id, firstName, lastName, phoneLast4, startDate, needsPhoneCheck,
 * token, row}], problems: [{row, text}]} with problems in row order. token is the raw
 * User Token, trimmed, and stays on the server: the Log is matched by it. row is the
 * volunteer's Profiles row.
 */
function parseProfiles(headerRow, rows, hashFn) {
  const wanted = requiredProfileHeaders();
  const headers = headerRow.map(normalizeHeader);
  const col = {};
  Object.keys(wanted).forEach((key) => {
    const at = headers.indexOf(wanted[key]);
    if (at < 0) throw new Error('Volunteer Profiles has no "' + wanted[key] + '" column.');
    col[key] = at;
  });
  col.token = profileTokenColumn(headers);

  const problems = [];
  const candidates = [];
  rows.forEach((cells, i) => {
    const row = i + 2;
    const cell = (key) => cellString(cells[col[key]]);
    const firstName = cell("firstName");
    const lastName = cell("lastName");
    if (!firstName || !lastName) return;
    const name = firstName + " " + lastName;
    const token = cell("token");
    if (!token) {
      problems.push({ row, text: "row " + row + ": " + name + " has no User Token" });
      return;
    }
    candidates.push({
      row,
      name,
      volunteer: {
        id: idFromHash(hashFn(token)),
        firstName,
        lastName,
        phoneLast4: phoneLast4(cell("phone")),
        startDate: parseStartDate(cell("startDate")),
        needsPhoneCheck: false,
        token,
        row,
      },
    });
  });

  const byId = new Map();
  candidates.forEach((c) => {
    if (!byId.has(c.volunteer.id)) byId.set(c.volunteer.id, []);
    byId.get(c.volunteer.id).push(c);
  });
  const listed = [];
  candidates.forEach((c) => {
    const sharing = byId.get(c.volunteer.id);
    if (sharing.length === 1) {
      listed.push(c);
      return;
    }
    const others = sharing.filter((o) => o !== c).map((o) => o.row);
    problems.push({
      row: c.row,
      text: "row " + c.row + ": " + c.name + " has the same User Token as " + rowList(others),
    });
  });

  const nameCounts = new Map();
  listed.forEach((c) => {
    const key = volunteerNameKey(c.volunteer);
    nameCounts.set(key, (nameCounts.get(key) || 0) + 1);
  });
  // Within a same-name group the last four must tell members apart. A member whose last
  // four matches another member's can't be confirmed by phone, so they are treated like
  // a member with no usable phone: listed, refused with PHONE_MISSING, and reported.
  const twins = listed.filter((c) => nameCounts.get(volunteerNameKey(c.volunteer)) > 1);
  const clashes = new Map();
  twins.forEach((c) => {
    const rows = twins
      .filter(
        (o) =>
          o !== c &&
          c.volunteer.phoneLast4 &&
          o.volunteer.phoneLast4 === c.volunteer.phoneLast4 &&
          volunteerNameKey(o.volunteer) === volunteerNameKey(c.volunteer),
      )
      .map((o) => o.row);
    if (rows.length) clashes.set(c, rows);
  });
  twins.forEach((c) => {
    c.volunteer.needsPhoneCheck = true;
    if (!c.volunteer.phoneLast4) {
      problems.push({
        row: c.row,
        text: "row " + c.row + ": " + c.name + " shares a name and has no usable phone number",
      });
    } else if (clashes.has(c)) {
      c.volunteer.phoneLast4 = "";
      problems.push({
        row: c.row,
        text:
          "row " +
          c.row +
          ": " +
          c.name +
          " shares a name and the last four phone digits with " +
          rowList(clashes.get(c)),
      });
    }
  });

  problems.sort((a, b) => a.row - b.row);
  return { volunteers: listed.map((c) => c.volunteer), problems };
}

function findVolunteer(volunteers, id) {
  const wanted = cellString(id);
  if (!wanted) return null;
  return volunteers.find((v) => v.id === wanted) || null;
}

/** Same-name group key: normalized first and last name. */
function volunteerNameKey(volunteer) {
  return normalizeName(volunteer.firstName) + "|" + normalizeName(volunteer.lastName);
}

/**
 * The volunteer a check-in or check-out acts on, as {volunteer}, or {refusal}.
 *
 * Members of a same-name group look alike in the list, so one of them can tap another's
 * entry. Their digits then say who they are: when the digits don't match the tapped
 * member, they are matched against every member of the group, and exactly one match is
 * the volunteer acted on. A member whose phoneLast4 is blank (no usable phone, or a last
 * four shared within the group) can't be matched, and tapping that member's entry gives
 * PHONE_MISSING.
 */
function resolveVolunteer(volunteers, id, digits) {
  const tapped = findVolunteer(volunteers, id);
  if (!tapped) return { refusal: "NOT_FOUND" };
  const phone = checkPhone(tapped, digits);
  if (!phone) return { volunteer: tapped };
  if (phone !== "PHONE_WRONG") return { refusal: phone };
  const group = volunteerNameKey(tapped);
  const matches = volunteers.filter(
    (v) => v.needsPhoneCheck && volunteerNameKey(v) === group && checkPhone(v, digits) === null,
  );
  return matches.length === 1 ? { volunteer: matches[0] } : { refusal: "PHONE_WRONG" };
}

// ---------------------------------------------------------------------------
// Access, phone and arrival checks

/** null when the code matches a Settings code of at least minCodeLetters(), else 'ACCESS'. */
function checkAccessCode(given, stored) {
  const expected = normalizeCode(stored);
  if (expected.length < minCodeLetters()) return "ACCESS";
  return normalizeCode(given) === expected ? null : "ACCESS";
}

/** null when no phone check is needed or the digits match, else a refusal code. */
function checkPhone(volunteer, digits) {
  if (!volunteer.needsPhoneCheck) return null;
  if (!volunteer.phoneLast4) return "PHONE_MISSING";
  const given = cellString(digits).replace(/\D/g, "");
  if (!given) return "PHONE_NEEDED";
  return given === volunteer.phoneLast4 ? null : "PHONE_WRONG";
}

/**
 * The arrival the page sent, in milliseconds: null when it sent none (the volunteer
 * didn't choose a time, so the arrival is server time), NaN when it isn't a readable time.
 */
function arrivalMsFromIso(arrivalIso) {
  if (arrivalIso === null || arrivalIso === undefined) return null;
  return Date.parse(String(arrivalIso));
}

/**
 * The rule for every stated time, at the kiosk or from the admin menu. Returns {ms} when
 * the time is accepted, else {refused: "FUTURE"} or {refused: "OTHER_DAY"}. A time up to
 * arrivalGraceMinutes() after nowMs is taken as nowMs (a tablet clock a little fast, or a
 * quarter-hour just ahead); one later is in the future. A time whose Central date
 * (msDate) isn't wantedDate is another day, and so is an unreadable time.
 */
function checkStatedTime(nowMs, ms, msDate, wantedDate) {
  if (typeof ms !== "number" || !isFinite(ms)) return { refused: "OTHER_DAY" };
  if (ms - nowMs > arrivalGraceMinutes() * 60000) return { refused: "FUTURE" };
  if (ms > nowMs) return { ms: nowMs };
  if (msDate !== wantedDate) return { refused: "OTHER_DAY" };
  return { ms };
}

/**
 * {arrivedMs} for an acceptable arrival, else a refusal code. A null arrival is server
 * time. An arrival up to arrivalGraceMinutes() ahead of server time is taken as server
 * time. arrivedDate is the arrival's Central date.
 */
function validateArrival(nowMs, arrivedMs, arrivedDate, todayDate) {
  if (arrivedMs === null) return { arrivedMs: nowMs };
  const checked = checkStatedTime(nowMs, arrivedMs, arrivedDate, todayDate);
  if (checked.refused) return "ARRIVAL_" + checked.refused;
  return { arrivedMs: checked.ms };
}

/**
 * {outMs} for an acceptable check-out time, else a refusal code. A null time (the
 * volunteer chose none, or the page is older than the check-out picker) is server time
 * and is never refused. Otherwise, in order: unreadable, future, another day, then before
 * startMs, the open shift's start. Equal to the start is accepted. When startMs is
 * unreadable that last check is skipped. outDate is the time's Central date.
 */
function validateCheckOut(nowMs, outMs, outDate, todayDate, startMs) {
  if (outMs === null) return { outMs: nowMs };
  const checked = checkStatedTime(nowMs, outMs, outDate, todayDate);
  if (checked.refused) return "CHECKOUT_" + checked.refused;
  if (isFinite(startMs) && checked.ms < startMs) return "CHECKOUT_BEFORE_ARRIVAL";
  return { outMs: checked.ms };
}

/** '' or label + ' differs by N min', with N the rounded gap compared and printed alike. */
function differsFlag(label, recordedMs, statedMs, thresholdMin) {
  if (!isFinite(recordedMs) || !isFinite(statedMs)) return "";
  const n = Math.round(Math.abs(recordedMs - statedMs) / 60000);
  return n > thresholdMin ? label + " differs by " + n + " min" : "";
}

/** '' or 'arrival differs by N min'. */
function arrivalFlag(tappedMs, arrivedMs, thresholdMin) {
  return differsFlag("arrival", tappedMs, arrivedMs, thresholdMin);
}

/** '' or 'check-out differs by N min'. */
function checkOutFlag(recordedOutMs, statedOutMs, thresholdMin) {
  return differsFlag("check-out", recordedOutMs, statedOutMs, thresholdMin);
}

/**
 * A cell's text with more text added after "; ", or the new text alone when the cell is
 * blank. Text already in the cell, staff's included, is always kept.
 */
function appendText(existing, text) {
  const before = cellString(existing);
  const added = cellString(text);
  if (!added) return before;
  return before ? before + "; " + added : added;
}

// ---------------------------------------------------------------------------
// Hours and milestones

/** Hours from start to end, 2 decimals, never negative; 0 when either time is unreadable. */
function hoursBetween(startMs, endMs) {
  if (!isFinite(startMs) || !isFinite(endMs)) return 0;
  return Math.max(0, Math.round(((endMs - startMs) / 3600000) * 100) / 100);
}

/**
 * Hours for a pair of times of one kind (recorded with recorded, stated with stated), or
 * "" (a blank cell) when either time is unreadable. A blank is never written as 0.00: a
 * zero would read as a real zero-hour shift.
 */
function pairHours(startMs, endMs) {
  return isFinite(startMs) && isFinite(endMs) ? hoursBetween(startMs, endMs) : "";
}

/** Whole minutes from an Hours cell; 0 when blank, unreadable or negative. */
function minutesFromHours(hours) {
  const n = Number(hours);
  if (!isFinite(n)) return 0;
  return Math.max(0, Math.round(n * 60));
}

/**
 * The hours a closed row adds toward milestones: its stated hours, the hours from the
 * times the volunteer chose. Kiosk rows and admin-menu rows count alike.
 */
function milestoneHours(entry) {
  return entry.statedHours;
}

/**
 * The milestone this check-out crosses, as {id, title, message}, or null. The before
 * values are the volunteer's closed rows; the check-out adds one shift and addMinutes.
 * When two cross at once the first in milestones() order wins. First completed shift
 * needs a start date on or after the launch date; a blank or unreadable one skips it.
 */
function milestoneCrossed(beforeShifts, beforeMinutes, addMinutes, startDate, launchDate) {
  const start = parseStartDate(startDate);
  const launch = parseStartDate(launchDate);
  const afterShifts = beforeShifts + 1;
  const afterMinutes = beforeMinutes + addMinutes;
  for (const m of milestones()) {
    if (m.sinceLaunchOnly && !(start && launch && start >= launch)) continue;
    const crossed =
      m.kind === "shifts"
        ? beforeShifts < m.threshold && afterShifts >= m.threshold
        : beforeMinutes < m.threshold * 60 && afterMinutes >= m.threshold * 60;
    if (crossed) return { id: m.id, title: m.title, message: m.message };
  }
  return null;
}

// ---------------------------------------------------------------------------
// The Log layout
//
// Log columns are found by their header in row 1, never by position: staff may reorder
// them, and put columns of their own between them. Every read and write goes through the
// map logColumns() builds, and the map fails only on a column the call depends on.

/**
 * The kiosk's Log headers, keyed by the short names the code uses, in the order a new Log
 * gets them. The first fourteen are ENCM's own, from the "2026-11 Log" tab of their
 * Volunteer Kiosk Log, line breaks included. The last four are the kiosk's.
 */
function logHeaderNames() {
  return {
    date: "Date",
    day: "Day",
    name: "Volunteer\nName",
    role: "Volunteer\nRole/Type",
    recordedIn: "Check-In\nRecorded\n(timestamp)",
    statedIn: "Check-In\nStated\n(user)",
    recordedOut: "Check-Out\nRecorded\n(timestamp)",
    statedOut: "Check-Out\nStated (user)",
    recordedHours: "Hours Served\n(timestamps)",
    statedHours: "Hours Served\n(stated)",
    alerts: "Admin\nAlerts?",
    activity: "Activity",
    notes: "Notes",
    token: "User Token",
    status: "Status",
    inBy: "Check-In\nEntered By",
    outBy: "Check-Out\nEntered By",
    shiftId: "Shift ID",
  };
}

/** The Log header row a new Log gets. */
function logHeaders() {
  const names = logHeaderNames();
  return Object.keys(names).map((key) => names[key]);
}

/**
 * Headers the kiosk can't work without. Role/Type and Activity are staff's and never read
 * or written; Notes is written only by an admin-menu call that carries a note.
 */
function requiredLogHeaders() {
  const H = logHeaderNames();
  return logHeaders().filter((h) => h !== H.role && h !== H.activity && h !== H.notes);
}

/** Each header's kind, which sets its number format: "text", "time" or "hours". */
function logColumnKinds() {
  const H = logHeaderNames();
  const kinds = {};
  logHeaders().forEach((h) => (kinds[h] = "text"));
  [H.recordedIn, H.statedIn, H.recordedOut, H.statedOut].forEach((h) => (kinds[h] = "time"));
  [H.recordedHours, H.statedHours].forEach((h) => (kinds[h] = "hours"));
  return kinds;
}

/** The header row the kiosk wrote before the Log took ENCM's layout. */
function oldLogHeaders() {
  return [
    "Shift ID",
    "Volunteer ID",
    "First name",
    "Last name",
    "Date",
    "Tapped in at",
    "Arrived at",
    "Signed out at",
    "Hours",
    "Status",
    "Flag",
    "Staff note",
  ];
}

/** True when a header row starts with the old layout's twelve headers. */
function isOldLogLayout(headerRow) {
  const old = oldLogHeaders();
  return old.every((h, i) => normalizeHeader(headerRow[i]) === normalizeHeader(h));
}

/** 0-based indexes of every cell in headerRow whose header is this one. */
function logHeaderIndexes(headerRow, header) {
  const wanted = normalizeHeader(header);
  const found = [];
  headerRow.forEach((cell, i) => {
    if (normalizeHeader(cell) === wanted) found.push(i);
  });
  return found;
}

/** The required headers headerRow lacks, in logHeaders() order. */
function missingLogHeaders(headerRow) {
  return requiredLogHeaders().filter((h) => logHeaderIndexes(headerRow, h).length === 0);
}

/**
 * The header cells setupSheets writes in row 1 of the Log, as [{col (1-based), header}].
 * An empty row gets the full logHeaders() from column A. Otherwise each required header
 * the row lacks, and Notes when it has no Notes column, goes into the empty cells to the
 * right of the last header, in logHeaders() order. Notes is added because an admin note
 * can't be written without it, and the error for that says to run setupSheets. Only empty
 * cells are named, so a row that has every header gets nothing. An old-layout row is not
 * handled here: setupSheets moves that tab aside and starts a new one.
 */
function logHeaderWrites(headerRow) {
  let last = -1;
  headerRow.forEach((cell, i) => {
    if (cellString(cell) !== "") last = i;
  });
  if (last < 0) return logHeaders().map((header, i) => ({ col: i + 1, header }));
  const notes = logHeaderNames().notes;
  const missing = missingLogHeaders(headerRow);
  const wanted = logHeaders().filter(
    (h) => missing.indexOf(h) >= 0 || (h === notes && logHeaderIndexes(headerRow, h).length === 0),
  );
  return wanted.map((header, i) => ({ col: last + 2 + i, header }));
}

/**
 * The number format each kiosk column of a Log header row gets, as [{col (1-based),
 * kind}] in column order, with kind as in logColumnKinds(). Every column headed with a
 * kiosk header gets one; columns with other headers are staff's and left alone.
 */
function logColumnFormats(headerRow) {
  const kinds = logColumnKinds();
  const formats = [];
  logHeaders().forEach((h) =>
    logHeaderIndexes(headerRow, h).forEach((i) => formats.push({ col: i + 1, kind: kinds[h] })),
  );
  return formats.sort((a, b) => a.col - b.col);
}

function missingLogColumnError(header) {
  return new Error('The Log has no "' + normalizeHeader(header) + '" column. Run setupSheets().');
}

/**
 * Maps each kiosk header to its 0-based index in headerRow, comparing normalizeHeader
 * forms, so line breaks, extra spaces and case don't matter. A required header must be
 * there exactly once, else this throws. An optional header (Role/Type, Activity, Notes)
 * maps to its leftmost column, or to -1 when there is none.
 */
function logColumns(headerRow) {
  const required = requiredLogHeaders();
  const cols = {};
  logHeaders().forEach((h) => {
    const found = logHeaderIndexes(headerRow, h);
    if (required.indexOf(h) >= 0) {
      if (!found.length) throw missingLogColumnError(h);
      if (found.length > 1) {
        throw new Error(
          'The Log has more than one "' +
            normalizeHeader(h) +
            '" column. Rename or remove the extra one.',
        );
      }
    }
    cols[h] = found.length ? found[0] : -1;
  });
  return cols;
}

/** An Hours cell as a number, NaN when blank or unreadable. */
function hoursCell(value) {
  if (typeof value === "number") return value;
  const s = cellString(value);
  return s === "" ? NaN : Number(s);
}

/**
 * One Log row as the entry the rest of this file uses:
 * {row, shiftId, token, name, dateText, recordedInMs, statedInMs, recordedOutMs,
 * statedOutMs, recordedHours, statedHours, alerts, notes, status}.
 *
 * cells is the row's raw values, row its sheet row number, cols the logColumns map. read
 * holds two functions the caller supplies: read.text(value) gives a cell as text (a date
 * as its Central yyyy-MM-dd), and read.time(value) gives {ms, date}, with date the
 * value's Central yyyy-MM-dd.
 *
 * Every time on a row is on that row's Date. A time cell whose Central date isn't the
 * row's Date reads as NaN (unreadable): a time typed without a date (Sheets stores it on
 * 1899-12-30) must never turn into a shift a hundred years long. Hours are NaN when
 * blank.
 */
function logEntry(cells, row, cols, read) {
  const H = logHeaderNames();
  const raw = (header) => {
    const at = cols[header];
    return typeof at === "number" && at >= 0 ? cells[at] : "";
  };
  const text = (header) => cellString(read.text(raw(header)));
  const dateText = text(H.date);
  const day = rowDate(dateText);
  const time = (header) => {
    const value = raw(header);
    if (cellString(value) === "") return NaN;
    const t = read.time(value);
    return t && day && t.date === day && typeof t.ms === "number" && isFinite(t.ms) ? t.ms : NaN;
  };
  return {
    row,
    shiftId: text(H.shiftId),
    token: text(H.token),
    name: text(H.name),
    dateText,
    recordedInMs: time(H.recordedIn),
    statedInMs: time(H.statedIn),
    recordedOutMs: time(H.recordedOut),
    statedOutMs: time(H.statedOut),
    recordedHours: hoursCell(raw(H.recordedHours)),
    statedHours: hoursCell(raw(H.statedHours)),
    alerts: text(H.alerts),
    notes: text(H.notes),
    status: text(H.status),
  };
}

/**
 * Turns a cell map (header to value) into the writes for one row: [{col, value, kind}]
 * with 1-based columns, in logHeaders() order. Times are milliseconds and hours numbers;
 * an unreadable one is written as a blank. Columns the map doesn't name are left alone.
 * Throws on a key that isn't a kiosk header, or whose column the Log lacks.
 */
function cellWrites(cells, cols) {
  const kinds = logColumnKinds();
  Object.keys(cells).forEach((key) => {
    if (!kinds[key]) throw new Error('"' + normalizeHeader(key) + '" is not a Log header.');
  });
  return logHeaders()
    .filter((h) => Object.prototype.hasOwnProperty.call(cells, h))
    .map((h) => {
      const at = cols[h];
      if (typeof at !== "number" || at < 0) throw missingLogColumnError(h);
      const kind = kinds[h];
      let value = cells[h];
      if (kind === "text") {
        value = value === null || value === undefined ? "" : String(value);
      } else if (typeof value !== "number" || !isFinite(value)) {
        value = "";
      }
      return { col: at + 1, value, kind };
    });
}

// ---------------------------------------------------------------------------
// Log rows
//
// Entries are what logEntry() returns. A row belongs to a volunteer when its User Token
// is the volunteer's token.

function isStatus(entry, status) {
  return cellString(entry.status).toLowerCase() === status;
}

/** True when a Log row's token is this volunteer token. A blank token matches nobody. */
function isTokenRow(entry, token) {
  const wanted = cellString(token);
  return wanted !== "" && cellString(entry.token) === wanted;
}

/**
 * When the shift started: Check-In Stated, or Check-In Recorded when the stated time is
 * unreadable. NaN when both are.
 */
function shiftStartMs(entry) {
  return isFinite(entry.statedInMs) ? entry.statedInMs : entry.recordedInMs;
}

/** True when the row's start can be read; a shift with no start has no hours. */
function hasReadableStart(entry) {
  return isFinite(shiftStartMs(entry));
}

/** This token's open row dated today (the latest start if staff edits left more than one), or null. */
function findOpenShiftToday(entries, token, todayDate) {
  let found = null;
  entries.forEach((e) => {
    if (!isTokenRow(e, token) || !isStatus(e, "open") || !isRowToday(e.dateText, todayDate)) {
      return;
    }
    if (!found || shiftStartMs(e) > shiftStartMs(found)) found = e;
  });
  return found;
}

/** Count and total whole minutes, from milestoneHours, of this token's closed rows. */
function closedTotals(entries, token) {
  let shifts = 0;
  let minutes = 0;
  entries.forEach((e) => {
    if (!isTokenRow(e, token) || !isStatus(e, "closed")) return;
    shifts += 1;
    minutes += minutesFromHours(milestoneHours(e));
  });
  return { shifts, minutes };
}

/** The list the page gets: the hashed ID only, and no phone, start date, token or row. */
function volunteerSummaries(volunteers, entries, todayDate) {
  return volunteers.map((v) => {
    const open = findOpenShiftToday(entries, v.token, todayDate);
    const startMs = open ? shiftStartMs(open) : NaN;
    return {
      id: v.id,
      firstName: v.firstName,
      lastName: v.lastName,
      openShiftArrival: isFinite(startMs) ? new Date(startMs).toISOString() : null,
      needsPhoneCheck: v.needsPhoneCheck,
    };
  });
}

// ---------------------------------------------------------------------------
// Cell maps for kiosk writes
//
// Each builder returns a cell map for cellWrites(). No Log row is started without the
// keys that later find it: a builder that starts a row throws on an empty User Token or
// Shift ID, before anything is written.

function requireRowKeys(token, shiftId) {
  if (!cellString(token)) throw new Error("A Log row can't be written without a User Token.");
  if (!cellString(shiftId)) throw new Error("A Log row can't be written without a Shift ID.");
}

/** The Volunteer Name cell: Profiles first name, a space, last name. */
function volunteerFullName(volunteer) {
  return cellString(volunteer.firstName) + " " + cellString(volunteer.lastName);
}

/**
 * A kiosk check-in's new row. nowMs is the tap (Check-In Recorded), arrivedMs the stated
 * arrival, flag the arrival flag or ''.
 */
function checkInCells(volunteer, todayDate, nowMs, arrivedMs, flag, shiftId) {
  requireRowKeys(volunteer.token, shiftId);
  const H = logHeaderNames();
  return {
    [H.date]: todayDate,
    [H.day]: weekdayName(todayDate),
    [H.name]: sheetText(volunteerFullName(volunteer)),
    [H.recordedIn]: nowMs,
    [H.statedIn]: arrivedMs,
    [H.alerts]: sheetText(flag),
    [H.token]: sheetText(volunteer.token),
    [H.status]: "open",
    [H.inBy]: "kiosk",
    [H.shiftId]: sheetText(shiftId),
  };
}

/** The Admin Alerts? text for a check-out whose open row has no readable start. */
function unreadableStartAlert() {
  return "check-in time unreadable, stated hours left blank";
}

/**
 * The cells a kiosk check-out writes on the open row. nowMs is the tap (Check-Out
 * Recorded), statedOutMs the stated check-out, flag the check-out flag or ''. Each hours
 * value pairs times of one kind and is blank when either is unreadable. Admin Alerts? is
 * written only when there is something to add, and then keeps what the cell held. A row
 * whose start can't be read closes with blank stated hours and an alert saying so, not
 * with a zero.
 */
function checkOutCells(open, nowMs, statedOutMs, flag) {
  const H = logHeaderNames();
  const cells = {
    [H.recordedOut]: nowMs,
    [H.statedOut]: statedOutMs,
    [H.recordedHours]: pairHours(open.recordedInMs, nowMs),
    [H.statedHours]: pairHours(shiftStartMs(open), statedOutMs),
    [H.status]: "closed",
    [H.outBy]: "kiosk",
  };
  const added = appendText(flag, hasReadableStart(open) ? "" : unreadableStartAlert());
  if (added) cells[H.alerts] = sheetText(appendText(open.alerts, added));
  return cells;
}

// ---------------------------------------------------------------------------
// Check-in and check-out decisions

/**
 * Checks a check-in in order: NOT_FOUND, phone, ALREADY_IN, ARRIVAL_FUTURE,
 * ARRIVAL_OTHER_DAY. Input: {volunteers, id (the tapped entry), digits, entries,
 * todayDate, nowMs, arrivedMs (null for server time), arrivedDate, flagMinutes}. Returns
 * {refusal} or {volunteer, arrivedMs, flag}; volunteer is the one resolveVolunteer found.
 */
function decideCheckIn(input) {
  const who = resolveVolunteer(input.volunteers, input.id, input.digits);
  if (who.refusal) return { refusal: who.refusal };
  const volunteer = who.volunteer;
  if (findOpenShiftToday(input.entries, volunteer.token, input.todayDate)) {
    return { refusal: "ALREADY_IN" };
  }
  const arrival = validateArrival(input.nowMs, input.arrivedMs, input.arrivedDate, input.todayDate);
  if (typeof arrival === "string") return { refusal: arrival };
  return {
    volunteer,
    arrivedMs: arrival.arrivedMs,
    flag: arrivalFlag(input.nowMs, arrival.arrivedMs, input.flagMinutes),
  };
}

/**
 * Checks a check-out in order: NOT_FOUND, phone, NOT_IN, then the stated check-out time
 * (CHECKOUT_OTHER_DAY, CHECKOUT_FUTURE, CHECKOUT_BEFORE_ARRIVAL). Input: {volunteers, id
 * (the tapped entry), digits, entries (the whole Log), todayDate, nowMs, outMs (null for
 * server time), outDate, flagMinutes, launchDate}.
 *
 * Returns {refusal} or {volunteer, row, cells, minutes, milestone, statedOutMs}:
 * volunteer is the one resolveVolunteer found, row the open row, cells its check-out cell
 * map, minutes the whole minutes this shift adds toward milestones, and the milestone is
 * counted from the closed rows before this one.
 */
function decideCheckOut(input) {
  const who = resolveVolunteer(input.volunteers, input.id, input.digits);
  if (who.refusal) return { refusal: who.refusal };
  const volunteer = who.volunteer;
  const open = findOpenShiftToday(input.entries, volunteer.token, input.todayDate);
  if (!open) return { refusal: "NOT_IN" };
  const out = validateCheckOut(
    input.nowMs,
    input.outMs,
    input.outDate,
    input.todayDate,
    shiftStartMs(open),
  );
  if (typeof out === "string") return { refusal: out };
  const flag = checkOutFlag(input.nowMs, out.outMs, input.flagMinutes);
  const cells = checkOutCells(open, input.nowMs, out.outMs, flag);
  const H = logHeaderNames();
  const minutes = minutesFromHours(
    milestoneHours({ ...open, statedHours: hoursCell(cells[H.statedHours]) }),
  );
  const before = closedTotals(input.entries, volunteer.token);
  return {
    volunteer,
    row: open.row,
    cells,
    minutes,
    milestone: milestoneCrossed(
      before.shifts,
      before.minutes,
      minutes,
      volunteer.startDate,
      input.launchDate,
    ),
    statedOutMs: out.outMs,
  };
}

// ---------------------------------------------------------------------------
// Kiosk admin menu
//
// The admin menu's pure logic goes in this section, after the kiosk's: initials, roster
// labels, open-shift choices, and the add-a-shift and fix-a-sign-out decisions and their
// cell maps. It builds on checkStatedTime, logEntry, cellWrites, pairHours, shiftStartMs,
// hasReadableStart, appendText and requireRowKeys above, and its refusal codes join
// refusalMessages().
//
// The menu's rules: the server checks every limit the dialog shows; a menu row's
// Recorded times and Hours Served (timestamps) are never written; and nothing the menu
// writes overlaps another shift of the same volunteer on the same date.

/** How long a dialog key stays valid, in seconds. */
function adminKeySeconds() {
  return 1800;
}

/** The script cache key that marks a dialog key as issued by the spreadsheet's menu. */
function adminKeyCacheKey(key) {
  return "admin-key:" + key;
}

/** The longest note the menu writes, in characters. */
function adminNoteMaxLength() {
  return 500;
}

/**
 * An admin's initials, upper-case, or '' when they aren't 1 to 5 letters. Spaces and
 * dots are dropped first, so "j.p." and "J P" are "JP".
 */
function normalizeInitials(text) {
  const letters = cellString(text).replace(/[\s.]/g, "");
  return /^[A-Za-z]{1,5}$/.test(letters) ? letters.toUpperCase() : "";
}

/**
 * The volunteer picker's list, [{id, label}], sorted by last name, then first name, then
 * Profiles row. The label is "First Last"; a member of a same-name group also gets their
 * Profiles row and phone, so staff can tell members apart and check Profiles.
 */
function adminRosterLabels(volunteers) {
  const sorted = volunteers.slice().sort((a, b) => {
    const byLast = normalizeName(a.lastName).localeCompare(normalizeName(b.lastName));
    if (byLast) return byLast;
    const byFirst = normalizeName(a.firstName).localeCompare(normalizeName(b.firstName));
    return byFirst || a.row - b.row;
  });
  return sorted.map((v) => {
    let label = volunteerFullName(v);
    if (v.needsPhoneCheck) {
      const phone = v.phoneLast4 ? "phone ending " + v.phoneLast4 : "no usable phone";
      label += " (Profiles row " + v.row + ", " + phone + ")";
    }
    return { id: v.id, label };
  });
}

/**
 * Fix a sign-out's list, [{shiftId, label}]: every open row with a Shift ID, any date,
 * newest first. formatTime(ms) gives a Central clock time such as "9:00 AM". A label
 * reads "Thu 2026-11-12 · Jordan Rivera · in 9:00 AM".
 */
function openShiftChoices(entries, formatTime) {
  const open = entries.filter((e) => isStatus(e, "open") && cellString(e.shiftId));
  const startOf = (e) => (hasReadableStart(e) ? shiftStartMs(e) : -Infinity);
  open.sort((a, b) => {
    const da = rowDate(a.dateText);
    const db = rowDate(b.dateText);
    if (da !== db) return da < db ? 1 : -1;
    if (startOf(a) !== startOf(b)) return startOf(b) - startOf(a);
    return b.row - a.row;
  });
  return open.map((e) => {
    const date = rowDate(e.dateText);
    const day = date ? weekdayName(date).slice(0, 3) + " " + date : cellString(e.dateText);
    const start = hasReadableStart(e)
      ? "in " + formatTime(shiftStartMs(e))
      : "check-in time unreadable";
    return {
      shiftId: e.shiftId,
      label: [day || "no date", cellString(e.name) || "no name", start].join(" · "),
    };
  });
}

/**
 * The dialog's date and time as "yyyy-MM-dd HH:mm" for Utilities.parseDate, or '' when
 * either isn't a real date or a 24-hour time. Seconds, if a browser sends them, are
 * dropped.
 */
function adminDateTimeText(dateText, timeText) {
  const date = cellString(dateText);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || parseStartDate(date) !== date) return "";
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(cellString(timeText));
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return "";
  return date + " " + m[1].padStart(2, "0") + ":" + m[2];
}

/** When the shift ended: Check-Out Stated, or Check-Out Recorded when the stated time is unreadable. */
function shiftEndMs(entry) {
  return isFinite(entry.statedOutMs) ? entry.statedOutMs : entry.recordedOutMs;
}

/**
 * The first closed row (earliest start) of this token on date whose times overlap
 * startMs to endMs, or null. Overlap means newIn < oldOut and oldIn < newOut, so shifts
 * that only touch don't overlap. Rows whose start or end can't be read are skipped.
 */
function findOverlap(entries, token, date, startMs, endMs) {
  let found = null;
  entries.forEach((e) => {
    if (!isTokenRow(e, token) || !isStatus(e, "closed") || rowDate(e.dateText) !== date) return;
    const oldIn = shiftStartMs(e);
    const oldOut = shiftEndMs(e);
    if (!isFinite(oldIn) || !isFinite(oldOut)) return;
    if (startMs < oldOut && oldIn < endMs && (!found || oldIn < shiftStartMs(found))) found = e;
  });
  return found;
}

/**
 * The ADMIN_OVERLAP refusal, naming the shift it conflicts with so staff can find it.
 * When openStartMs is a number, the refusal is for closing an open row that starts
 * inside the other shift: every check-out time would overlap it, so staff must correct
 * or remove one of the two rows in the sheet first.
 */
function overlapRefusal(conflict, formatTime, openStartMs) {
  const r = refusal("ADMIN_OVERLAP");
  const span = formatTime(shiftStartMs(conflict)) + " to " + formatTime(shiftEndMs(conflict));
  let message = r.message + " The other shift is " + span + ", on Log row " + conflict.row + ".";
  if (typeof openStartMs === "number") {
    message +=
      " This open shift starts at " +
      formatTime(openStartMs) +
      ", inside that one, so any check-out time would overlap it. Correct or remove one" +
      " of the two rows in the sheet first, then close this one.";
  }
  return { ok: false, refusal: r.refusal, message };
}

/** The cells Add a shift writes on a new row. The Recorded times and their hours stay blank. */
function handShiftCells(volunteer, date, inMs, outMs, note, initials, shiftId) {
  requireRowKeys(volunteer.token, shiftId);
  const H = logHeaderNames();
  const cells = {
    [H.date]: date,
    [H.day]: weekdayName(date),
    [H.name]: sheetText(volunteerFullName(volunteer)),
    [H.statedIn]: inMs,
    [H.statedOut]: outMs,
    [H.statedHours]: pairHours(inMs, outMs),
    [H.token]: sheetText(volunteer.token),
    [H.status]: "closed",
    [H.inBy]: sheetText(initials),
    [H.outBy]: sheetText(initials),
    [H.shiftId]: sheetText(shiftId),
  };
  if (cellString(note)) cells[H.notes] = sheetText(note);
  return cells;
}

/**
 * The cells Fix a sign-out writes on the open row. Check-In Entered By and the Recorded
 * times and their hours are left as they are; a note is added after the row's Notes.
 */
function fixSignOutCells(open, outMs, note, initials) {
  const H = logHeaderNames();
  const cells = {
    [H.statedOut]: outMs,
    [H.statedHours]: pairHours(shiftStartMs(open), outMs),
    [H.status]: "closed",
    [H.outBy]: sheetText(initials),
  };
  if (cellString(note)) cells[H.notes] = sheetText(appendText(open.notes, note));
  return cells;
}

/** The refusal code for a stated time checkStatedTime refused. */
function adminTimeRefusal(checked) {
  return checked.refused === "FUTURE" ? "ADMIN_FUTURE" : "ADMIN_BAD_TIME";
}

/**
 * Checks an Add a shift in order: ADMIN_INITIALS, ADMIN_NOTE_TOO_LONG, ADMIN_NOT_FOUND,
 * ADMIN_BAD_TIME (date), ADMIN_FUTURE (date after today), each time through
 * checkStatedTime (ADMIN_FUTURE or ADMIN_BAD_TIME), ADMIN_OUT_BEFORE_IN, ADMIN_OPEN_SHIFT,
 * ADMIN_OVERLAP.
 *
 * Input: {volunteers, id, entries (the whole Log), todayDate, nowMs, date, inMs, inDate,
 * outMs, outDate, initials, note, shiftId}. inMs and outMs are the dialog's times on
 * date, NaN when unreadable; inDate and outDate their Central dates.
 *
 * Returns {refusal}, {refusal: "ADMIN_OVERLAP", conflict} with the overlapping row, or
 * {volunteer, cells, hours}.
 */
function decideAddShift(input) {
  const initials = normalizeInitials(input.initials);
  if (!initials) return { refusal: "ADMIN_INITIALS" };
  const note = cellString(input.note);
  if (note.length > adminNoteMaxLength()) return { refusal: "ADMIN_NOTE_TOO_LONG" };
  const volunteer = findVolunteer(input.volunteers, input.id);
  if (!volunteer) return { refusal: "ADMIN_NOT_FOUND" };
  const date = cellString(input.date);
  if (!date || parseStartDate(date) !== date) return { refusal: "ADMIN_BAD_TIME" };
  if (date > input.todayDate) return { refusal: "ADMIN_FUTURE" };
  const checkedIn = checkStatedTime(input.nowMs, input.inMs, input.inDate, date);
  if (checkedIn.refused) return { refusal: adminTimeRefusal(checkedIn) };
  const checkedOut = checkStatedTime(input.nowMs, input.outMs, input.outDate, date);
  if (checkedOut.refused) return { refusal: adminTimeRefusal(checkedOut) };
  const inMs = checkedIn.ms;
  const outMs = checkedOut.ms;
  if (outMs < inMs) return { refusal: "ADMIN_OUT_BEFORE_IN" };
  const open = input.entries.some(
    (e) => isTokenRow(e, volunteer.token) && isStatus(e, "open") && rowDate(e.dateText) === date,
  );
  if (open) return { refusal: "ADMIN_OPEN_SHIFT" };
  const conflict = findOverlap(input.entries, volunteer.token, date, inMs, outMs);
  if (conflict) return { refusal: "ADMIN_OVERLAP", conflict };
  const cells = handShiftCells(volunteer, date, inMs, outMs, note, initials, input.shiftId);
  return { volunteer, cells, hours: cells[logHeaderNames().statedHours] };
}

/**
 * The open rows with this Shift ID. Fix a sign-out acts only when there is exactly one; a
 * blank Shift ID matches nothing.
 */
function openRowsById(entries, shiftId) {
  const wanted = cellString(shiftId);
  if (!wanted) return [];
  return entries.filter((e) => isStatus(e, "open") && cellString(e.shiftId) === wanted);
}

/**
 * Checks a Fix a sign-out in order: ADMIN_INITIALS, ADMIN_NOTE_TOO_LONG, ADMIN_NOT_OPEN
 * (no open row has the Shift ID), ADMIN_DUPLICATE_SHIFT (more than one does),
 * ADMIN_BAD_ROW (the row's start can't be read, so its hours can't be), the time through
 * checkStatedTime on the row's Date (ADMIN_FUTURE or ADMIN_BAD_TIME), ADMIN_OUT_BEFORE_IN,
 * ADMIN_OVERLAP.
 *
 * Input: {entries (the whole Log), shiftId, nowMs, outMs, outDate, initials, note}.
 * outMs is the dialog's time on the row's Date, NaN when unreadable.
 *
 * Returns {refusal}, {refusal: "ADMIN_OVERLAP", conflict} with the overlapping row (and
 * openStartMs, the open row's start, when that start is inside the other shift, so no
 * check-out time could pass), or {open, cells, hours}.
 */
function decideFixSignOut(input) {
  const initials = normalizeInitials(input.initials);
  if (!initials) return { refusal: "ADMIN_INITIALS" };
  const note = cellString(input.note);
  if (note.length > adminNoteMaxLength()) return { refusal: "ADMIN_NOTE_TOO_LONG" };
  const rows = openRowsById(input.entries, input.shiftId);
  if (!rows.length) return { refusal: "ADMIN_NOT_OPEN" };
  if (rows.length > 1) return { refusal: "ADMIN_DUPLICATE_SHIFT" };
  const open = rows[0];
  if (!hasReadableStart(open)) return { refusal: "ADMIN_BAD_ROW" };
  const date = rowDate(open.dateText);
  const checked = checkStatedTime(input.nowMs, input.outMs, input.outDate, date);
  if (checked.refused) return { refusal: adminTimeRefusal(checked) };
  const startMs = shiftStartMs(open);
  if (checked.ms < startMs) return { refusal: "ADMIN_OUT_BEFORE_IN" };
  const conflict = findOverlap(input.entries, open.token, date, startMs, checked.ms);
  if (conflict) {
    const startInside = shiftStartMs(conflict) <= startMs && startMs < shiftEndMs(conflict);
    return startInside
      ? { refusal: "ADMIN_OVERLAP", conflict, openStartMs: startMs }
      : { refusal: "ADMIN_OVERLAP", conflict };
  }
  const cells = fixSignOutCells(open, checked.ms, note, initials);
  return { open, cells, hours: cells[logHeaderNames().statedHours] };
}

// ---------------------------------------------------------------------------
// Refusals

/** {ok: false, refusal, message} for a refusal code. */
function refusal(code) {
  const message = refusalMessages()[code];
  if (!message) throw new Error("Unknown refusal code: " + code);
  return { ok: false, refusal: code, message };
}
