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
  return 'America/Chicago';
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

/** The Profiles list is cached only when its JSON is at most this many UTF-8 bytes. */
function profilesCacheMaxBytes() {
  return 100000;
}

function logHeaders() {
  return [
    'Shift ID',
    'Volunteer ID',
    'First name',
    'Last name',
    'Date',
    'Tapped in at',
    'Arrived at',
    'Signed out at',
    'Hours',
    'Status',
    'Flag',
    'Staff note',
  ];
}

/** Settings rows setupSheets creates when missing, as [name, default value]. */
function settingsDefaults(todayDate) {
  const rows = [
    ['Kiosk access code', ''],
    ['Volunteer Profiles file ID', ''],
    ['Volunteer Profiles tab', 'Volunteer Profiles'],
    ['Kiosk launch date', todayDate],
    ['Arrival flag minutes', String(defaultFlagMinutes())],
    ['Profiles problems', ''],
  ];
  ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].forEach(
    (day) => rows.push(['Closing time ' + day, '17:00']),
  );
  return rows;
}

/** Profiles headers the kiosk needs, after normalizeHeader. Email is never read. */
function requiredProfileHeaders() {
  return {
    firstName: 'volunteer first name',
    lastName: 'volunteer last name',
    token: 'onboarding token',
    phone: 'volunteer phone',
    startDate: 'start date mm/dd/yyyy',
  };
}

function refusalMessages() {
  return {
    ACCESS: 'This kiosk needs to be set up. Please ask a board member.',
    NOT_FOUND: "We couldn't find your profile. Please see a board member.",
    ALREADY_IN: "You're already checked in today.",
    NOT_IN: "You're not checked in today.",
    ARRIVAL_FUTURE: "Your arrival time can't be in the future. Please choose an earlier time.",
    ARRIVAL_OTHER_DAY: 'Please choose a time from today.',
    PHONE_NEEDED: 'Please enter the last four digits of your phone number.',
    PHONE_WRONG: "Those digits don't match our records. Please try again or see a board member.",
    PHONE_MISSING: 'We need to confirm who you are. Please see a board member.',
    BUSY: 'The kiosk is busy. Please try again.',
  };
}

/** Kiosk-logged milestones, checked in this order. */
function milestones() {
  return [
    {
      id: 'shift-1',
      title: 'First completed shift',
      message: 'Your first day making a difference. Welcome to the neighborhood!',
      kind: 'shifts',
      threshold: 1,
      sinceLaunchOnly: true,
    },
    {
      id: 'shift-10',
      title: '10 shifts',
      message: '10 shifts checked in here. Thank you for showing up for your neighbors!',
      kind: 'shifts',
      threshold: 10,
      sinceLaunchOnly: false,
    },
    {
      id: 'shift-25',
      title: '25 shifts',
      message: "25 shifts checked in here. That's something special.",
      kind: 'shifts',
      threshold: 25,
      sinceLaunchOnly: false,
    },
    {
      id: 'hours-50',
      title: '50 hours',
      message: '50 hours logged here. 50 hours of care, kindness, and community.',
      kind: 'hours',
      threshold: 50,
      sinceLaunchOnly: false,
    },
    {
      id: 'hours-100',
      title: '100 hours',
      message: '100 hours logged here, making East Nashville stronger.',
      kind: 'hours',
      threshold: 100,
      sinceLaunchOnly: false,
    },
  ];
}

// ---------------------------------------------------------------------------
// Text

function cellString(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

/** Newlines and runs of spaces become one space, trimmed, lower-cased. */
function normalizeHeader(text) {
  return cellString(text).replace(/\s+/g, ' ').toLowerCase();
}

function normalizeName(text) {
  return cellString(text).replace(/\s+/g, ' ').toLowerCase();
}

/** Lower-case letters only, so a passphrase typed on the letter keyboard matches the sheet. */
function normalizeCode(text) {
  return cellString(text).toLowerCase().replace(/[^a-z]/g, '');
}

/**
 * Text written into a sheet cell. A leading '=' would make Sheets read the value as a
 * formula, so such text gets the apostrophe that marks a cell as plain text.
 */
function sheetText(text) {
  const s = cellString(text);
  return s.charAt(0) === '=' ? "'" + s : s;
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
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += ((bytes[i] + 256) % 256).toString(16).padStart(2, '0');
  }
  return hex;
}

