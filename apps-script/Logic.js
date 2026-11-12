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
    [volunteerHourValueSetting(), ""],
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
    ADMIN_BAD_MONTH: "Please choose a month.",
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

/**
 * The list the page gets: the hashed ID only, and no phone, start date, token or row.
 * checkedIn is the test check-in and check-out use, an open row dated today, so it holds
 * even when that row's start can't be read. openShiftArrival is that row's start, or null
 * when there is no such row or its start can't be read.
 */
function volunteerSummaries(volunteers, entries, todayDate) {
  return volunteers.map((v) => {
    const open = findOpenShiftToday(entries, v.token, todayDate);
    const startMs = open ? shiftStartMs(open) : NaN;
    return {
      id: v.id,
      firstName: v.firstName,
      lastName: v.lastName,
      checkedIn: Boolean(open),
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

// ---------------------------------------------------------------------------
// Reports
//
// The pure logic of the reports: which Log rows count, the month's figures, the cells of
// a frozen report tab, and the texts setupReports writes (the Monthly Hours formulas, the
// filter views, the columns that get a soft warning). Reports read the Log and never write
// a Log cell. No report output holds a User Token: tokens are read only to tell volunteers
// apart.
//
// The rules every report follows:
// - A row's month comes from its Date read as text, and only when that text is exactly
//   yyyy-MM-dd and a real day (monthKey). The Day column is never read.
// - A counted row is Status "closed" (trimmed, any case) with a User Token. Only counted
//   rows add shifts, hours or volunteers to a figure. An open row counts nowhere; it is
//   listed for review, and its count is on the report's first lines.
// - Hours are Hours Served (stated), in whole hundredths of an hour (reportHundredths).
// - Rows are put in order by row date, then shift start (a row with no readable start
//   after those with one), then Log row (reportRowOrder). A counted row with no month has
//   no place in that order, so it is left out wherever order matters: a volunteer's first
//   shift, the milestone walk and the label's latest row. It is listed for review.
// - Who entered each end is read with one case rule (entrySource): case is ignored
//   everywhere. "kiosk" in any case is the kiosk and is never initials; any other 1 to 5
//   letters A to Z, in any case, are an admin's initials. The filter views use the same
//   rule.

/** The Settings row that holds the dollar value of one volunteer hour. */
function volunteerHourValueSetting() {
  return "Volunteer hour value";
}

/** How many rows setupReports gives the Monthly Hours tab; one month's rows must fit. */
function monthlyHoursRowCount() {
  return 5000;
}

/** Every filter view setupReports owns has a title starting with this. */
function filterViewTitlePrefix() {
  return "Kiosk: ";
}

/** The description of each soft-warning protection setupReports owns on the Log. */
function kioskWarnDescription() {
  return "Kiosk column: the kiosk and the Kiosk admin menu write this. Change it only to fix a mistake.";
}

/** What the report prints for value when the Settings row is blank. */
function hourValueBlankMessage() {
  return "Set " + volunteerHourValueSetting() + " in Settings";
}

/** What the report prints for value when the Settings row holds something not a dollar amount. */
function hourValueUnreadableMessage() {
  return (
    "The " +
    volunteerHourValueSetting() +
    " in Settings can't be read. Enter a dollar amount such as 34.79."
  );
}

/**
 * The Log's header map for a report: the logColumns map, which already holds Role/Type and
 * Activity at their leftmost column, or -1 when the Log has none. Throws as logColumns does
 * when a column the kiosk needs is missing or repeated, so a report fails where the kiosk
 * fails, with the kiosk's message.
 */
function reportColumns(headerRow) {
  return logColumns(headerRow);
}

/**
 * One Log row as a report reads it: logEntry's fields plus inBy, outBy (the Entered By
 * texts), roleType, activity (blank when the column is missing), and statedHoursCell and
 * recordedHoursCell, the raw Hours Served (stated) and (timestamps) values as the sheet
 * gave them. Arguments as logEntry's.
 */
function reportEntry(cells, row, cols, read) {
  const H = logHeaderNames();
  const raw = (header) => {
    const at = cols[header];
    const value = typeof at === "number" && at >= 0 ? cells[at] : "";
    return value === undefined || value === null ? "" : value;
  };
  const text = (header) => cellString(read.text(raw(header)));
  const entry = logEntry(cells, row, cols, read);
  entry.inBy = text(H.inBy);
  entry.outBy = text(H.outBy);
  entry.roleType = text(H.role);
  entry.activity = text(H.activity);
  entry.statedHoursCell = raw(H.statedHours);
  entry.recordedHoursCell = raw(H.recordedHours);
  return entry;
}

/** "yyyy-MM" of a Date text that is exactly yyyy-MM-dd and a real day, else "". */
function monthKey(dateText) {
  const s = cellString(dateText);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && parseStartDate(s) === s ? s.slice(0, 7) : "";
}

/** The month before a "yyyy-MM" month. */
function previousMonth(month) {
  const year = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  return m === 1 ? year - 1 + "-12" : year + "-" + String(m - 1).padStart(2, "0");
}

/** "November 2026" for "2026-11". */
function monthName(month) {
  const names = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  return names[Number(month.slice(5, 7)) - 1] + " " + month.slice(0, 4);
}

/** True for a row a report counts: Status closed (trimmed, any case) and a User Token. */
function isCountedRow(entry) {
  return isStatus(entry, "closed") && cellString(entry.token) !== "";
}

/**
 * Who entered one end of a row, from its Entered By text: "kiosk" ("kiosk" trimmed, any
 * case), "initials" (any other 1 to 5 letters A to Z, any case), "typed" (blank: typed into
 * the sheet) or "other" (anything else, such as "auto-close" or "J.P.").
 */
function entrySource(text) {
  const s = cellString(text);
  if (!s) return "typed";
  if (s.toLowerCase() === "kiosk") return "kiosk";
  if (/^[A-Za-z]{1,5}$/.test(s)) return "initials";
  return "other";
}

/**
 * entrySource of a row's Check-Out Entered By, except that a blank one on an open row is
 * "pending": an open row has no check-out yet, so its blank was not typed into the sheet.
 */
function checkOutSource(entry) {
  if (isStatus(entry, "open") && !cellString(entry.outBy)) return "pending";
  return entrySource(entry.outBy);
}

/**
 * Whole hundredths of an hour from a raw Hours Served cell, read as Number(value) the way
 * minutesFromHours reads it: a finite value of 0 or more becomes Math.round(value * 100),
 * anything else (blank, text that isn't a number, a negative) is 0.
 *
 * The report's total of these is the sheet's plain SUM of column J over the same rows only
 * when every cell is a number of 0 or more. On a negative cell the report adds 0 and SUM
 * adds the negative; on a text cell such as "2.5" the report adds 2.50 and SUM adds
 * nothing. Every counted row whose stated hours cell is blank, text or negative is listed
 * for review, so the difference can always be found.
 */
function reportHundredths(value) {
  if (typeof value !== "number" && typeof value !== "string") return 0;
  const n = Number(value);
  return isFinite(n) && n >= 0 ? Math.round(n * 100) : 0;
}

/**
 * Whole cents from the Settings "Volunteer hour value" text. "$", commas and spaces are
 * dropped; what is left must be digits with up to two decimals. Returns null when the cell
 * is blank and NaN when it holds anything else that can't be read, so the report can say
 * which.
 */
function parseMoneyCents(text) {
  const given = cellString(text);
  if (!given) return null;
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(given.replace(/[$,\s]/g, ""));
  if (!m) return NaN;
  return Number(m[1]) * 100 + Number((m[2] || "").padEnd(2, "0"));
}

/**
 * The order rows are walked in: row date, then shift start (a row whose start can't be read
 * comes after those whose start can), then Log row. Only for rows that have a month.
 */
function reportRowOrder(a, b) {
  const da = cellString(a.dateText);
  const db = cellString(b.dateText);
  if (da !== db) return da < db ? -1 : 1;
  const sa = shiftStartMs(a);
  const sb = shiftStartMs(b);
  const ra = isFinite(sa);
  const rb = isFinite(sb);
  if (ra !== rb) return ra ? -1 : 1;
  if (ra && sa !== sb) return sa - sb;
  return a.row - b.row;
}

/** True when a Log row has nothing in Date, Volunteer Name, User Token, Status or Shift ID. */
function isBlankLogRow(entry) {
  return [entry.dateText, entry.name, entry.token, entry.status, entry.shiftId].every(
    (v) => cellString(v) === "",
  );
}

/** Each token's first shift: its earliest counted row with a month, in reportRowOrder. */
function firstShifts(entries) {
  const first = new Map();
  entries.forEach((e) => {
    if (!isCountedRow(e) || !monthKey(e.dateText)) return;
    const token = cellString(e.token);
    const known = first.get(token);
    if (!known || reportRowOrder(e, known) < 0) first.set(token, e);
  });
  return first;
}

/**
 * Total stated hours, shifts, volunteers and new volunteers for one month: {hundredths, shifts, headcount, newVolunteers (count)}.
 * first is firstShifts(entries).
 */
function monthFigures(entries, month, first) {
  let hundredths = 0;
  let shifts = 0;
  const tokens = new Set();
  entries.forEach((e) => {
    if (!isCountedRow(e) || monthKey(e.dateText) !== month) return;
    shifts += 1;
    hundredths += reportHundredths(e.statedHoursCell);
    tokens.add(cellString(e.token));
  });
  let newVolunteers = 0;
  tokens.forEach((t) => {
    if (monthKey(first.get(t).dateText) === month) newVolunteers += 1;
  });
  return { hundredths, shifts, headcount: tokens.size, newVolunteers };
}

/**
 * Labels for the volunteers of one month, as Map token -> {label, firstRow}. counted is
 * the month's counted rows, first is firstShifts(entries) over the whole Log.
 *
 * The label is the Volunteer Name on the token's latest counted row in the month ("(no
 * name)" when blank). When tokens share a label (by normalizeName), each gets " · first
 * shift yyyy-MM-dd", its first shift's date. When those also share a date, each gets
 * ", Log row N" too, N being its first shift's Log row. firstRow is that row; labels that
 * sort alike are ordered by it.
 */
function volunteerLabels(counted, first) {
  const latest = new Map();
  counted.forEach((e) => {
    const token = cellString(e.token);
    const known = latest.get(token);
    if (!known || reportRowOrder(e, known) > 0) latest.set(token, e);
  });
  const labels = new Map();
  latest.forEach((e, token) => {
    labels.set(token, { label: cellString(e.name) || "(no name)", firstRow: first.get(token).row });
  });
  const sameName = new Map();
  labels.forEach((v, token) => {
    const key = normalizeName(v.label);
    if (!sameName.has(key)) sameName.set(key, []);
    sameName.get(key).push(token);
  });
  sameName.forEach((tokens) => {
    if (tokens.length < 2) return;
    const byDate = new Map();
    tokens.forEach((t) => {
      const date = cellString(first.get(t).dateText);
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date).push(t);
    });
    tokens.forEach((t) => {
      const date = cellString(first.get(t).dateText);
      const v = labels.get(t);
      v.label += " · first shift " + date;
      if (byDate.get(date).length > 1) v.label += ", Log row " + v.firstRow;
    });
  });
  return labels;
}

/** Compares two {label, firstRow} by label (case and spacing ignored), then first shift row. */
function labelOrder(a, b) {
  const byLabel = normalizeName(a.label).localeCompare(normalizeName(b.label));
  return byLabel || a.firstRow - b.firstRow;
}

/**
 * Every milestone crossed in a month, as [{token, row, date, id, title}] ordered by date,
 * Log row, then milestones() order. For each token its counted rows with a month are walked
 * in reportRowOrder, each adding one shift and minutesFromHours of its stated hours, as the
 * kiosk counts at check-out. A milestone is crossed in the month when the row that reaches
 * its threshold is dated in the month. First completed shift is left out: it needs
 * Profiles' start date, and new volunteers already show first shifts.
 */
function milestonesCrossedIn(entries, month) {
  const byToken = new Map();
  entries.forEach((e) => {
    if (!isCountedRow(e) || !monthKey(e.dateText)) return;
    const token = cellString(e.token);
    if (!byToken.has(token)) byToken.set(token, []);
    byToken.get(token).push(e);
  });
  const list = milestones().filter((m) => !m.sinceLaunchOnly);
  const crossed = [];
  byToken.forEach((rows, token) => {
    rows.sort(reportRowOrder);
    let shifts = 0;
    let minutes = 0;
    rows.forEach((e) => {
      const afterShifts = shifts + 1;
      const afterMinutes = minutes + minutesFromHours(milestoneHours(e));
      if (monthKey(e.dateText) === month) {
        list.forEach((m, order) => {
          const hit =
            m.kind === "shifts"
              ? shifts < m.threshold && afterShifts >= m.threshold
              : minutes < m.threshold * 60 && afterMinutes >= m.threshold * 60;
          if (hit) {
            crossed.push({
              token,
              row: e.row,
              date: cellString(e.dateText),
              id: m.id,
              title: m.title,
              order,
            });
          }
        });
      }
      shifts = afterShifts;
      minutes = afterMinutes;
    });
  });
  crossed.sort((a, b) =>
    a.date !== b.date ? (a.date < b.date ? -1 : 1) : a.row - b.row || a.order - b.order,
  );
  return crossed.map((c) => ({
    token: c.token,
    row: c.row,
    date: c.date,
    id: c.id,
    title: c.title,
  }));
}

/**
 * The rows a month's report lists for review, as [{id, title, rows: [{row, date, name,
 * status, detail}]}] in this order, each group's rows by Log row:
 * - open: open rows in the month (they count nowhere);
 * - flagged: rows in the month whose Admin Alerts? isn't blank (detail: the alerts);
 * - admin: rows in the month with initials on either end (detail: "in JP, out JP");
 * - status: rows in the month whose Status isn't open or closed, blank included (not counted);
 * - source: rows in the month with an end typed into the sheet (blank) or entered by
 *   another source (detail names each such end);
 * - hours: counted rows in the month whose stated hours cell isn't a number of 0 or more
 *   (they add a shift and 0 hours, or a text number's hours);
 * - noToken: closed rows in the month with no User Token (not counted);
 * - noDate: rows anywhere in the Log whose Date isn't yyyy-MM-dd (in no month). Rows with
 *   nothing in Date, Volunteer Name, User Token, Status and Shift ID are not rows.
 */
function reviewGroups(entries, month) {
  const groups = [
    { id: "open", title: "Open shifts, not counted" },
    { id: "flagged", title: "Flagged rows (Admin Alerts? not blank)" },
    { id: "admin", title: "Rows entered by an admin (initials)" },
    { id: "status", title: "Rows whose Status is not open or closed, not counted" },
    { id: "source", title: "Rows with an end typed into the sheet or entered another way" },
    { id: "hours", title: "Counted shifts whose stated hours are blank, text or negative" },
    { id: "noToken", title: "Closed rows with no User Token, not counted" },
    { id: "noDate", title: "Rows anywhere in the Log whose Date isn't yyyy-MM-dd, in no month" },
  ].map((g) => ({ id: g.id, title: g.title, rows: [] }));
  const by = {};
  groups.forEach((g) => (by[g.id] = g.rows));
  const line = (e, detail) => ({
    row: e.row,
    date: cellString(e.dateText),
    name: cellString(e.name),
    status: cellString(e.status),
    detail: detail || "",
  });
  entries.forEach((e) => {
    const m = monthKey(e.dateText);
    if (!m) {
      if (!isBlankLogRow(e)) by.noDate.push(line(e, ""));
      return;
    }
    if (m !== month) return;
    const open = isStatus(e, "open");
    const closed = isStatus(e, "closed");
    const ends = [
      ["in", entrySource(e.inBy), cellString(e.inBy)],
      ["out", checkOutSource(e), cellString(e.outBy)],
    ];
    if (open) by.open.push(line(e, ""));
    if (cellString(e.alerts)) by.flagged.push(line(e, cellString(e.alerts)));
    const initials = ends.filter((x) => x[1] === "initials").map((x) => x[0] + " " + x[2]);
    if (initials.length) by.admin.push(line(e, initials.join(", ")));
    if (!open && !closed) by.status.push(line(e, ""));
    const odd = ends
      .filter((x) => x[1] === "typed" || x[1] === "other")
      .map((x) => x[0] + (x[1] === "typed" ? " typed into the sheet" : ' "' + x[2] + '"'));
    if (odd.length) by.source.push(line(e, odd.join(", ")));
    const j = e.statedHoursCell;
    if (isCountedRow(e) && !(typeof j === "number" && isFinite(j) && j >= 0)) {
      const shown = cellString(j);
      by.hours.push(line(e, shown ? 'stated hours "' + shown + '"' : "stated hours blank"));
    }
    if (closed && !cellString(e.token)) by.noToken.push(line(e, ""));
  });
  groups.forEach((g) => g.rows.sort((a, b) => a.row - b.row));
  return groups;
}

/**
 * Percent change as text with one decimal, rounded half away from zero: "+283.3%",
 * "-0.3%" for -0.25%, "0.0%" for no change, "n/a" when previous is 0. change and previous
 * are whole numbers (hundredths or counts), previous 0 or more.
 */
function percentChange(change, previous) {
  if (!previous) return "n/a";
  const tenths = Math.floor((2 * Math.abs(change) * 1000 + previous) / (2 * previous));
  if (!tenths) return "0.0%";
  return (change < 0 ? "-" : "+") + Math.floor(tenths / 10) + "." + (tenths % 10) + "%";
}

/**
 * Month over month: [{id, label, unit, current, previous, change, percent}] for stated hours
 * (unit "hours", values in hundredths), shifts, volunteers and new volunteers (unit
 * "count"). current and previous are monthFigures results.
 */
function monthOverMonth(current, previous) {
  return [
    ["hours", "Stated hours", "hours", "hundredths"],
    ["shifts", "Shifts", "count", "shifts"],
    ["headcount", "Volunteers", "count", "headcount"],
    ["newVolunteers", "New volunteers", "count", "newVolunteers"],
  ].map(([id, label, unit, key]) => {
    const change = current[key] - previous[key];
    return {
      id,
      label,
      unit,
      current: current[key],
      previous: previous[key],
      change,
      percent: percentChange(change, previous[key]),
    };
  });
}

/**
 * Hours and shifts per Role/Type or Activity over counted rows, as {columnMissing, groups:
 * [{label, shifts, hundredths}]}. Values group by trimmed text, case ignored, labelled with
 * the spelling on the group's earliest row; a blank reads "(not set)" and sorts last.
 */
function groupTable(counted, field, columnMissing) {
  const groups = new Map();
  counted
    .slice()
    .sort(reportRowOrder)
    .forEach((e) => {
      const text = columnMissing ? "" : cellString(e[field]);
      const key = text.toLowerCase();
      if (!groups.has(key))
        groups.set(key, { key, label: text || "(not set)", shifts: 0, hundredths: 0 });
      const g = groups.get(key);
      g.shifts += 1;
      g.hundredths += reportHundredths(e.statedHoursCell);
    });
  const list = Array.from(groups.values()).sort((a, b) => {
    if (!a.key !== !b.key) return a.key ? -1 : 1;
    return a.key.localeCompare(b.key);
  });
  return {
    columnMissing,
    groups: list.map((g) => ({ label: g.label, shifts: g.shifts, hundredths: g.hundredths })),
  };
}

/**
 * Every calculation of one month's report, from reportEntry rows of the whole Log. month is
 * "yyyy-MM". rateCents is parseMoneyCents of the Settings value: a number, null (blank) or
 * NaN (can't be read). cols is the reportColumns map, used only to tell whether Role/Type
 * and Activity are there; without it both are taken as present. No clock and no sheet.
 *
 * Returns {
 *   month, previousMonth, yearStart,
 *   hundredths, shifts, headcount,                       total stated hours, shifts, volunteers
 *   volunteers: [{label, shifts, hundredths}],           hours and shifts per volunteer, by label
 *   newVolunteers: [label],                              new volunteers, by label
 *   averageHundredths: number or null,                   average shift, null with no shifts
 *   weekdays: [{day, shifts, hundredths}],               by weekday, Monday to Sunday
 *   roleType, activity: {columnMissing, groups},         by Role/Type and by Activity
 *   adjustments: {compared, adjusted, statedMinusRecordedHundredths},   adjustments
 *   review: reviewGroups(entries, month), openCount,     rows to review, open count
 *   yearToDate: {hundredths, shifts, headcount},         year to date
 *   milestones: [{label, title, date, row}],             milestones crossed
 *   value: {rateCents, cents, message},                  volunteer value, cents null with a message
 *   monthOverMonth: monthOverMonth(...)                  month over month
 * }. Nothing in it is a User Token.
 */
function monthReport(entries, month, rateCents, cols) {
  const H = logHeaderNames();
  const missing = (header) =>
    Boolean(cols) && !(typeof cols[header] === "number" && cols[header] >= 0);
  const first = firstShifts(entries);
  const counted = entries.filter((e) => isCountedRow(e) && monthKey(e.dateText) === month);
  const labels = volunteerLabels(counted, first);
  const figures = monthFigures(entries, month, first);
  const before = previousMonth(month);

  const perToken = new Map();
  counted.forEach((e) => {
    const token = cellString(e.token);
    if (!perToken.has(token)) perToken.set(token, { shifts: 0, hundredths: 0 });
    const v = perToken.get(token);
    v.shifts += 1;
    v.hundredths += reportHundredths(e.statedHoursCell);
  });
  const volunteers = Array.from(perToken.keys())
    .map((t) => ({ ...labels.get(t), ...perToken.get(t) }))
    .sort(labelOrder)
    .map((v) => ({ label: v.label, shifts: v.shifts, hundredths: v.hundredths }));
  const newVolunteers = Array.from(perToken.keys())
    .filter((t) => monthKey(first.get(t).dateText) === month)
    .map((t) => labels.get(t))
    .sort(labelOrder)
    .map((v) => v.label);

  const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const weekdays = days.map((day) => ({ day, shifts: 0, hundredths: 0 }));
  counted.forEach((e) => {
    const w = weekdays[days.indexOf(weekdayName(cellString(e.dateText)))];
    w.shifts += 1;
    w.hundredths += reportHundredths(e.statedHoursCell);
  });

  // A compared row has all four times and a numeric recorded hours cell; menu rows have no
  // recorded times, so they are never compared. A row is adjusted when, on either end, the
  // stated and recorded times differ by at least one minute after rounding the gap to the
  // nearest minute, the arrival flag's rule (differsFlag with a threshold of 0): a gap of
  // 30 seconds or more is adjusted, one under 30 seconds is not.
  const readable = (ms) => typeof ms === "number" && isFinite(ms);
  let compared = 0;
  let adjusted = 0;
  let gap = 0;
  counted.forEach((e) => {
    const recorded = hoursCell(e.recordedHoursCell);
    const times = [e.recordedInMs, e.statedInMs, e.recordedOutMs, e.statedOutMs];
    if (!times.every(readable) || !isFinite(recorded) || recorded < 0) return;
    compared += 1;
    if (
      differsFlag("in", e.recordedInMs, e.statedInMs, 0) ||
      differsFlag("out", e.recordedOutMs, e.statedOutMs, 0)
    ) {
      adjusted += 1;
    }
    gap += reportHundredths(e.statedHoursCell) - reportHundredths(e.recordedHoursCell);
  });

  const review = reviewGroups(entries, month);
  const yearStart = month.slice(0, 4) + "-01";
  let ytdHundredths = 0;
  let ytdShifts = 0;
  const ytdTokens = new Set();
  entries.forEach((e) => {
    const m = monthKey(e.dateText);
    if (!isCountedRow(e) || !m || m < yearStart || m > month) return;
    ytdShifts += 1;
    ytdHundredths += reportHundredths(e.statedHoursCell);
    ytdTokens.add(cellString(e.token));
  });

  const rateReadable = typeof rateCents === "number" && isFinite(rateCents) && rateCents >= 0;
  let value;
  if (rateReadable) {
    value = {
      rateCents,
      cents: Math.round((figures.hundredths * rateCents) / 100),
      message: "",
    };
  } else if (rateCents === null || rateCents === undefined || rateCents === "") {
    value = { rateCents: null, cents: null, message: hourValueBlankMessage() };
  } else {
    value = { rateCents: null, cents: null, message: hourValueUnreadableMessage() };
  }

  return {
    month,
    previousMonth: before,
    yearStart,
    hundredths: figures.hundredths,
    shifts: figures.shifts,
    headcount: figures.headcount,
    volunteers,
    newVolunteers,
    averageHundredths: figures.shifts ? Math.round(figures.hundredths / figures.shifts) : null,
    weekdays,
    roleType: groupTable(counted, "roleType", missing(H.role)),
    activity: groupTable(counted, "activity", missing(H.activity)),
    adjustments: { compared, adjusted, statedMinusRecordedHundredths: gap },
    review,
    openCount: review[0].rows.length,
    yearToDate: { hundredths: ytdHundredths, shifts: ytdShifts, headcount: ytdTokens.size },
    milestones: milestonesCrossedIn(entries, month).map((m) => ({
      label: labels.get(m.token).label,
      title: m.title,
      date: m.date,
      row: m.row,
    })),
    value,
    monthOverMonth: monthOverMonth(figures, monthFigures(entries, before, first)),
  };
}

/** "11.50" from 1150 hundredths; with signed, "+11.50", "-0.15" or "0.00". */
function hoursText(hundredths, signed) {
  const abs = Math.abs(hundredths);
  const text = Math.floor(abs / 100) + "." + String(abs % 100).padStart(2, "0");
  if (!signed || !hundredths) return text;
  return (hundredths < 0 ? "-" : "+") + text;
}

/** "$40,008.50" from 4000850 cents. */
function moneyText(cents) {
  const dollars = String(Math.floor(cents / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return "$" + dollars + "." + String(cents % 100).padStart(2, "0");
}

/** The report's first lines' open-shift sentence, or "" when the month has none. */
function openShiftsLine(count) {
  if (!count) return "";
  return count === 1
    ? "1 open shift in this month is not counted. Close it with Fix a sign-out, then make the report again."
    : count +
        " open shifts in this month are not counted. Close them with Fix a sign-out, then make the report again.";
}

/**
 * The frozen report tab's cells, as {values, formats}: two rectangular arrays of the same
 * shape, to be written with setNumberFormats and then setValues. report is monthReport's
 * result, month its "yyyy-MM", initials the admin's (already normalized), madeAtText when
 * the report was made, such as "2026-12-01 9:14 AM".
 *
 * Every text cell has already been through sheetText and has the format "@" (plain text),
 * so no name or date is read as a formula or a date. Hours are numbers formatted "0.00",
 * counts and Log rows "0", value "$#,##0.00". Signed changes and percents are text. No
 * cell holds a User Token.
 */
function reportRows(report, month, initials, madeAtText) {
  const values = [];
  const formats = [];
  const T = (text) => [sheetText(text), "@"];
  const N = (n) => [n, "0"];
  const Hh = (hundredths) => [hundredths / 100, "0.00"];
  const add = (...cells) => {
    values.push(cells.map((c) => (Array.isArray(c) ? c[0] : sheetText(c))));
    formats.push(cells.map((c) => (Array.isArray(c) ? c[1] : "@")));
  };
  const blank = () => add("");
  const table = (title, header, rows, empty) => {
    blank();
    add(title);
    add(...header);
    if (!rows.length) add(empty || "(none)");
    rows.forEach((r) => add(...r));
  };

  add("Monthly report for " + monthName(month) + " (" + month + ")");
  add(
    "Counts closed shifts with a User Token, using stated hours. Made " +
      cellString(madeAtText) +
      " by " +
      cellString(initials) +
      " from the Log tab.",
  );
  if (report.openCount) add(openShiftsLine(report.openCount));

  blank();
  add("Summary");
  add("Stated hours", Hh(report.hundredths));
  add("Shifts", N(report.shifts));
  add("Volunteers", N(report.headcount));
  add("New volunteers", N(report.newVolunteers.length), report.newVolunteers.join(", "));
  add(
    "Average shift (hours)",
    report.averageHundredths === null ? "" : Hh(report.averageHundredths),
  );
  if (report.value.cents === null) {
    add("Volunteer value", report.value.message);
  } else {
    add(
      "Volunteer value",
      [report.value.cents / 100, "$#,##0.00"],
      "at " + moneyText(report.value.rateCents) + " an hour",
    );
  }
  const adj = report.adjustments;
  add("Adjusted shifts", N(adj.adjusted), "of " + adj.compared + " compared");
  add("Stated minus recorded (hours)", hoursText(adj.statedMinusRecordedHundredths, true));

  blank();
  add("Month over month", monthName(month), monthName(report.previousMonth), "Change", "% change");
  report.monthOverMonth.forEach((r) => {
    const amount = (n) => (r.unit === "hours" ? Hh(n) : N(n));
    const change =
      r.unit === "hours" ? hoursText(r.change, true) : (r.change > 0 ? "+" : "") + String(r.change);
    add(r.label, amount(r.current), amount(r.previous), change, r.percent);
  });

  blank();
  add("Year to date", monthName(report.yearStart) + " to " + monthName(month));
  add("Stated hours", Hh(report.yearToDate.hundredths));
  add("Shifts", N(report.yearToDate.shifts));
  add("Volunteers", N(report.yearToDate.headcount));

  const hoursRows = (list, labelKey) =>
    list.map((g) => [g[labelKey], N(g.shifts), Hh(g.hundredths)]);
  table(
    "Hours per volunteer",
    ["Volunteer", "Shifts", "Stated hours"],
    hoursRows(report.volunteers, "label"),
  );
  if (report.volunteers.length) add("Total", N(report.shifts), Hh(report.hundredths));
  table("Hours by weekday", ["Day", "Shifts", "Stated hours"], hoursRows(report.weekdays, "day"));
  [
    ["Role/Type", report.roleType],
    ["Activity", report.activity],
  ].forEach(([name, t]) => {
    const title = "Hours by " + name + (t.columnMissing ? " (no " + name + " column)" : "");
    table(title, [name, "Shifts", "Stated hours"], hoursRows(t.groups, "label"));
  });
  table(
    "Milestones crossed this month",
    ["Volunteer", "Milestone", "Date", "Log row"],
    report.milestones.map((m) => [m.label, m.title, m.date, N(m.row)]),
  );

  blank();
  add("Rows to review", "Log row numbers are as of when this report was made.");
  report.review.forEach((g) => {
    add(g.title + ": " + g.rows.length);
    if (!g.rows.length) return;
    add("Date", "Volunteer", "Status", "Log row", "Detail");
    g.rows.forEach((r) => add(r.date, r.name, r.status || "(blank)", N(r.row), r.detail));
  });

  const width = Math.max(...values.map((r) => r.length));
  values.forEach((r, i) => {
    while (r.length < width) {
      r.push("");
      formats[i].push("@");
    }
  });
  return { values, formats };
}

/**
 * The name of a new report tab: "Report 2026-11", or "Report 2026-11 (2)", "(3)" ... when
 * taken. Sheets tab names are unique without regard to case, so taken names are compared
 * that way.
 */
function reportTabName(month, existingNames) {
  const taken = new Set((existingNames || []).map((n) => cellString(n).toLowerCase()));
  const base = "Report " + month;
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) {
    const name = base + " (" + i + ")";
    if (!taken.has(name.toLowerCase())) return name;
  }
}

/**
 * The report dialog's months, as {months, defaultMonth}: every month with a dated Log row
 * up to the current month, plus the current month, newest first. A month after the current
 * one is left out, since a report for it is refused. defaultMonth is the month before the
 * current one when it is listed, else the current month. entries need only dateText;
 * todayDate is the Central yyyy-MM-dd.
 */
function reportMonths(entries, todayDate) {
  const current = monthKey(todayDate);
  const set = new Set([current]);
  entries.forEach((e) => {
    const m = monthKey(e.dateText);
    if (m && m <= current) set.add(m);
  });
  const months = Array.from(set).sort().reverse();
  const before = previousMonth(current);
  return { months, defaultMonth: months.indexOf(before) >= 0 ? before : current };
}

/**
 * The refusal for a report month, or null: ADMIN_BAD_MONTH unless it is "yyyy-MM" with a
 * month of 01 to 12, ADMIN_FUTURE when it is after todayDate's month.
 */
function reportMonthRefusal(month, todayDate) {
  const m = /^(\d{4})-(\d{2})$/.exec(cellString(month));
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return "ADMIN_BAD_MONTH";
  return m[0] > monthKey(todayDate) ? "ADMIN_FUTURE" : null;
}

/**
 * The downloads a report tab offers, by export format, each with the parameters that
 * follow its gid. Every export names the tab's gid, so it covers that one tab. A format is
 * added here, and then to reportDownloadUrls.
 */
function reportExportFormats() {
  return {
    csv: "",
    pdf: "&portrait=false&fitw=true&gridlines=false",
  };
}

/**
 * {csvUrl, pdfUrl}: the report tab gid of spreadsheet fileId as a CSV and as a PDF. Each
 * link downloads that tab only and works for anyone signed in with access to the file.
 */
function reportDownloadUrls(fileId, gid) {
  const base = "https://docs.google.com/spreadsheets/d/" + encodeURIComponent(fileId) + "/export?";
  const extra = reportExportFormats();
  const url = (format) => base + "format=" + format + "&gid=" + gid + extra[format];
  return { csvUrl: url("csv"), pdfUrl: url("pdf") };
}

/**
 * The Log headers that get a soft warning: the columns the kiosk and the menu fill. Not
 * Role/Type, Activity or Notes, which staff fill, nor Admin Alerts?, where staff may add
 * text that check-out keeps.
 */
function kioskWarnHeaders() {
  const H = logHeaderNames();
  return [
    H.date,
    H.day,
    H.name,
    H.recordedIn,
    H.statedIn,
    H.recordedOut,
    H.statedOut,
    H.recordedHours,
    H.statedHours,
    H.token,
    H.status,
    H.inBy,
    H.outBy,
    H.shiftId,
  ];
}

/** The column letter of a 0-based column index: 0 is A, 25 Z, 26 AA. */
function columnLetter(index) {
  if (typeof index !== "number" || !isFinite(index) || index < 0 || index % 1 !== 0) {
    throw new Error("There is no column at index " + index + ".");
  }
  let n = index + 1;
  let letters = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    letters = String.fromCharCode(65 + r) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

/** The column letter of a Log header in the map; throws the kiosk's message when it's missing. */
function logLetter(cols, header) {
  const at = cols[header];
  if (typeof at !== "number" || at < 0) throw missingLogColumnError(header);
  return columnLetter(at);
}

/** A tab name quoted for a formula reference. */
function quotedTab(name) {
  return "'" + String(name).replace(/'/g, "''") + "'";
}

/**
 * A formula giving a Date cell's (or column's) month as "yyyy-mm", or "": a date value
 * through TEXT, a text Date only when it is exactly yyyy-MM-dd and a real day. This is
 * monthKey's rule.
 */
function monthFormula(ref) {
  const t = "TRIM(" + ref + ")";
  return (
    "IF(ISNUMBER(" +
    ref +
    "), TEXT(" +
    ref +
    ', "yyyy-mm"), IFERROR(IF(TEXT(DATEVALUE(' +
    t +
    '), "yyyy-mm-dd") = ' +
    t +
    ", LEFT(" +
    t +
    ', 7), ""), ""))'
  );
}

/** A formula giving an Hours cell's whole hundredths: reportHundredths' rule. */
function hundredthsFormula(ref) {
  const v = "VALUE(TRIM(" + ref + "))";
  return (
    "IF(ISNUMBER(" +
    ref +
    "), IF(" +
    ref +
    " >= 0, ROUND(" +
    ref +
    " * 100), 0), IFERROR(IF(" +
    v +
    " >= 0, ROUND(" +
    v +
    " * 100), 0), 0))"
  );
}

/**
 * Everything setupReports writes on the Monthly Hours tab except B1, built from the Log's
 * header map so every Log reference uses the map's letters. logTab is the Log's tab name.
 *
 * Returns {
 *   cells: [{a1, value}]          every cell to write, a formula when value starts "=";
 *   formats: [{range, format}]    number formats to set;
 *   picker: {a1, listRange}       B1, a dropdown over the month list in listRange;
 *   hiddenColumns: [letter]       the columns to hide;
 *   rowCount                      rows the tab gets.
 * }
 *
 * Hidden H to L hold one formula spilling the picked month's rows, ordered as the report
 * orders them (row date, then shift start, unreadable starts last, then Log row): a
 * volunteer key, Volunteer Name, Status, Hours Served (stated) and Admin Alerts?. The key
 * is the Log row of the first row holding the row's User Token, found with XMATCH (exact,
 * no wildcards, though it ignores case), so volunteers are told apart and no token is
 * written on the tab. A row with no month is never picked, even with B1 blank. Every
 * visible formula reads that spill.
 *
 * Row 4 holds the month's stated hours, shifts, volunteers, average shift, and open and
 * flagged counts. Row 7 on holds one formula for hours and shifts per volunteer, grouped by the volunteer key only and labelled with the name on the key's latest
 * row in the spill, which is the name on the volunteer's latest counted row in the month, as
 * monthReport labels it. Two volunteers with one name show as two lines with that name;
 * the frozen report adds the first-shift date.
 *
 * Hidden N holds the month list: every month with a dated Log row up to the current month,
 * plus the current month, newest first, as reportMonths lists them.
 *
 * Where the live tab can differ from the frozen report: a time typed with no date counts
 * as a shift start here, while the report reads it as unreadable (this changes only which
 * name labels a volunteer with two rows on one date); a text hours cell is read with VALUE,
 * which reads a few texts Number doesn't, such as "50%" or "$5" (such rows are listed for
 * review); and TEXT and TODAY use the spreadsheet's time zone, where the report uses
 * Central.
 */
function monthlyHoursFormulas(cols, logTab) {
  const H = logHeaderNames();
  const tab = quotedTab(logTab || "Log");
  const col = (header) => {
    const letter = logLetter(cols, header);
    return tab + "!" + letter + "2:" + letter;
  };
  const date = col(H.date);
  const token = col(H.token);
  const statedIn = col(H.statedIn);
  const recordedIn = col(H.recordedIn);
  const day =
    "ARRAYFORMULA(IF(ISNUMBER(" +
    date +
    "), TEXT(" +
    date +
    ', "yyyy-mm-dd"), TRIM(' +
    date +
    ")))";
  const start =
    "ARRAYFORMULA(IF(ISNUMBER(" +
    statedIn +
    "), " +
    statedIn +
    ", IF(ISNUMBER(" +
    recordedIn +
    "), " +
    recordedIn +
    ", 1E+9)))";
  const spill =
    "=IFERROR(LET(" +
    "months, ARRAYFORMULA(" +
    monthFormula(date) +
    "), " +
    'picked, ARRAYFORMULA((months <> "") * (months = $B$1) = 1), ' +
    "allTokens, ARRAYFORMULA(TRIM(" +
    token +
    ")), " +
    "rowTokens, FILTER(allTokens, picked), " +
    'keys, ARRAYFORMULA(IF(rowTokens = "", "", XMATCH(rowTokens, allTokens) + 1)), ' +
    "SORT({keys, FILTER({" +
    [col(H.name), col(H.status), col(H.statedHours), col(H.alerts)].join(", ") +
    "}, picked)}, " +
    "FILTER(" +
    day +
    ", picked), TRUE, " +
    "FILTER(" +
    start +
    ", picked), TRUE, " +
    "FILTER(ARRAYFORMULA(ROW(" +
    date +
    ")), picked), TRUE)" +
    '), "")';

  const counted = '(LOWER(TRIM(J2:J)) = "closed") * (H2:H <> "")';
  const hundredths = hundredthsFormula("K2:K");
  const sumHundredths = "ARRAYFORMULA(SUM(IF(" + counted + ", " + hundredths + ", 0)))";
  const label = (rows) =>
    "IF(TRIM(INDEX(" +
    rows +
    ", ROWS(" +
    rows +
    '))) = "", "(no name)", TRIM(INDEX(' +
    rows +
    ", ROWS(" +
    rows +
    "))))";
  const perVolunteer =
    "=IFERROR(LET(" +
    "isCounted, ARRAYFORMULA(" +
    counted +
    " = 1), " +
    "keys, FILTER(H2:H, isCounted), " +
    "names, FILTER(I2:I, isCounted), " +
    "hours, FILTER(ARRAYFORMULA(" +
    hundredths +
    "), isCounted), " +
    "SORT({" +
    "MAP(UNIQUE(keys), LAMBDA(key, " +
    label("FILTER(names, keys = key)") +
    ")), " +
    "MAP(UNIQUE(keys), LAMBDA(key, ROWS(FILTER(keys, keys = key)))), " +
    "MAP(UNIQUE(keys), LAMBDA(key, SUM(FILTER(hours, keys = key)) / 100))" +
    '}, 1, TRUE)), "")';
  const monthList =
    "=LET(" +
    "months, ARRAYFORMULA(" +
    monthFormula(date) +
    "), " +
    'current, TEXT(TODAY(), "yyyy-mm"), ' +
    'SORT(UNIQUE({current; IFERROR(FILTER(months, months <> "", months <= current), current)}), 1, FALSE))';

  const cells = [
    { a1: "A1", value: "Month" },
    {
      a1: "C1",
      value:
        "Pick a month. This tab updates by itself and changes nothing in the Log. If it shows #REF!, ask the maintainer to run setupReports.",
    },
    { a1: "A3", value: "Stated hours" },
    { a1: "B3", value: "Shifts" },
    { a1: "C3", value: "Volunteers" },
    { a1: "D3", value: "Average shift (hours)" },
    { a1: "E3", value: "Open shifts not counted" },
    { a1: "F3", value: "Flagged rows" },
    { a1: "A4", value: "=" + sumHundredths + " / 100" },
    { a1: "B4", value: "=ARRAYFORMULA(SUM(" + counted + "))" },
    {
      a1: "C4",
      value: '=IFERROR(COUNTUNIQUE(FILTER(H2:H, LOWER(TRIM(J2:J)) = "closed", H2:H <> "")), 0)',
    },
    { a1: "D4", value: '=IF(B4 = 0, "", ROUND(' + sumHundredths + " / B4) / 100)" },
    { a1: "E4", value: '=ARRAYFORMULA(SUM((LOWER(TRIM(J2:J)) = "open") * 1))' },
    { a1: "F4", value: '=ARRAYFORMULA(SUM((TRIM(L2:L) <> "") * 1))' },
    { a1: "A6", value: "Volunteer" },
    { a1: "B6", value: "Shifts" },
    { a1: "C6", value: "Stated hours" },
    { a1: "A7", value: perVolunteer },
    { a1: "H1", value: "Volunteer key (first Log row of the volunteer)" },
    { a1: "I1", value: "Volunteer Name" },
    { a1: "J1", value: "Status" },
    { a1: "K1", value: "Hours Served (stated)" },
    { a1: "L1", value: "Admin Alerts?" },
    { a1: "H2", value: spill },
    { a1: "N1", value: monthList },
  ];
  return {
    cells,
    formats: [
      { range: "A4", format: "0.00" },
      { range: "B4:C4", format: "0" },
      { range: "D4", format: "0.00" },
      { range: "E4:F4", format: "0" },
      { range: "B7:B", format: "0" },
      { range: "C7:C", format: "0.00" },
    ],
    picker: { a1: "B1", listRange: "N1:N" },
    hiddenColumns: ["H", "I", "J", "K", "L", "N"],
    rowCount: monthlyHoursRowCount(),
  };
}

/**
 * The filter views setupReports keeps on the Log, as Sheets API v4 FilterView objects
 * without filterViewId: [{title, range: {sheetId}, filterSpecs}]. Each covers the whole
 * tab, so rows added later are included, and each condition is a custom formula on the
 * map's letters, written for row 2. Case is ignored as entrySource ignores it. A row with
 * nothing in Date, Volunteer Name, User Token, Status and Shift ID is never shown, so the
 * tab's empty rows stay out of the views.
 */
function filterViewSpecs(cols, sheetId) {
  const H = logHeaderNames();
  const ref = (header) => "$" + logLetter(cols, header) + "2";
  const t = (header) => "TRIM(" + ref(header) + ")";
  const status = "LOWER(" + t(H.status) + ")";
  const hasData =
    "OR(" +
    [H.date, H.name, H.token, H.status, H.shiftId].map((h) => t(h) + ' <> ""').join(", ") +
    ")";
  const isInitials = (header) =>
    "AND(REGEXMATCH(" + t(header) + ', "^[A-Za-z]{1,5}$"), LOWER(' + t(header) + ') <> "kiosk")';
  const isOther = (header) =>
    "AND(" +
    t(header) +
    ' <> "", LOWER(' +
    t(header) +
    ') <> "kiosk", NOT(REGEXMATCH(' +
    t(header) +
    ', "^[A-Za-z]{1,5}$")))';
  const month = monthFormula(ref(H.date));
  const views = [
    ["This month", month + ' = TEXT(TODAY(), "yyyy-mm")'],
    ["Last month", month + ' = TEXT(EDATE(TODAY(), -1), "yyyy-mm")'],
    ["Open shifts", status + ' = "open"'],
    ["Flagged", "AND(" + hasData + ", " + t(H.alerts) + ' <> "")'],
    ["Admin-entered", "OR(" + isInitials(H.inBy) + ", " + isInitials(H.outBy) + ")"],
    [
      "Typed into the sheet",
      "AND(" +
        hasData +
        ", OR(" +
        t(H.shiftId) +
        ' = "", ' +
        t(H.inBy) +
        ' = "", AND(' +
        status +
        ' <> "open", ' +
        t(H.outBy) +
        ' = "")))',
    ],
    [
      "Other status or source",
      "AND(" +
        hasData +
        ", OR(AND(" +
        status +
        ' <> "open", ' +
        status +
        ' <> "closed"), ' +
        isOther(H.inBy) +
        ", " +
        isOther(H.outBy) +
        "))",
    ],
  ];
  const dateColumn = cols[H.date];
  return views.map(([name, formula]) => ({
    title: filterViewTitlePrefix() + name,
    range: { sheetId },
    filterSpecs: [
      {
        columnIndex: dateColumn,
        filterCriteria: {
          condition: { type: "CUSTOM_FORMULA", values: [{ userEnteredValue: "=" + formula }] },
        },
      },
    ],
  }));
}

/**
 * The batchUpdate requests that bring the Log's filter views in line with specs
 * (filterViewSpecs). existing is the Log's current views, [{filterViewId, title}]. A spec
 * whose title an existing view has updates that view in place (the first one, by
 * filterViewId), so its link keeps working; any other spec is added. Views with other
 * titles are never named.
 */
function filterViewRequests(specs, existing) {
  return specs.map((spec) => {
    const found = (existing || []).find((v) => cellString(v.title) === spec.title);
    if (!found) return { addFilterView: { filter: spec } };
    return {
      updateFilterView: {
        filter: Object.assign({ filterViewId: found.filterViewId }, spec),
        fields: "title,range,filterSpecs",
      },
    };
  });
}

/** The tab setupReports builds for the live month table. */
function monthlyHoursTabName() {
  return "Monthly Hours";
}

/**
 * The first words of the description of each kind of protection the reports make.
 * setupReports finds its own protections by these and touches no other. No prefix starts
 * another, so one kind is never taken for another.
 * - kioskColumn: the soft warnings on the Log's kiosk columns. setupReports keeps them in
 *   line with the header map.
 * - monthlyHours: the Monthly Hours tab's warning. setupReports keeps one.
 * - reportTab: each report tab's warning, made once with the tab. setupReports never reads,
 *   edits or removes it.
 */
function reportProtectionPrefixes() {
  return {
    kioskColumn: "Kiosk column:",
    monthlyHours: "Monthly Hours tab:",
    reportTab: "Report tab:",
  };
}

/** The description of the Monthly Hours tab's warning-only protection. */
function monthlyHoursDescription() {
  return (
    reportProtectionPrefixes().monthlyHours +
    " setupReports writes this tab. Pick a month in B1; anything else typed here is replaced when setupReports runs again."
  );
}

/** The description of a report tab's warning-only protection. */
function reportTabDescription() {
  return (
    reportProtectionPrefixes().reportTab +
    " written once by the Kiosk admin menu's Monthly report, and never changed by the script. To correct it, fix the Log and make the report again."
  );
}

/**
 * Which of one tab's protections setupReports keeps, removes and adds. wanted lists the
 * range keys it wants protected; existing is the tab's protections in order, [{key,
 * description}]. Only a protection whose description starts with prefix is setupReports'
 * own. For each wanted key, the first own protection with that key is kept; every other own
 * protection is removed (a duplicate, or a column the header map no longer names); a wanted
 * key with none kept is added. A protection that isn't its own is never named, so a rerun
 * neither adds a second copy nor removes what staff, or the report menu, made.
 * Returns {keep: [index into existing], remove: [index], add: [key]}.
 */
function ownedProtectionPlan(wanted, existing, prefix) {
  const keep = [];
  const remove = [];
  const claimed = new Set();
  (existing || []).forEach((p, i) => {
    if (!cellString(p.description).startsWith(prefix)) return;
    const key = cellString(p.key);
    if (wanted.indexOf(key) >= 0 && !claimed.has(key)) {
      claimed.add(key);
      keep.push(i);
    } else {
      remove.push(i);
    }
  });
  const add = wanted.filter((key, i) => !claimed.has(key) && wanted.indexOf(key) === i);
  return { keep, remove, add };
}

/**
 * The month the Monthly Hours picker shows after setupReports: what the cell holds when it
 * is a "yyyy-MM" month as text, else todayDate's month. A date value in the cell (typed
 * before the cell was plain text) reads as yyyy-MM-dd and is replaced.
 */
function pickerMonth(cellText, todayDate) {
  const s = cellString(cellText);
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(s) ? s : monthKey(todayDate);
}

/**
 * What setupReports logs when it finishes. counts is {views: {added, updated}, warnings:
 * {kept, added, removed}}. It ends with the one thing staff must do by hand: the filter
 * views name Log columns by letter, so after a Log column is inserted, deleted or moved they
 * look at the wrong column until setupReports runs again.
 */
function setupReportsMessage(counts) {
  const v = counts.views;
  const w = counts.warnings;
  return [
    "setupReports finished.",
    "The " + monthlyHoursTabName() + " tab is written.",
    "Filter views: " + v.updated + " updated, " + v.added + " added.",
    "Kiosk column warnings: " + w.kept + " kept, " + w.added + " added, " + w.removed + " removed.",
    "The filter views name Log columns by letter. After a Log column is inserted, deleted or moved, they look at the wrong column until setupReports runs again, so run it again then.",
  ].join("\n");
}
