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

/** The script cache key for the Settings tab's values, with the time they were read. */
function settingsCacheKey() {
  return "settings:v1";
}

/** The script cache key for the time of the last Settings edit, in ms since 1970, as text. */
function settingsStampKey() {
  return "settings:edited";
}

/** How long a cached copy of Settings may be used after it was read from the tab. */
function settingsCacheSeconds() {
  return 300;
}

/** Settings are cached only when their cached text is at most this many UTF-8 bytes. */
function settingsCacheMaxBytes() {
  return 100000;
}

/** The cached text for settings ({name: text}) read from the tab at readAtMs. */
function settingsCacheValue(settings, readAtMs) {
  return JSON.stringify({ v: 1, readAt: readAtMs, settings });
}

/**
 * The settings in a cached Settings text (settingsCacheValue), or null when they may not
 * be used. They may be used only when they were read from the tab after the last edit
 * stamp (stampText, null or undefined when there is none) and less than
 * settingsCacheSeconds() before nowMs. Anything that can't be read as that (not JSON, an
 * unknown version, a read time that isn't a number, a value that isn't text, a stamp
 * that isn't a whole number) gives null, and the caller reads the tab.
 */
function settingsFromCache(valueText, stampText, nowMs) {
  if (typeof valueText !== "string" || !valueText) return null;
  let value;
  try {
    value = JSON.parse(valueText);
  } catch (e) {
    return null;
  }
  if (!value || typeof value !== "object" || value.v !== 1) return null;
  const readAt = value.readAt;
  if (typeof readAt !== "number" || !Number.isFinite(readAt)) return null;
  if (!(nowMs - readAt < settingsCacheSeconds() * 1000)) return null;
  if (stampText !== null && stampText !== undefined) {
    if (typeof stampText !== "string" || !/^\d+$/.test(stampText)) return null;
    if (!(readAt > Number(stampText))) return null;
  }
  const settings = value.settings;
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return null;
  for (const name of Object.keys(settings)) {
    if (typeof settings[name] !== "string") return null;
  }
  return settings;
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
    [kioskContactSetting(), ""],
  );
  return rows;
}

/** The header of the Settings tab's column C, which says what each setting does. */
function settingsDescriptionHeader() {
  return "What it does";
}

/**
 * One plain sentence per Settings row, for staff: what the setting does, what to type and
 * what blank means. setupSheets writes them into column C on every run and never touches
 * a value. A row the kiosk fills itself starts "Written by the kiosk:". The names are
 * exactly settingsDefaults()' names, and a test holds the two lists together.
 */
function settingsDescriptions() {
  return {
    "Kiosk access code":
      "The code a board member types on the tablet to open the kiosk: at least 16 letters (only letters count, and capitals are the same as small letters), and while it's blank or shorter no tablet can open.",
    "Volunteer Profiles file ID":
      "Which spreadsheet the volunteer list comes from, as the long ID in its link between /d/ and /edit; while it's blank, no volunteer can be found on the tablet or in the menu.",
    "Volunteer Profiles tab":
      "The tab in that spreadsheet that holds the volunteer list; blank means a tab named Volunteer Profiles.",
    "Kiosk launch date":
      "The day the kiosk started, as yyyy-mm-dd: only volunteers who started on or after it get the first-shift welcome, and the nightly auto clock-out closes only shifts on or after it, so never leave it blank.",
    "Arrival flag minutes":
      "How many minutes a volunteer's chosen arrival time can be from the moment they tapped in before the shift is flagged, as a number 0 or more; blank means 15.",
    "Check-out flag minutes":
      "How many minutes a volunteer's chosen check-out time can be from the moment they tapped out before the shift is flagged, as a number 0 or more; blank means 15.",
    [volunteerHourValueSetting()]:
      "The dollar value of one volunteer hour, such as 34.79, used in the monthly report; while it's blank the report leaves the value out and says to set it here.",
    "Profiles problems":
      "Written by the kiosk: rows of Volunteer Profiles it had to leave out, and why (blank means none), so fix them in Volunteer Profiles, not here.",
    "Auto clock-out after hours":
      "How many hours after check-in a shift nobody checked out of stays open on the tablet before the nightly auto clock-out closes it, from 10 to 24; blank or anything else means 12.",
    "Auto clock-out last run":
      "Written by the kiosk: when the nightly auto clock-out last ran and how many shifts it closed, so leave it alone.",
    "Long shift flag hours":
      "A tablet check-out that credits more hours than this is flagged as a long shift, as a number above 0; blank or anything else means 8.",
    "Flags email":
      "Type On to send the weekly flags email; anything else, blank included, keeps it off.",
    "Flags email to":
      "Who gets the weekly flags email, as one or more email addresses separated by commas, spaces or new lines; blank sends nothing.",
    "Flags email day":
      "The weekday the weekly flags email goes out if there is anything to report, such as Monday or Mon; blank or anything else means Monday, and the first one after a change, or after turning the email On, can come sooner (see the How to tab).",
    "Flags email hour":
      "The hour, Central time, the weekly flags email goes out if there is anything to report, as a whole number from 0 to 23 (8 is 8 AM, 14 is 2 PM); blank or anything else means 8, and the first one after a change, or after turning the email On, can come sooner (see the How to tab).",
    "Flags email last run":
      "Written by the kiosk: when the weekly flags email last checked and whether it sent or had nothing to send; while the email is On with an address, clearing it makes the next hourly check run again, which sends only if there is anything to report.",
    "Daily jobs installed by":
      "Written by the kiosk: the Google account that runs the nightly jobs and the weekly email, so leave it alone.",
    [importFileSetting()]:
      "The old hours spreadsheet that Kiosk admin > Import past hours… offers first; an import fills it in, and blank just means the window starts empty.",
    [importTabSetting()]:
      "The tab in that old hours spreadsheet that Import past hours… offers first; blank means Historical Hours.",
    [kioskContactSetting()]:
      "Who to ask when the kiosk or this sheet isn't working, such as a name and an email or phone: the How to tab shows it, and so does the Kiosk admin menu when something goes wrong; while it's blank, the How to tab says to ask whoever looks after the kiosk.",
  };
}

/**
 * Column C of the Settings tab from row 2 down, one text per name in names (column A's
 * text, read the way readSettings_ reads it, down to the last row with a name). It says
 * what readSettings_ does with each row, because both compare names exactly:
 * - a known name, the first time: its sentence;
 * - the same known name again: the not-used line, since only the first row counts;
 * - a name the kiosk doesn't know, every time: the unknown line;
 * - no name: "".
 * Known means an own key of settingsDescriptions(), so "toString" is unknown.
 */
function settingsDescriptionColumn(names) {
  const descriptions = settingsDescriptions();
  const seen = {};
  return (names || []).map((raw) => {
    const name = cellString(raw);
    if (name === "") return "";
    if (!Object.prototype.hasOwnProperty.call(descriptions, name)) {
      return "The kiosk doesn't use this row.";
    }
    if (Object.prototype.hasOwnProperty.call(seen, name)) {
      return "Not used: an earlier row has the same name, and only the first one counts.";
    }
    seen[name] = true;
    return descriptions[name];
  });
}

/**
 * The description of the one warning-only protection on Settings column C, so typing
 * there warns first. setupSheets finds it by this text and never adds a second.
 */
function settingsDescriptionProtection() {
  return "What it does: written by the kiosk. Type a setting's value in the Value column, not here.";
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
    ADMIN_REMOVE_REASON: "Please enter a reason for removing this shift.",
    ADMIN_REMOVE_NO_ID:
      "That row has no Shift ID, so the menu can't remove it. Delete it in the sheet by hand.",
    ADMIN_REMOVE_NOT_FOUND:
      "No Log row has that Shift ID any more. Close this window and find the shift again.",
    ADMIN_REMOVE_MOVED:
      "That row moved or changed in the Log since you found it. Find the shift again, then remove it.",
    ADMIN_REMOVE_HEADERS:
      "This row has a value in a column whose header is blank, repeated, or named like a Removed shifts column, so it can't be removed without losing that value. Give that column a unique header first.",
    ADMIN_RESTORE_NOT_FOUND:
      "That shift is no longer on the Removed shifts tab. Close this window and open Restore a shift again.",
    ADMIN_RESTORE_MOVED:
      "That row moved or changed on the Removed shifts tab. Close this window and open Restore a shift again.",
    ADMIN_RESTORE_IN_LOG:
      "A Log row already has this Shift ID, so the shift is already in the Log. Tidy the extra copy by hand.",
    ADMIN_RESTORE_OPEN_SHIFT:
      "This shift is open and the volunteer already has an open shift in the Log. Close that one with Fix a sign-out first.",
    ADMIN_RESTORE_HEADERS:
      "This row has a value in a column the Log doesn't have exactly once, or whose header is blank or repeated, so it can't go back without losing that value. Give the Log one column with that header first.",
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
 * when the launch date can't be read; rows before it, and imported rows (Shift ID
 * import-), never count. A paper row has no tablet check-out to miss.
 */