/** The kiosk's Volunteer ID: the first 16 hex characters of the token's SHA-256. */
function idFromHash(hex) {
  return String(hex).toLowerCase().slice(0, 16);
}

/** Last four digits of a phone number, ignoring a trailing extension; empty if fewer than four. */
function phoneLast4(text) {
  const withoutExtension = cellString(text).replace(/\s*(?:ext\.?|x|#)\s*\d+\s*$/i, '');
  const digits = withoutExtension.replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : '';
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
    if (!m) return '';
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
    return '';
  }
  return year + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0');
}

/**
 * True when a Log Date cell is today. The cell arrives as text (a Date cell already
 * formatted as yyyy-MM-dd); a date-time text counts by its date part.
 */
function isRowToday(cellText, todayDate) {
  if (!todayDate) return false;
  const datePart = cellString(cellText).split(/[\sT]/)[0];
  return parseStartDate(datePart) === todayDate;
}

/** The Settings arrival flag minutes, or the default when blank or not a number of 0 or more. */
function parseFlagMinutes(text) {
  const s = cellString(text);
  const n = Number(s);
  return s !== '' && isFinite(n) && n >= 0 ? n : defaultFlagMinutes();
}

// ---------------------------------------------------------------------------
// Volunteer Profiles

function rowList(rowNumbers) {
  return (rowNumbers.length === 1 ? 'row ' : 'rows ') + rowNumbers.join(', ');
}

/**
 * Builds the kiosk list from the Profiles header row and data rows (all cells already
 * strings). Data row i is sheet row i + 2. hashFn(token) returns SHA-256 hex.
 *
 * Every row with a first and last name either is listed with an ID of its own, or gets
 * a problem line saying why it can't check in. Rows without both names are skipped.
 * A same-name member whose phone can't confirm them (none, or the same last four as
 * another member) is listed with phoneLast4 '' so checkPhone returns PHONE_MISSING.
 * Returns {volunteers: [{id, firstName, lastName, phoneLast4, startDate, needsPhoneCheck}],
 * problems: [{row, text}]} with problems in row order.
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

  const problems = [];
  const candidates = [];
  rows.forEach((cells, i) => {
    const row = i + 2;
    const cell = (key) => cellString(cells[col[key]]);
    const firstName = cell('firstName');
    const lastName = cell('lastName');
    if (!firstName || !lastName) return;
    const name = firstName + ' ' + lastName;
    const token = cell('token');
    if (!token) {
      problems.push({ row, text: 'row ' + row + ': ' + name + ' has no onboarding token' });
      return;
    }
    candidates.push({
      row,
      name,
      volunteer: {
        id: idFromHash(hashFn(token)),
        firstName,
        lastName,
        phoneLast4: phoneLast4(cell('phone')),
        startDate: parseStartDate(cell('startDate')),
        needsPhoneCheck: false,
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
      text: 'row ' + c.row + ': ' + c.name + ' has the same onboarding token as ' + rowList(others),
    });
  });

  const nameKey = (v) => normalizeName(v.firstName) + '|' + normalizeName(v.lastName);
  const nameCounts = new Map();
  listed.forEach((c) => {
    const key = nameKey(c.volunteer);
    nameCounts.set(key, (nameCounts.get(key) || 0) + 1);
  });
  // Within a same-name group the last four must tell members apart. A member whose last
  // four matches another member's can't be confirmed by phone, so they are treated like
  // a member with no usable phone: listed, refused with PHONE_MISSING, and reported.
  const twins = listed.filter((c) => nameCounts.get(nameKey(c.volunteer)) > 1);
  const clashes = new Map();
  twins.forEach((c) => {
    const rows = twins
      .filter(
        (o) =>
          o !== c &&
          c.volunteer.phoneLast4 &&
          o.volunteer.phoneLast4 === c.volunteer.phoneLast4 &&
          nameKey(o.volunteer) === nameKey(c.volunteer),
      )
      .map((o) => o.row);
    if (rows.length) clashes.set(c, rows);
  });
  twins.forEach((c) => {
    c.volunteer.needsPhoneCheck = true;
    if (!c.volunteer.phoneLast4) {
      problems.push({
        row: c.row,
        text: 'row ' + c.row + ': ' + c.name + ' shares a name and has no usable phone number',
      });
    } else if (clashes.has(c)) {
      c.volunteer.phoneLast4 = '';
      problems.push({
        row: c.row,
        text:
          'row ' +
          c.row +
          ': ' +
          c.name +
          ' shares a name and the last four phone digits with ' +
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

// ---------------------------------------------------------------------------
// Access, phone and arrival checks

/** null when the code matches a Settings code of at least minCodeLetters(), else 'ACCESS'. */
function checkAccessCode(given, stored) {
  const expected = normalizeCode(stored);
  if (expected.length < minCodeLetters()) return 'ACCESS';
  return normalizeCode(given) === expected ? null : 'ACCESS';
}

/** null when no phone check is needed or the digits match, else a refusal code. */
function checkPhone(volunteer, digits) {
  if (!volunteer.needsPhoneCheck) return null;
  if (!volunteer.phoneLast4) return 'PHONE_MISSING';
  const given = cellString(digits).replace(/\D/g, '');
  if (!given) return 'PHONE_NEEDED';
  return given === volunteer.phoneLast4 ? null : 'PHONE_WRONG';
}

/**
 * {arrivedMs} for an acceptable arrival, else a refusal code. An arrival up to
 * arrivalGraceMinutes() ahead of server time is taken as server time. arrivedDate is the
 * arrival's Central date.
 */
function validateArrival(nowMs, arrivedMs, arrivedDate, todayDate) {
  if (typeof arrivedMs !== 'number' || !isFinite(arrivedMs)) return 'ARRIVAL_OTHER_DAY';
  if (arrivedMs - nowMs > arrivalGraceMinutes() * 60000) return 'ARRIVAL_FUTURE';
  if (arrivedMs > nowMs) return { arrivedMs: nowMs };
  if (arrivedDate !== todayDate) return 'ARRIVAL_OTHER_DAY';
  return { arrivedMs };
}

/** '' or 'arrival differs by N min', with N the rounded gap compared and printed alike. */
function arrivalFlag(tappedMs, arrivedMs, thresholdMin) {
  if (!isFinite(tappedMs) || !isFinite(arrivedMs)) return '';
  const n = Math.round(Math.abs(tappedMs - arrivedMs) / 60000);
  return n > thresholdMin ? 'arrival differs by ' + n + ' min' : '';
}

// ---------------------------------------------------------------------------
// Hours and milestones

/** Hours from start to end, 2 decimals, never negative; 0 when either time is unreadable. */
function hoursBetween(startMs, endMs) {
  if (!isFinite(startMs) || !isFinite(endMs)) return 0;
  return Math.max(0, Math.round(((endMs - startMs) / 3600000) * 100) / 100);
}

/** Whole minutes from an Hours cell; 0 when blank, unreadable or negative. */
function minutesFromHours(hours) {
  const n = Number(hours);
  if (!isFinite(n)) return 0;
  return Math.max(0, Math.round(n * 60));
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
      m.kind === 'shifts'
        ? beforeShifts < m.threshold && afterShifts >= m.threshold
        : beforeMinutes < m.threshold * 60 && afterMinutes >= m.threshold * 60;
    if (crossed) return { id: m.id, title: m.title, message: m.message };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Log rows
//
// A log entry is one Log row as Sheets.js reads it:
// {row, id, dateText, tappedMs, arrivedMs, hours, status}. Times are NaN when the cell
// is not a date.

function isStatus(entry, status) {
  return cellString(entry.status).toLowerCase() === status;
}

/** When the shift started: Arrived at, or Tapped in at when Arrived at is unreadable. */
function shiftStartMs(entry) {
  return isFinite(entry.arrivedMs) ? entry.arrivedMs : entry.tappedMs;
}

/** This ID's open row dated today (the latest start if staff edits left more than one), or null. */
function findOpenShiftToday(entries, id, todayDate) {
  let found = null;
  entries.forEach((e) => {
    if (e.id !== id || !isStatus(e, 'open') || !isRowToday(e.dateText, todayDate)) return;
    if (!found || shiftStartMs(e) > shiftStartMs(found)) found = e;
  });
  return found;
}

/** Count and total whole minutes of this ID's closed rows. */
function closedTotals(entries, id) {
  let shifts = 0;
  let minutes = 0;
  entries.forEach((e) => {
    if (e.id !== id || !isStatus(e, 'closed')) return;
    shifts += 1;
    minutes += minutesFromHours(e.hours);
  });
  return { shifts, minutes };
}

/** The list the page gets: no phone, start date or token. */
function volunteerSummaries(volunteers, entries, todayDate) {
  return volunteers.map((v) => {
    const open = findOpenShiftToday(entries, v.id, todayDate);
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
// Check-in and check-out decisions

/**
 * Checks a check-in in order: NOT_FOUND, phone, ALREADY_IN, ARRIVAL_FUTURE,
 * ARRIVAL_OTHER_DAY. Input: {volunteer (or null), digits, entries, todayDate, nowMs,
 * arrivedMs, arrivedDate, flagMinutes}. Returns {refusal} or {arrivedMs, flag}.
 */
function decideCheckIn(input) {
  if (!input.volunteer) return { refusal: 'NOT_FOUND' };
  const phone = checkPhone(input.volunteer, input.digits);
  if (phone) return { refusal: phone };
  if (findOpenShiftToday(input.entries, input.volunteer.id, input.todayDate)) {
    return { refusal: 'ALREADY_IN' };
  }
  const arrival = validateArrival(input.nowMs, input.arrivedMs, input.arrivedDate, input.todayDate);
  if (typeof arrival === 'string') return { refusal: arrival };
  return {
    arrivedMs: arrival.arrivedMs,
    flag: arrivalFlag(input.nowMs, arrival.arrivedMs, input.flagMinutes),
  };
}

/**
 * Checks a check-out in order: NOT_FOUND, phone, NOT_IN. Input: {volunteer (or null),
 * digits, entries (the whole Log), todayDate, nowMs, launchDate}. Returns {refusal} or
 * {row, hours, minutes, milestone}, with the milestone counted from the closed rows
 * before this one.
 */
function decideCheckOut(input) {
  if (!input.volunteer) return { refusal: 'NOT_FOUND' };
  const phone = checkPhone(input.volunteer, input.digits);
  if (phone) return { refusal: phone };
  const open = findOpenShiftToday(input.entries, input.volunteer.id, input.todayDate);
  if (!open) return { refusal: 'NOT_IN' };
  const hours = hoursBetween(shiftStartMs(open), input.nowMs);
  const minutes = minutesFromHours(hours);
  const before = closedTotals(input.entries, input.volunteer.id);
  return {
    row: open.row,
    hours,
    minutes,
    milestone: milestoneCrossed(
      before.shifts,
      before.minutes,
      minutes,
      input.volunteer.startDate,
      input.launchDate,
    ),
  };
}

/** {ok: false, refusal, message} for a refusal code. */
function refusal(code) {
  const message = refusalMessages()[code];
  if (!message) throw new Error('Unknown refusal code: ' + code);
  return { ok: false, refusal: code, message };
}
