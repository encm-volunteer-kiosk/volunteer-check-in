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
  rows.push(
    ["Auto clock-out after hours", String(defaultAutoClockOutHours())],
    ["Auto clock-out last run", ""],
    ["Long shift flag hours", String(defaultLongShiftHours())],
    ["Flags email", "Off"],
    ["Flags email to", ""],
    ["Flags email day", defaultFlagsEmailDay()],
    ["Flags email hour", String(defaultFlagsEmailHour())],
    ["Flags email last run", ""],
    ["Daily jobs installed by", ""],
    ["Past hours file ID", ""],
    ["Past hours tab", "Historical Hours"],
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
    ALREADY_IN: "You're already checked in.",
    NOT_IN: "You're not checked in.",
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
 * Text written into a sheet cell, so the cell holds exactly the text. Sheets reads a
 * leading '=' as a formula and takes a leading apostrophe as its plain-text mark, dropping
 * it, so text starting with either gets one apostrophe more: "=1" is kept as "=1" and
 * "'Neil" as "'Neil", and each reads back as typed.
 */
function sheetText(text) {
  const s = cellString(text);
  const first = s.charAt(0);
  return first === "=" || first === "'" ? "'" + s : s;
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
 * and is never refused, whatever the date. Otherwise, in order: unreadable
 * (CHECKOUT_OTHER_DAY), future, then before startMs, the open shift's start. Equal to the
 * start is accepted. Any time from the start up to now is accepted, past midnight too, so
 * an evening shift can be checked out after midnight. Only when startMs is unreadable is
 * the time held to today instead (CHECKOUT_OTHER_DAY): there is no start to measure from.
 * outDate is the time's Central date.
 */
function validateCheckOut(nowMs, outMs, outDate, todayDate, startMs) {
  if (outMs === null) return { outMs: nowMs };
  const hasStart = typeof startMs === "number" && isFinite(startMs);
  // With a start, the time's own date is the date wanted, so no date is refused.
  const checked = checkStatedTime(nowMs, outMs, outDate, hasStart ? outDate : todayDate);
  if (checked.refused) return "CHECKOUT_" + checked.refused;
  if (hasStart && checked.ms < startMs) return "CHECKOUT_BEFORE_ARRIVAL";
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

/** The date Sheets gives a time typed with no date: day zero, 30 December 1899. */
function timeOnlyDate() {
  return "1899-12-30";
}

/**
 * A typed time of day as "HH:mm", or '' when text isn't one. Takes h:mm or h:mm:ss,
 * optionally followed by AM or PM in any case, with or without a space before it and
 * with or without dots ("9:00 AM", "9:00am", "9:00 p.m."). Hours run 1 to 12 with AM or
 * PM and 0 to 23 without; minutes and seconds 00 to 59. Seconds are dropped. "12:00 AM" is
 * midnight and "12:30 PM" half past noon.
 */
function clockText(text) {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*([ap])\.?\s*m\.?)?$/i.exec(cellString(text));
  if (!m || Number(m[2]) > 59 || (m[3] !== undefined && Number(m[3]) > 59)) return "";
  let hour = Number(m[1]);
  if (m[4]) {
    if (hour < 1 || hour > 12) return "";
    hour = (hour % 12) + (m[4].toLowerCase() === "p" ? 12 : 0);
  } else if (hour > 23) return "";
  return String(hour).padStart(2, "0") + ":" + m[2];
}

/**
 * A time cell's milliseconds on the row's Date day (yyyy-MM-dd), NaN when it isn't on that
 * day. t is read.time's {ms, date, clock}. A full date-time counts when its Central date
 * is day. A time with no date (a clock with date 1899-12-30, or a clock from text) is put
 * on day by read.at, and counts when the result is on day: a time skipped when daylight
 * time starts reads as the later time read.at gives, and NaN only if that is another day.
 * A read without at reads every time with no date as NaN.
 */
function rowTimeMs(t, day, read) {
  if (!t || !day) return NaN;
  if (t.date === day) return typeof t.ms === "number" && isFinite(t.ms) ? t.ms : NaN;
  const clock = cellString(t.clock);
  const noDate = t.date === timeOnlyDate() || cellString(t.date) === "";
  if (!clock || !noDate || !read || typeof read.at !== "function") return NaN;
  const on = read.at(day, clock);
  return on && on.date === day && typeof on.ms === "number" && isFinite(on.ms) ? on.ms : NaN;
}

/**
 * One Log row as the entry the rest of this file uses:
 * {row, shiftId, token, name, dateText, recordedInMs, statedInMs, recordedOutMs,
 * statedOutMs, recordedHours, statedHours, alerts, notes, status, outBy}. outBy is the
 * Check-Out Entered By text.
 *
 * cells is the row's raw values, row its sheet row number, cols the logColumns map. read
 * holds the functions the caller supplies: read.text(value) gives a cell as text (a date
 * as its Central yyyy-MM-dd), read.time(value) gives {ms, date, clock}, with date the
 * value's Central yyyy-MM-dd and clock its Central "HH:mm" when it has one, and
 * read.at(dateText, clock) gives {ms, date} for a Central "HH:mm" on a yyyy-MM-dd.
 *
 * Every time on a row is on that row's Date (rowTimeMs). A full date-time whose Central
 * date is the row's Date is kept. A time with no date, such as "9:00 AM" typed into the
 * cell (Sheets stores it on 1899-12-30) or typed as text, is read as that time on the
 * row's Date, to the minute. Anything else reads as NaN (unreadable), so a full date-time
 * on another day can't make a shift days long. Hours are NaN when blank.
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
    return rowTimeMs(read.time(value), day, read);
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
    outBy: text(H.outBy),
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
 * isTokenRow on a row's raw cells, before logEntry: the User Token cell is read exactly as
 * logEntry reads it, so this keeps exactly the rows whose entries isTokenRow keeps. A
 * blank token keeps no row. read is as for logEntry. It lets the kiosk parse only the
 * tapped volunteer's rows, which is all the check-in and check-out decisions look at.
 */
function logRowHasToken(cells, cols, token, read) {
  const at = cols[logHeaderNames().token];
  const cell = typeof at === "number" && at >= 0 ? cells[at] : "";
  return isTokenRow({ token: cellString(read.text(cell)) }, token);
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

/**
 * When the row was checked in, which is where its age is measured from: Check-In Recorded
 * (the tap) when it reads, else the start (shiftStartMs). NaN when neither reads. The tap,
 * not the stated arrival, because the arrival picker offers any earlier time of the day:
 * measured from a stated 8 AM, a volunteer tapping in at 4 PM could be out of the window
 * the moment the row is written. A row with no readable tap was typed or edited by hand,
 * and its start is the only time it has.
 */
function checkedInMs(entry) {
  return isFinite(entry.recordedInMs) ? entry.recordedInMs : shiftStartMs(entry);
}

/**
 * True when an open row is the tablet's at nowMs: its age (checkedInMs) is under windowMs,
 * the "Auto clock-out after hours" window. A row with no readable time has no age and is
 * the tablet's while it is dated todayDate. Once a row's age is at least the window it is
 * the auto clock-out's (autoClockOutRows) and no longer the tablet's, so a row is never
 * both.
 */
function isTabletOpenRow(entry, nowMs, windowMs, todayDate) {
  if (!isStatus(entry, "open")) return false;
  const at = checkedInMs(entry);
  if (isFinite(at)) return nowMs - at < windowMs;
  return isRowToday(entry.dateText, todayDate);
}

/**
 * This token's open row that the tablet can still check out (isTabletOpenRow), or null.
 * When staff edits left more than one, the latest start wins.
 */
function findOpenShift(entries, token, nowMs, windowMs, todayDate) {
  let found = null;
  entries.forEach((e) => {
    if (!isTokenRow(e, token) || !isTabletOpenRow(e, nowMs, windowMs, todayDate)) return;
    if (!found || shiftStartMs(e) > shiftStartMs(found)) found = e;
  });
  return found;
}

/**
 * The "Auto clock-out after hours" Settings value as milliseconds (parseAutoClockOutHours).
 */
function autoClockOutWindowMs(text) {
  return parseAutoClockOutHours(text) * 3600000;
}

/**
 * The Log dates the kiosk list reads: yesterday and today. Every readable time on a row is
 * on its Date (rowTimeMs) and the window is at most 24 hours, so a row still in the window
 * is dated one of these. The one exception is the night clocks spring forward with the
 * window at 24: a tap just before midnight two days back is still in it for that hour.
 * The list misses that row; check-in reads the whole Log and refuses with ALREADY_IN.
 */
function recentLogDates(todayDate) {
  return [addDays(todayDate, -1), todayDate];
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
 * checkedIn is the test check-in and check-out use, an open row the tablet can still
 * check out (findOpenShift), so it holds past midnight for the window after the tap, and
 * holds even when that row's start can't be read. openShiftArrival is that row's start,
 * or null when there is no such row or its start can't be read.
 */
function volunteerSummaries(volunteers, entries, nowMs, windowMs, todayDate) {
  return volunteers.map((v) => {
    const open = findOpenShift(entries, v.token, nowMs, windowMs, todayDate);
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

/**
 * True when this token's latest row dated on or after the launch date, in reportRowOrder,
 * is a check-out the volunteer didn't make: still open, or closed with a Check-Out Entered
 * By other than kiosk (the auto clock-out, an admin's Fix a sign-out or Add a shift, or a
 * row typed by hand). Read at check-in, before the new row is written, so the notice
 * shows once per missed check-out: the new row is the one looked at next time. An open
 * row found here has left the window, or the check-in would have been refused. False
 * when the launch date can't be read; rows before it, such as imported ones, never count.
 */
function missedSignOut(entries, token, launchDate) {
  const launch = parseStartDate(launchDate);
  if (!launch) return false;
  const rows = entries.filter((e) => {
    const date = rowDate(e.dateText);
    return isTokenRow(e, token) && date !== "" && date >= launch;
  });
  if (!rows.length) return false;
  const last = rows.slice().sort(reportRowOrder)[rows.length - 1];
  if (isStatus(last, "open")) return true;
  return isStatus(last, "closed") && entrySource(last.outBy) !== "kiosk";
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
 * '' or the Admin Alerts? text for a tablet check-out whose stated hours are more than
 * limitHours ("Long shift flag hours"): "long shift: 10.25 h stated, over 8 h". statedHours
 * is the Hours Served (stated) value the check-out writes, so the flag and the cell never
 * disagree; exactly limitHours is not flagged. Blank hours (no readable start) give ''.
 */
function longShiftAlert(statedHours, limitHours) {
  if (typeof statedHours !== "number" || !isFinite(statedHours)) return "";
  if (!(statedHours > limitHours)) return "";
  return (
    "long shift: " +
    hoursNumberText(statedHours) +
    " h stated, over " +
    hoursNumberText(limitHours) +
    " h"
  );
}

/** Hours as the alerts print them: up to 2 decimals, no trailing zeros ("8", "10.25", "8.5"). */
function hoursNumberText(hours) {
  return String(Math.round(hours * 100) / 100);
}

/**
 * The flags a kiosk check-out raises, in the order Admin Alerts? gets them: the check-out
 * flag when there is one, then the long-shift flag (longShiftAlert) when there is one,
 * then unreadableStartAlert() when the open row has no readable start. The Flags tab gets
 * one row for each, so it and Admin Alerts? never disagree.
 */
function checkOutFlags(open, flag, longFlag) {
  const flags = [];
  if (cellString(flag)) flags.push(cellString(flag));
  if (cellString(longFlag)) flags.push(cellString(longFlag));
  if (!hasReadableStart(open)) flags.push(unreadableStartAlert());
  return flags;
}

/**
 * The cells a kiosk check-out writes on the open row. nowMs is the tap (Check-Out
 * Recorded), statedOutMs the stated check-out, flag the check-out flag or '', longFlag the
 * long-shift flag or ''. Each hours
 * value pairs times of one kind and is blank when either is unreadable. Admin Alerts? is
 * written only when checkOutFlags has something to add, and then keeps what the cell
 * held. A row whose start can't be read closes with blank stated hours and an alert
 * saying so, not with a zero.
 */
function checkOutCells(open, nowMs, statedOutMs, flag, longFlag) {
  const H = logHeaderNames();
  const cells = {
    [H.recordedOut]: nowMs,
    [H.statedOut]: statedOutMs,
    [H.recordedHours]: pairHours(open.recordedInMs, nowMs),
    [H.statedHours]: pairHours(shiftStartMs(open), statedOutMs),
    [H.status]: "closed",
    [H.outBy]: "kiosk",
  };
  const flags = checkOutFlags(open, flag, longFlag);
  if (flags.length) cells[H.alerts] = sheetText(flags.reduce(appendText, open.alerts));
  return cells;
}

// ---------------------------------------------------------------------------
// Check-in and check-out decisions

/**
 * Checks a check-in in order: NOT_FOUND, phone, ALREADY_IN (an open row still in the
 * window, findOpenShift), ARRIVAL_FUTURE, ARRIVAL_OTHER_DAY. Input: {volunteers, id (the
 * tapped entry), digits, entries (the Log), todayDate, nowMs, windowMs, arrivedMs (null
 * for server time), arrivedDate, flagMinutes, launchDate}. Only the resolved volunteer's
 * rows (isTokenRow) are looked at, so entries may be those rows alone. Returns {refusal} or
 * {volunteer, arrivedMs, flag, flags, missedSignOut}; volunteer is the one
 * resolveVolunteer found, flag the arrival flag or '', flags the list the Flags tab gets:
 * [flag], or [] when nothing is flagged, and missedSignOut whether the volunteer's last
 * check-out was one they didn't make (missedSignOut).
 */
function decideCheckIn(input) {
  const who = resolveVolunteer(input.volunteers, input.id, input.digits);
  if (who.refusal) return { refusal: who.refusal };
  const volunteer = who.volunteer;
  if (findOpenShift(input.entries, volunteer.token, input.nowMs, input.windowMs, input.todayDate)) {
    return { refusal: "ALREADY_IN" };
  }
  const arrival = validateArrival(input.nowMs, input.arrivedMs, input.arrivedDate, input.todayDate);
  if (typeof arrival === "string") return { refusal: arrival };
  const flag = arrivalFlag(input.nowMs, arrival.arrivedMs, input.flagMinutes);
  return {
    volunteer,
    arrivedMs: arrival.arrivedMs,
    flag,
    flags: flag ? [flag] : [],
    missedSignOut: missedSignOut(input.entries, volunteer.token, input.launchDate),
  };
}

/**
 * Checks a check-out in order: NOT_FOUND, phone, NOT_IN (no open row in the window,
 * findOpenShift), then the stated check-out time (validateCheckOut). Input: {volunteers, id
 * (the tapped entry), digits, entries (the Log), todayDate, nowMs, windowMs, outMs
 * (null for server time), outDate, flagMinutes, longShiftHours (parseLongShiftHours),
 * launchDate}. Only the resolved volunteer's rows (isTokenRow) are looked at, so entries
 * may be those rows alone.
 *
 * Returns {refusal} or {volunteer, row, cells, minutes, milestone, statedOutMs, flags,
 * open}: volunteer is the one resolveVolunteer found, row the open row, cells its
 * check-out cell map, minutes the whole minutes this shift adds toward milestones, and the
 * milestone is counted from the closed rows before this one. flags is checkOutFlags, the
 * texts the cells add to Admin Alerts? (the long-shift flag among them when the stated
 * hours are more than longShiftHours), and open the open row's entry.
 */
function decideCheckOut(input) {
  const who = resolveVolunteer(input.volunteers, input.id, input.digits);
  if (who.refusal) return { refusal: who.refusal };
  const volunteer = who.volunteer;
  const open = findOpenShift(
    input.entries,
    volunteer.token,
    input.nowMs,
    input.windowMs,
    input.todayDate,
  );
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
  const longFlag = longShiftAlert(pairHours(shiftStartMs(open), out.outMs), input.longShiftHours);
  const cells = checkOutCells(open, input.nowMs, out.outMs, flag, longFlag);
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
    flags: checkOutFlags(open, flag, longFlag),
    open,
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
 * that only touch don't overlap. Rows whose start or end can't be read are skipped, and so
 * are rows whose end reads before their start (a check-out typed past midnight), which
 * have no window.
 */
function findOverlap(entries, token, date, startMs, endMs) {
  let found = null;
  entries.forEach((e) => {
    if (!isTokenRow(e, token) || !isStatus(e, "closed") || rowDate(e.dateText) !== date) return;
    const oldIn = shiftStartMs(e);
    const oldOut = shiftEndMs(e);
    if (!isFinite(oldIn) || !isFinite(oldOut) || oldOut < oldIn) return;
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
// a frozen report tab, and the texts setupReports writes (the
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
 * One Log row as a report reads it: logEntry's fields (outBy among them) plus inBy (the
 * Check-In Entered By text), roleType, activity (blank when the column is missing), and statedHoursCell and
 * recordedHoursCell, the raw Hours Served (stated) and (timestamps) values as the sheet
 * gave them, and timeKinds, the timeCellKind of the raw Date and four time cells as
 * {date, recordedIn, statedIn, recordedOut, statedOut}. Arguments as logEntry's.
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
  entry.roleType = text(H.role);
  entry.activity = text(H.activity);
  entry.statedHoursCell = raw(H.statedHours);
  entry.recordedHoursCell = raw(H.recordedHours);
  entry.timeKinds = {
    date: timeCellKind(raw(H.date)),
    recordedIn: timeCellKind(raw(H.recordedIn)),
    statedIn: timeCellKind(raw(H.statedIn)),
    recordedOut: timeCellKind(raw(H.recordedOut)),
    statedOut: timeCellKind(raw(H.statedOut)),
  };
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
 * comes after those whose start can), then Log row. The date is read as rowDate reads it,
 * so a Date typed as m/d/yyyy sorts among the yyyy-MM-dd ones; a Date it can't read is
 * compared as its text.
 */
function reportRowOrder(a, b) {
  const da = rowDate(a.dateText) || cellString(a.dateText);
  const db = rowDate(b.dateText) || cellString(b.dateText);
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
 * The frozen report tab's cells, as {values, formats, kinds}: values and formats are two
 * rectangular arrays of the same shape, to be written with setNumberFormats and then
 * setValues; kinds says what each row is, for its look (reportTabLook): "title" (the
 * first line), "section" (a section's or table's title), "header" (a table's column
 * headers), "blank" or "body". report is monthReport's
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
  const kinds = [];
  const N = (n) => [n, "0"];
  const Hh = (hundredths) => [hundredths / 100, "0.00"];
  const addAs = (kind, ...cells) => {
    values.push(cells.map((c) => (Array.isArray(c) ? c[0] : sheetText(c))));
    formats.push(cells.map((c) => (Array.isArray(c) ? c[1] : "@")));
    kinds.push(kind);
  };
  const add = (...cells) => addAs("body", ...cells);
  const blank = () => addAs("blank", "");
  const table = (title, header, rows, empty) => {
    blank();
    addAs("section", title);
    addAs("header", ...header);
    if (!rows.length) add(empty || "(none)");
    rows.forEach((r) => add(...r));
  };

  addAs("title", "Monthly report for " + monthName(month) + " (" + month + ")");
  add(
    "Counts closed shifts with a User Token, using stated hours. Made " +
      cellString(madeAtText) +
      " by " +
      cellString(initials) +
      " from the Log tab.",
  );
  if (report.openCount) add(openShiftsLine(report.openCount));

  blank();
  addAs("section", "Summary");
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
  addAs(
    "section",
    "Month over month",
    monthName(month),
    monthName(report.previousMonth),
    "Change",
    "% change",
  );
  report.monthOverMonth.forEach((r) => {
    const amount = (n) => (r.unit === "hours" ? Hh(n) : N(n));
    const change =
      r.unit === "hours" ? hoursText(r.change, true) : (r.change > 0 ? "+" : "") + String(r.change);
    add(r.label, amount(r.current), amount(r.previous), change, r.percent);
  });

  blank();
  addAs("section", "Year to date", monthName(report.yearStart) + " to " + monthName(month));
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
  addAs("section", "Rows to review", "Log row numbers are as of when this report was made.");
  report.review.forEach((g) => {
    addAs("section", g.title + ": " + g.rows.length);
    if (!g.rows.length) return;
    addAs("header", "Date", "Volunteer", "Status", "Log row", "Detail");
    g.rows.forEach((r) => add(r.date, r.name, r.status || "(blank)", N(r.row), r.detail));
  });

  const width = Math.max(...values.map((r) => r.length));
  values.forEach((r, i) => {
    while (r.length < width) {
      r.push("");
      formats[i].push("@");
    }
  });
  return { values, formats, kinds };
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

/**
 * The old live month tab, which the Hours tab replaces. setupReports deletes a tab of this
 * name once Hours reads back filled, and only when it carries the kiosk's protection.
 */
function monthlyHoursTabName() {
  return "Monthly Hours";
}

/**
 * The first words of the description of each kind of protection the reports make.
 * setupReports finds its own protections by these and touches no other. No prefix starts
 * another, so one kind is never taken for another.
 * - kioskColumn: the soft warnings on the Log's kiosk columns. setupReports keeps them in
 *   line with the header map.
 * - monthlyHours: the old Monthly Hours tab's warning. setupReports deletes that tab
 *   only when it carries this.
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
 * What setupReports logs when it finishes. counts is {views: {added, updated}, warnings:
 * {kept, added, removed}, hours: {asOf, monthlyHours}}: asOf is the Hours tables' time
 * (L1) as Central text, and monthlyHours what became of the old Monthly Hours tab:
 * "deleted", "unmarked" (a tab of that name without the kiosk's protection, left alone) or
 * "none". It ends with the things staff must do by hand: rerun setupDailyJobs once for the
 * nightly Hours refresh when the jobs were installed before it, and rerun setupReports
 * after a Log column moves, since the filter views name Log columns by letter.
 */
function setupReportsMessage(counts) {
  const v = counts.views;
  const w = counts.warnings;
  const h = counts.hours || {};
  const old = monthlyHoursTabName();
  const monthly = {
    deleted: "The " + old + " tab was deleted; the " + hoursTabName() + " tab replaces it.",
    unmarked:
      "A tab named " +
      old +
      " was left alone: it doesn't carry the kiosk's " +
      old +
      " protection, so it isn't the kiosk's. Delete it by hand when it's no longer needed.",
  }[h.monthlyHours];
  return [
    "setupReports finished.",
    "The " +
      hoursTabName() +
      " and " +
      hoursDataTabName() +
      " tabs are set up. " +
      hoursTabName() +
      " is filled as of " +
      cellString(h.asOf) +
      ".",
    monthly,
    "Filter views: " + v.updated + " updated, " + v.added + " added.",
    "Kiosk column warnings: " + w.kept + " kept, " + w.added + " added, " + w.removed + " removed.",
    "If the daily jobs were installed before this version, run setupDailyJobs once more for the nightly Hours refresh.",
    "The filter views name Log columns by letter. After a Log column is inserted, deleted or moved, they look at the wrong column until setupReports runs again, so run it again then.",
  ]
    .filter(Boolean)
    .join("\n");
}

// ---------------------------------------------------------------------------
// The Hours tab
//
// Hours data is a hidden tab of plain values the script writes: one row per counted shift
// with a month, worked out here by the monthly report's own counting code, so the Hours
// tab and the report count the same rows the same way. The Hours tab holds three pivot
// tables and five slicers over it. Nothing on either tab is a formula over the Log, so a
// kiosk tap starts no recalculation there; the tables are as of the last refresh.
//
// Hours data's row 1 also holds the refresh's state cells, L1 to Q1, outside the pivots'
// columns A to J. Every time in them is epoch milliseconds written as digits:
//   L1 table time   "<ms>": when the read behind the table in place started
//   M1 table state  "complete", "writing <ms>" or "stopped <ms>" (or "stopped")
//   N1 last event   "<kind>|<cause>|<T ms>|<W ms>|<message>"
//   O1 last write   "<read ms>|<work ms>|<write ms>|<rows>"
//   P1 digest       "sha256:<hex>" of the table and row 3's counts last written
//   Q1 build state  "building <ms>" or "built <ms>", written by setupReports only
// The tables are whole when M1 is "complete" and L1 is known. Every state cell, and the
// Hours tab's B1, is written only while the execution holds the document lock, and B1 is
// always hoursLine of the cells, so it never says the tables are whole when the cells
// don't. hoursNextState lists, for one hold, the writes the rule allows and their order.

/** The tab setupReports builds for the pivot tables and slicers. */
function hoursTabName() {
  return "Hours";
}

/** The hidden tab the refresh writes, the pivots' and slicers' source. */
function hoursDataTabName() {
  return "Hours data";
}

/**
 * The developer metadata setupReports puts on each tab it makes. A tab named Hours or
 * Hours data without its mark isn't the kiosk's: setupReports stops before changing
 * anything and the refresh writes nothing to it.
 */
function hoursTabMark() {
  return { key: "kiosk-tab", hours: "hours", data: "hours-data" };
}

/** Hours data's headers, columns A to J. */
function hoursDataHeaders() {
  return [
    "Date",
    "Year",
    "Month",
    "Weekday",
    "Start",
    "Volunteer",
    "Shifts",
    "Hours",
    "Role/Type",
    "Activity",
  ];
}

/**
 * Hours data's number formats, columns A to J: plain text for every text column, so
 * "2026-11" and "2026" are not read as a date or a number, "0" for Shifts and "0.00" for
 * Hours.
 */
function hoursDataFormats() {
  return ["@", "@", "@", "@", "@", "@", "0", "0.00", "@", "@"];
}

/** The state cells on Hours data, in order, and their range. */
function hoursStateCells() {
  return ["L1", "M1", "N1", "O1", "P1", "Q1"];
}

function hoursStateRange() {
  return "L1:Q1";
}

/**
 * The one range every pivot and slicer on the Hours tab reads: Hours data from row 1 with
 * no end row, columns A to J. Built here once so every spec holds an equal value.
 */
function hoursSourceRange(dataSheetId) {
  return { sheetId: dataSheetId, startRowIndex: 0, startColumnIndex: 0, endColumnIndex: 10 };
}

/** The row the Hours tab's pivots start on (A8, E8, K8). */
function hoursPivotRow() {
  return 8;
}

/**
 * The rows the Hours tab needs for a table of rows rows: the Shifts pivot at K8 puts one
 * line per shift below its header, so its last line is about hoursPivotRow() + rows, and
 * 200 spare rows cover its Grand Total and a refresh that adds a few rows. A pivot that
 * must add rows to its tab while a large setValues lands fails ("Service Spreadsheets
 * failed while accessing document"), so the tab gets these rows, in one call, before any
 * table write. The tab is never made smaller.
 */
function hoursTabRows(rows) {
  return hoursPivotRow() + Math.max(0, rows) + 200;
}

/** What Start holds when a row's start can't be read (an imported row has none). */
function hoursNoTime() {
  return "no time";
}

/** What Role/Type or Activity holds when blank or when the Log has no such column. */
function hoursNotSet() {
  return "(not set)";
}

/**
 * Text written into a Hours data text cell. A leading '=' gets sheetText's apostrophe, so
 * the cell holds the name and not a formula; the cells are plain text ("@") as well.
 */
function hoursCellText(text) {
  return sheetText(text);
}

/** Trimmed, with every run of spaces (newlines and tabs too) as one space. */
function hoursSpaced(text) {
  return cellString(text).replace(/\s+/g, " ");
}

/** The counted rows with a month, the rows Hours data lists, in reportRowOrder. */
function hoursRows(entries) {
  return (entries || [])
    .filter((e) => isCountedRow(e) && monthKey(e.dateText))
    .sort(reportRowOrder);
}

/**
 * The key two Hours labels are compared by: normalizeName, then upper case, then lower case
 * again. A pivot folds case through upper case, where "ß" becomes "SS", so it groups "Anna
 * Straße" with "ANNA STRASSE", which normalizeName keeps apart. Labels equal under
 * normalizeName have equal keys too, since the key is worked out from normalizeName's text.
 * normalizeName itself stays as it is: the kiosk's name matching uses it.
 */
function hoursLabelKey(text) {
  return normalizeName(normalizeName(text).toUpperCase());
}

/**
 * Each volunteer's label on the Hours tab, as Map token -> label, over the whole Log (every
 * counted row with a month). No two tokens end with labels equal under hoursLabelKey, so
 * no two volunteers share a line in a pivot.
 *
 * 1. A token's base label is the Volunteer Name on its latest counted row in
 *    reportRowOrder, spaced as hoursSpaced, or "(no name)" when that cell is blank.
 * 2. When two or more tokens have base labels equal under hoursLabelKey, each gets
 *    " · first shift yyyy-MM-dd", the Date of its first shift (firstShifts).
 * 3. Then, until no label is shared: each label not yet given a Log row that equals another
 *    token's under hoursLabelKey gets ", Log row N", N its first shift's Log row. A token
 *    gets this at most once. N is unique to its token and ends the label (the key changes
 *    no digit), so two labels with a Log row are never equal; each pass gives at least one
 *    token its Log row, so the loop ends within one pass per token.
 */
function hoursLabels(entries) {
  const rows = hoursRows(entries);
  const first = firstShifts(entries);
  const latest = new Map();
  rows.forEach((e) => latest.set(cellString(e.token), e));
  const labels = new Map();
  latest.forEach((e, token) => labels.set(token, hoursSpaced(e.name) || "(no name)"));
  const groups = () => {
    const by = new Map();
    labels.forEach((label, token) => {
      const key = hoursLabelKey(label);
      if (!by.has(key)) by.set(key, []);
      by.get(key).push(token);
    });
    return Array.from(by.values()).filter((tokens) => tokens.length > 1);
  };
  groups().forEach((tokens) =>
    tokens.forEach((t) =>
      labels.set(t, labels.get(t) + " · first shift " + cellString(first.get(t).dateText)),
    ),
  );
  const withRow = new Set();
  for (let pass = 0; pass <= labels.size; pass++) {
    const shared = groups();
    if (!shared.length) break;
    shared.forEach((tokens) =>
      tokens.forEach((t) => {
        if (withRow.has(t)) return;
        withRow.add(t);
        labels.set(t, labels.get(t) + ", Log row " + first.get(t).row);
      }),
    );
  }
  return labels;
}

/**
 * One spelling per group for a Role/Type or Activity field: Map normalizeName key ->
 * spelling, the value (spaced as hoursSpaced) on the group's latest row in rows, which are
 * in reportRowOrder. A pivot and a slicer merge values that differ only in case, and label
 * the group with whichever spelling survives a filter, so the table writes one.
 */
function hoursSpellings(rows, field) {
  const spelling = new Map();
  rows.forEach((e) => {
    const s = hoursSpaced(e[field]);
    if (s) spelling.set(normalizeName(s), s);
  });
  return spelling;
}

/**
 * Everything the refresh writes, from one read of the Log. entries are reportEntry rows
 * (readReportLog_); flags is readFlags_'s rows, or null when the Flags tab is missing or
 * its read threw; clock(ms) gives a Central "HH:mm".
 *
 * Returns {
 *   header        hoursDataHeaders();
 *   rows          Hours data's rows 2 down, one per counted row with a month, in
 *                 reportRowOrder: Date, Year, Month, Weekday, Start ("HH:mm" or "no
 *                 time"), Volunteer (hoursLabels), 1, Hours (reportHundredths of the stated
 *                 hours over 100), Role/Type and Activity (one spelling per group, or "(not
 *                 set)"). Text through hoursCellText; no User Token anywhere;
 *   counts        {open, alerts, unreviewedFlags (null without a Flags read), undatable}
 *                 over the whole Log: open rows, non-blank rows with Admin Alerts? set,
 *                 unreviewed Flags rows with a Volunteer Name or Shift ID, and counted rows
 *                 left out because their Date isn't yyyy-MM-dd;
 *   countsLine    the Hours tab's row 3, hoursCountsLine(counts);
 *   digestText    the text whose SHA-256 is P1: the rows and row 3 together.
 * }
 */
function hoursTable(entries, flags, clock) {
  const list = entries || [];
  const rows = hoursRows(list);
  const labels = hoursLabels(list);
  const roles = hoursSpellings(rows, "roleType");
  const activities = hoursSpellings(rows, "activity");
  const group = (spelling, value) =>
    hoursCellText(spelling.get(normalizeName(value)) || hoursNotSet());
  const table = rows.map((e) => {
    const date = cellString(e.dateText);
    const start = shiftStartMs(e);
    return [
      date,
      date.slice(0, 4),
      monthKey(date),
      weekdayName(date),
      isFinite(start) ? clock(start) : hoursNoTime(),
      hoursCellText(labels.get(cellString(e.token))),
      1,
      reportHundredths(e.statedHoursCell) / 100,
      group(roles, e.roleType),
      group(activities, e.activity),
    ];
  });
  const counts = {
    open: list.filter((e) => isStatus(e, "open")).length,
    alerts: list.filter((e) => !isBlankLogRow(e) && cellString(e.alerts) !== "").length,
    unreviewedFlags: flags
      ? flags.filter((f) => (cellString(f.name) || cellString(f.shiftId)) && !f.reviewed).length
      : null,
    undatable: list.filter((e) => isCountedRow(e) && !monthKey(e.dateText)).length,
  };
  const countsLine = hoursCountsLine(counts);
  return {
    header: hoursDataHeaders(),
    rows: table,
    counts,
    countsLine,
    digestText: JSON.stringify({ rows: table, countsLine }),
  };
}

/**
 * The Hours tab's row 3: counts that don't follow the slicers, each with where to look, as
 * of the last refresh. counts as hoursTable's; null before the first refresh.
 */
function hoursCountsLine(counts) {
  if (!counts) return "Counts at the last refresh show here once Hours is refreshed.";
  const flags =
    counts.unreviewedFlags === null || counts.unreviewedFlags === undefined
      ? "unreviewed Flags rows: Run setupSheets to add the Flags tab"
      : plural(counts.unreviewedFlags, "unreviewed Flags row", "unreviewed Flags rows") +
        " (see the Flags tab's " +
        flagsViewTitle() +
        " view)";
  return (
    "At the last refresh: " +
    [
      plural(counts.open, "open shift", "open shifts") +
        ", not counted (see the Log's " +
        filterViewTitlePrefix() +
        "Open shifts view)",
      plural(counts.alerts, "Log row", "Log rows") +
        " with Admin Alerts? set (see the Log's " +
        filterViewTitlePrefix() +
        "Flagged view)",
      flags,
      plural(counts.undatable, "counted row", "counted rows") +
        " left out because the Date can't be read (see the monthly report's rows to review)",
    ].join("; ") +
    "."
  );
}

/** "sha256:<hex>", the digest cell P1 holds, from the hex of hoursTable's digestText. */
function hoursDigestCell(hex) {
  return "sha256:" + String(hex).toLowerCase();
}

/** The four causes of a refresh, as N1 holds them, and how B1 says each. */
function hoursCauses() {
  return {
    open: "on open",
    menu: "from the menu",
    nightly: "nightly",
    setupReports: "by setupReports",
  };
}

/** The N1 kinds, and the messages an open-skipped note carries. */
function hoursNoteKinds() {
  return ["refreshed", "failed-read", "failed-write", "open-skipped"];
}

function hoursSkipReasons() {
  return ["note-only", "too-big", "no-timing"];
}

/**
 * N1's text: "<kind>|<cause>|<T>|<W>|<message>". A message has every run of spaces made
 * one space and every "|" made "/", and is cut to 100 characters.
 */
function hoursNoteCell(kind, cause, t, w, message) {
  const m = hoursSpaced(message).replace(/\|/g, "/").slice(0, 100);
  return [kind, cause, Math.round(t), Math.round(w), m].join("|");
}

/** O1's text from {readMs, workMs, writeMs, rows}. */
function hoursTimingCell(timing) {
  return [timing.readMs, timing.workMs, timing.writeMs, timing.rows]
    .map((n) => Math.max(0, Math.round(Number(n) || 0)))
    .join("|");
}

/** Digits as a number, from a text or a number cell; null for anything else. */
function hoursMs(value) {
  if (typeof value === "number")
    return isFinite(value) && value >= 0 && value % 1 === 0 ? value : null;
  const s = cellString(value);
  return /^\d{1,16}$/.test(s) ? Number(s) : null;
}

/**
 * The state cells read back: cells is [L1, M1, N1, O1, P1, Q1] as getValues gives them.
 * A cell that doesn't match its form reads as null (unknown); digits read as digits
 * whether the cell holds text or a number.
 *
 * Returns {
 *   tableTime   L1's ms, or null;
 *   table       {kind: "complete"}, {kind: "writing", ms} or {kind: "stopped", ms (null
 *               for a bare "stopped")}, or null;
 *   note        {kind, cause, t, w, message}, or null;
 *   lastWrite   {readMs, workMs, writeMs, rows}, or null;
 *   digest      "sha256:<hex>", or null;
 *   build       {kind: "building" or "built", ms}, or null.
 * }
 */
function hoursState(cells) {
  const c = cells || [];
  const text = (i) => cellString(c[i]);
  const tableTime = hoursMs(c[0]);
  let table = null;
  const m = text(1);
  if (m === "complete") table = { kind: "complete" };
  else if (m === "stopped") table = { kind: "stopped", ms: null };
  else {
    const hit = /^(writing|stopped) (\d{1,16})$/.exec(m);
    if (hit) table = { kind: hit[1], ms: Number(hit[2]) };
  }
  let note = null;
  const n = text(2).split("|");
  if (
    n.length === 5 &&
    hoursNoteKinds().indexOf(n[0]) >= 0 &&
    Object.prototype.hasOwnProperty.call(hoursCauses(), n[1]) &&
    hoursMs(n[2]) !== null &&
    hoursMs(n[3]) !== null &&
    (n[0] !== "open-skipped" || (n[1] === "open" && hoursSkipReasons().indexOf(n[4]) >= 0)) &&
    (n[0] !== "refreshed" || n[4] === "")
  ) {
    note = { kind: n[0], cause: n[1], t: Number(n[2]), w: Number(n[3]), message: n[4] };
  }
  let lastWrite = null;
  const o = text(3).split("|");
  if (o.length === 4 && o.every((x) => hoursMs(x) !== null)) {
    const [readMs, workMs, writeMs, rows] = o.map(Number);
    lastWrite = { readMs, workMs, writeMs, rows };
  }
  const p = text(4);
  const digest = /^sha256:[0-9a-f]{64}$/.test(p) ? p : null;
  let build = null;
  const q = /^(building|built) (\d{1,16})$/.exec(text(5));
  if (q) build = { kind: q[1], ms: Number(q[2]) };
  return { tableTime, table, note, lastWrite, digest, build };
}

/** True when the table in place is whole: M1 "complete" and L1 known. */
function hoursWhole(state) {
  return Boolean(
    state && state.table && state.table.kind === "complete" && state.tableTime !== null,
  );
}

/** "<message>." with no second full stop. */
function hoursSentence(text) {
  const s = hoursSpaced(text);
  return /[.!?]$/.test(s) ? s : s + ".";
}

/**
 * B1's line, a pure function of the state cells: a table part from Q1, M1 and L1, then a
 * note part from N1, joined. formatTime(ms) gives a Central "yyyy-MM-dd h:mm a".
 */
function hoursLine(state, formatTime) {
  const s = state || hoursState([]);
  const at = (ms) => formatTime(ms);
  const refresh = "use Kiosk admin > Refresh Hours";
  const causes = hoursCauses();
  let tablePart;
  let stoppedAt = null;
  let whole = false;
  if (!s.build || s.build.kind === "building") {
    tablePart = s.build
      ? "Hours is being set up by setupReports since " +
        at(s.build.ms) +
        "; if this stays over 5 minutes, run setupReports again."
      : "Hours is not set up: run setupReports.";
  } else if (s.table && s.table.kind === "writing") {
    tablePart =
      "Refreshing since " + at(s.table.ms) + ". If this stays over 5 minutes, " + refresh + ".";
  } else if (!hoursWhole(s)) {
    stoppedAt = s.table && s.table.kind === "stopped" ? s.table.ms : null;
    tablePart =
      (stoppedAt === null
        ? "A refresh stopped part way"
        : "A refresh at " + at(stoppedAt) + " stopped part way") +
      ", so the tables may be incomplete: " +
      refresh +
      ".";
  } else {
    whole = true;
    tablePart = "As of " + at(s.tableTime) + ".";
  }
  const n = s.note;
  if (!n) return tablePart;
  const cause = causes[n.cause];
  const failure = (what) =>
    "The refresh " +
    cause +
    " at " +
    at(n.t) +
    " " +
    what +
    (n.message ? ": " + hoursSentence(n.message) : ".");
  if (whole && n.kind === "refreshed" && n.t === s.tableTime) {
    return "As of " + at(s.tableTime) + ", refreshed " + cause + ".";
  }
  if (stoppedAt !== null && n.kind === "failed-write" && n.t === stoppedAt) {
    return failure("failed part way") + " The tables may be incomplete: " + refresh + ".";
  }
  let notePart;
  if (n.kind === "refreshed") notePart = "Refreshed " + cause + " at " + at(n.t) + ".";
  else if (n.kind === "failed-read") notePart = failure("failed before writing");
  else if (n.kind === "failed-write") notePart = failure("failed part way");
  else {
    const why = {
      "note-only": "",
      "too-big": " (the Log is too big to refresh on open now)",
      "no-timing": " (no write timing yet)",
    }[n.message];
    notePart = "Not refreshed on open at " + at(n.w) + why + ": " + refresh + " for newer taps.";
  }
  return tablePart + " " + notePart;
}

/** How long an open may take in all before its table write, and the lock wait counted in. */
function hoursOpenBudgetMs() {
  return 20000;
}

function hoursOpenLockWaitMs() {
  return 2000;
}

/**
 * The on-open budget check: "ok", "too-big" when the time since onOpen began, plus the
 * lock wait, plus O1's write time scaled by rowsNow over O1's rows (at least 1), is over
 * the budget, or "no-timing" when O1 is unknown. state is hoursState's.
 */
function hoursBudget(sinceOpenMs, state, rowsNow) {
  const o = state && state.lastWrite;
  if (!o) return "no-timing";
  const scale = Math.max(1, (Number(rowsNow) || 0) / Math.max(1, o.rows));
  const estimate = Number(sinceOpenMs) + hoursOpenLockWaitMs() + o.writeMs * scale;
  return estimate > hoursOpenBudgetMs() ? "too-big" : "ok";
}

/**
 * The state-cell writes one hold may make, in order, as {decision, steps}. Reports.js runs
 * the steps as listed; the model test plays the same list.
 *
 * state is hoursState of the cells read back after taking the lock (or again in a catch).
 * run is {cause ("open", "menu", "nightly" or "setupReports"), t (when this run's read of
 * the Log started), w (now, for a note), mark (the time this execution puts in M1's
 * "writing": t for a refresh, setupReports' start S), held (true when this hold has already
 * settled, so it isn't settled again), markWritten (true once this execution has written
 * its mark in this hold), digest (P1's text for the table read), rows (how many rows it
 * holds), budget (hoursBudget's answer, open only)}. outcome is one of:
 *   {kind: "read"}            the read worked: "newer-in" (a newer whole
 *                             table is in: no state cell), "skipped" (an open over its
 *                             budget: a note only), "unchanged" (an open whose table is
 *                             unchanged: L1 and a note only) or "write" (the full write);
 *   {kind: "failed", message} a throw: "failed-write" (this run's mark
 *                             is in M1), "failed-read", or "quiet" (no state cell);
 *   {kind: "note-only"}       an open that only notes it didn't refresh;
 *   {kind: "setup-start"}     setupReports before it changes either tab:
 *                             M1 "writing S", Q1 "building S";
 *   {kind: "setup-built"}     setupReports once the Hours tab is laid
 *                             out: Q1 "built S".
 *
 * Each step is {op: "set", cell, value}, {op: "set", cell: "O1", timing: true} (the
 * caller writes hoursTimingCell of its measured times), {op: "render"} (B1 from the cells
 * read back), {op: "flush"}, or a table change: "grow" (add rows to the Hours tab, in one
 * call, when it has fewer than hoursTabRows of the rows, so the Shifts pivot never grows
 * its tab during the write; then add rows to Hours data if it is short, with formats on
 * the new rows; neither tab is made smaller), "values" (one setValues of the rows),
 * "clear" (A2:J2, only when there are no rows), "trim" (delete Hours data's rows below the
 * last one kept), "counts" (row 3 on the Hours tab).
 *
 * The rule, clause by clause:
 * - Settle on entry: unless held, the first write is M1 "writing t" to "stopped t", or an
 *   unknown M1 to "stopped". Only the lock holder writes a table and it marks it complete
 *   in the same hold, so a "writing" a new holder sees belongs to a run that is gone.
 * - Ordered by read time: when the table in place is whole and L1 is t or later, the run
 *   writes no state cell ("newer-in", or "quiet" for a failure). setupReports is never
 *   stopped by this: its own "writing S" is in M1.
 * - Whole only after flush: M1 "writing <mark>", render, flush; the table changes, flush;
 *   L1, P1, O1, N1; M1 "complete" last; render; flush.
 * - One note per run, replacing N1 with no comparison.
 * - Every hold renders B1 after its state writes and ends with a render and a flush.
 */
function hoursNextState(state, run, outcome) {
  const steps = [];
  const set = (cell, value) => steps.push({ op: "set", cell, value });
  const render = () => steps.push({ op: "render" });
  const flush = () => steps.push({ op: "flush" });
  const end = (decision) => {
    render();
    flush();
    return { decision, steps };
  };
  let s = state || hoursState([]);
  if (!run.held) {
    if (s.table && s.table.kind === "writing") {
      set("M1", "stopped " + s.table.ms);
      s = Object.assign({}, s, { table: { kind: "stopped", ms: s.table.ms } });
    } else if (!s.table) {
      set("M1", "stopped");
      s = Object.assign({}, s, { table: { kind: "stopped", ms: null } });
    }
  }
  const ownMark =
    run.markWritten && s.table && s.table.kind === "writing" && s.table.ms === run.mark;
  const newerIn = run.cause !== "setupReports" && hoursWhole(s) && s.tableTime >= run.t;
  const note = (kind, t, message) => set("N1", hoursNoteCell(kind, run.cause, t, run.w, message));
  const kind = outcome && outcome.kind;

  if (kind === "setup-start") {
    // B1 is rendered between the two writes too, so no moment has B1 saying the tables
    // are whole while Q1 says building.
    set("M1", "writing " + run.mark);
    render();
    set("Q1", "building " + run.mark);
    return end("setup-start");
  }
  if (kind === "setup-built") {
    set("Q1", "built " + run.mark);
    return end("setup-built");
  }
  if (kind === "note-only") {
    set("N1", hoursNoteCell("open-skipped", "open", run.w, run.w, "note-only"));
    return end("note-only");
  }
  if (kind === "failed") {
    if (ownMark) {
      set("M1", "stopped " + run.mark);
      note("failed-write", run.mark, outcome.message);
      return end("failed-write");
    }
    if (run.cause === "setupReports" || newerIn) return end("quiet");
    note("failed-read", run.t, outcome.message);
    return end("failed-read");
  }
  if (newerIn) return end("newer-in");
  if (run.cause === "open" && run.budget && run.budget !== "ok") {
    note("open-skipped", run.t, run.budget);
    return end("skipped");
  }
  if (run.cause === "open" && hoursWhole(s) && run.digest && run.digest === s.digest) {
    set("L1", String(run.t));
    note("refreshed", run.t, "");
    return end("unchanged");
  }
  if (!ownMark) set("M1", "writing " + run.mark);
  render();
  flush();
  steps.push({ op: "grow" }, { op: "values" });
  if (!run.rows) steps.push({ op: "clear" });
  steps.push({ op: "trim" }, { op: "counts" });
  flush();
  set("L1", String(run.t));
  set("P1", run.digest);
  steps.push({ op: "set", cell: "O1", timing: true });
  note("refreshed", run.t, "");
  set("M1", "complete");
  return end("write");
}

/**
 * The Hours tab's row 2: how to use it. openPath is what opening the sheet does:
 * "refresh" (it refreshes), "note" (it only notes it didn't) or "none" (it writes nothing).
 */
function hoursUsageText(openPath) {
  const refreshes = openPath === "refresh";
  const first =
    openPath === "none"
      ? "The tables show the Log as of the time in B1, the last refresh from the menu, at night or by setupReports."
      : "The tables show the Log as of the time in B1. Newer taps show at the next refresh: " +
        (refreshes ? "when the sheet is opened, " : "") +
        "from Kiosk admin > Refresh Hours, and each night.";
  return (
    first +
    " Click a slicer to pick a year, month, role, activity or volunteer; clear them all for all time." +
    " Your picks are yours alone: nobody else sees them, and they're gone when you close the tab." +
    " To sort a table, click it and use Sort by in the editor that opens. setupReports resets sorts."
  );
}

/**
 * Everything setupReports puts on the Hours tab, and the look of Hours data, as plain data
 * and Sheets API requests. hoursSheetId and dataSheetId are the two tabs' sheet IDs;
 * openPath as hoursUsageText's.
 *
 * Returns {
 *   cells: [{a1, value}]   A1's title, row 2's text, row 3's line before the first refresh
 *                          (B1 is written only by the render);
 *   frozenRows             1;
 *   source                 hoursSourceRange(dataSheetId);
 *   formats, widths, heights, rules, pivots, slicers: Sheets API requests, by kind;
 *   requests               all of them in the order to send: formats, widths, heights,
 *                          rules (the three Grand Total rules first), pivots, slicers;
 *   data: {headers, formats, stateRange, tabColor}   Hours data's look;
 *   tabColor               the Hours tab's colour.
 * }
 *
 * Layout: row 1 the title and the refresh line in B1, not wrapped, overflowing C1:P1; row
 * 2 one merged cell A2:P2, wrapped, top-aligned, 66 px; row 3 one merged cell A3:P3 with
 * the counts; row 5 the slicers for Year, Month, Role/Type, Activity and Volunteer, left
 * to right from column A, each 240 px wide so its title shows in full and its value list
 * has room (at 165 px the titles were cut to "Ro..."); from row 8 the pivots Hours by
 * volunteer (A8), Hours by month (E8) and Shifts (K8), each filtered to Shifts = 1, a
 * column no slicer uses. Stripes and Grand Total rows come from rules keyed on each
 * pivot's first column, so they follow the pivot as it grows and shrinks; every body row
 * gets its fill from a rule, so the pivot's own grey band never shows. Widths are fixed
 * pixels, not fitted to content.
 */
function hoursTabPlan(hoursSheetId, dataSheetId, openPath) {
  const P = lookPalette();
  const navy = P.navy;
  const white = P.white;
  const band = P.band;
  const section = P.section;
  const id = hoursSheetId;
  const source = hoursSourceRange(dataSheetId);
  const range = (r0, r1, c0, c1) => {
    const g = { sheetId: id, startRowIndex: r0, startColumnIndex: c0, endColumnIndex: c1 };
    if (r1 !== null) g.endRowIndex = r1;
    return g;
  };
  const repeat = (gridRange, format, fields) => ({
    repeatCell: { range: gridRange, cell: { userEnteredFormat: format }, fields },
  });
  const color = lookColorStyle;

  const formats = [
    { unmergeCells: { range: range(0, 3, 0, 16) } },
    { mergeCells: { range: range(1, 2, 0, 16), mergeType: "MERGE_ALL" } },
    { mergeCells: { range: range(2, 3, 0, 16), mergeType: "MERGE_ALL" } },
    repeat(
      range(0, 3, 0, 16),
      { numberFormat: { type: "TEXT", pattern: "@" } },
      "userEnteredFormat.numberFormat",
    ),
    repeat(
      range(0, 1, 0, 1),
      {
        textFormat: {
          foregroundColorStyle: color(navy),
          fontSize: lookTitleFontSize(),
          bold: true,
        },
      },
      "userEnteredFormat.textFormat",
    ),
    repeat(range(0, 1, 1, 2), { wrapStrategy: "OVERFLOW_CELL" }, "userEnteredFormat.wrapStrategy"),
    repeat(
      range(1, 2, 0, 16),
      { wrapStrategy: "WRAP", verticalAlignment: "TOP" },
      "userEnteredFormat(wrapStrategy,verticalAlignment)",
    ),
    repeat(
      range(2, 3, 0, 16),
      {
        wrapStrategy: "WRAP",
        verticalAlignment: "TOP",
        backgroundColorStyle: color(section),
        textFormat: { foregroundColorStyle: color(navy) },
      },
      "userEnteredFormat(wrapStrategy,verticalAlignment,backgroundColorStyle,textFormat)",
    ),
  ];
  [
    [0, 3],
    [4, 9],
    [10, 16],
  ].forEach(([c0, c1]) =>
    formats.push(
      repeat(
        range(7, 8, c0, c1),
        {
          backgroundColorStyle: color(navy),
          textFormat: { foregroundColorStyle: color(white), bold: true },
          wrapStrategy: "WRAP",
        },
        "userEnteredFormat(backgroundColorStyle,textFormat,wrapStrategy)",
      ),
    ),
  );
  [
    [2, "0.00"],
    [6, "0.00"],
    [8, "0.00"],
    [15, "0.00"],
    [1, "0"],
    [5, "0"],
    [7, "0"],
  ].forEach(([c, pattern]) =>
    formats.push(
      repeat(
        range(8, null, c, c + 1),
        { numberFormat: { type: "NUMBER", pattern } },
        "userEnteredFormat.numberFormat",
      ),
    ),
  );

  const widths = [
    [0, 220],
    [1, 90],
    [2, 90],
    [3, 24],
    [4, 110],
    [5, 90],
    [6, 90],
    [7, 90],
    [8, 110],
    [9, 24],
    [10, 110],
    [11, 70],
    [12, 220],
    [13, 140],
    [14, 140],
    [15, 90],
  ].map(([c, pixelSize]) => ({
    updateDimensionProperties: {
      range: { sheetId: id, dimension: "COLUMNS", startIndex: c, endIndex: c + 1 },
      properties: { pixelSize },
      fields: "pixelSize",
    },
  }));
  const heights = [
    [1, 66],
    [2, 44],
  ].map(([r, pixelSize]) => ({
    updateDimensionProperties: {
      range: { sheetId: id, dimension: "ROWS", startIndex: r, endIndex: r + 1 },
      properties: { pixelSize },
      fields: "pixelSize",
    },
  }));

  const pivotsAt = [
    ["A", 0, 3],
    ["E", 4, 9],
    ["K", 10, 16],
  ];
  const rule = (c0, c1, formula, format) => ({
    ranges: [range(8, null, c0, c1)],
    booleanRule: {
      condition: { type: "CUSTOM_FORMULA", values: [{ userEnteredValue: formula }] },
      format,
    },
  });
  const ruleList = [];
  pivotsAt.forEach(([col, c0, c1]) =>
    ruleList.push(
      rule(c0, c1, "=$" + col + '9 = "Grand Total"', {
        backgroundColorStyle: color(section),
        textFormat: { bold: true },
      }),
    ),
  );
  [
    ["ISEVEN", band],
    ["ISODD", white],
  ].forEach(([parity, fill]) =>
    pivotsAt.forEach(([col, c0, c1]) =>
      ruleList.push(
        rule(
          c0,
          c1,
          "=AND($" + col + '9 <> "", $' + col + '9 <> "Grand Total", ' + parity + "(ROW()))",
          { backgroundColorStyle: color(fill) },
        ),
      ),
    ),
  );
  const rules = ruleList.map((r, index) => ({ addConditionalFormatRule: { index, rule: r } }));

  const counted = [
    {
      columnOffsetIndex: 6,
      filterCriteria: {
        condition: { type: "NUMBER_EQ", values: [{ userEnteredValue: "1" }] },
        visibleByDefault: true,
      },
    },
  ];
  const byVolunteer = {
    source,
    rows: [
      {
        sourceColumnOffset: 5,
        showTotals: true,
        sortOrder: "DESCENDING",
        valueBucket: { valuesIndex: 1 },
        label: "Volunteer",
      },
    ],
    values: [
      { sourceColumnOffset: 6, summarizeFunction: "SUM", name: "Shifts" },
      { sourceColumnOffset: 7, summarizeFunction: "SUM", name: "Hours" },
    ],
    filterSpecs: counted,
  };
  const byMonth = {
    source,
    rows: [{ sourceColumnOffset: 2, showTotals: true, sortOrder: "ASCENDING", label: "Month" }],
    values: [
      { sourceColumnOffset: 6, summarizeFunction: "SUM", name: "Shifts" },
      { sourceColumnOffset: 7, summarizeFunction: "SUM", name: "Hours" },
      { sourceColumnOffset: 5, summarizeFunction: "COUNTUNIQUE", name: "Volunteers" },
      { summarizeFunction: "CUSTOM", formula: "=SUM(Hours)/SUM(Shifts)", name: "Average shift" },
    ],
    filterSpecs: counted,
  };
  const shifts = {
    source,
    rows: [
      [0, "Date"],
      [4, "Start"],
      [5, "Volunteer"],
      [8, "Role/Type"],
      [9, "Activity"],
    ].map(([offset, label], i) => ({
      sourceColumnOffset: offset,
      showTotals: i === 0,
      sortOrder: i === 0 ? "DESCENDING" : "ASCENDING",
      repeatHeadings: true,
      label,
    })),
    values: [{ sourceColumnOffset: 7, summarizeFunction: "SUM", name: "Hours" }],
    filterSpecs: counted,
  };
  const pivots = [byVolunteer, byMonth, shifts].map((pivotTable, i) => ({
    updateCells: {
      rows: [{ values: [{ pivotTable }] }],
      start: { sheetId: id, rowIndex: hoursPivotRow() - 1, columnIndex: pivotsAt[i][1] },
      fields: "pivotTable",
    },
  }));

  const slicers = [
    [1, "Year"],
    [2, "Month"],
    [8, "Role/Type"],
    [9, "Activity"],
    [5, "Volunteer"],
  ].map(([columnIndex, title], i) => ({
    addSlicer: {
      slicer: {
        spec: { dataRange: source, columnIndex, title, applyToPivotTables: true },
        position: {
          overlayPosition: {
            anchorCell: { sheetId: id, rowIndex: 4, columnIndex: 0 },
            offsetXPixels: i * 250,
            offsetYPixels: 2,
            widthPixels: 240,
            heightPixels: 32,
          },
        },
      },
    },
  }));

  return {
    cells: [
      { a1: "A1", value: "Volunteer hours" },
      { a1: "A2", value: hoursUsageText(openPath) },
      { a1: "A3", value: hoursCountsLine(null) },
    ],
    frozenRows: 1,
    source,
    formats,
    widths,
    heights,
    rules,
    pivots,
    slicers,
    requests: [].concat(formats, widths, heights, rules, pivots, slicers),
    data: {
      headers: hoursDataHeaders(),
      formats: hoursDataFormats(),
      stateRange: hoursStateRange(),
      tabColor: lookTabColours().hoursData,
    },
    tabColor: lookTabColours().hours,
  };
}

// ---------------------------------------------------------------------------
// The Flags tab
//
// One row per flag, for staff to tick off as reviewed. The Log row is the record: Admin
// Alerts? keeps every kiosk flag, and a Flags row is a copy for review. The script only
// appends Flags rows. It reads the Flags header to place its writes; only the weekly
// flags email reads Flags rows back, and only to count and list them, so staff may sort,
// filter or delete rows. Reviewed By and Notes are staff's; the script writes Reviewed
// once, unticked, on the row it appends.

/** The Flags headers, keyed by the short names the code uses, in the order a new tab gets them. */
function flagHeaderNames() {
  return {
    date: "Date",
    name: "Volunteer Name",
    shiftId: "Shift ID",
    reason: "Reason",
    raisedAt: "Raised At",
    reviewed: "Reviewed",
    reviewedBy: "Reviewed By",
    notes: "Notes",
    source: "Source",
    logRow: "Log Row",
  };
}

/** The Flags header row a new tab gets. */
function flagHeaders() {
  const names = flagHeaderNames();
  return Object.keys(names).map((key) => names[key]);
}

/** The headers the script writes: every one except Reviewed By and Notes, which are staff's. */
function requiredFlagHeaders() {
  const F = flagHeaderNames();
  return flagHeaders().filter((h) => h !== F.reviewedBy && h !== F.notes);
}

/** Each Flags header's kind, which sets its number format: "text", "time", "checkbox" or "number". */
function flagColumnKinds() {
  const F = flagHeaderNames();
  const kinds = {};
  flagHeaders().forEach((h) => (kinds[h] = "text"));
  kinds[F.raisedAt] = "time";
  kinds[F.reviewed] = "checkbox";
  kinds[F.logRow] = "number";
  return kinds;
}

/**
 * Where a flag came from, the Source column. auto-close is the daily auto clock-out
 * (runAutoClockOut), import is Import past hours, log check is the Log check (nightly or
 * Kiosk admin > Check the Log now).
 */
function flagSources() {
  return {
    checkIn: "kiosk check-in",
    checkOut: "kiosk check-out",
    autoClose: "auto-close",
    import: "import",
    logCheck: "log check",
  };
}

/** The title of the filter view setupSheets keeps on the Flags tab. */
function flagsViewTitle() {
  return "Flags: Unreviewed";
}

/**
 * Maps each Flags header to its 0-based index in headerRow, comparing normalizeHeader
 * forms. A required header must be there exactly once, else this throws. Reviewed By and
 * Notes map to their leftmost column, or to -1 when there is none.
 */
function flagColumns(headerRow) {
  const required = requiredFlagHeaders();
  const cols = {};
  flagHeaders().forEach((h) => {
    const found = logHeaderIndexes(headerRow, h);
    if (required.indexOf(h) >= 0) {
      if (!found.length) {
        throw new Error(
          'The Flags tab has no "' + normalizeHeader(h) + '" column. Run setupSheets().',
        );
      }
      if (found.length > 1) {
        throw new Error(
          'The Flags tab has more than one "' +
            normalizeHeader(h) +
            '" column. Rename or remove the extra one.',
        );
      }
    }
    cols[h] = found.length ? found[0] : -1;
  });
  return cols;
}

/**
 * The header cells setupSheets writes in row 1 of the Flags tab, as [{col (1-based),
 * header}]. An empty row gets the full flagHeaders() from column A. Otherwise each
 * required header the row lacks goes into the empty cells to the right of the last
 * header, in flagHeaders() order. Reviewed By and Notes are not added: they are staff's.
 */
function flagHeaderWrites(headerRow) {
  let last = -1;
  headerRow.forEach((cell, i) => {
    if (cellString(cell) !== "") last = i;
  });
  if (last < 0) return flagHeaders().map((header, i) => ({ col: i + 1, header }));
  const missing = requiredFlagHeaders().filter((h) => logHeaderIndexes(headerRow, h).length === 0);
  return missing.map((header, i) => ({ col: last + 2 + i, header }));
}

/**
 * The kind of each Flags column of a header row, as [{col (1-based), kind}] in column
 * order, kind as in flagColumnKinds(). Columns with other headers are staff's and left out.
 */
function flagColumnFormats(headerRow) {
  const kinds = flagColumnKinds();
  const formats = [];
  flagHeaders().forEach((h) =>
    logHeaderIndexes(headerRow, h).forEach((i) => formats.push({ col: i + 1, kind: kinds[h] })),
  );
  return formats.sort((a, b) => a.col - b.col);
}

/**
 * The Flags rows for one call, one header-keyed map per reason. base is {date, name,
 * shiftId, raisedAtMs, source, logRow}: the Log row's Date, Volunteer Name and Shift ID,
 * the call's time, where the flag came from and the Log row number. Reviewed is false.
 * A blank reason gives no row. Throws when the Shift ID is empty, since it is the key that
 * finds the Log row. No User Token goes on a Flags row.
 */
function flagRows(base, reasons) {
  const b = base || {};
  if (!cellString(b.shiftId)) throw new Error("A Flags row can't be written without a Shift ID.");
  const F = flagHeaderNames();
  return (reasons || [])
    .filter((reason) => cellString(reason) !== "")
    .map((reason) => ({
      [F.date]: sheetText(b.date),
      [F.name]: sheetText(b.name),
      [F.shiftId]: sheetText(b.shiftId),
      [F.reason]: sheetText(reason),
      [F.raisedAt]: b.raisedAtMs,
      [F.reviewed]: false,
      [F.source]: sheetText(b.source),
      [F.logRow]: b.logRow,
    }));
}

/**
 * One Flags row map (flagRows) as a row of width cells, each value under its header's
 * column in cols (flagColumns) and blank elsewhere. Raised At stays in milliseconds, or
 * blank when it isn't a number; Log Row is blank when it isn't a number. Throws on a key
 * that isn't a Flags header, or whose column the tab lacks.
 */
function flagRowValues(cells, cols, width) {
  const kinds = flagColumnKinds();
  const row = Array.from({ length: width }, () => "");
  Object.keys(cells).forEach((key) => {
    if (!kinds[key]) throw new Error('"' + normalizeHeader(key) + '" is not a Flags header.');
    const at = cols[key];
    if (typeof at !== "number" || at < 0 || at >= width) {
      throw new Error(
        'The Flags tab has no "' + normalizeHeader(key) + '" column. Run setupSheets().',
      );
    }
    let value = cells[key];
    if (kinds[key] === "time" || kinds[key] === "number") {
      value = typeof value === "number" && isFinite(value) ? value : "";
    } else if (kinds[key] === "text") {
      value = value === null || value === undefined ? "" : String(value);
    }
    row[at] = value;
  });
  return row;
}

/**
 * The batchUpdate request that keeps the "Flags: Unreviewed" filter view on the Flags tab:
 * rows with a Shift ID whose Reviewed isn't ticked, newest Raised At first. cols is the
 * flagColumns map, sheetId the tab's, existingViewId the id of the view with that title
 * when there is one: that view is updated in place, so its link keeps working; otherwise
 * one is added. Returns a list of one request.
 */
function flagFilterViewRequests(cols, sheetId, existingViewId) {
  const F = flagHeaderNames();
  const letter = (header) => "$" + columnLetter(cols[header]) + "2";
  const formula = "=AND(TRIM(" + letter(F.shiftId) + ') <> "", ' + letter(F.reviewed) + " <> TRUE)";
  const view = {
    title: flagsViewTitle(),
    range: { sheetId },
    filterSpecs: [
      {
        columnIndex: cols[F.reviewed],
        filterCriteria: {
          condition: { type: "CUSTOM_FORMULA", values: [{ userEnteredValue: formula }] },
        },
      },
    ],
    sortSpecs: [{ dimensionIndex: cols[F.raisedAt], sortOrder: "DESCENDING" }],
  };
  if (existingViewId === null || existingViewId === undefined || existingViewId === "") {
    return [{ addFilterView: { filter: view } }];
  }
  return [
    {
      updateFilterView: {
        filter: Object.assign({ filterViewId: existingViewId }, view),
        fields: "title,range,filterSpecs,sortSpecs",
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// The look of the kiosk's tabs
//
// One palette for every tab the kiosk keeps: the kiosk page's colours (src/index.css) and
// light tints of them, so the sheet and the tablet look like one thing. setupSheets puts
// the look on the Log, Flags and Settings on every run (lookPlan, lookRequests, then
// applyLook_ in Sheets.js); a report tab gets its look once, when it is written
// (reportTabLook). Every conditional format rule the kiosk makes carries lookMarker() in
// its formula, so a later run finds its own rules and replaces them, keeps every rule
// staff made, and keeps staff's rules first in the tab's list (lookRuleRequests).

/**
 * The palette, as "#rrggbb", by use:
 * - navy: header of a column the script writes (white bold text); title and section text.
 * - teal: header of a column staff fill (white bold text).
 * - white and band: the two row bands; band is a tint of the page's light blue.
 * - open: an open shift's row on the Log (a tint of yellow).
 * - alert: an Admin Alerts? cell with text on the Log (a tint of the error red).
 * - reviewed: the text of a reviewed flag on Flags (lighter than the page's muted grey).
 * - section: a section heading's fill (the page's light blue).
 * - yellow, grey, blue: tab colours (lookTabColours).
 */
function lookPalette() {
  return {
    navy: "#062f5a",
    teal: "#168c86",
    white: "#ffffff",
    band: "#eef7fc",
    open: "#fff4d6",
    alert: "#fbe3e2",
    reviewed: "#8a9aa8",
    section: "#dff3fb",
    yellow: "#f9bd2f",
    grey: "#52687b",
    blue: "#0669a9",
  };
}

/** Each tab's colour, from lookPalette. hoursData is for when that tab is shown. */
function lookTabColours() {
  const P = lookPalette();
  return {
    log: P.navy,
    flags: P.yellow,
    settings: P.grey,
    hours: P.teal,
    hoursData: P.grey,
    report: P.blue,
  };
}

/** A title's font size in points (Hours and report tabs); titles are navy and bold. */
function lookTitleFontSize() {
  return 14;
}

/** The height of a header row the look styles, in pixels. */
function lookHeaderHeight() {
  return 40;
}

/**
 * The marker in every conditional format rule the kiosk makes. N of a text is 0, so
 * lookFormula's "N(...) = 0" is always true and changes nothing; it is there to be found.
 */
function lookMarker() {
  return 'N("kiosk look")';
}

/** A conditional format formula carrying the marker: =AND(N("kiosk look") = 0, condition). */
function lookFormula(condition) {
  return "=AND(" + lookMarker() + " = 0, " + condition + ")";
}

/**
 * True when a conditional format rule, as the Sheets API gives it, is one the kiosk made:
 * one of its condition's values holds the marker's text. Gradient rules and every other
 * rule are staff's.
 */
function isLookRule(rule) {
  const values =
    (rule && rule.booleanRule && rule.booleanRule.condition && rule.booleanRule.condition.values) ||
    [];
  return values.some((v) => cellString(v && v.userEnteredValue).indexOf('"kiosk look"') >= 0);
}

/** A "#rrggbb" colour as the Sheets API's {red, green, blue}, each 0 to 1. */
function lookRgb(hex) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(cellString(hex));
  if (!m) throw new Error("Not a #rrggbb colour: " + hex);
  return {
    red: parseInt(m[1], 16) / 255,
    green: parseInt(m[2], 16) / 255,
    blue: parseInt(m[3], 16) / 255,
  };
}

/** A colour as the Sheets API's ColorStyle. */
function lookColorStyle(hex) {
  return { rgbColor: lookRgb(hex) };
}

/**
 * The batchUpdate requests that replace the kiosk's conditional format rules on a tab and
 * keep staff's. existing is the tab's conditionalFormats as the Sheets API lists them, in
 * order; rules are the new rules as the API's ConditionalFormatRule objects whose ranges
 * leave out sheetId, which each range gets here. Every kiosk rule
 * (isLookRule) is deleted, from the last up so the indexes hold; staff's rules keep their
 * order and stay first; the new rules follow them in the order given, where Sheets
 * applies the first rule in the list that matches a cell. Shared by every tab the kiosk
 * styles with rules.
 */
function lookRuleRequests(sheetId, existing, rules) {
  const list = existing || [];
  const requests = [];
  for (let i = list.length - 1; i >= 0; i--) {
    if (isLookRule(list[i])) requests.push({ deleteConditionalFormatRule: { sheetId, index: i } });
  }
  const staff = list.length - requests.length;
  (rules || []).forEach((rule, i) => {
    const placed = Object.assign({}, rule, {
      ranges: rule.ranges.map((r) => Object.assign({ sheetId }, r)),
    });
    requests.push({ addConditionalFormatRule: { index: staff + i, rule: placed } });
  });
  return requests;
}

/**
 * The look's columns for a tab, as [{header, colour, width}] with colour "navy" (the
 * script writes the column) or "teal" (staff fill it) and width in pixels. tab is "log",
 * "flags" or "settings".
 */
function lookColumns(tab) {
  const col = (header, colour, width) => ({ header, colour, width });
  if (tab === "log") {
    const H = logHeaderNames();
    return [
      col(H.date, "navy", 95),
      col(H.day, "navy", 90),
      col(H.name, "navy", 170),
      col(H.role, "teal", 130),
      col(H.recordedIn, "navy", 150),
      col(H.statedIn, "navy", 150),
      col(H.recordedOut, "navy", 150),
      col(H.statedOut, "navy", 150),
      col(H.recordedHours, "navy", 95),
      col(H.statedHours, "navy", 95),
      col(H.alerts, "navy", 220),
      col(H.activity, "teal", 130),
      col(H.notes, "teal", 260),
      col(H.token, "navy", 120),
      col(H.status, "navy", 75),
      col(H.inBy, "navy", 95),
      col(H.outBy, "navy", 95),
      col(H.shiftId, "navy", 120),
    ];
  }
  if (tab === "flags") {
    const F = flagHeaderNames();
    return [
      col(F.date, "navy", 95),
      col(F.name, "navy", 170),
      col(F.shiftId, "navy", 120),
      col(F.reason, "navy", 260),
      col(F.raisedAt, "navy", 150),
      col(F.reviewed, "teal", 80),
      col(F.reviewedBy, "teal", 95),
      col(F.notes, "teal", 260),
      col(F.source, "navy", 90),
      col(F.logRow, "navy", 75),
    ];
  }
  if (tab === "settings") {
    return [col("Setting", "navy", 230), col("Value", "teal", 380)];
  }
  throw new Error("No look for a tab called " + tab + ".");
}

/**
 * The look of the Log, Flags or Settings tab (tab "log", "flags" or "settings") for its
 * header row, as plain data that lookRequests turns into Sheets API requests:
 * - width: the header's columns, from A to the last header with text.
 * - headerColours: one "#rrggbb" per header cell, navy or teal by lookColumns; a header
 *   the look doesn't know, or a blank cell between headers, is staff's: teal.
 * - widths: [{col (0-based), px}] for the headers the look knows; a staff column's width
 *   is left alone. A header found twice gets its width in both places.
 * - wrapColumns: 0-based columns wrapped from top to bottom (Settings' Value).
 * - banding: one row banding from row 2 over the header's columns, white then band, with
 *   no end row: Sheets keeps it to the tab's last row, and rows the kiosk appends at the
 *   end extend it. null when the header is empty.
 * - rules: the conditional formats, each from row 2 down with no end row and the marker in
 *   its formula, columns named by letter. Log: an Admin Alerts? cell with text, then an
 *   open row (Status "open", any case), so an alert's colour shows on an open row. Flags:
 *   a ticked Reviewed greys the row's text. A rule whose column the header lacks is left
 *   out.
 * - tabColour.
 */
function lookPlan(headerRow, tab) {
  const columns = lookColumns(tab);
  const P = lookPalette();
  const header = headerRow || [];
  let width = 0;
  header.forEach((cell, i) => {
    if (cellString(cell) !== "") width = i + 1;
  });
  const headerColours = [];
  const widths = [];
  for (let i = 0; i < width; i++) {
    const known = columns.find((c) => normalizeHeader(c.header) === normalizeHeader(header[i]));
    headerColours.push(known ? P[known.colour] : P.teal);
    if (known) widths.push({ col: i, px: known.width });
  }
  const first = (h) => {
    const found = logHeaderIndexes(header.slice(0, width), h);
    return found.length ? found[0] : -1;
  };
  const rule = (startCol, endCol, condition, format) => ({
    ranges: [{ startRowIndex: 1, startColumnIndex: startCol, endColumnIndex: endCol }],
    booleanRule: {
      condition: { type: "CUSTOM_FORMULA", values: [{ userEnteredValue: lookFormula(condition) }] },
      format,
    },
  });
  const fill = (hex) => ({ backgroundColorStyle: lookColorStyle(hex) });
  const rules = [];
  const wrapColumns = [];
  if (tab === "log") {
    const H = logHeaderNames();
    const alerts = first(H.alerts);
    const status = first(H.status);
    if (alerts >= 0) {
      const a = columnLetter(alerts);
      rules.push(rule(alerts, alerts + 1, "TRIM($" + a + '2) <> ""', fill(P.alert)));
    }
    if (status >= 0) {
      const s = columnLetter(status);
      rules.push(rule(0, width, "LOWER(TRIM($" + s + '2)) = "open"', fill(P.open)));
    }
  } else if (tab === "flags") {
    const reviewed = first(flagHeaderNames().reviewed);
    if (reviewed >= 0) {
      rules.push(
        rule(0, width, "$" + columnLetter(reviewed) + "2 = TRUE", {
          textFormat: { foregroundColorStyle: lookColorStyle(P.reviewed) },
        }),
      );
    }
  } else {
    const value = first("Value");
    if (value >= 0) wrapColumns.push(value);
  }
  return {
    tab,
    width,
    headerColours,
    headerHeight: lookHeaderHeight(),
    widths,
    wrapColumns,
    banding: width ? { startRow: 1, endCol: width, first: P.white, second: P.band } : null,
    rules,
    tabColour: lookTabColours()[tab],
  };
}

/**
 * The one batchUpdate's requests that put a lookPlan on the tab sheetId. existing is what
 * the tab has now: {bandings: [bandedRangeId], rules: its conditionalFormats in order}. In
 * order: delete every banding on the tab (two bandings can't overlap, so staff's banding
 * on these tabs is replaced); delete the kiosk's own rules (lookRuleRequests); style the
 * header row, one request per run of one colour, and set its height; set the known
 * widths; wrap the wrap columns; add the banding; add the rules after staff's; set the tab
 * colour. Only the formats named in each request's fields change, so a header's number
 * format and every value stay as they are.
 */
function lookRequests(plan, sheetId, existing) {
  const have = existing || {};
  const requests = [];
  (have.bandings || []).forEach((id) => requests.push({ deleteBanding: { bandedRangeId: id } }));
  const rules = lookRuleRequests(sheetId, have.rules, plan.rules);
  rules.filter((r) => r.deleteConditionalFormatRule).forEach((r) => requests.push(r));

  const colours = plan.headerColours;
  for (let start = 0; start < colours.length;) {
    let end = start + 1;
    while (end < colours.length && colours[end] === colours[start]) end++;
    requests.push({
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: 0,
          endRowIndex: 1,
          startColumnIndex: start,
          endColumnIndex: end,
        },
        cell: {
          userEnteredFormat: {
            backgroundColorStyle: lookColorStyle(colours[start]),
            textFormat: { foregroundColorStyle: lookColorStyle(lookPalette().white), bold: true },
            wrapStrategy: "WRAP",
            verticalAlignment: "MIDDLE",
          },
        },
        fields: [
          "userEnteredFormat.backgroundColorStyle",
          "userEnteredFormat.textFormat.foregroundColorStyle",
          "userEnteredFormat.textFormat.bold",
          "userEnteredFormat.wrapStrategy",
          "userEnteredFormat.verticalAlignment",
        ].join(","),
      },
    });
    start = end;
  }
  if (colours.length) {
    requests.push({
      updateDimensionProperties: {
        range: { sheetId, dimension: "ROWS", startIndex: 0, endIndex: 1 },
        properties: { pixelSize: plan.headerHeight },
        fields: "pixelSize",
      },
    });
  }
  plan.widths.forEach((w) =>
    requests.push({
      updateDimensionProperties: {
        range: { sheetId, dimension: "COLUMNS", startIndex: w.col, endIndex: w.col + 1 },
        properties: { pixelSize: w.px },
        fields: "pixelSize",
      },
    }),
  );
  plan.wrapColumns.forEach((col) =>
    requests.push({
      repeatCell: {
        range: { sheetId, startColumnIndex: col, endColumnIndex: col + 1 },
        cell: { userEnteredFormat: { wrapStrategy: "WRAP" } },
        fields: "userEnteredFormat.wrapStrategy",
      },
    }),
  );
  if (plan.banding) {
    requests.push({
      addBanding: {
        bandedRange: {
          range: {
            sheetId,
            startRowIndex: plan.banding.startRow,
            startColumnIndex: 0,
            endColumnIndex: plan.banding.endCol,
          },
          rowProperties: {
            firstBandColorStyle: lookColorStyle(plan.banding.first),
            secondBandColorStyle: lookColorStyle(plan.banding.second),
          },
        },
      },
    });
  }
  rules.filter((r) => r.addConditionalFormatRule).forEach((r) => requests.push(r));
  requests.push({
    updateSheetProperties: {
      properties: { sheetId, tabColorStyle: lookColorStyle(plan.tabColour) },
      fields: "tabColorStyle",
    },
  });
  return requests;
}

/** A report tab's column widths in pixels, A to E: labels and names, then figures and details. */
function reportColumnWidths() {
  return [230, 170, 140, 110, 300];
}

/**
 * How a new report tab is styled, from reportRows' {values, kinds}, as plain data that
 * writeReportTab_ applies once:
 * - styles: [{kind, ranges (A1), fontColor?, fontSize?, background?, bold, bottomBorder?}]
 *   for the kinds with rows: the title row's first cell navy, 14 pt, bold; each section
 *   row across the tab's width with the section fill and navy bold text; each table
 *   header row bold with a navy bottom border, from A to its last cell with text.
 * - widths: [{col (1-based), px}] for the tab's columns.
 * - tabColour.
 */
function reportTabLook(rows) {
  const P = lookPalette();
  const values = rows.values;
  const kinds = rows.kinds;
  const width = values.length ? values[0].length : 0;
  const ranges = { title: [], section: [], header: [] };
  kinds.forEach((kind, i) => {
    const r = i + 1;
    if (kind === "title") ranges.title.push("A" + r);
    if (kind === "section") ranges.section.push("A" + r + ":" + columnLetter(width - 1) + r);
    if (kind === "header") {
      let last = 0;
      values[i].forEach((v, j) => {
        if (cellString(v) !== "") last = j;
      });
      ranges.header.push("A" + r + ":" + columnLetter(last) + r);
    }
  });
  const styles = [
    {
      kind: "title",
      ranges: ranges.title,
      fontColor: P.navy,
      fontSize: lookTitleFontSize(),
      bold: true,
    },
    {
      kind: "section",
      ranges: ranges.section,
      background: P.section,
      fontColor: P.navy,
      bold: true,
    },
    { kind: "header", ranges: ranges.header, bold: true, bottomBorder: P.navy },
  ].filter((s) => s.ranges.length);
  const widths = reportColumnWidths()
    .slice(0, width)
    .map((px, i) => ({ col: i + 1, px }));
  return { styles, widths, tabColour: lookTabColours().report };
}

// ---------------------------------------------------------------------------
// Daily jobs
//
// Jobs.js runs these on installable triggers owned by one account, which installs them
// with setupDailyJobs. This section holds their pure rules: the list of jobs, the Settings
// values they read, when the weekly flags email is due and what it says. Times of day are
// Central wall-clock texts, "yyyy-MM-dd HH:mm", as Jobs.js formats the server's clock and
// as the last-run Settings values are written.

/**
 * The jobs setupDailyJobs installs, one trigger each, and nothing else. handler is the
 * public Jobs.js function the trigger calls. A job runs either every everyHours hours or
 * once a day at atHour (Central). The Hours refresh runs an hour after the auto clock-out,
 * so the rows it closes show.
 */
function dailyJobs() {
  return [
    { handler: "runFlagsEmail", everyHours: 1 },
    { handler: "runAutoClockOut", atHour: 4 },
    { handler: "runHoursRefresh", atHour: 5 },
  ];
}

/** "Auto clock-out after hours" when blank or out of range. */
function defaultAutoClockOutHours() {
  return 12;
}

/** The fewest and most hours "Auto clock-out after hours" may be. */
function autoClockOutHoursRange() {
  return { min: 10, max: 24 };
}

/** "Long shift flag hours" when blank or not above 0. */
function defaultLongShiftHours() {
  return 8;
}

function defaultFlagsEmailDay() {
  return "Monday";
}

function defaultFlagsEmailHour() {
  return 8;
}

/** The weekly email's sender name. The address is the job owner's domain no-reply address. */
function flagsEmailSenderName() {
  return "ENCM Volunteer Kiosk";
}

/** How many of the week's flags the email lists before "and N more". */
function flagsEmailListMax() {
  return 25;
}

/** The email warns when "Auto clock-out last run" is blank or older than this many hours. */
function autoClockOutStaleHours() {
  return 48;
}

/** The text of a number Setting, or NaN when it isn't a finite number. */
function settingNumber(text) {
  const s = cellString(text);
  const n = Number(s);
  return s !== "" && isFinite(n) ? n : NaN;
}

/**
 * "Auto clock-out after hours": a number from 10 to 24 as given, anything else 12. Below
 * 10 is read as a mistake: a window shorter than a shift plus some slack would take a
 * volunteer who is still there off the tablet.
 */
function parseAutoClockOutHours(text) {
  const n = settingNumber(text);
  const range = autoClockOutHoursRange();
  return n >= range.min && n <= range.max ? n : defaultAutoClockOutHours();
}

/** "Long shift flag hours": a finite number above 0 as given, anything else 8. */
function parseLongShiftHours(text) {
  const n = settingNumber(text);
  return n > 0 ? n : defaultLongShiftHours();
}

/** "Flags email": true only for On, in any case. */
function parseFlagsEmailOn(text) {
  return cellString(text).toLowerCase() === "on";
}

/**
 * "Flags email to": the addresses split on commas, semicolons, spaces or new lines, as
 * {valid, invalid}. Valid ones look like a@b.c and are kept once each, in the order
 * written, ignoring case for the repeat.
 */
function parseEmailAddresses(text) {
  const valid = [];
  const invalid = [];
  const seen = {};
  cellString(text)
    .split(/[,;\s]+/)
    .filter((part) => part !== "")
    .forEach((part) => {
      if (!/^[^@\s]+@[^@\s.]+(\.[^@\s.]+)+$/.test(part)) {
        invalid.push(part);
        return;
      }
      const key = part.toLowerCase();
      if (!seen[key]) {
        seen[key] = true;
        valid.push(part);
      }
    });
  return { valid, invalid };
}

/** An English weekday, full or its first three letters, any case, as its full name; else ''. */
function weekdayFromText(text) {
  const s = cellString(text).toLowerCase();
  const names = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const found = names.find((name) => {
    const n = name.toLowerCase();
    return s === n || s === n.slice(0, 3);
  });
  return found || "";
}

/** "Flags email day": an English weekday, full or its first three letters, any case; else Monday. */
function parseWeekdaySetting(text) {
  return weekdayFromText(text) || defaultFlagsEmailDay();
}

/** "Flags email hour": a whole hour from 0 to 23, Central; else 8. */
function parseEmailHour(text) {
  const n = settingNumber(text);
  return Number.isInteger(n) && n >= 0 && n <= 23 ? n : defaultFlagsEmailHour();
}

/** A yyyy-MM-dd date moved by a whole number of days; empty for an unreadable date. */
function addDays(dateText, days) {
  const date = parseStartDate(dateText);
  if (!date) return "";
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/**
 * The "yyyy-MM-dd HH:mm" a last-run Settings value starts with ("2026-11-09 08:05, sent to
 * 3"), or empty when it doesn't start with a readable one.
 */
function lastRunTime(text) {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2})(?!\d)/.exec(cellString(text));
  if (!m || !parseStartDate(m[1]) || Number(m[2]) > 23 || Number(m[3]) > 59) return "";
  return m[0];
}

/** A last-run Settings value: the time, then ", " and what the run did. */
function lastRunText(nowText, what) {
  return nowText + ", " + what;
}

/**
 * The weekly email's due slot: the latest "yyyy-MM-dd HH:00" at or before nowText that
 * falls on weekday (a name from parseWeekdaySetting) at hour (0-23).
 */
function flagsEmailSlot(nowText, weekday, hour) {
  const today = nowText.slice(0, 10);
  const nowHour = Number(nowText.slice(11, 13));
  const names = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  let back = (names.indexOf(weekdayName(today)) - names.indexOf(weekday) + 7) % 7;
  if (back === 0 && nowHour < hour) back = 7;
  return addDays(today, -back) + " " + String(hour).padStart(2, "0") + ":00";
}

/**
 * True when the weekly email is due at nowText: "Flags email last run" (lastRunValue) is
 * before the due slot. A blank or unreadable last run is before every slot. The texts are
 * Central wall-clock times, compared as text, so the hour repeated when clocks fall back
 * can't send twice.
 */
function flagsEmailDue(nowText, lastRunValue, weekday, hour) {
  const last = lastRunTime(lastRunValue);
  return last === "" || last < flagsEmailSlot(nowText, weekday, hour);
}

/** A "yyyy-MM-dd HH:mm" text as milliseconds on a clock with no time zone, for differences. */
function wallClockMs(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/.exec(cellString(text));
  if (!m) return NaN;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
}

/**
 * {stale, lastRun}: stale when "Auto clock-out last run" (lastRunValue) is blank,
 * unreadable or more than 48 hours before nowText (an hour either way across a clock
 * change); lastRun is its "yyyy-MM-dd HH:mm" or empty.
 */
function autoClockOutCheck(lastRunValue, nowText) {
  const lastRun = lastRunTime(lastRunValue);
  const stale =
    lastRun === "" ||
    wallClockMs(nowText) - wallClockMs(lastRun) > autoClockOutStaleHours() * 3600000;
  return { stale, lastRun };
}

/**
 * The weekly email's counts from the Flags tab's rows. flags is [{date, name, shiftId,
 * reason, raisedAtMs, reviewed}]. recent: the rows raised in the 7 days before nowMs,
 * newest first. unreviewed: rows with a Volunteer Name or Shift ID whose Reviewed isn't
 * ticked, any age.
 */
function flagsSummary(flags, nowMs) {
  const from = nowMs - 7 * 24 * 3600000;
  const recent = flags
    .filter((f) => isFinite(f.raisedAtMs) && f.raisedAtMs > from && f.raisedAtMs <= nowMs)
    .sort((a, b) => b.raisedAtMs - a.raisedAtMs);
  const unreviewed = flags.filter(
    (f) => (cellString(f.name) !== "" || cellString(f.shiftId) !== "") && f.reviewed !== true,
  ).length;
  return { recent, unreviewed };
}

/** True for a ticked Reviewed cell: the checkbox's true, or the text TRUE. */
function isTicked(value) {
  return value === true || cellString(value).toLowerCase() === "true";
}

function htmlText(text) {
  return cellString(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function plural(count, one, many) {
  return count + " " + (count === 1 ? one : many);
}

/**
 * The weekly flags email, or null when there is nothing to send: no flag raised in the
 * week, none unreviewed and the auto clock-out not stale. input is {summary
 * (flagsSummary), autoClockOut (autoClockOutCheck), flagsUrl, skipped (addresses in
 * "Flags email to" that couldn't be read)}. Returns {subject, body, htmlBody}. Names
 * and reasons come from the Flags tab, which staff already see; no User Token.
 */
function flagsEmailMessage(input) {
  const recent = input.summary.recent;
  const unreviewed = input.summary.unreviewed;
  const auto = input.autoClockOut;
  if (!recent.length && !unreviewed && !auto.stale) return null;

  const counts =
    plural(recent.length, "new flag", "new flags") + " this week, " + unreviewed + " unreviewed";
  const subject = "Volunteer kiosk: " + (auto.stale ? "auto clock-out not running, " : "") + counts;

  const text = [];
  const html = [];
  const para = (plain, markup) => {
    text.push(plain);
    html.push("<p>" + (markup === undefined ? htmlText(plain) : markup) + "</p>");
  };
  if (auto.stale) {
    para(
      (auto.lastRun
        ? "The auto clock-out last ran at " + auto.lastRun + "."
        : "The auto clock-out has never run.") +
        " Shifts nobody checked out of are not being closed. Ask whoever looks after the" +
        ' kiosk to check its daily jobs; Settings "Daily jobs installed by" names the account' +
        " that runs them.",
    );
  }
  para("Flags raised in the last 7 days: " + recent.length);
  para("Flags still unreviewed: " + unreviewed);
  para(
    "Review them on the Flags tab (Data > Filter views > " +
      flagsViewTitle() +
      "): " +
      input.flagsUrl,
    'Review them on the <a href="' +
      htmlText(input.flagsUrl) +
      '">Flags tab</a> (Data &gt; Filter views &gt; ' +
      htmlText(flagsViewTitle()) +
      ").",
  );
  if (recent.length) {
    const shown = recent.slice(0, flagsEmailListMax());
    const line = (f) =>
      cellString(f.date) + ", " + cellString(f.name) + ": " + cellString(f.reason);
    const more = recent.length - shown.length;
    text.push(
      ["This week's flags, newest first:"]
        .concat(shown.map(line))
        .concat(more > 0 ? ["and " + more + " more"] : [])
        .join("\n"),
    );
    html.push(
      "<p>This week's flags, newest first:</p><ul>" +
        shown.map((f) => "<li>" + htmlText(line(f)) + "</li>").join("") +
        "</ul>" +
        (more > 0 ? "<p>and " + more + " more</p>" : ""),
    );
  }
  if (input.skipped && input.skipped.length) {
    para(
      'Not sent to these entries in Settings "Flags email to", which aren\'t email addresses: ' +
        input.skipped.join(", "),
    );
  }
  para(
    'Sent by the volunteer kiosk because Settings "Flags email" is On. Set it to Off to stop' +
      " these emails.",
  );
  return { subject, body: text.join("\n\n"), htmlBody: html.join("\n") };
}

// ---------------------------------------------------------------------------
// Past hours import
//
// The Kiosk admin menu's Import past hours (Import.js) reads a tab laid out like ENCM's
// "Historical Hours": a header row, then one row per shift with its Date, First name, Last
// name and hours, and optionally the month tab and cell the shift was copied from. Each
// shift becomes a closed Log row with its stated hours and no times. Import.js reads and
// writes; the rules are here.
//
// A source row is known by its source key: its date, its written name and its count among
// the source rows with that date and name. Never by its position, since rows move in the
// old sheet. The Import ledger tab keeps every key brought in, so a second run adds
// nothing and a row staff delete from the Log stays deleted. Once imported, a row is
// corrected on the Log, never in the source: a corrected name or date is a new key.

/** The tab in the Check-In Log that remembers every source key imported. */
function importLedgerTab() {
  return "Import ledger";
}

/** The Settings rows that prefill the dialog; a run that writes saves what it used. */
function importFileSetting() {
  return "Past hours file ID";
}

function importTabSetting() {
  return "Past hours tab";
}

/** The tab the dialog offers when Settings names none. */
function importDefaultTab() {
  return "Historical Hours";
}

/**
 * Both Entered By cells of an imported row. Six letters, so entrySource reads it as
 * "other", never as an admin's initials.
 */
function importEnteredBy() {
  return "import";
}

/** Rows written per lock: a tablet call waits at most one block. */
function importBlockSize() {
  return 250;
}

/** A run starts no new block after this long, inside Apps Script's 6-minute limit. */
function importTimeBudgetMs() {
  return 270000;
}

/** The ledger headers, keyed by the short names the code uses, in the order a new tab gets them. */
function importLedgerHeaderNames() {
  return {
    key: "Source key",
    shiftId: "Shift ID",
    importedAt: "Imported At",
    importedBy: "Imported By",
    source: "Source",
  };
}

function importLedgerHeaders() {
  const names = importLedgerHeaderNames();
  return Object.keys(names).map((key) => names[key]);
}

/**
 * Maps each ledger header to its 0-based index in headerRow (normalizeHeader forms). Each
 * must be there exactly once, else this throws: the ledger is the import's memory, and a
 * run that can't read it would import everything again.
 */
function importLedgerColumns(headerRow) {
  const cols = {};
  importLedgerHeaders().forEach((h) => {
    const found = logHeaderIndexes(headerRow, h);
    if (found.length !== 1) {
      throw new Error(
        'The "' +
          importLedgerTab() +
          '" tab needs exactly one "' +
          h +
          '" column in row 1. Put it back, then run the import again.',
      );
    }
    cols[h] = found[0];
  });
  return cols;
}

/** Why a source row is left out, by code, as the preview lists them. */
function importLeftOutReasons() {
  return {
    date: "date can't be read",
    future: "date is after today",
    launch: 'date is on or after the "Kiosk launch date"',
    name: "no first or last name",
    hours: "hours aren't a number above 0 and at most 24",
  };
}

/** {ok: false, refusal, message} for an import refusal; detail fills in the message. */
function importRefusal(code, detail) {
  const d = cellString(detail);
  const messages = {
    IMPORT_LAUNCH_DATE:
      'The Settings value "Kiosk launch date" is blank or isn\'t a date (yyyy-MM-dd). The import' +
      " brings in only shifts before that date, so set it first.",
    IMPORT_FILE_ID: "Please paste the spreadsheet's link or ID.",
    IMPORT_FILE:
      "That spreadsheet can't be opened. Check the link or ID, and that this account can open it.",
    IMPORT_TAB: 'That spreadsheet has no tab named "' + d + '".',
    IMPORT_HEADERS: "The tab's first row has no " + d + " column.",
  };
  if (!messages[code]) throw new Error("Unknown import refusal code: " + code);
  return { ok: false, refusal: code, message: messages[code] };
}

/**
 * The spreadsheet ID in a pasted link (".../spreadsheets/d/<id>/edit...") or a bare ID;
 * '' when there is neither.
 */
function importFileId(text) {
  const s = cellString(text);
  const link = /\/d\/([A-Za-z0-9_-]{10,})/.exec(s);
  if (link) return link[1];
  return /^[A-Za-z0-9_-]{10,}$/.test(s) ? s : "";
}

/**
 * The source tab's columns from its header row, as {cols, missing}. cols holds 0-based
 * indexes {date, firstName, lastName, hours, sourceTab, sourceCell}, -1 when absent;
 * missing lists the required headers the row lacks. Date, First name and Last name are
 * required. Hours is the column headed "Hours", else the column right after Last name
 * (ENCM's tab leaves it unheaded). "Source cell" is optional, and the unheaded column just
 * left of it, when that isn't the hours column, is the source tab. Both are kept only for
 * the row's Notes.
 */
function importColumns(headerRow) {
  const headers = (headerRow || []).map(normalizeHeader);
  const at = (name) => headers.indexOf(name);
  const cols = {
    date: at("date"),
    firstName: at("first name"),
    lastName: at("last name"),
    hours: at("hours"),
    sourceTab: -1,
    sourceCell: at("source cell"),
  };
  const missing = [];
  if (cols.date < 0) missing.push("Date");
  if (cols.firstName < 0) missing.push("First name");
  if (cols.lastName < 0) missing.push("Last name");
  if (cols.hours < 0 && cols.lastName >= 0) cols.hours = cols.lastName + 1;
  const left = cols.sourceCell - 1;
  if (cols.sourceCell > 0 && headers[left] === "" && left !== cols.hours) cols.sourceTab = left;
  return { cols, missing };
}

/** The same-name key of a written name: volunteerNameKey of its first and last name. */
function importNameKey(firstName, lastName) {
  return volunteerNameKey({ firstName, lastName });
}

/** A written name as it goes on the Log: first and last, trimmed, runs of spaces as one. */
function importWrittenName(firstName, lastName) {
  return (cellString(firstName) + " " + cellString(lastName)).replace(/\s+/g, " ").trim();
}

/**
 * The User Token an unmatched name's rows get, so the reports count them as one volunteer
 * under the written name: "import:" and the name key with its "|" as a space ("import:jane
 * doe"). A real token never starts this way. Staff who find the volunteer type the real
 * token over it.
 */
function importStandInToken(nameKey) {
  return "import:" + cellString(nameKey).replace(/\|/g, " ").replace(/\s+/g, " ").trim();
}

/** A source row's key: date, name key and its count among rows with that date and name. */
function importSourceKey(date, nameKey, n) {
  return date + "|" + nameKey + "|" + n;
}

/** An imported row's Shift ID: "import-" and the first 16 hex of the key's SHA-256. */
function importShiftId(key, hashFn) {
  return "import-" + String(hashFn(key)).toLowerCase().slice(0, 16);
}

/** The launch date as yyyy-MM-dd, or the IMPORT_LAUNCH_DATE refusal as {refusal}. */
function importLaunchDate(text) {
  const launch = parseStartDate(text);
  return launch ? { launch } : { refusal: importRefusal("IMPORT_LAUNCH_DATE") };
}

/** A source hours cell as a number, NaN when blank or not a number. */
function importHours(value) {
  return hoursCell(typeof value === "number" ? value : cellString(value));
}

/**
 * Works out what an import would do. input is {header, rows, launchDate, todayDate,
 * volunteers, ledgerKeys, logShiftIds, hashFn}: the source header row, its data rows (data
 * row i is source row i + 2; a date cell already as yyyy-MM-dd text, hours as read), the
 * Settings launch date, today, the Profiles list, the source keys in the ledger, the Shift
 * IDs on the Log, and a SHA-256 hex function.
 *
 * A row is importable when its Date reads as a day (parseStartDate) not after today and
 * before the launch date, it has a first or last name, and its hours are a number above 0
 * and at most 24. Wholly blank rows are skipped and not counted. A key counts every row
 * whose date reads and that has a name, left out or not, so fixing one row's hours in the
 * source doesn't change its neighbours' keys.
 *
 * A name matches when exactly one Profiles volunteer has its name key. Returns {refusal}
 * (launch date or headers), or {rowsRead, toImport, alreadyImported, onLog, leftOut}: the
 * first three are lists of items {sourceRow, date, firstName, lastName, name, nameKey, key,
 * shiftId, hours, volunteer (null when unmatched), matches, sourceTab, sourceCell}, in
 * source order; leftOut is [{row, reason}] with reason a code of importLeftOutReasons().
 * An item in toImport is neither in the ledger nor on the Log; one in onLog has its Shift
 * ID on the Log but no ledger line, which the run adds.
 */
function importPlan(input) {
  const launch = importLaunchDate(input.launchDate);
  if (launch.refusal) return { refusal: launch.refusal };
  const columns = importColumns(input.header);
  if (columns.missing.length) {
    return {
      refusal: importRefusal(
        "IMPORT_HEADERS",
        columns.missing.map((h) => '"' + h + '"').join(" or "),
      ),
    };
  }
  const c = columns.cols;
  const byName = new Map();
  (input.volunteers || []).forEach((v) => {
    const key = volunteerNameKey(v);
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(v);
  });
  const ledger = new Set((input.ledgerKeys || []).map(cellString));
  const onLogIds = new Set((input.logShiftIds || []).map(cellString));
  const counts = new Map();
  const plan = { rowsRead: 0, toImport: [], alreadyImported: [], onLog: [], leftOut: [] };

  (input.rows || []).forEach((cells, i) => {
    const row = i + 2;
    if ((cells || []).every((v) => cellString(v) === "")) return;
    plan.rowsRead++;
    const cell = (at) => (at >= 0 ? cells[at] : "");
    const date = parseStartDate(cell(c.date));
    const firstName = cellString(cell(c.firstName));
    const lastName = cellString(cell(c.lastName));
    const hours = importHours(cell(c.hours));
    const hasName = firstName !== "" || lastName !== "";
    const nameKey = importNameKey(firstName, lastName);
    let n = 0;
    if (date && hasName) {
      const at = date + "|" + nameKey;
      n = (counts.get(at) || 0) + 1;
      counts.set(at, n);
    }
    let reason = "";
    if (!date) reason = "date";
    else if (date > input.todayDate) reason = "future";
    else if (date >= launch.launch) reason = "launch";
    else if (!hasName) reason = "name";
    else if (!isFinite(hours) || hours <= 0 || hours > 24) reason = "hours";
    if (reason) {
      plan.leftOut.push({ row, reason });
      return;
    }
    const key = importSourceKey(date, nameKey, n);
    const shiftId = importShiftId(key, input.hashFn);
    const same = byName.get(nameKey) || [];
    const item = {
      sourceRow: row,
      date,
      firstName,
      lastName,
      name: importWrittenName(firstName, lastName),
      nameKey,
      key,
      shiftId,
      hours,
      volunteer: same.length === 1 ? same[0] : null,
      matches: same.length,
      sourceTab: cellString(cell(c.sourceTab)),
      sourceCell: cellString(cell(c.sourceCell)),
    };
    if (ledger.has(key)) plan.alreadyImported.push(item);
    else if (onLogIds.has(shiftId)) plan.onLog.push(item);
    else plan.toImport.push(item);
  });
  return plan;
}

/** Hours added up in hundredths, so 0.1 + 0.2 is 0.3. */
function importHoursTotal(items) {
  return items.reduce((sum, item) => sum + Math.round(item.hours * 100), 0) / 100;
}

/** {name key: rows} for the unmatched items. */
function importUnmatchedCounts(items) {
  const counts = {};
  items.forEach((item) => {
    if (!item.volunteer) counts[item.nameKey] = (counts[item.nameKey] || 0) + 1;
  });
  return counts;
}

/**
 * The preview's counts for a plan: {rowsRead, toImport, matched, unmatched, hours,
 * alreadyImported, onLog, leftOut, unmatchedNames: [{name, rows, matches}] sorted by name,
 * leftOutRows: [{reason (text), rows: [source row numbers]}] in importLeftOutReasons()
 * order}. No User Token.
 */
function importSummary(plan) {
  const unmatched = plan.toImport.filter((item) => !item.volunteer);
  const counts = importUnmatchedCounts(plan.toImport);
  const names = [];
  const seen = new Set();
  unmatched.forEach((item) => {
    if (seen.has(item.nameKey)) return;
    seen.add(item.nameKey);
    names.push({ name: item.name, rows: counts[item.nameKey], matches: item.matches });
  });
  names.sort((a, b) => normalizeName(a.name).localeCompare(normalizeName(b.name)));
  const reasons = importLeftOutReasons();
  const leftOutRows = Object.keys(reasons)
    .map((code) => ({
      reason: reasons[code],
      rows: plan.leftOut.filter((l) => l.reason === code).map((l) => l.row),
    }))
    .filter((group) => group.rows.length);
  return {
    rowsRead: plan.rowsRead,
    toImport: plan.toImport.length,
    matched: plan.toImport.length - unmatched.length,
    unmatched: unmatched.length,
    hours: importHoursTotal(plan.toImport),
    alreadyImported: plan.alreadyImported.length,
    onLog: plan.onLog.length,
    leftOut: plan.leftOut.length,
    unmatchedNames: names,
    leftOutRows,
  };
}

/** The Admin Alerts? text of an unmatched row: no Profiles match, or a same-name group. */
function importAlert(matches) {
  const why =
    matches > 1
      ? "imported: name matches " + matches + " Volunteer Profiles rows"
      : "imported: no Volunteer Profiles match for this name";
  return why + "; correct this row on the Log, not in the old sheet";
}

/**
 * An imported row's Notes: "Imported by JP from Old Volunteer Hours › Historical Hours row
 * 12 (2025.12 C3)", the part in brackets only when the source names its tab or cell.
 */
function importNote(initials, fileName, tab, item) {
  const from = [item.sourceTab, item.sourceCell].filter((s) => cellString(s) !== "").join(" ");
  return (
    "Imported by " +
    initials +
    " from " +
    cellString(fileName) +
    " › " +
    cellString(tab) +
    " row " +
    item.sourceRow +
    (from ? " (" + from + ")" : "")
  );
}

/**
 * The cell map of an imported row. note is the Notes text, or '' to leave Notes alone
 * (when the Log has no Notes column). The four times and Hours Served (timestamps) are
 * not written: the source has no times.
 */
function importCells(item, note) {
  const H = logHeaderNames();
  const token = item.volunteer ? item.volunteer.token : importStandInToken(item.nameKey);
  requireRowKeys(token, item.shiftId);
  const cells = {
    [H.date]: item.date,
    [H.day]: weekdayName(item.date),
    [H.name]: sheetText(item.volunteer ? volunteerFullName(item.volunteer) : item.name),
    [H.statedHours]: item.hours,
    [H.token]: sheetText(token),
    [H.status]: "closed",
    [H.inBy]: importEnteredBy(),
    [H.outBy]: importEnteredBy(),
    [H.shiftId]: item.shiftId,
  };
  if (!item.volunteer) cells[H.alerts] = importAlert(item.matches);
  if (cellString(note)) cells[H.notes] = sheetText(note);
  return cells;
}

/** One ledger line as a header-keyed map. */
function importLedgerLine(item, nowMs, initials, fileId, tab) {
  const L = importLedgerHeaderNames();
  return {
    [L.key]: sheetText(item.key),
    [L.shiftId]: item.shiftId,
    [L.importedAt]: nowMs,
    [L.importedBy]: sheetText(initials),
    [L.source]: sheetText(fileId + ", " + tab + ", row " + item.sourceRow),
  };
}

/** One ledger map as a row of width cells under cols (importLedgerColumns). */
function importLedgerValues(line, cols, width) {
  const row = Array.from({ length: width }, () => "");
  Object.keys(line).forEach((h) => (row[cols[h]] = line[h]));
  return row;
}

/** The items cut into blocks of size, in order. */
function importBlocks(items, size) {
  const blocks = [];
  for (let i = 0; i < items.length; i += size) blocks.push(items.slice(i, i + size));
  return blocks;
}

/**
 * The Flags rows for one written block: one per unmatched name not in flagged (the name
 * keys already flagged this run), for the name's first row in the block. written is
 * [{item, row}] with row the Log row, counts the run's unmatched rows per name key. Adds
 * the names it flags to flagged. Reason is the row's alert and the name's rows in this run.
 */
function importFlagRows(written, counts, flagged, nowMs) {
  const rows = [];
  written.forEach(({ item, row }) => {
    if (item.volunteer || flagged.has(item.nameKey)) return;
    flagged.add(item.nameKey);
    const n = counts[item.nameKey] || 1;
    const reason =
      importAlert(item.matches) + " (" + n + (n === 1 ? " row" : " rows") + " in this import)";
    flagRows(
      {
        date: item.date,
        name: item.name,
        shiftId: item.shiftId,
        raisedAtMs: nowMs,
        source: flagSources().import,
        logRow: row,
      },
      [reason],
    ).forEach((r) => rows.push(r));
  });
  return rows;
}

// ---------------------------------------------------------------------------
// Auto clock-out
//
// The daily job runAutoClockOut (Jobs.js), at about 4 AM Central, closes open rows nobody
// checked out of with a guessed time, and flags each one. An open row's age is measured
// from when it was checked in (checkedInMs). It is the tablet's while that age is under the
// "Auto clock-out after hours" window (isTabletOpenRow) and the job's once it is at least
// the window, so a row is never both, and a volunteer can check out at the tablet for the
// whole window after the tap. Jobs.js reads and writes; the rules are here.
//
// The guess is never before the volunteer tapped in (the floor) and never after the run's
// time or the start of the volunteer's next row (the limit); when the limit is before the
// floor, the limit wins. In order: the volunteer's usual length on that weekday, else the
// Finish of the matching window on the Shifts tab, else the arrival plus 3 hours, raised to
// the floor and cut to the limit. The volunteer's own history comes first, and every guess
// is flagged with where it came from.

/**
 * The Check-Out Entered By of a row the auto clock-out closes. entrySource reads it as
 * "other", never as an admin's initials, so reports list the row as entered another way.
 */
function autoCloseEnteredBy() {
  return "auto-close";
}

/** The tab in the Check-In Log the job reads shift windows from. Staff's: only ever read. */
function shiftsTab() {
  return "Shifts";
}

/** The Shifts headers the job reads, after normalizeHeader. Other columns are ignored. */
function shiftsHeaderNames() {
  return { weekday: "shifts", start: "start", finish: "finish" };
}

/** The header row is the first of the tab's top rows that holds all three headers. */
function shiftsHeaderSearchRows() {
  return 10;
}

/** A start this many minutes before a Shifts window's Start still matches it. */
function shiftsEarlyMinutes() {
  return 30;
}

/** The usual length looks back this many weeks. */
function usualLengthWeeks() {
  return 26;
}

/** The usual length takes at most this many of the most recent rows. */
function usualLengthSampleMax() {
  return 8;
}

/** The usual length needs at least this many rows. */
function usualLengthMinRows() {
  return 3;
}

/** How far from the median a row may be and still count as near it, for the spread rule. */
function usualLengthSpreadMinutes() {
  return 60;
}

/** The last step's length: the arrival plus this many hours. */
function fallbackShiftHours() {
  return 3;
}

/** A run starts no new row after this long, well inside Google's 6-minute limit. */
function autoClockOutBudgetMs() {
  return 4.5 * 60000;
}

/** The Admin Alerts? text of an open row the job can't close because no time on it reads. */
function autoClockOutSkippedAlert() {
  return "auto clock-out skipped: check-in time unreadable";
}

/**
 * "Kiosk launch date" as yyyy-MM-dd. Throws when it is blank or unreadable, so the run
 * fails (and the owner gets Google's failure email) rather than close every open row the
 * Log has ever had.
 */
function autoClockOutLaunchDate(text) {
  const launch = parseStartDate(text);
  if (!launch) {
    throw new Error(
      'Auto clock-out: the Settings value "Kiosk launch date" is blank or not a date, so ' +
        "no row was closed. Write it as yyyy-MM-dd.",
    );
  }
  return launch;
}

/**
 * The open rows a run at nowMs acts on, as {close, skip}. Only rows with Status open and
 * a Date on or after launchDate. close: rows whose age (checkedInMs) is at least windowMs,
 * oldest first; a row edited by hand so its start is not before nowMs is left for a later
 * run. skip: rows dated before todayDate on which no time reads, so no time can be
 * guessed, and whose Admin Alerts? doesn't yet hold autoClockOutSkippedAlert(), so each is
 * flagged once. A row whose Date can't be read is in neither list: it has no age and isn't
 * dated today.
 */
function autoClockOutRows(entries, nowMs, windowMs, todayDate, launchDate) {
  const close = [];
  const skip = [];
  entries.forEach((e) => {
    if (!isStatus(e, "open")) return;
    const date = rowDate(e.dateText);
    if (!date || date < launchDate) return;
    const at = checkedInMs(e);
    if (isFinite(at)) {
      if (nowMs - at >= windowMs && shiftStartMs(e) < nowMs) close.push(e);
      return;
    }
    if (date < todayDate && !cellString(e.alerts).includes(autoClockOutSkippedAlert())) {
      skip.push(e);
    }
  });
  close.sort((a, b) => checkedInMs(a) - checkedInMs(b) || a.row - b.row);
  return { close, skip };
}

/**
 * True when a Log row read again just before an auto clock-out write (current, a log
 * entry, or null when the row is past the Log's end) is still the row the run planned for:
 * still open, with the same Shift ID, User Token, Date and check-in times. Staff can sort,
 * insert or delete Log rows while a run goes on, which moves rows under their numbers; a
 * row that changed is left for the next run rather than written by a stale number.
 */
function autoClockOutRowUnchanged(planned, current) {
  if (!current || !isStatus(current, "open")) return false;
  return (
    cellString(current.shiftId) === cellString(planned.shiftId) &&
    cellString(current.token) === cellString(planned.token) &&
    cellString(current.dateText) === cellString(planned.dateText) &&
    Object.is(current.recordedInMs, planned.recordedInMs) &&
    Object.is(current.statedInMs, planned.statedInMs)
  );
}

/**
 * The volunteer's usual length for an open row's weekday, as {minutes, weekday}, or null.
 * The sample is the same token's closed rows dated on the same weekday, before this row's
 * Date and at most 26 weeks before it, with Hours Served (stated) a number above 0 and at
 * most 24, and a check-out made at the kiosk, by an admin's initials or typed by hand
 * (entrySource). Auto-closed and imported rows are left out, so guesses never feed guesses.
 * The 8 most recent by Date are taken; there must be at least 3. minutes is their median
 * stated length in whole minutes (an even count takes the mean of the middle two, rounded
 * down). Null when the sample is too spread: fewer than two thirds of it (rounded up) within
 * 60 minutes of the median, so one odd shift in three passes and no usual length doesn't.
 */
function usualLength(entries, row) {
  const date = rowDate(row.dateText);
  if (!date) return null;
  const weekday = weekdayName(date);
  const from = addDays(date, -7 * usualLengthWeeks());
  const sources = ["kiosk", "initials", "typed"];
  const sample = entries
    .filter((e) => {
      if (e.row === row.row || !isTokenRow(e, row.token) || !isStatus(e, "closed")) return false;
      const d = rowDate(e.dateText);
      if (!d || d >= date || d < from || weekdayName(d) !== weekday) return false;
      const hours = e.statedHours;
      if (typeof hours !== "number" || !isFinite(hours) || hours <= 0 || hours > 24) return false;
      return sources.indexOf(entrySource(e.outBy)) >= 0;
    })
    .sort((a, b) => reportRowOrder(b, a))
    .slice(0, usualLengthSampleMax());
  if (sample.length < usualLengthMinRows()) return null;
  const minutes = sample.map((e) => Math.round(e.statedHours * 60)).sort((a, b) => a - b);
  const n = minutes.length;
  const median =
    n % 2 ? minutes[(n - 1) / 2] : Math.floor((minutes[n / 2 - 1] + minutes[n / 2]) / 2);
  const near = minutes.filter((m) => Math.abs(m - median) <= usualLengthSpreadMinutes()).length;
  if (near < Math.ceil((2 * n) / 3)) return null;
  return { minutes: median, weekday };
}

/**
 * A Shifts Start or Finish cell as "HH:mm", or ''. clock is what read.clock gave (a sheet
 * time, or text clockText reads, such as "9:00 AM"); text is the cell's text, for an hour
 * with AM or PM and no minutes, such as "9 AM" or "1pm".
 */
function shiftsClock(clock, text) {
  if (cellString(clock)) return cellString(clock);
  const m = /^(\d{1,2})\s*([ap])\.?\s*m\.?$/i.exec(cellString(text));
  return m ? clockText(m[1] + ":00 " + m[2] + "m") : "";
}

/**
 * The Shifts tab's windows from its values (rows of cells), as {windows, problem}.
 * windows: [{weekday, start, finish}], weekday a full English name and start and finish
 * "HH:mm". Columns are found by header (shiftsHeaderNames), in the first of the top rows
 * that holds all three; other columns are ignored. A weekday cell is an English weekday,
 * full or its first three letters, any case. A row missing any of the three is skipped.
 * read.text(value) gives a cell as text and read.clock(value) its "HH:mm" or ''. problem
 * is '' or a line for the log when no header row is found.
 */
function shiftsTabWindows(values, read) {
  const H = shiftsHeaderNames();
  let cols = null;
  let headerAt = -1;
  for (let i = 0; i < Math.min(values.length, shiftsHeaderSearchRows()); i++) {
    const names = values[i].map((v) => normalizeHeader(cellString(read.text(v))));
    const found = {
      weekday: names.indexOf(H.weekday),
      start: names.indexOf(H.start),
      finish: names.indexOf(H.finish),
    };
    if (found.weekday >= 0 && found.start >= 0 && found.finish >= 0) {
      cols = found;
      headerAt = i;
      break;
    }
  }
  if (!cols) {
    return {
      windows: [],
      problem: 'the "' + shiftsTab() + '" tab has no header row with Shifts, Start and Finish',
    };
  }
  const windows = [];
  values.slice(headerAt + 1).forEach((cells) => {
    const cell = (at) => (at < cells.length ? cells[at] : "");
    const weekday = weekdayFromText(read.text(cell(cols.weekday)));
    const start = shiftsClock(read.clock(cell(cols.start)), read.text(cell(cols.start)));
    const finish = shiftsClock(read.clock(cell(cols.finish)), read.text(cell(cols.finish)));
    if (weekday && start && finish) windows.push({ weekday, start, finish });
  });
  return { windows, problem: "" };
}

/**
 * The Shifts window an open row's start matches, as {startMs, finishMs, start}, or null.
 * A window is Start to Finish on the row's Date, on the row's weekday; Finish is on the
 * next day when it is not after Start. It matches when startMs is at or after Start minus
 * 30 minutes and before Finish. Of the matches, the one whose Start is nearest startMs
 * wins, a tie going to the later Start. at(dateText, clock) gives {ms, date} as read.at.
 */
function matchShiftsWindow(windows, dateText, startMs, at) {
  const date = rowDate(dateText);
  if (!date || !isFinite(startMs)) return null;
  const weekday = weekdayName(date);
  let best = null;
  (windows || []).forEach((w) => {
    if (w.weekday !== weekday) return;
    const s = at(date, w.start);
    if (!s || !isFinite(s.ms)) return;
    let f = at(date, w.finish);
    if (!f || !(f.ms > s.ms)) f = at(addDays(date, 1), w.finish);
    if (!f || !isFinite(f.ms)) return;
    if (startMs < s.ms - shiftsEarlyMinutes() * 60000 || startMs >= f.ms) return;
    const gap = Math.abs(startMs - s.ms);
    if (!best || gap < best.gap || (gap === best.gap && s.ms > best.startMs)) {
      best = { startMs: s.ms, finishMs: f.ms, start: w.start, gap };
    }
  });
  return best && { startMs: best.startMs, finishMs: best.finishMs, start: best.start };
}

/**
 * The auto clock-out's time for an open row (one autoClockOutRows closes), as {ms, source}
 * plus weekday for "usual" and windowStart for "shifts". start is the row's start
 * (shiftStartMs); floor the later of start and Check-In Recorded when it reads; limit the
 * earlier of nowMs and the start of the same token's next row (any Status, the earliest
 * start after start).
 *
 * The usual length (usualLength) and then the Shifts window's Finish (matchShiftsWindow)
 * are each used only when they lie between floor and limit. Otherwise start + 3 hours
 * ("arrival"), raised to floor when earlier ("tap"), then cut to limit when later ("next"
 * when the next row's start is the limit, "run" when nowMs is). So the guess is never in
 * the future, never runs into the next shift, and is never before the tap unless the
 * volunteer's own rows disagree. windows is the Shifts tab's (shiftsTabWindows), [] when
 * there is none; read.at is as logEntry's.
 */
function autoClockOutGuess(entries, row, nowMs, windows, read) {
  const start = shiftStartMs(row);
  const floor = isFinite(row.recordedInMs) ? Math.max(start, row.recordedInMs) : start;
  let next = Infinity;
  entries.forEach((e) => {
    if (e.row === row.row || !isTokenRow(e, row.token)) return;
    const s = shiftStartMs(e);
    if (isFinite(s) && s > start && s < next) next = s;
  });
  const limit = Math.min(nowMs, next);
  const fits = (ms) => ms >= floor && ms <= limit;

  const usual = usualLength(entries, row);
  if (usual && fits(start + usual.minutes * 60000)) {
    return { ms: start + usual.minutes * 60000, source: "usual", weekday: usual.weekday };
  }
  const window = matchShiftsWindow(windows, row.dateText, start, read.at);
  if (window && fits(window.finishMs)) {
    return { ms: window.finishMs, source: "shifts", windowStart: window.start };
  }
  let ms = start + fallbackShiftHours() * 3600000;
  let source = "arrival";
  if (ms < floor) {
    ms = floor;
    source = "tap";
  }
  if (ms > limit) {
    ms = limit;
    source = limit === next ? "next" : "run";
  }
  return { ms, source };
}

/** A Central "HH:mm" as "1:30 PM". */
function clockLabel(hhmm) {
  const m = /^(\d{2}):(\d{2})$/.exec(cellString(hhmm));
  if (!m) return cellString(hhmm);
  const hour = Number(m[1]);
  return (hour % 12 || 12) + ":" + m[2] + (hour < 12 ? " AM" : " PM");
}

/**
 * The Admin Alerts? text and Flags reason of a row the job closes, naming where its time
 * came from: "auto clock-out at 1:30 PM, usual Tuesday length", "..., Finish of the 9:00
 * AM Shifts window", "..., arrival + 3 h", "..., time of the check-in tap", "..., start of
 * the next shift" or "..., time of this run". The time carries its weekday ("Wednesday
 * 2:00 AM") when it falls on another day than the row's Date. read.time(value) is as
 * logEntry's; it is given a Date.
 */
function autoClockOutAlert(row, guess, read) {
  const t = read.time(new Date(guess.ms));
  const day = t.date && t.date !== rowDate(row.dateText) ? weekdayName(t.date) + " " : "";
  const why = {
    usual: "usual " + guess.weekday + " length",
    shifts: "Finish of the " + clockLabel(guess.windowStart) + " Shifts window",
    arrival: "arrival + " + fallbackShiftHours() + " h",
    tap: "time of the check-in tap",
    next: "start of the next shift",
    run: "time of this run",
  }[guess.source];
  return "auto clock-out at " + day + clockLabel(t.clock) + ", " + why;
}

/**
 * The cells the job writes on a row it closes. Check-Out Stated is the guess, as a
 * date-time (on the next day for an overnight guess); Check-Out Recorded and Hours Served
 * (timestamps) are blank, since nobody tapped; Hours Served (stated) is from the start to
 * the guess. Status closed, so the guessed hours count at once, flagged. Admin Alerts? gets
 * the alert after what it holds. A row with no Shift ID gets shiftId, so its Flags row can
 * find it.
 */
function autoClockOutCells(row, guess, alert, shiftId) {
  const H = logHeaderNames();
  const cells = {
    [H.recordedOut]: "",
    [H.statedOut]: guess.ms,
    [H.recordedHours]: "",
    [H.statedHours]: pairHours(shiftStartMs(row), guess.ms),
    [H.alerts]: sheetText(appendText(row.alerts, alert)),
    [H.status]: "closed",
    [H.outBy]: autoCloseEnteredBy(),
  };
  if (!cellString(row.shiftId)) cells[H.shiftId] = sheetText(shiftId);
  return cells;
}

/**
 * The cells the job writes on a row it skips (autoClockOutRows skip): the skipped alert
 * after what Admin Alerts? holds, and shiftId when the row has no Shift ID. The row stays
 * open.
 */
function autoClockOutSkipCells(row, shiftId) {
  const H = logHeaderNames();
  const cells = { [H.alerts]: sheetText(appendText(row.alerts, autoClockOutSkippedAlert())) };
  if (!cellString(row.shiftId)) cells[H.shiftId] = sheetText(shiftId);
  return cells;
}

/**
 * The Flags row base (flagRows) for a row the job writes: Source auto-close, Raised At the
 * run's time.
 */
function autoClockOutFlagBase(row, shiftId, nowMs) {
  return {
    date: rowDate(row.dateText),
    name: row.name,
    shiftId: cellString(row.shiftId) || shiftId,
    raisedAtMs: nowMs,
    source: flagSources().autoClose,
    logRow: row.row,
  };
}

// ---------------------------------------------------------------------------
// The Log check
//
// A check of every Log row that isBlankLogRow doesn't call blank, run with the nightly
// Hours refresh and from Kiosk admin > Check the Log now. It reads reportEntry rows,
// reports each problem as a Flags row with Source "log check", and changes nothing on
// the Log. Each problem has a key (logCheckKey): its Shift ID and code, or, on a row with
// no Shift ID, its Date, Volunteer Name and code. The key lives only on the Flags tab, in
// the row's Shift ID, Date, Volunteer Name and the label its Reason starts with. One
// Flags row per key, ever, until staff delete it: a key already on the tab isn't raised
// again, Reviewed or not, and within one run only the first problem per key is kept.
//
// Import rows (Check-In Entered By "import") have no times by design, so the checks that
// read times skip them. The checks that read times on the row's Date (no-check-in,
// out-before-in, hours-mismatch and the time part of impossible-length) are skipped on a
// row whose Date is bad.

/** Each Log check problem's code and its fixed label, in the order a row is checked. */
function logCheckReasons() {
  return {
    "no-shift-id": "No Shift ID",
    "duplicate-id": "Shift ID on more than one row",
    "bad-date": "Date isn't a full date",
    "recorded-no-date": "Recorded time has no date",
    "bad-status": "Status isn't open or closed",
    "no-check-in": "Check-in missing or unreadable",
    "out-before-in": "Check-out before check-in",
    "closed-no-out": "Closed with no check-out",
    "hours-mismatch": "Hours don't match the times",
    "impossible-length": "Impossible shift length",
  };
}

/** Hours above this, in an hours cell or between a pair of times, are an impossible shift. */
function logCheckMaxHours() {
  return 16;
}

/** The most Flags rows one Log check run adds; the rest wait for the next run. */
function logCheckMaxNewFlags() {
  return 100;
}

/** The Shift ID a Log check Flags row gets when its Log row has none (flagRows needs one). */
function logCheckNoIdText() {
  return "(no Shift ID)";
}

/** How far an hours cell may be from its times, in hundredths of an hour, for rounding. */
function logCheckHoursTolerance() {
  return 1;
}

/** The first year a Log Date may be in. */
function logCheckFirstYear() {
  return 2000;
}

/**
 * What a raw Log cell holds: "blank" (nothing), "time-only" (a time with no date: a Date
 * before 2 January 1900, which is how Sheets stores a time typed with no date, or text
 * clockText reads) or "other". A Date is detected the way isDate_ does it, by its
 * toString tag, so a Date made in another context counts. No zone work.
 */
function timeCellKind(value) {
  if (cellString(value) === "") return "blank";
  if (Object.prototype.toString.call(value) === "[object Date]") {
    const ms = value.getTime();
    return isFinite(ms) && ms < Date.UTC(1900, 0, 2) ? "time-only" : "other";
  }
  return clockText(value) ? "time-only" : "other";
}

/** How many entries the Log check looks at: those that aren't isBlankLogRow. */
function logCheckRowCount(entries) {
  return (entries || []).filter((e) => !isBlankLogRow(e)).length;
}

/**
 * A problem's key: "id|<Shift ID>|<code>", or with no Shift ID (blank, or the
 * logCheckNoIdText a Flags row gets for one) "row|<Date>|<normalized name>|<code>".
 */
function logCheckKey(shiftId, dateText, name, code) {
  const id = cellString(shiftId);
  if (id && id !== logCheckNoIdText()) return "id|" + id + "|" + code;
  return "row|" + cellString(dateText) + "|" + normalizeName(name) + "|" + code;
}

/** An hours cell as a number: a number, or text that reads as one; NaN otherwise. */
function logCheckHoursNumber(cell) {
  if (typeof cell === "number") return cell;
  if (typeof cell !== "string" || cell.trim() === "") return NaN;
  return Number(cell.trim());
}

/** An hours cell as the Log check's details show it: "3.50 h", "blank" or 'reads "x"'. */
function logCheckHoursCellText(cell) {
  if (cellString(cell) === "") return "blank";
  const n = logCheckHoursNumber(cell);
  return isFinite(n) ? n.toFixed(2) + " h" : 'reads "' + cellString(cell) + '"';
}

/**
 * The bad-date detail for a row, or "" when its Date is good. A Date is good when the
 * cell isn't a bare time and its text is a real yyyy-MM-dd day (monthKey) from
 * 1 January logCheckFirstYear() to the end of lastMonth ("yyyy-MM"). Nobody works in a
 * later month: Add a shift refuses a date after today and the kiosk writes today.
 */
function logCheckDateDetail(entry, lastMonth) {
  const kinds = entry.timeKinds || {};
  const text = cellString(entry.dateText);
  if (kinds.date === "time-only") return "Date holds only a time";
  if (text === "") return "Date is blank";
  const month = monthKey(text);
  if (!month || Number(month.slice(0, 4)) < logCheckFirstYear() || month > lastMonth) {
    return 'Date reads "' + text + '"';
  }
  return "";
}

/**
 * Every problem on the Log, in Log row order and then logCheckReasons() order, as
 * [{code, key, label, reason, base}]. entries are reportEntry rows (timeKinds among
 * them), in Log row order. clock(ms) gives a time as the details show it, such as
 * "9:06 AM". reason is "<label>: <detail>". base is {date, name, shiftId, logRow}, the
 * Flags row's Date (the Date cell's text), Volunteer Name, Shift ID (logCheckNoIdText()
 * when the row has none) and Log Row. A duplicate Shift ID is one problem, at its first
 * row.
 *
 * nowMs (optional, Date.now() when left out) sets the last month a Date may be in: the
 * month nowMs falls in, read in UTC, which is never behind the kiosk's Central month.
 */
function logCheckProblems(entries, clock, nowMs) {
  const reasons = logCheckReasons();
  const maxHours = logCheckMaxHours();
  const show = typeof clock === "function" ? clock : (ms) => new Date(ms).toISOString();
  const now = typeof nowMs === "number" && isFinite(nowMs) ? nowMs : Date.now();
  const lastMonth = new Date(now).toISOString().slice(0, 7);
  const rows = (entries || []).filter((e) => !isBlankLogRow(e));

  const idRows = new Map();
  rows.forEach((e) => {
    const id = cellString(e.shiftId);
    if (!id) return;
    if (!idRows.has(id)) idRows.set(id, []);
    idRows.get(id).push(e.row);
  });

  const problems = [];
  const duplicatesDone = new Set();
  rows.forEach((e) => {
    const id = cellString(e.shiftId);
    const kinds = e.timeKinds || {};
    const add = (code, detail) => {
      const label = reasons[code];
      problems.push({
        code,
        key: logCheckKey(id, e.dateText, e.name, code),
        label,
        reason: label + ": " + detail,
        base: {
          date: cellString(e.dateText),
          name: cellString(e.name),
          shiftId: id || logCheckNoIdText(),
          logRow: e.row,
        },
      });
    };
    const isImport = cellString(e.inBy).toLowerCase() === importEnteredBy();
    const open = isStatus(e, "open");
    const closed = isStatus(e, "closed");
    const pairs = [
      {
        times: "recorded",
        cell: "timestamps",
        inMs: e.recordedInMs,
        outMs: e.recordedOutMs,
        hours: e.recordedHoursCell,
      },
      {
        times: "stated",
        cell: "stated",
        inMs: shiftStartMs(e),
        outMs: e.statedOutMs,
        hours: e.statedHoursCell,
      },
    ];
    const bothRead = (p) => isFinite(p.inMs) && isFinite(p.outMs);

    if (!id) add("no-shift-id", "the Shift ID cell is blank");

    if (id && !duplicatesDone.has(id) && idRows.get(id).length > 1) {
      duplicatesDone.add(id);
      add("duplicate-id", rowList(idRows.get(id)));
    }

    const dateDetail = logCheckDateDetail(e, lastMonth);
    if (dateDetail) add("bad-date", dateDetail);
    const timesRead = !dateDetail && !isImport;

    const bare = [];
    if (kinds.recordedIn === "time-only") bare.push("Check-In Recorded");
    if (kinds.recordedOut === "time-only") bare.push("Check-Out Recorded");
    if (bare.length) {
      add(
        "recorded-no-date",
        bare.join(" and ") + (bare.length > 1 ? " hold" : " holds") + " only a time",
      );
    }

    if (!open && !closed) {
      const status = cellString(e.status);
      add("bad-status", status ? 'Status reads "' + status + '"' : "Status is blank");
    }

    const alerts = cellString(e.alerts).toLowerCase();
    const alerted =
      alerts.indexOf(unreadableStartAlert().toLowerCase()) >= 0 ||
      alerts.indexOf(autoClockOutSkippedAlert().toLowerCase()) >= 0;
    if ((open || closed) && timesRead && !hasReadableStart(e) && !alerted) {
      const noCells = kinds.recordedIn === "blank" && kinds.statedIn === "blank";
      add(
        "no-check-in",
        noCells ? "both check-in cells blank" : "check-in can't be read on the row's Date",
      );
    }

    if (timesRead) {
      const backwards = pairs
        .filter((p) => bothRead(p) && p.outMs < p.inMs)
        .map((p) => p.times + " in " + show(p.inMs) + ", out " + show(p.outMs));
      if (backwards.length) add("out-before-in", backwards.join("; "));
    }

    if (closed && !isImport && kinds.recordedOut === "blank" && kinds.statedOut === "blank") {
      add("closed-no-out", "both check-out cells blank");
    }

    if (closed && timesRead) {
      const off = pairs
        .filter((p) => bothRead(p) && p.outMs >= p.inMs)
        .filter((p) => {
          const n = logCheckHoursNumber(p.hours);
          const expected = hoursBetween(p.inMs, p.outMs);
          return (
            cellString(p.hours) === "" ||
            !isFinite(n) ||
            Math.abs(Math.round(n * 100) - Math.round(expected * 100)) > logCheckHoursTolerance()
          );
        })
        .map(
          (p) =>
            p.cell +
            " " +
            logCheckHoursCellText(p.hours) +
            ", times give " +
            hoursBetween(p.inMs, p.outMs).toFixed(2) +
            " h",
        );
      if (off.length) add("hours-mismatch", off.join("; "));
    }

    const tooLong = [];
    pairs.forEach((p) => {
      const n = logCheckHoursNumber(p.hours);
      if (isFinite(n) && (n < 0 || n > maxHours)) {
        tooLong.push(p.cell + " hours " + n.toFixed(2) + " h");
      }
    });
    if (timesRead) {
      pairs.forEach((p) => {
        if (bothRead(p) && p.outMs >= p.inMs && p.outMs - p.inMs > maxHours * 3600000) {
          const apart = Math.round(((p.outMs - p.inMs) / 3600000) * 100) / 100;
          tooLong.push(p.times + " times " + apart.toFixed(2) + " h apart");
        }
      });
    }
    if (tooLong.length) add("impossible-length", tooLong.join("; "));
  });
  return problems;
}

/**
 * The key (logCheckKey) of a Flags row as readFlags_ gives it ({date, name, shiftId,
 * reason, raisedAtMs, reviewed, source}), or "" when the row isn't a Log check flag: its
 * Source isn't "log check" (trimmed, any case) or its Reason doesn't start with a Log
 * check label and a colon. A Shift ID of logCheckNoIdText() keys by Date and Volunteer
 * Name.
 */
function logCheckFlagKey(flag) {
  const f = flag || {};
  if (cellString(f.source).toLowerCase() !== flagSources().logCheck) return "";
  const reason = cellString(f.reason);
  const reasons = logCheckReasons();
  const code = Object.keys(reasons).find((c) => reason.indexOf(reasons[c] + ":") === 0);
  return code ? logCheckKey(f.shiftId, f.date, f.name, code) : "";
}

/**
 * What one run flags. problems is logCheckProblems' list, flags the Flags tab's rows
 * (readFlags_), nowMs the run's time for Raised At and max the most rows to add
 * (logCheckMaxNewFlags() when left out). Returns {newRows, found, already, flagged, left,
 * byLabel}: newRows are flagRows maps with Source "log check", in problem order; found
 * counts distinct keys, already those whose key is on the tab, flagged is newRows.length
 * and left the rest, waiting for the next run. byLabel counts found keys per label, in
 * logCheckReasons() order, naming only labels with at least one.
 */
function logCheckPlan(problems, flags, nowMs, max) {
  const limit =
    max === undefined || max === null
      ? logCheckMaxNewFlags()
      : Math.max(0, Math.floor(Number(max)) || 0);
  const onTab = new Set();
  (flags || []).forEach((f) => {
    const key = logCheckFlagKey(f);
    if (key) onTab.add(key);
  });
  const seen = new Set();
  const counts = {};
  const newRows = [];
  let found = 0;
  let already = 0;
  (problems || []).forEach((p) => {
    if (seen.has(p.key)) return;
    seen.add(p.key);
    found++;
    counts[p.label] = (counts[p.label] || 0) + 1;
    if (onTab.has(p.key)) {
      already++;
      return;
    }
    if (newRows.length >= limit) return;
    const base = {
      date: p.base.date,
      name: p.base.name,
      shiftId: p.base.shiftId,
      raisedAtMs: nowMs,
      source: flagSources().logCheck,
      logRow: p.base.logRow,
    };
    flagRows(base, [p.reason]).forEach((row) => newRows.push(row));
  });
  const reasons = logCheckReasons();
  const byLabel = {};
  Object.keys(reasons).forEach((code) => {
    if (counts[reasons[code]]) byLabel[reasons[code]] = counts[reasons[code]];
  });
  return {
    newRows,
    found,
    already,
    flagged: newRows.length,
    left: found - already - newRows.length,
    byLabel,
  };
}

/**
 * The text a Log check result shows staff (Check the Log now's alert). result is
 * {kind: "done" | "busy" | "failed", checked, found, already, flagged, left, byLabel, ms,
 * message}; only its fields are read.
 */
function logCheckMessage(result) {
  const r = result || {};
  if (r.kind === "busy") {
    return "The kiosk was busy, so nothing was flagged. Try again in a minute.";
  }
  if (r.kind !== "done") {
    const why = cellString(r.message);
    return why ? "The Log check failed: " + why : "The Log check failed.";
  }
  const head = "Checked " + plural(r.checked || 0, "Log row", "Log rows");
  if (!r.found) return head + ": no problems found.";
  let text =
    head +
    ": found " +
    plural(r.found, "problem", "problems") +
    ". " +
    (r.flagged || 0) +
    " flagged now on the Flags tab, " +
    (r.already || 0) +
    " already flagged";
  if (r.left > 0) text += ", " + r.left + " more will be flagged next run";
  text += ".";
  const reasons = logCheckReasons();
  const by = r.byLabel || {};
  Object.keys(reasons).forEach((code) => {
    const n = by[reasons[code]];
    if (n > 0) text += "\n  " + reasons[code] + ": " + n;
  });
  return text;
}