function missedSignOut(entries, token, launchDate) {
  const launch = parseStartDate(launchDate);
  if (!launch) return false;
  const rows = entries.filter((e) => {
    const date = rowDate(e.dateText);
    return isTokenRow(e, token) && !isImportShiftId(e.shiftId) && date !== "" && date >= launch;
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
// Removed shifts
//
// Remove a shift… moves one Log row, found by its Shift ID, to the "Removed shifts" tab,
// with who removed it, when and why, and ticks that row's Flags rows Reviewed. Restore a
// shift… puts a Removed row back at the end of the Log. Both tabs are read and written by
// header, as the Log is.
//
// The rule both keep: Remove then Restore gives back every non-blank cell of the row. A
// value under a header that can't be mapped both ways (blank, repeated, or named like one
// of the Removed tab's own three columns) is refused on the way out, and a value under a
// header the Log no longer has is refused on the way back.

/** The tab Remove a shift… moves rows to. Nothing but Restore reads it. */
function removedTabName() {
  return "Removed shifts";
}

/** The three columns the Removed tab has after the Log's own headers. */
function removedExtraHeaders() {
  return { by: "Removed by", at: "Removed at", reason: "Removed reason" };
}

/** The description of the Removed tab's one warning-only protection. */
function removedProtectionDescription() {
  return (
    "Removed shifts: rows removed from the Log. Use Kiosk admin > Restore a shift… to put " +
    "one back."
  );
}

/** True when a header is one of the three removedExtraHeaders(), by normalizeHeader. */
function isRemovedExtraHeader(header) {
  const k = normalizeHeader(header);
  const extras = removedExtraHeaders();
  return Object.keys(extras).some((name) => normalizeHeader(extras[name]) === k);
}

/** {normalized header: how many cells of headerRow have it}; blank headers aren't counted. */
function headerCounts(headerRow) {
  const counts = {};
  (headerRow || []).forEach((h) => {
    const k = normalizeHeader(h);
    if (k) counts[k] = (Object.prototype.hasOwnProperty.call(counts, k) ? counts[k] : 0) + 1;
  });
  return counts;
}

/** How a refusal names a column: its header on one line, or its letter when it has none. */
function headerProblemText(headerRow, index) {
  const h = cellString(headerRow[index]).replace(/\s+/g, " ");
  return h || columnLetter(index) + " (no header)";
}

/**
 * The header cells to write in row 1 of the Removed tab, as [{col (1-based), header}],
 * always one run of columns. An empty tab gets the Log's header row as it is, blanks
 * included, up to its last header, then the three extras. A tab that has a header gets,
 * right of its last header, each Log header it lacks (in Log order, once each, leaving out
 * a Log header named like an extra), then any extra it lacks.
 */
function removedHeaderWrites(logHeader, removedHeader) {
  const extras = removedExtraHeaders();
  const extraList = [extras.by, extras.at, extras.reason];
  const lastOf = (row) => {
    let last = -1;
    (row || []).forEach((cell, i) => {
      if (cellString(cell) !== "") last = i;
    });
    return last;
  };
  const last = lastOf(removedHeader);
  if (last < 0) {
    const logPart = (logHeader || []).slice(0, lastOf(logHeader) + 1).map(cellString);
    return logPart.concat(extraList).map((header, i) => ({ col: i + 1, header }));
  }
  const have = headerCounts(removedHeader);
  const wanted = [];
  (logHeader || []).forEach((h) => {
    const k = normalizeHeader(h);
    if (!k || have[k] || isRemovedExtraHeader(h)) return;
    have[k] = 1;
    wanted.push(cellString(h));
  });
  extraList.forEach((h) => {
    if (!have[normalizeHeader(h)]) wanted.push(h);
  });
  return wanted.map((header, i) => ({ col: last + 2 + i, header }));
}

/**
 * A row of width cells for toHeader, each copied from the fromRow cell under the same
 * header in fromHeader (normalizeHeader forms; the leftmost when one repeats). A header
 * goes to its leftmost column in toHeader only. A cell with no match, or under a blank
 * header, is null, so the caller decides what goes there.
 */
function headerMapCopy(fromHeader, fromRow, toHeader, width) {
  const from = {};
  (fromHeader || []).forEach((h, i) => {
    const k = normalizeHeader(h);
    if (k && !Object.prototype.hasOwnProperty.call(from, k)) from[k] = i;
  });
  const used = {};
  return Array.from({ length: width }, (_, j) => {
    const k = normalizeHeader((toHeader || [])[j]);
    if (!k || used[k] || !Object.prototype.hasOwnProperty.call(from, k)) return null;
    used[k] = true;
    const value = (fromRow || [])[from[k]];
    return value === undefined ? null : value;
  });
}

/**
 * The column a Log row can't be moved to Removed shifts without losing, as
 * headerProblemText gives it, or "": the first non-blank cell under a blank or repeated Log
 * header, or under a Log header named like one of the Removed tab's extras.
 */
function removeHeaderProblem(logHeader, cells) {
  const counts = headerCounts(logHeader);
  for (let i = 0; i < (cells || []).length; i++) {
    if (cellString(cells[i]) === "") continue;
    const k = normalizeHeader(logHeader[i]);
    if (!k || counts[k] > 1 || isRemovedExtraHeader(logHeader[i])) {
      return headerProblemText(logHeader, i);
    }
  }
  return "";
}

/**
 * The column a Removed row can't go back to the Log without losing, as headerProblemText
 * gives it, or "": the first non-blank cell, other than the three extras, under a blank or
 * repeated Removed header, or under a header the Log doesn't have exactly once.
 */
function restoreHeaderProblem(removedHeader, cells, logHeader) {
  const removed = headerCounts(removedHeader);
  const log = headerCounts(logHeader);
  for (let i = 0; i < (cells || []).length; i++) {
    if (cellString(cells[i]) === "") continue;
    const k = normalizeHeader(removedHeader[i]);
    if (k && isRemovedExtraHeader(removedHeader[i])) continue;
    if (!k || removed[k] > 1 || log[k] !== 1) return headerProblemText(removedHeader, i);
  }
  return "";
}

/**
 * The row a Remove or Restore acts on, from the rows that hold its Shift ID: the only one
 * wherever it has moved, or, when the Shift ID is on several rows, the one still at row.
 * null when none is.
 */
function pickShiftRow(candidates, row) {
  const list = candidates || [];
  if (list.length === 1) return list[0];
  return list.find((c) => c.row === Number(row)) || null;
}

/**
 * Checks a Remove a shift… in order: ADMIN_INITIALS, ADMIN_REMOVE_REASON (blank),
 * ADMIN_NOTE_TOO_LONG (reason), ADMIN_REMOVE_NO_ID, ADMIN_REMOVE_NOT_FOUND (no Log row
 * has the Shift ID), ADMIN_REMOVE_MOVED (pickShiftRow found none), ADMIN_REMOVE_HEADERS
 * (removeHeaderProblem).
 *
 * Input: {candidates: [{row, values, formats, entry}] (the Log rows with the Shift ID, read
 * under the lock), shiftId, row (the row the dialog showed), reason, initials, logHeader}.
 *
 * Returns {refusal}, {refusal: "ADMIN_REMOVE_HEADERS", header}, or {target, initials,
 * reason, remaining}: remaining is how many other Log rows hold the Shift ID.
 */
function decideRemove(input) {
  const initials = normalizeInitials(input.initials);
  if (!initials) return { refusal: "ADMIN_INITIALS" };
  const reason = cellString(input.reason);
  if (!reason) return { refusal: "ADMIN_REMOVE_REASON" };
  if (reason.length > adminNoteMaxLength()) return { refusal: "ADMIN_NOTE_TOO_LONG" };
  if (!cellString(input.shiftId)) return { refusal: "ADMIN_REMOVE_NO_ID" };
  const candidates = input.candidates || [];
  if (!candidates.length) return { refusal: "ADMIN_REMOVE_NOT_FOUND" };
  const target = pickShiftRow(candidates, input.row);
  if (!target) return { refusal: "ADMIN_REMOVE_MOVED" };
  const header = removeHeaderProblem(input.logHeader, target.values);
  if (header) return { refusal: "ADMIN_REMOVE_HEADERS", header };
  return { target, initials, reason, remaining: candidates.length - 1 };
}

/**
 * Checks a Restore a shift… in order: ADMIN_INITIALS, ADMIN_RESTORE_NOT_FOUND (no Removed
 * row has the Shift ID), ADMIN_RESTORE_MOVED (pickShiftRow found none),
 * ADMIN_RESTORE_IN_LOG (a Log row has the Shift ID), ADMIN_RESTORE_OPEN_SHIFT (the row is
 * open and the volunteer has an open Log row), ADMIN_RESTORE_HEADERS
 * (restoreHeaderProblem).
 *
 * Input: {candidates: [{row, values, formats, entry}] (the Removed rows with the Shift
 * ID), shiftId, row, initials, logShiftIds (every Shift ID on the Log, from one read of
 * its Shift ID column), tokenEntries (the Log entries of the row's User Token),
 * removedHeader, logHeader}.
 *
 * Returns {refusal}, {refusal: "ADMIN_RESTORE_HEADERS", header}, or {target, initials}.
 */
function decideRestore(input) {
  const initials = normalizeInitials(input.initials);
  if (!initials) return { refusal: "ADMIN_INITIALS" };
  const shiftId = cellString(input.shiftId);
  const candidates = shiftId ? input.candidates || [] : [];
  if (!candidates.length) return { refusal: "ADMIN_RESTORE_NOT_FOUND" };
  const target = pickShiftRow(candidates, input.row);
  if (!target) return { refusal: "ADMIN_RESTORE_MOVED" };
  if ((input.logShiftIds || []).some((id) => cellString(id) === shiftId)) {
    return { refusal: "ADMIN_RESTORE_IN_LOG" };
  }
  if (
    isStatus(target.entry, "open") &&
    (input.tokenEntries || []).some((e) => isStatus(e, "open") && isTokenRow(e, target.entry.token))
  ) {
    return { refusal: "ADMIN_RESTORE_OPEN_SHIFT" };
  }
  const header = restoreHeaderProblem(input.removedHeader, target.values, input.logHeader);
  if (header) return { refusal: "ADMIN_RESTORE_HEADERS", header };
  return { target, initials };
}

/**
 * A row as Remove and Restore list it: {label, detail}. entry is a log entry plus inBy
 * (Check-In Entered By), and, for a Removed row, removedBy, removedAtDate (Central
 * yyyy-MM-dd), removedAtMs and removedReason. clock(ms) gives a Central "9:00 AM". The
 * label reads "Thu 2026-11-12 · Jordan Rivera · in 9:00 AM · closed"; the detail has one
 * line each for the row's date, name, status, times, hours, Entered By, alerts and notes,
 * and for a Removed row who removed it, when and why.
 */
function shiftChoiceLabel(entry, clock) {
  const e = entry || {};
  const date = rowDate(e.dateText);
  const day = date ? weekdayName(date).slice(0, 3) + " " + date : cellString(e.dateText);
  const time = (ms) => (isFinite(ms) ? clock(ms) : "blank or unreadable");
  const hours = (h) => (typeof h === "number" && isFinite(h) ? h.toFixed(2) : "blank");
  const start = hasReadableStart(e) ? "in " + clock(shiftStartMs(e)) : "check-in unreadable";
  const label = [
    day || "no date",
    cellString(e.name) || "no name",
    start,
    cellString(e.status) || "no status",
  ].join(" · ");
  const lines = [
    "Date: " + (cellString(e.dateText) || "blank"),
    "Volunteer: " + (cellString(e.name) || "blank"),
    "Status: " + (cellString(e.status) || "blank"),
    "Check-in: stated " + time(e.statedInMs) + ", recorded " + time(e.recordedInMs),
    "Check-out: stated " + time(e.statedOutMs) + ", recorded " + time(e.recordedOutMs),
    "Hours: stated " + hours(e.statedHours) + ", timestamps " + hours(e.recordedHours),
    "Entered by: in " +
      (cellString(e.inBy) || "blank") +
      ", out " +
      (cellString(e.outBy) || "blank"),
    "Admin Alerts?: " + (cellString(e.alerts) || "none"),
    "Notes: " + (cellString(e.notes) || "none"),
    "Shift ID: " + (cellString(e.shiftId) || "none"),
  ];
  if (e.removedBy !== undefined) {
    const at = isFinite(e.removedAtMs)
      ? cellString(e.removedAtDate) + " " + clock(e.removedAtMs)
      : "unknown";
    lines.push("Removed by: " + (cellString(e.removedBy) || "blank") + ", at " + at);
    lines.push("Removed reason: " + (cellString(e.removedReason) || "blank"));
  }
  return { label, detail: lines.join("\n") };
}

/** The note Remove adds to each Flags row it ticks. today is yyyy-MM-dd. */
function removeFlagNote(initials, reason, today) {
  return (
    "Log row removed by " +
    cellString(initials) +
    " on " +
    cellString(today) +
    ": " +
    cellString(reason)
  );
}

/** The note Restore adds to each Flags row of the Shift ID. today is yyyy-MM-dd. */
function restoreFlagNote(initials, today) {
  return "Log row restored by " + cellString(initials) + " on " + cellString(today) + ".";
}

/**
 * Whether Remove ticks a Flags row that has the removed row's Shift ID. flag is {date,
 * name, reason, source, logRow}; only is {row, date, name, remaining}: the removed row's
 * number, Date and Volunteer Name, and how many Log rows still hold the Shift ID after the
 * delete. With none left, every flag of the Shift ID was the removed row's. With some
 * left, a flag is the removed row's only when its Log Row, Date and Volunteer Name are
 * the removed row's; and the Log check's "Shift ID on more than one row" flag is ticked
 * too when exactly one row is left, since the pair it reports is gone. Every other flag is
 * left for the remaining copy. A stale Log Row leaves a flag unticked, the safe side.
 */
function removeFlagMatches(flag, only) {
  const f = flag || {};
  if (!only || !(only.remaining > 0)) return true;
  const date = cellString(f.date);
  const sameDate = date === cellString(only.date) || (date !== "" && date === rowDate(only.date));
  const sameRow = cellString(f.logRow) !== "" && Number(f.logRow) === Number(only.row);
  if (sameRow && sameDate && normalizeName(f.name) === normalizeName(only.name)) return true;
  if (only.remaining !== 1) return false;
  const source = flagSources().logCheck;
  if (!source || cellString(f.source) !== source) return false;
  return cellString(f.reason).indexOf(logCheckReasons()["duplicate-id"] + ":") === 0;
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
 * "none". trigger is ensureHoursSortTrigger_'s answer: {kind: "installed" or "kept",
 * account} or {kind: "failed", message}; the sort boxes run as that account, and a failure
 * doesn't undo Hours. It ends with the things staff must do by hand: rerun setupDailyJobs
 * once for the nightly Hours refresh when the jobs were installed before it, and rerun
 * setupReports after a Log column moves, since the filter views name Log columns by letter.
 */
function setupReportsMessage(counts) {
  const v = counts.views;
  const w = counts.warnings;
  const h = counts.hours || {};
  const t = counts.trigger || {};
  const trigger = {
    installed: "The sort boxes run as " + cellString(t.account) + " (trigger installed).",
    kept: "The sort boxes run as " + cellString(t.account) + " (trigger already installed).",
    failed:
      "The sort boxes' trigger couldn't be installed: " +
      hoursSentence(t.message) +
      " Hours is set up, but picking a sort does nothing until setupReports runs again and installs it.",
  }[t.kind];
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
    trigger,
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
// tables and seven slicers over it. Nothing on either tab is a formula over the Log, so a
// kiosk tap starts no recalculation there; the tables are as of the last refresh.
//
// Hours data's row 1 also holds the refresh's state cells, L1 to Q1, outside the pivots'
// columns A to K. Every time in them is epoch milliseconds written as digits:
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

/**
 * Hours data's headers, columns A to K. Date and To date hold the same day, so a From date
 * slicer on one and a To date slicer on the other make a range: two slicers on one column
 * would share one filter.
 */
function hoursDataHeaders() {
  return [
    "Date",
    "Year",
    "Month",
    "To date",
    "Start",
    "Volunteer",
    "Shifts",
    "Hours",
    "Role/Type",
    "Activity",
    "Shift",
  ];
}

/**
 * Hours data's number formats, columns A to K: Date and To date are real dates shown as
 * yyyy-mm-dd; every text column is plain text, so "2026-11" and "2026" are not read as a
 * date or a number; "0" for Shifts and "0.00" for Hours.
 */
function hoursDataFormats() {
  return ["yyyy-mm-dd", "@", "@", "yyyy-mm-dd", "@", "@", "0", "0.00", "@", "@", "@"];
}

/**
 * A yyyy-MM-dd date as a sheet's date number: days since 1899-12-30, worked out with
 * Date.UTC so no time zone moves the day. "" for anything that isn't a real yyyy-MM-dd
 * date; every Hours data row has one, since a row needs a month.
 */
function hoursDateSerial(dateText) {
  const s = cellString(dateText);
  if (!monthKey(s)) return "";
  const [year, month, day] = s.split("-").map(Number);
  return (Date.UTC(year, month - 1, day) - Date.UTC(1899, 11, 30)) / 86400000;
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
 * no end row, columns A to K. Built here once so every spec holds an equal value.
 */
function hoursSourceRange(dataSheetId) {
  return { sheetId: dataSheetId, startRowIndex: 0, startColumnIndex: 0, endColumnIndex: 11 };
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
 * Labels for items in their order, none equal to an earlier one under hoursLabelKey: an
 * item takes its base text (baseOf(item)) when no earlier label has its key, else
 * "<base> (k)" with the smallest k from 2 whose key no earlier label has. The key keeps
 * digits, so "<base> (k)" for different k never share a key and a free k always exists.
 * An item's label depends only on the items before it.
 */
function hoursDistinct(items, baseOf) {
  const taken = new Set();
  return items.map((item) => {
    const base = baseOf(item);
    let label = base;
    for (let k = 2; taken.has(hoursLabelKey(label)); k++) label = base + " (" + k + ")";
    taken.add(hoursLabelKey(label));
    return label;
  });
}

/**
 * Each volunteer's label on the Hours tab, as Map token -> label, over the whole Log (every
 * counted row with a month).
 *
 * 1. Units: a token whose latest counted row in reportRowOrder has a Volunteer Name is a
 *    unit of its own, its base label that name spaced as hoursSpaced. Every token whose
 *    latest name is blank is in one shared unit, base label "(no name)". A unit's first
 *    shift is the earliest of its tokens' first shifts (firstShifts).
 * 2. Order: the nameless unit first, then the named units by first shift in
 *    reportRowOrder, which ends on the Log row, so no two units tie.
 * 3. hoursDistinct in that order, and every token of a unit gets the unit's label.
 *
 * So two tokens' labels are equal under hoursLabelKey exactly when both are nameless, and
 * a unit's label depends only on the units before it: a new volunteer's first shift is
 * the newest, so it comes last and changes nobody's label.
 */
function hoursLabels(entries) {
  const rows = hoursRows(entries);
  const first = firstShifts(entries);
  const latest = new Map();
  rows.forEach((e) => latest.set(cellString(e.token), e));
  const named = [];
  const nameless = { base: "(no name)", tokens: [], first: null };
  latest.forEach((e, token) => {
    const name = hoursSpaced(e.name);
    const shift = first.get(token);
    if (name) {
      named.push({ base: name, tokens: [token], first: shift });
      return;
    }
    nameless.tokens.push(token);
    if (!nameless.first || reportRowOrder(shift, nameless.first) < 0) nameless.first = shift;
  });
  named.sort((a, b) => reportRowOrder(a.first, b.first));
  const units = (nameless.tokens.length ? [nameless] : []).concat(named);
  const unitLabels = hoursDistinct(units, (u) => u.base);
  const labels = new Map();
  units.forEach((u, i) => u.tokens.forEach((t) => labels.set(t, unitLabels[i])));
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
 *                 reportRowOrder: Date (hoursDateSerial), Year, Month, To date (the same
 *                 number as Date), Start ("HH:mm" or "no time"), Volunteer (hoursLabels),
 *                 1, Hours (reportHundredths of the stated hours over 100), Role/Type and
 *                 Activity (one spelling per group, or "(not set)"), Shift (below).
 *                 Text through hoursCellText; no User Token anywhere;
 *   counts        {open, alerts, unreviewedFlags (null without a Flags read), undatable}
 *                 over the whole Log: open rows, non-blank rows with Admin Alerts? set,
 *                 unreviewed Flags rows with a Volunteer Name or Shift ID, and counted rows
 *                 left out because their Date isn't yyyy-MM-dd;
 *   countsLine    the Hours tab's row 3, hoursCountsLine(counts);
 *   digestText    the text whose SHA-256 is P1: the rows and row 3 together.
 * }
 *
 * The Shift label is "<yyyy-MM-dd> <Ddd> <Start> · <volunteer label>", so the Shifts pivot
 * sorts by it in date then start order. It is built from the raw volunteer label, not
 * Volunteer's cell text (which may carry an apostrophe), made unique per row through
 * hoursDistinct in the rows' order, so every shift is its own pivot line and a newer row
 * changes no older row's label, and only then made cell-safe, whole.
 */
function hoursTable(entries, flags, clock) {
  const list = entries || [];
  const rows = hoursRows(list);
  const labels = hoursLabels(list);
  const roles = hoursSpellings(rows, "roleType");
  const activities = hoursSpellings(rows, "activity");
  const group = (spelling, value) =>
    hoursCellText(spelling.get(normalizeName(value)) || hoursNotSet());
  const starts = rows.map((e) => {
    const start = shiftStartMs(e);
    return isFinite(start) ? clock(start) : hoursNoTime();
  });
  const shifts = hoursDistinct(
    rows.map((e, i) => {
      const date = cellString(e.dateText);
      const volunteer = labels.get(cellString(e.token));
      return date + " " + weekdayName(date).slice(0, 3) + " " + starts[i] + " · " + volunteer;
    }),
    (base) => base,
  ).map(hoursCellText);
  const table = rows.map((e, i) => {
    const date = cellString(e.dateText);
    const serial = hoursDateSerial(date);
    return [
      serial,
      date.slice(0, 4),
      monthKey(date),
      serial,
      starts[i],
      hoursCellText(labels.get(cellString(e.token))),
      1,
      reportHundredths(e.statedHoursCell) / 100,
      group(roles, e.roleType),
      group(activities, e.activity),
      shifts[i],
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

/**
 * A pivot's outer row-group sort, as text to compare: its sortOrder, then " by value k"
 * when it sorts by a value (valueBucket.valuesIndex), or nothing when it sorts by its own
 * labels. Sheets stores a value bucket for value 0 as {} (it leaves out a zero), so a
 * bucket with no index reads as value 0. A pivot with no row group gives "".
 */
function hoursPivotSortKey(pivotTable) {
  const group = pivotTable && pivotTable.rows && pivotTable.rows[0];
  if (!group) return "";
  const bucket = group.valueBucket;
  const by = bucket ? " by value " + (Number(bucket.valuesIndex) || 0) : "";
  return cellString(group.sortOrder) + by;
}

/**
 * What one run of the sort boxes sends, worked out from what it read under the lock.
 * boxes is the Hours tab's A7:N7 values; current is {hoursSheetId, dataSheetId, pivots}:
 * the two tabs' ids and the boxed pivots' definitions as stored, one per boxed table in
 * hoursSortChoices' order (null where no pivot was found).
 *
 * Each box's choice comes from hoursBoxChoices: a blank or unknown box gives its table's
 * starting choice and a write-back of that text. The requests, for one batchUpdate, are a
 * data validation on every box cell with its own list, as setupReports sets it, every
 * time, since a paste can copy another cell's validation over a box or strip it; then the
 * write-backs; then, for each pivot whose outer row-group sort (hoursPivotSortKey) differs from its choice's, the
 * whole pivot from hoursPivots, the same plan setupReports builds, so a re-sort changes
 * the order and nothing else. A missing pivot is left missing: setupReports makes pivots.
 *
 * Returns {choices (hoursBoxChoices'), requests, resorted (how many pivots are rewritten),
 * summary ("volunteer most hours first, month oldest month first, ...", for the log)}.
 */
function hoursSortPlan(boxes, current) {
  const tables = hoursSortChoices();
  const choices = hoursBoxChoices(boxes);
  const wanted = hoursPivots(hoursSourceRange(current.dataSheetId), choices);
  const have = current.pivots || [];
  const id = current.hoursSheetId;
  const row = 6; // row 7, where the boxes are, 0-based
  const validations = [];
  const writeBacks = [];
  const resorts = [];
  tables.forEach((table, i) => {
    const column = table.column;
    validations.push({
      setDataValidation: {
        range: {
          sheetId: id,
          startRowIndex: row,
          endRowIndex: row + 1,
          startColumnIndex: column,
          endColumnIndex: column + 1,
        },
        rule: {
          condition: {
            type: "ONE_OF_LIST",
            values: table.choices.map((c) => ({ userEnteredValue: c.text })),
          },
          strict: true,
          showCustomUi: true,
        },
      },
    });
    if (choices[i].writeBack) {
      writeBacks.push({
        updateCells: {
          rows: [{ values: [{ userEnteredValue: { stringValue: choices[i].choice } }] }],
          start: { sheetId: id, rowIndex: row, columnIndex: column },
          fields: "userEnteredValue",
        },
      });
    }
    if (have[i] && hoursPivotSortKey(have[i]) !== hoursPivotSortKey(wanted[i])) {
      resorts.push({
        updateCells: {
          rows: [{ values: [{ pivotTable: wanted[i] }] }],
          start: { sheetId: id, rowIndex: hoursPivotRow() - 1, columnIndex: column },
          fields: "pivotTable",
        },
      });
    }
  });
  const summary = tables
    .map((table, i) => table.key + " " + choices[i].choice.replace(/^Sort: /, ""))
    .join(", ");
  return {
    choices,
    requests: [].concat(validations, writeBacks, resorts),
    resorted: resorts.length,
    summary,
  };
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
 * "clear" (A2:K2, only when there are no rows), "trim" (delete Hours data's rows below the
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
 * How long a sort box takes to re-sort its table, in seconds, as staff are told in row 2
 * and row 4. It is the slowest table's median edit-to-sorted time measured on a copy at
 * full size, rounded up to the next 5 seconds; set it here when that is measured.
 */
function hoursSortSeconds() {
  return 20;
}

/**
 * The sort box above each Hours pivot, in pivot order (Hours by volunteer, Hours by month,
 * Shifts). Each box is a dropdown in row 7, merged across its table's columns.
 *
 * Returns [{
 *   key       "volunteer", "month" or "shifts": the table's short name for log lines;
 *   title     the table's name;
 *   cell      the box's cell, "A7", "E7" or "K7";
 *   merge     the box's merged range, "A7:C7", "E7:I7" or "K7:N7";
 *   column, endColumn   the merge's columns as 0-based indexes, end exclusive;
 *   pivot     the cell the table's pivot starts at, "A8", "E8" or "K8";
 *   choices   [{text, sortOrder, valuesIndex}]: valuesIndex is the value the outer row
 *             group sorts by (its Grand Total), or null to sort by the group's own values;
 *   start     the starting choice's text: what a new tab gets, and what a blank or
 *             unknown box is reset to.
 * }]
 *
 * Every choice's text starts "Sort: " so the box labels itself. The Shifts table's outer
 * group is the Shift label, which starts with the date, then the weekday, then the start
 * time ("no time" sorts after every HH:mm), then the volunteer: so "newest first" gives
 * days newest first and, within a day, "no time" first, then the latest start to the
 * earliest; "oldest first" the reverse.
 */
function hoursSortChoices() {
  const choice = (text, sortOrder, valuesIndex) => ({ text, sortOrder, valuesIndex });
  const table = (key, title, column, endColumn, choices) => ({
    key,
    title,
    cell: columnLetter(column) + "7",
    merge: columnLetter(column) + "7:" + columnLetter(endColumn - 1) + "7",
    column,
    endColumn,
    pivot: columnLetter(column) + hoursPivotRow(),
    choices,
    start: choices[0].text,
  });
  return [
    // Values: Shifts 0, Hours 1.
    table("volunteer", "Hours by volunteer", 0, 3, [
      choice("Sort: most hours first", "DESCENDING", 1),
      choice("Sort: fewest hours first", "ASCENDING", 1),
      choice("Sort: most shifts first", "DESCENDING", 0),
      choice("Sort: name A to Z", "ASCENDING", null),
      choice("Sort: name Z to A", "DESCENDING", null),
    ]),
    // Values: Shifts 0, Hours 1, Volunteers 2, Average shift 3.
    table("month", "Hours by month", 4, 9, [
      choice("Sort: oldest month first", "ASCENDING", null),
      choice("Sort: newest month first", "DESCENDING", null),
      choice("Sort: most hours first", "DESCENDING", 1),
      choice("Sort: most shifts first", "DESCENDING", 0),
      choice("Sort: most volunteers first", "DESCENDING", 2),
    ]),
    // Values: Hours 0.
    table("shifts", "Shifts", 10, 14, [
      choice("Sort: newest first", "DESCENDING", null),
      choice("Sort: oldest first", "ASCENDING", null),
      choice("Sort: most hours first", "DESCENDING", 0),
      choice("Sort: fewest hours first", "ASCENDING", 0),
    ]),
  ];
}

/**
 * Row 7's values (A7:N7, as one row of getValues; a short row reads as blanks) to each
 * box's choice, in hoursSortChoices' order: [{key, cell, choice, writeBack}]. choice is the
 * box's value when it is exactly one of that box's own choices, else the starting choice;
 * writeBack is true when the cell doesn't hold choice and must be written with it (a blank
 * box, a typed value, or another box's choice pasted over it).
 */
function hoursBoxChoices(values) {
  const row = values || [];
  return hoursSortChoices().map((t) => {
    const value = row[t.column];
    const known = typeof value === "string" && t.choices.some((c) => c.text === value);
    return { key: t.key, cell: t.cell, choice: known ? value : t.start, writeBack: !known };
  });
}

/**
 * Each box's choice text in hoursSortChoices' order, from choices given as texts or as
 * hoursBoxChoices' objects; a missing or unknown one gives that box's starting choice.
 */
function hoursChoiceTexts(choices) {
  return hoursSortChoices().map((t, i) => {
    const given = (choices || [])[i];
    const text = given && typeof given === "object" ? given.choice : given;
    return t.choices.some((c) => c.text === text) ? text : t.start;
  });
}

/**
 * The three Hours pivots as Sheets API pivotTable objects, in hoursSortChoices' order:
 * Hours by volunteer, Hours by month, Shifts. source is hoursSourceRange's GridRange.
 * choices gives each table's choice in that order, as choice texts or as hoursBoxChoices'
 * objects; a missing or unknown one gives the starting choice. Each table's outer row group
 * takes its choice's sort: its sortOrder, and a valueBucket on its valuesIndex when it
 * sorts by a value (no buckets, so it sorts by that value's Grand Total).
 *
 * Every pivot is filtered to Shifts = 1, a column no slicer uses. The Shifts pivot has one
 * line per shift: the Shift label (K), then Role/Type and Activity as repeated labels with
 * no totals, and Hours.
 */
function hoursPivots(source, choices) {
  const picked = hoursChoiceTexts(choices);
  const sorts = hoursSortChoices().map((t, i) => t.choices.find((c) => c.text === picked[i]));
  const outer = (offset, label, sort, extra) => {
    const group = { sourceColumnOffset: offset, showTotals: true, sortOrder: sort.sortOrder };
    if (sort.valuesIndex !== null) group.valueBucket = { valuesIndex: sort.valuesIndex };
    return Object.assign(group, extra, { label });
  };
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
    rows: [outer(5, "Volunteer", sorts[0], {})],
    values: [
      { sourceColumnOffset: 6, summarizeFunction: "SUM", name: "Shifts" },
      { sourceColumnOffset: 7, summarizeFunction: "SUM", name: "Hours" },
    ],
    filterSpecs: counted,
  };
  const byMonth = {
    source,
    rows: [outer(2, "Month", sorts[1], {})],
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
    rows: [outer(10, "Shift", sorts[2], { repeatHeadings: true })].concat(
      [
        [8, "Role/Type"],
        [9, "Activity"],
      ].map(([offset, label]) => ({
        sourceColumnOffset: offset,
        showTotals: false,
        sortOrder: "ASCENDING",
        repeatHeadings: true,
        label,
      })),
    ),
    values: [{ sourceColumnOffset: 7, summarizeFunction: "SUM", name: "Hours" }],
    filterSpecs: counted,
  };
  return [byVolunteer, byMonth, shifts];
}

/** Row 4's line, right above the slicers: how to use a slicer, clear them all, and sort. */
function hoursHowTo() {
  return (
    "In a slicer, click Clear, then tick what you want. Reload the page to clear every slicer." +
    " A sort box takes up to " +
    hoursSortSeconds() +
    " seconds."
  );
}

/** F6's note, beside the From date and To date slicers: how to pick a range of days. */
function hoursDateNote() {
  return (
    "Date range: From date > Filter by condition > Greater than or equal to > a date like" +
    " 2026-11-01. To date: Less than or equal to."
  );
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
    " Click a slicer to pick a year, month, role, activity or volunteer, or use From date and" +
    " To date for a range of days; clear them all for all time." +
    " Your picks are yours alone: nobody else sees them, and they're gone when you close the tab" +
    " or reload the page." +
    " To sort a table, pick an order in the box above it. The new order takes up to " +
    hoursSortSeconds() +
    " seconds to show, and it is shared: everyone sees it."
  );
}

/**
 * Everything setupReports puts on the Hours tab, and the look of Hours data, as plain data
 * and Sheets API requests. hoursSheetId and dataSheetId are the two tabs' sheet IDs;
 * openPath as hoursUsageText's; choices, each box's choice in hoursSortChoices' order, as
 * hoursBoxChoices gives them from row 7 before the tab is cleared (missing: the starting
 * choices).
 *
 * Returns {
 *   cells: [{a1, value}]   A1's title, row 2's text, row 3's line before the first refresh,
 *                          A4's how-to line, F6's date note and each box's choice (B1 is
 *                          written only by the render);
 *   frozenRows             1;
 *   source                 hoursSourceRange(dataSheetId);
 *   boxes                  hoursSortChoices() with each table's chosen text as choice;
 *   formats, widths, heights, validations, rules, pivots, slicers: Sheets API requests, by
 *                          kind;
 *   requests               all of them in the order to send: formats (merges first),
 *                          widths, heights, validations, rules (the three Grand Total
 *                          rules first), pivots, slicers;
 *   data: {headers, formats, stateRange, tabColor}   Hours data's look;
 *   tabColor               the Hours tab's colour.
 * }
 *
 * Layout: row 1 the title and the refresh line in B1, not wrapped, overflowing C1:P1; row
 * 2 one merged cell A2:P2, wrapped, top-aligned, 66 px; row 3 one merged cell A3:P3 with
 * the counts; row 4 the how-to line in A4, 10 pt navy, not wrapped, overflowing to the
 * right; row 5 the slicers for Year, Month, Role/Type, Activity and Volunteer, and row 6
 * those for From date and To date (two slicers on one column would share one filter, so
 * each reads its own date column) with the date note in F6; both rows 38 px, each slicer
 * 240 px wide at 250 px steps from column A, so its title shows in full and its value list
 * has room (at 165 px the titles were cut to "Ro..."), and five fit a 1,366 px screen; row
 * 7 the sort boxes, each merged across its table's columns so its longest choice shows,
 * with a strict dropdown of its own choices; from row 8 the pivots Hours by volunteer
 * (A8), Hours by month (E8) and Shifts (K8, through N), from hoursPivots. Stripes and
 * Grand Total rows come from rules keyed on each pivot's first column, so they follow the
 * pivot as it grows and shrinks; every body row gets its fill from a rule, so the pivot's
 * own grey band never shows. Widths are fixed pixels, not fitted to content.
 */
function hoursTabPlan(hoursSheetId, dataSheetId, openPath, choices) {
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
  const picked = hoursChoiceTexts(choices);
  const boxes = hoursSortChoices().map((t, i) => Object.assign(t, { choice: picked[i] }));
  // A line of navy text that doesn't wrap and runs on over the empty cells to its right.
  const line = (r, c) =>
    repeat(
      range(r, r + 1, c, c + 1),
      {
        wrapStrategy: "OVERFLOW_CELL",
        textFormat: { foregroundColorStyle: color(navy), fontSize: 10 },
      },
      "userEnteredFormat(wrapStrategy,textFormat)",
    );

  const formats = [
    { unmergeCells: { range: range(0, 7, 0, 16) } },
    { mergeCells: { range: range(1, 2, 0, 16), mergeType: "MERGE_ALL" } },
    { mergeCells: { range: range(2, 3, 0, 16), mergeType: "MERGE_ALL" } },
  ];
  boxes.forEach((b) =>
    formats.push({
      mergeCells: { range: range(6, 7, b.column, b.endColumn), mergeType: "MERGE_ALL" },
    }),
  );
  formats.push(
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
    line(3, 0),
    line(5, 5),
  );
  boxes.forEach((b) =>
    formats.push(
      repeat(
        range(6, 7, b.column, b.endColumn),
        {
          backgroundColorStyle: color(section),
          textFormat: { foregroundColorStyle: color(navy) },
        },
        "userEnteredFormat(backgroundColorStyle,textFormat)",
      ),
    ),
  );
  [
    [0, 3],
    [4, 9],
    [10, 14],
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
    [13, "0.00"],
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
    [10, 320],
    [11, 140],
    [12, 140],
    [13, 90],
    [14, 90],
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
    [4, 38],
    [5, 38],
  ].map(([r, pixelSize]) => ({
    updateDimensionProperties: {
      range: { sheetId: id, dimension: "ROWS", startIndex: r, endIndex: r + 1 },
      properties: { pixelSize },
      fields: "pixelSize",
    },
  }));

  // Each box takes only its own choices, rejects anything else, and shows its arrow.
  const validations = boxes.map((b) => ({
    setDataValidation: {
      range: range(6, 7, b.column, b.column + 1),
      rule: {
        condition: {
          type: "ONE_OF_LIST",
          values: b.choices.map((c) => ({ userEnteredValue: c.text })),
        },
        strict: true,
        showCustomUi: true,
      },
    },
  }));

  const pivotsAt = [
    ["A", 0, 3],
    ["E", 4, 9],
    ["K", 10, 14],
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

  const pivots = hoursPivots(
    source,
    boxes.map((b) => b.choice),
  ).map((pivotTable, i) => ({
    updateCells: {
      rows: [{ values: [{ pivotTable }] }],
      start: { sheetId: id, rowIndex: hoursPivotRow() - 1, columnIndex: pivotsAt[i][1] },
      fields: "pivotTable",
    },
  }));

  // Row 5 (index 4) holds five slicers and row 6 (index 5) the two date slicers, each row
  // from column A at 250 px steps.
  const slicers = [
    [4, 0, 1, "Year"],
    [4, 1, 2, "Month"],
    [4, 2, 8, "Role/Type"],
    [4, 3, 9, "Activity"],
    [4, 4, 5, "Volunteer"],
    [5, 0, 0, "From date"],
    [5, 1, 3, "To date"],
  ].map(([rowIndex, i, columnIndex, title]) => ({
    addSlicer: {
      slicer: {
        spec: { dataRange: source, columnIndex, title, applyToPivotTables: true },
        position: {
          overlayPosition: {
            anchorCell: { sheetId: id, rowIndex, columnIndex: 0 },
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
      { a1: "A4", value: hoursHowTo() },
      { a1: "F6", value: hoursDateNote() },
    ].concat(boxes.map((b) => ({ a1: b.cell, value: b.choice }))),
    frozenRows: 1,
    source,
    boxes,
    formats,
    widths,
    heights,
    validations,
    rules,
    pivots,
    slicers,
    requests: [].concat(formats, widths, heights, validations, rules, pivots, slicers),
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
// appends Flags rows, each under the last row in use (flagRowUsed). It reads the Flags
// header to place its writes. Three things read Flags rows back: the weekly flags email
// and the Hours refresh, to count and list them, and the Log check, to skip a problem
// already flagged. So staff may sort, filter or delete rows; a deleted Log check row is
// raised again on the next check. Reviewed By and Notes are staff's; the script writes
// Reviewed once, unticked, on the row it appends.

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
 * Whether a Flags row is in use, so a new flag goes below it: any cell other than Reviewed
 * isn't blank, or Reviewed holds anything but an unticked box (blank, false or "FALSE").
 * cells is one row of the tab, cols is flagColumns of its header. Rows that hold only an
 * unticked box, as setupSheets leaves every row, are free.
 */
function flagRowUsed(cells, cols) {
  const reviewed = cols[flagHeaderNames().reviewed];
  return (cells || []).some((value, i) => {
    if (i !== reviewed) return cellString(value) !== "";
    return value !== false && cellString(value) !== "" && !/^false$/i.test(cellString(value));
  });
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
    howTo: P.blue,
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
    return [
      col("Setting", "navy", 230),
      col("Value", "teal", 380),
      col(settingsDescriptionHeader(), "navy", 420),
    ];
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
 * - wrapColumns: 0-based columns wrapped from top to bottom (Settings' Value and What it does).
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
    const what = first(settingsDescriptionHeader());
    if (what >= 0) wrapColumns.push(what);
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
    "Review them on the Flags tab (Data > Change view > " +
      flagsViewTitle() +
      "): " +
      input.flagsUrl,
    'Review them on the <a href="' +
      htmlText(input.flagsUrl) +
      '">Flags tab</a> (Data &gt; Change view &gt; ' +
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
// Rows from any date up to today come in; "Kiosk launch date" is not read. A matched row
// for a day its volunteer also has a kiosk shift on the Log (open or closed, not itself an
// import) still comes in, with an alert in Admin Alerts? and one Flags row, so staff can
// check it isn't the same shift counted twice.
//
// A source row is known by its source key: its date, its written name and its count among
// the source rows with that date and name. Never by its position, since rows move in the
// old sheet. The Import ledger tab keeps every key brought in, so a second run adds
// nothing and a row staff delete from the Log stays deleted. Once imported, a row is
// corrected on the Log, never in the source: a corrected name or date is a new key, a
// corrected hours count never reaches the Log, and a row typed above one with the same
// date and name moves the counts. The import never compares a source row with the Log, so
// none of these is seen or flagged.

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
    name: "no first or last name",
    hours: "hours aren't a number above 0 and at most 24",
  };
}

/** {ok: false, refusal, message} for an import refusal; detail fills in the message. */
function importRefusal(code, detail) {
  const d = cellString(detail);
  const messages = {
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

/** True when a Shift ID is an imported row's: it starts "import-", in any capitals. */
function isImportShiftId(shiftId) {
  return /^import-/i.test(cellString(shiftId));
}

/** The same-day key of a date (yyyy-MM-dd) and a User Token. */
function importDayKey(date, token) {
  return date + "|" + cellString(token);
}

/**
 * The day keys (importDayKey) of every kiosk shift among rows [{dateText, token, status,
 * shiftId}], the Log's cells as text. A kiosk shift is any Log row that isn't an import
 * (the tablet, the menu or typed by hand; a blank Shift ID counts) with Status open or
 * closed, a User Token and a Date that reads. Built once per Log read.
 */
function importKioskDays(rows) {
  const days = new Set();
  (rows || []).forEach((r) => {
    if (isImportShiftId(r.shiftId)) return;
    if (!isStatus(r, "open") && !isStatus(r, "closed")) return;
    const token = cellString(r.token);
    const date = rowDate(r.dateText);
    if (token === "" || date === "") return;
    days.add(importDayKey(date, token));
  });
  return days;
}

/**
 * True when an item's matched volunteer has a kiosk shift on its date. An unmatched item
 * is never same-day: its stand-in token is on no kiosk row.
 */
function importSameDay(item, kioskDays) {
  if (!item.volunteer || !kioskDays) return false;
  return kioskDays.has(importDayKey(item.date, item.volunteer.token));
}

/** The Admin Alerts? text, and the Flags Reason, of an imported row with a same-day kiosk shift. */
function importSameDayAlert() {
  return "imported: paper and kiosk shift on the same day; if both are the same shift, remove this imported row with Kiosk admin > Remove a shift…";
}

/**
 * One execution-log line for a written block: "Import block 3 of 8: 250 rows written, 4
 * same day, 2 ledger repairs, 2840 ms under the lock". result is the block's reply.
 */
function importBlockLog(index, count, result, ms) {
  return (
    "Import block " +
    index +
    " of " +
    count +
    ": " +
    result.written.length +
    " rows written, " +
    result.sameDay +
    " same day, " +
    result.ledgerAdded +
    " ledger repairs, " +
    ms +
    " ms under the lock"
  );
}

/** A source hours cell as a number, NaN when blank or not a number. */
function importHours(value) {
  return hoursCell(typeof value === "number" ? value : cellString(value));
}

/**
 * Works out what an import would do. input is {header, rows, todayDate, volunteers,
 * ledgerKeys, logShiftIds, kioskDays, hashFn}: the source header row, its data rows (data
 * row i is source row i + 2; a date cell already as yyyy-MM-dd text, hours as read),
 * today, the Profiles list, the source keys in the ledger, the Shift IDs on the Log, the
 * Log's kiosk days (importKioskDays; missing is empty), and a SHA-256 hex function.
 *
 * A row is importable when its Date reads as a day (parseStartDate) not after today, it
 * has a first or last name, and its hours are a number above 0 and at most 24. Wholly
 * blank rows are skipped and not counted. A key counts every row whose date reads and that
 * has a name, left out or not, so fixing one row's hours in the source doesn't change its
 * neighbours' keys.
 *
 * A name matches when exactly one Profiles volunteer has its name key. Returns {refusal}
 * (headers), or {rowsRead, toImport, alreadyImported, onLog, leftOut}: the
 * first three are lists of items {sourceRow, date, firstName, lastName, name, nameKey, key,
 * shiftId, hours, volunteer (null when unmatched), matches, sourceTab, sourceCell,
 * sameDay (importSameDay: the Preview's view; Import works it out again per block)}, in
 * source order; leftOut is [{row, reason}] with reason a code of importLeftOutReasons().
 * An item in toImport is neither in the ledger nor on the Log; one in onLog has its Shift
 * ID on the Log but no ledger line, which the run adds.
 */
function importPlan(input) {
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
  const kioskDays = input.kioskDays || new Set();
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
    item.sameDay = importSameDay(item, kioskDays);
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
 * The preview's counts for a plan: {rowsRead, toImport, matched, sameDay, unmatched, hours,
 * alreadyImported, onLog, leftOut, unmatchedNames: [{name, rows, matches}] sorted by name,
 * sameDayRows: [{name, date, row}] in source order, leftOutRows: [{reason (text), rows:
 * [source row numbers]}] in importLeftOutReasons() order}. sameDay counts the items to
 * import that have a kiosk shift that day, all of them matched; sameDayRows lists them
 * under their Log name and source row. No User Token.
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
  const sameDayRows = plan.toImport
    .filter((item) => item.sameDay)
    .map((item) => ({
      name: volunteerFullName(item.volunteer),
      date: item.date,
      row: item.sourceRow,
    }));
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
    sameDay: sameDayRows.length,
    unmatched: unmatched.length,
    hours: importHoursTotal(plan.toImport),
    alreadyImported: plan.alreadyImported.length,
    onLog: plan.onLog.length,
    leftOut: plan.leftOut.length,
    unmatchedNames: names,
    sameDayRows,
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
 * not written: the source has no times. Admin Alerts? holds the unmatched alert, or the
 * same-day alert when item.sameDay; a row is never both.
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
  else if (item.sameDay) cells[H.alerts] = importSameDayAlert();
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
 * The Flags rows for one written block, in Log row order: one per unmatched name not in
 * flagged (the name keys already flagged this run), for the name's first row in the
 * block, and one per row with item.sameDay. written is [{item, row}] with row the Log
 * row, counts the run's unmatched rows per name key. Adds the names it flags to flagged.
 * An unmatched name's Reason is the row's alert and the name's rows in this run; a
 * same-day row's is importSameDayAlert(), as in its Admin Alerts?, under its Log name.
 */
function importFlagRows(written, counts, flagged, nowMs) {
  const rows = [];
  written.forEach(({ item, row }) => {
    if (item.volunteer) {
      if (!item.sameDay) return;
      flagRows(
        {
          date: item.date,
          name: volunteerFullName(item.volunteer),
          shiftId: item.shiftId,
          raisedAtMs: nowMs,
          source: flagSources().import,
          logRow: row,
        },
        [importSameDayAlert()],
      ).forEach((r) => rows.push(r));
      return;
    }
    if (flagged.has(item.nameKey)) return;
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

// ---------------------------------------------------------------------------
// Staff help
//
// Help for the staff who run the sheet, written into the sheet by setupSheets on every
// run: the Settings tab's What it does column (above, after settingsDefaults), a hover
// note on each kiosk column header of the Log and Flags tabs, and the How to tab. All the
// text lives here, so each release that runs setupSheets keeps it current. Staff text
// never names code: it quotes only what staff see on screen.

/** The hover note on each Log header, keyed like logHeaderNames(). */
function logHeaderNotes() {
  return {
    date: "The shift's date, as yyyy-mm-dd. Filled by the kiosk; change it only to fix a mistake.",
    day: "The weekday of the Date. Filled by the kiosk.",
    name: "The volunteer's first and last name, from Volunteer Profiles. Filled by the kiosk; change it only to fix a mistake.",
    role: "Yours to fill: the volunteer's role or type. The kiosk never writes it; the Hours tab and the monthly report group by it.",
    recordedIn:
      "When the volunteer actually tapped Check In on the tablet. Blank on shifts added with Kiosk admin > Add a shift… or imported.",
    statedIn:
      "The arrival time the volunteer chose on the tablet, or the time an admin entered. The same as Recorded when they chose none. Hours count from this time.",
    recordedOut:
      "When the volunteer actually tapped Check Out. Blank when an admin or the nightly auto clock-out closed the shift.",
    statedOut:
      "The check-out time the volunteer chose, the time an admin entered, or the nightly auto clock-out's guess. Hours count to this time.",
    recordedHours:
      "Hours between the two Recorded times, to 2 decimals. For checking only: the reports don't count it.",
    statedHours:
      "Hours between the two Stated times, to 2 decimals. This is what the Hours tab, the monthly report and milestones count. If you fix a time by hand, fix this too.",
    alerts:
      "The kiosk's notes when something looks off: a time far from the tap, a long shift, an unreadable time, an auto clock-out. Each one is also on the Flags tab for review.",
    activity:
      "Yours to fill: what the volunteer did. The kiosk never writes it; the Hours tab and the monthly report group by it.",
    notes:
      "Notes typed in a Kiosk admin window are added here, after anything already in the cell. Otherwise yours.",
    token:
      "The volunteer's private token from Volunteer Profiles, which links the row to them. Keep this spreadsheet shared as narrowly as Volunteer Profiles.",
    status: "open from check-in until check-out, then closed. Only closed rows count toward hours.",
    inBy: "kiosk for a tablet check-in, an admin's initials for one added in the menu, import for past hours; blank means typed by hand.",
    outBy:
      "kiosk, an admin's initials, auto-close for the nightly auto clock-out, or import; blank means typed by hand.",
    shiftId:
      "The row's own ID. The Kiosk admin menu and the Flags tab find the row by it, so never change it or put it on another row.",
  };
}

/** The hover note on each Flags header, keyed like flagHeaderNames(). */
function flagHeaderNotes() {
  return {
    date: "The flagged shift's Date on the Log. Filled by the kiosk.",
    name: "The flagged shift's volunteer. Filled by the kiosk.",
    shiftId:
      "The flagged shift's Shift ID: the sure way to find it on the Log (copy it, then Ctrl+F on the Log).",
    reason:
      "Why it was flagged, word for word as in the Log's Admin Alerts?, or a problem the morning Log check found.",
    raisedAt: "When the flag was raised.",
    reviewed:
      "Tick it once someone has looked at the flag. Ticked flags leave the Flags: Unreviewed view and the weekly email's unreviewed count.",
    reviewedBy: "Yours: your initials.",
    notes: "Yours: what you found or did. Remove a shift and Restore a shift add a line here too.",
    source:
      "What raised it: kiosk check-in, kiosk check-out, auto-close (the nightly auto clock-out), import (Import past hours) or log check (the morning Log check).",
    logRow:
      "The Log row number when the flag was raised. A hint only: sorting the Log moves rows, so trust the Shift ID.",
  };
}

/**
 * Every header note text the kiosk wrote in an earlier release and no longer writes. When
 * a note's wording changes, its old text goes here, so a cell still carrying it is known
 * as the kiosk's and brought up to date; otherwise it would be taken for a staff note and
 * never updated. The list only grows: a text stays while any live sheet may carry it.
 */
function headerNotePastTexts() {
  return [];
}

/** Every text the kiosk counts as its own note: the current Log and Flags notes, then the past ones. */
function headerNoteKioskTexts() {
  const log = logHeaderNotes();
  const flags = flagHeaderNotes();
  return Object.keys(log)
    .map((k) => log[k])
    .concat(Object.keys(flags).map((k) => flags[k]))
    .concat(headerNotePastTexts());
}

/**
 * The notes for one tab's row 1, one per cell of headerRow, from each cell's existing note
 * (existing[i], "" when there is none). names and notes are one tab's header names and
 * notes, keyed alike; kioskTexts is headerNoteKioskTexts(). The kiosk writes a note only
 * on a cell whose note is empty or is exactly one of its own texts, compared with ===,
 * nothing trimmed or folded first; every other note is returned as it is, character for
 * character, so words staff wrote are kept unless they are exactly a kiosk text.
 * - A kiosk header (normalizeHeader match, every place it appears): its own current text
 *   when the note is empty or a kiosk text; else the note as it is.
 * - Any other cell: "" when the note is a kiosk text, which there describes the wrong
 *   column; else the note as it is.
 */
function headerNotesRow(headerRow, names, notes, existing, kioskTexts) {
  const byHeader = new Map();
  Object.keys(names).forEach((k) => byHeader.set(normalizeHeader(names[k]), notes[k]));
  const kiosk = new Set(kioskTexts || []);
  const have = existing || [];
  return (headerRow || []).map((cell, i) => {
    const e = have[i] === null || have[i] === undefined ? "" : String(have[i]);
    const h = normalizeHeader(cell);
    if (h !== "" && byHeader.has(h)) return e === "" || kiosk.has(e) ? byHeader.get(h) : e;
    return kiosk.has(e) ? "" : e;
  });
}

/** The name the How to tab gets when the kiosk makes it. After that it is found by its mark. */
function howToTabName() {
  return "How to";
}

/** The developer metadata that marks the kiosk's How to tab, a key no other tab uses. */
function howToTabMark() {
  return { key: "kiosk-guide", value: "how-to" };
}

/** The description of the How to tab's one warning-only protection. */
function howToProtectionDescription() {
  return "How to: written by the kiosk and rewritten whenever the kiosk is updated. Changes made here won't last.";
}

/**
 * One item line per header in names, in its order: the header with its line breaks and
 * spaces made single spaces, ": ", then that header's note exactly as headerNotesRow
 * writes it. The How to tab's column sections are built from these, so the tab and the
 * hover notes can't drift apart.
 */
function howToColumnLines(names, notes) {
  return Object.keys(names).map((k) => ({
    kind: "item",
    text: cellString(names[k]).replace(/\s+/g, " ") + ": " + notes[k],
  }));
}

// ---------------------------------------------------------------------------
// Kiosk contact
//
// Staff type who to ask for help in the Settings row "Kiosk contact": a name and an email or
// phone, on as many lines as they like. Only people with access to the spreadsheet see it.
// The How to tab shows it through one formula cell that reads the row live, so it is never
// stale; the Kiosk admin menu adds it to errors (kioskContactNote). The tablet never gets it.
//
// One rule for blank in both places: a value is blank when nothing is left after trimming
// the characters JavaScript's trim() removes (spaces, line breaks, tabs, no-break and other
// Unicode spaces), so a value of only line breaks is blank on the How to tab too.

/** The Settings row that names who to ask for help. */
function kioskContactSetting() {
  return "Kiosk contact";
}

/**
 * The How to contact line's two texts: blank, shown while the row is blank, missing or
 * unreadable; prefix, shown before the value otherwise.
 */
function howToContactTexts() {
  return {
    blank:
      "If the kiosk or this sheet isn't working and this tab doesn't help, ask whoever looks after the kiosk. To name them here, type their name and an email or phone in Kiosk contact on the Settings tab.",
    prefix: "If the kiosk or this sheet isn't working and this tab doesn't help, contact: ",
  };
}

/**
 * A Sheets (RE2) pattern for REGEXREPLACE that matches the characters trim() removes at
 * either end of a text: tab, line feed, vertical tab, form feed, carriage return, every
 * Unicode space and line or paragraph separator (\p{Z}), and the byte-order mark.
 */
function kioskContactTrimPattern() {
  const set = "[\\t\\n\\x{0B}\\f\\r\\p{Z}\\x{FEFF}]";
  return "^" + set + "+|" + set + "+$";
}

/**
 * The How to contact cell's formula. It finds the row the way readSettings_ (Sheets.js)
 * does: the first row below the header whose column A, trimmed, is exactly "Kiosk contact"
 * (case counts). Its column B, trimmed, follows the prefix; a blank value, a missing row or
 * any error (a deleted Settings tab) gives the blank text. Both trims are
 * kioskContactTrimPattern, the same characters cellString trims. The tab is the literal
 * "Settings", which a test holds equal to Sheets.js's SETTINGS_TAB.
 */
function kioskContactFormula() {
  const q = (t) => '"' + String(t).replace(/"/g, '""') + '"';
  const trim = (x) => "REGEXREPLACE(" + x + '&"", ' + q(kioskContactTrimPattern()) + ', "")';
  const texts = howToContactTexts();
  const row =
    "MATCH(1, ARRAYFORMULA(EXACT(" +
    trim("Settings!A:A") +
    ", " +
    q(kioskContactSetting()) +
    ")*(ROW(Settings!A:A)>1)), 0)";
  return (
    "=LET(contact, IFERROR(" +
    trim("INDEX(Settings!B:B, " + row + ")") +
    ', ""), IF(contact = "", ' +
    q(texts.blank) +
    ", " +
    q(texts.prefix) +
    " & contact))"
  );
}

/**
 * The line the Kiosk admin menu adds to an error: the value's lines, each trimmed, empty
 * ones dropped, joined with ", ", after "If this keeps happening, contact: "; "" when
 * nothing is left.
 */
function kioskContactNote(value) {
  const lines = cellString(value)
    .split(/\r\n|[\n\r\u2028\u2029]/)
    .map(cellString)
    .filter((line) => line !== "");
  return lines.length ? "If this keeps happening, contact: " + lines.join(", ") : "";
}

/**
 * An error's text with the contact line after it, or the text alone when note is "".
 *
 * Which messages name the contact, one rule for the whole Kiosk admin menu: every error it
 * shows in a window or an alert, and nothing else. An error thrown before a window or alert
 * exists (Import past hours with an unreadable Settings tab, a run from the wrong place) is
 * Google's own and carries no contact. In the three windows (AdminDialog.html, Report.html,
 * ImportDialog.html), that is whatever reaches the failure handler (a throw, Google's or the
 * kiosk's own) and a reply with no message. In the Refresh Hours alert, a run whose result
 * carries a message (it failed, or the Hours tabs are missing); in Check the Log now's, a
 * failed run. A refusal, a busy message or a run's result is shown as it is: each says what
 * to do. The windows join the two the same way, in their failed().
 */
function withKioskContact(text, note) {
  return note ? text + " " + note : text;
}

/**
 * The How to tab's sections, as [{title, lines: [{kind, text, formula?}]}], kind "contact",
 * "text", "step", "tip" or "item"; a step's text carries its own number. The one contact
 * line has text "" and a formula, kioskContactFormula. setupSheets rewrites the whole tab
 * from this on every run, so a release that changes this text, or the Hours lines it copies
 * from hoursHowTo() and hoursDateNote(), runs setupSheets after the push.
 */
function howToSections() {
  const text = (t) => ({ kind: "text", text: t });
  const step = (t) => ({ kind: "step", text: t });
  const tip = (t) => ({ kind: "tip", text: t });
  const item = (t) => ({ kind: "item", text: t });
  return [
    {
      title: "Problems with the kiosk",
      lines: [{ kind: "contact", text: "", formula: kioskContactFormula() }],
    },
    {
      title: "Before you start",
      lines: [
        text(
          "Use the Kiosk admin menu in a browser signed in to just one Google account, the shared kiosk account. With two accounts signed in, its windows can fail with a PERMISSION_DENIED error; a private (incognito) window signed in to the kiosk account fixes it.",
        ),
        text(
          "Every save asks for your initials (1 to 5 letters), so the sheet shows who did what.",
        ),
        text("A menu window stops working after 30 minutes. Close it and open the menu again."),
        text("If a save is refused, the window says why and keeps what you typed."),
      ],
    },
    {
      title: "Review flags",
      lines: [
        text(
          "A flag is something the kiosk wants a person to look at: a time far from when the volunteer tapped, a very long shift, a shift the nightly auto clock-out closed, a name Import past hours couldn't match or a paper shift it brought in for a day the volunteer also has a kiosk shift, or a problem the morning Log check found.",
        ),
        step(
          "1. Open the Flags tab, then Data > Change view > Flags: Unreviewed. It shows the flags nobody has ticked yet, newest first.",
        ),
        step(
          "2. Read the Reason. To find the shift on the Log, copy its Shift ID, open the Log, press Ctrl+F (Cmd+F on a Mac) and paste.",
        ),
        step("3. Fix the shift if it needs it (see below), or leave it if it's fine."),
        step(
          "4. Tick Reviewed, type your initials in Reviewed By, and add a note in Notes if there's something to say. The flag leaves the view.",
        ),
        tip(
          "Fixing a shift doesn't tick its flag: tick it yourself. A flag the morning Log check raised (Source: log check) comes back if you delete its row while the problem is still on the Log; other flags don't come back.",
        ),
      ],
    },
    {
      title: "Fix a sign-out (someone forgot to check out)",
      lines: [
        step("1. Kiosk admin > Fix a sign-out…"),
        step("2. Pick the shift from the list of open shifts. Type part of the name to search."),
        step(
          "3. Enter the time they left (it goes on the shift's own date), a note if you like, and your initials. Press Save.",
        ),
        tip(
          "If the check-in time itself is wrong or can't be read, fix it on the Log first, then come back here.",
        ),
      ],
    },
    {
      title: "Add a shift (someone forgot to check in and out)",
      lines: [
        step("1. Kiosk admin > Add a shift…"),
        step(
          "2. Search for the volunteer. People who share a name show their Profiles row and the last four digits of their phone, so you can tell them apart.",
        ),
        step(
          "3. Pick the date, enter the check-in and check-out times they gave you, a note if you like, and your initials. Press Save.",
        ),
        tip(
          "If they still have an open shift that day, close it with Kiosk admin > Fix a sign-out… first.",
        ),
      ],
    },
    {
      title: "Remove a shift (a row that shouldn't be there)",
      lines: [
        step("1. Kiosk admin > Remove a shift…"),
        step("2. Paste the shift's Shift ID, or pick the volunteer and the date, then press Find."),
        step("3. Pick the row and check its details show the right shift."),
        step("4. Type a reason and your initials. Press Save."),
        tip(
          "The row moves to the Removed shifts tab, so nothing is lost, and its flags are ticked. A row with no Shift ID can't be removed this way: delete it on the Log by hand.",
        ),
      ],
    },
    {
      title: "Restore a shift (put a removed row back)",
      lines: [
        step("1. Kiosk admin > Restore a shift…"),
        step(
          "2. Find the row in the list, newest first; type to search. Each row shows who removed it, when and why.",
        ),
        step("3. Type your initials and press Save. The row goes back at the bottom of the Log."),
        tip(
          "The Hours tab shows an added, fixed, removed or restored shift after its next refresh: about 5 AM, or now with Kiosk admin > Refresh Hours.",
        ),
      ],
    },
    {
      title: "Make the monthly report",
      lines: [
        step("1. Kiosk admin > Monthly report…"),
        step("2. Choose the month, type your initials and press Make report."),
        step(
          "3. The report goes on a new tab named for the month, such as Report 2026-11. The window then shows Download CSV and Download PDF links for that tab.",
        ),
        tip(
          "The report's dollar figure uses Volunteer hour value on the Settings tab. Making the same month again makes a second tab; delete old report tabs when you're done with them.",
        ),
      ],
    },
    {
      title: "The weekly flags email",
      lines: [
        text(
          "Once a week the kiosk can email a short list of new and unreviewed flags. It sends only when there is something to report: a flag raised in the last 7 days, a flag nobody has ticked Reviewed, or a nightly auto clock-out that hasn't run for over 2 days or has never run.",
        ),
        step("1. On the Settings tab, type the addresses in the Value of Flags email to."),
        step(
          "2. Change Flags email day and Flags email hour (Central time) if Monday at 8 AM doesn't suit.",
        ),
        step(
          '3. Set Flags email to On. The kiosk checks once an hour. If Flags email last run is blank, unreadable or older than the last time that day and hour came round, the next hourly check runs, whatever the day. After that a check runs once a week, at the first hourly check on or after that day and hour. A check with nothing to report sends nothing and writes "nothing to send" in Flags email last run.',
        ),
        tip(
          "Changing the day or hour takes effect at once: if the new day and hour have come round since the last check, a check runs within the hour. To stop the email, set Flags email to Off. To check this week again, clear the Value of Flags email last run: the next hourly check runs, and sends if there is anything to report.",
        ),
      ],
    },
    {
      title: "Change a setting",
      lines: [
        step(
          "1. Open the Settings tab and find the setting in the Setting column. Its What it does column says what it does and what to type.",
        ),
        step(
          "2. Type the new value in the Value column on that row. Change nothing else on the row.",
        ),
        step(
          "3. The kiosk uses the new value the next time it needs it: the next tap, menu window or scheduled job.",
        ),
        tip(
          'Rows whose What it does starts "Written by the kiosk" fill themselves in; leave them alone unless a how-to on this tab says otherwise.',
        ),
      ],
    },
    {
      title: "Look up hours (the Hours tab)",
      lines: [
        text(
          "The Hours tab shows hours, shifts and volunteers for any period you pick. It updates at about 5 AM each day; Kiosk admin > Refresh Hours updates it now.",
        ),
        step(
          "1. Use the slicers above the tables (Year, Month, Role/Type, Activity, Volunteer) to pick a period. Every slicer filters every table.",
        ),
        step("2. " + hoursHowTo()),
        step("3. " + hoursDateNote()),
        step(
          "4. To sort a table, pick an order in the Sort box above it. Everyone sees the new order.",
        ),
        step("5. Your slicer picks are yours alone: nobody else sees them."),
        step(
          "6. Double-click a number to see the shifts behind it on a new tab. Delete that tab when you're done.",
        ),
        tip(
          "Don't use Set current filters as default in a slicer's menu: it changes the Hours tab for everyone.",
        ),
      ],
    },
    {
      title: "Other menu items",
      lines: [
        text("Kiosk admin > Refresh Hours brings the Hours tab up to date now."),
        text(
          "Kiosk admin > Check the Log now runs the morning check for problems on the Log right away and says what it found. New problems go on the Flags tab.",
        ),
        text(
          "Kiosk admin > Import past hours… brings shifts in from an old hours spreadsheet, from any date. Press Preview first. Running it again brings in only new rows, as long as rows it already brought in are left as they are in the old sheet and new rows go at the bottom of the tab. A shift on a day the volunteer also has a kiosk shift still comes in, flagged so you can check it isn't counted twice.",
        ),
      ],
    },
    {
      title: "Please don't",
      lines: [
        item(
          "• Rename the Log, Flags, Settings or Hours tabs. The kiosk finds them and stops working without them.",
        ),
        item(
          "• Rename or delete the Shifts tab. The nightly auto clock-out reads it to guess when people left, and without it the guesses get worse.",
        ),
        item(
          "• Rename a column header on the Log or Flags tab, or give two columns the same header. Adding columns of your own is fine; if one of the kiosk's columns needs to move, tell the kiosk's developers so its colours and filter views follow.",
        ),
        item(
          "• Change a name in the Setting column on the Settings tab. The kiosk would treat that setting as missing.",
        ),
        item(
          "• Delete a shift with a Shift ID from the Log by hand. Use Kiosk admin > Remove a shift… so a copy is kept.",
        ),
        item(
          "• Change a Shift ID, or put one row's Shift ID on another row. Copying one to search for it is fine.",
        ),
        item(
          "• Type over or delete anything on the Hours tab other than its slicers and Sort boxes.",
        ),
        item("• Edit the Removed shifts or Import ledger tabs by hand. The kiosk relies on them."),
      ],
    },
    {
      title: "What the Log columns hold",
      lines: [
        text(
          "Each Log and Flags column header has a hover note with the text below. Once you write your own note on a header, or change the kiosk's, the kiosk leaves it exactly as you left it, and its own text stays here. If you delete a note, the kiosk puts its own back the next time it is updated.",
        ),
      ].concat(howToColumnLines(logHeaderNames(), logHeaderNotes())),
    },
    {
      title: "What the Flags columns hold",
      lines: howToColumnLines(flagHeaderNames(), flagHeaderNotes()),
    },
  ];
}

/**
 * The How to tab's rows, one per line of column A, as [{kind, text, formula?}]: the title,
 * the two notes under it, then per section a blank row, its heading and its lines. Only
 * the contact line has a formula.
 */
function howToRows() {
  const rows = [
    { kind: "title", text: "How to: the volunteer kiosk sheet" },
    {
      kind: "note",
      text: "Short how-tos for the jobs staff do in this spreadsheet. The kiosk writes this tab and rewrites it whenever the kiosk is updated, so changes made here won't last; to suggest a change, tell the kiosk's developers.",
    },
    {
      kind: "note",
      text: "Hover over a column header on the Log or the Flags tab to see what that column holds; the same notes are at the end of this tab. On the Settings tab, the What it does column explains each setting.",
    },
  ];
  howToSections().forEach((section) => {
    rows.push({ kind: "blank", text: "" });
    rows.push({ kind: "heading", text: section.title });
    section.lines.forEach((line) =>
      rows.push(
        line.formula
          ? { kind: line.kind, text: line.text, formula: line.formula }
          : { kind: line.kind, text: line.text },
      ),
    );
  });
  return rows;
}

/**
 * Each How to row kind's format, as {weight, size, colour, background, style} in the
 * values Sheets' setFontWeights, setFontSizes, setFontColors, setBackgrounds and
 * setFontStyles take.
 */
function howToStyles() {
  const P = lookPalette();
  const black = "#000000";
  const look = (weight, size, colour, background, style) => ({
    weight,
    size,
    colour,
    background,
    style,
  });
  return {
    title: look("bold", lookTitleFontSize(), P.navy, P.white, "normal"),
    note: look("normal", 10, P.grey, P.white, "italic"),
    heading: look("bold", 11, P.navy, P.section, "normal"),
    contact: look("normal", 10, black, P.white, "normal"),
    text: look("normal", 10, black, P.white, "normal"),
    step: look("normal", 10, black, P.white, "normal"),
    tip: look("normal", 10, P.grey, P.white, "italic"),
    item: look("normal", 10, black, P.white, "normal"),
    blank: look("normal", 10, black, P.white, "normal"),
  };
}
