// The Logs the golden month test runs, shared by tests/report-golden-make.mjs (which writes
// tests/report-golden.json from main 2e7c0da's Logic.js) and tests/reports.test.mjs (which
// holds today's month reports to that file). Not a test file itself.
//
// Each Log is a list of rows as maps of short header keys (logHeaderNames' keys) to cell
// values, read into report entries the way tests/reports.test.mjs reads them.

const centralDate = (ms) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));

const centralWall = (ms) => {
  const p = {};
  new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
    .formatToParts(new Date(ms))
    .forEach((x) => (p[x.type] = x.value));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
};

/** read.text, read.time and read.at as Sheets.js gives them, over a loaded Logic.js L. */
function readFor(L) {
  const timeOnDate = (dateText, clock) => {
    const text = L.adminDateTimeText(dateText, clock);
    if (!text) return { ms: NaN, date: "" };
    const wall = Date.parse(text.replace(" ", "T") + ":00Z");
    const found = [5, 6].map((o) => wall + o * 3600000).find((t) => centralWall(t) === wall);
    const ms = found === undefined ? wall + 6 * 3600000 : found;
    return { ms, date: centralDate(ms) };
  };
  return {
    text: (v) => L.cellString(v),
    time: (v) => {
      const none = { ms: NaN, date: "", clock: "" };
      if (Object.prototype.toString.call(v) === "[object Date]") {
        const ms = v.getTime();
        if (!isFinite(ms)) return none;
        return {
          ms,
          date: centralDate(ms),
          clock: new Date(centralWall(ms)).toISOString().slice(11, 16),
        };
      }
      const clock = L.clockText(v);
      if (clock) return { ms: NaN, date: "", clock };
      const ms = L.cellString(v) ? Date.parse(String(v)) : NaN;
      return isFinite(ms) ? { ms, date: centralDate(ms), clock: "" } : none;
    },
    at: timeOnDate,
  };
}

/** The Log header of a golden Log: the kiosk's, less any header named in without. */
export function goldenHeader(L, without = []) {
  const H = L.logHeaderNames();
  const drop = without.map((k) => H[k]);
  return Array.from(L.logHeaders()).filter((h) => !drop.includes(h));
}

/** {entries, cols}: a golden Log's rows as report entries under its header. */
export function goldenEntries(L, log) {
  const header = goldenHeader(L, log.without);
  const H = L.logHeaderNames();
  const cols = L.reportColumns(header);
  const read = readFor(L);
  const entries = log.rows.map((values, i) => {
    const cells = header.map((h) => {
      const key = Object.keys(H).find((k) => L.normalizeHeader(H[k]) === L.normalizeHeader(h));
      return key && values[key] !== undefined ? values[key] : "";
    });
    return L.reportEntry(cells, i + 2, cols, read);
  });
  return { entries, cols };
}

/** A Central time on a date as an ISO text (Central is UTC-6 from November, -5 before). */
const at = (date, hhmm) => {
  const offset = date < "2026-11-01" ? "-05:00" : "-06:00";
  return date + "T" + hhmm + ":00" + offset;
};

/** A day name for a yyyy-MM-dd, as the Log's Day column holds it. */
const dayName = (date) =>
  ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][
    new Date(date + "T12:00:00Z").getUTCDay()
  ];

/** A kiosk shift: tapped and stated alike unless given. */
function kioskShift(date, name, token, inAt, outAt, extra = {}) {
  return {
    date,
    day: dayName(date),
    name,
    token,
    status: "closed",
    recordedIn: at(date, inAt),
    statedIn: at(date, inAt),
    recordedOut: at(date, outAt),
    statedOut: at(date, outAt),
    inBy: "kiosk",
    outBy: "kiosk",
    shiftId: "s-" + date + "-" + token + "-" + inAt,
    ...extra,
  };
}

/** A row as the paper import writes it: closed, stated times only, "import" at both ends. */
function importedShift(date, name, token, inAt, outAt, hours, extra = {}) {
  return {
    date,
    day: dayName(date),
    name,
    token,
    status: "closed",
    statedIn: at(date, inAt),
    statedOut: at(date, outAt),
    statedHours: hours,
    inBy: "import",
    outBy: "import",
    shiftId: "imp-" + date + "-" + token + "-" + inAt,
    ...extra,
  };
}

/** Dee Fox: 9 counted shifts and 48.00 hours before the last date, then 2.50 hours. */
function deeFox(lastDate) {
  const rows = [];
  for (let i = 1; i <= 9; i++) {
    const date = "2026-10-" + String(i).padStart(2, "0");
    rows.push(
      kioskShift(date, "Dee Fox", "tD", "09:00", "14:00", { statedHours: i === 9 ? 8 : 5 }),
    );
  }
  rows.push(kioskShift(lastDate, "Dee Fox", "tD", "09:00", "11:30", { statedHours: 2.5 }));
  return rows;
}

const SAMPLE = [
  kioskShift("2026-10-28", "Ben Ott", "tB", "09:00", "12:00", { recordedHours: 3, statedHours: 3 }),
  kioskShift("2026-11-02", "Ana Ruiz", "tA", "09:00", "12:00", {
    recordedHours: 3,
    statedHours: 3,
    activity: "Pantry",
  }),
  kioskShift("2026-11-04", "Ben Ott", "tB", "10:00", "12:30", {
    recordedIn: at("2026-11-04", "10:24"),
    recordedHours: 2.1,
    statedHours: 2.5,
    alerts: "arrival differs by 24 min",
  }),
  {
    date: "2026-11-04",
    name: "Ana Ruiz",
    token: "tA",
    status: "closed",
    statedIn: at("2026-11-04", "13:00"),
    statedOut: at("2026-11-04", "17:00"),
    statedHours: 4,
    inBy: "JP",
    outBy: "JP",
    shiftId: "s5",
  },
  {
    date: "2026-11-09",
    name: "Cal Diaz",
    token: "tC",
    status: "closed",
    recordedIn: at("2026-11-09", "13:00"),
    statedIn: at("2026-11-09", "13:00"),
    statedOut: at("2026-11-09", "15:00"),
    statedHours: 2,
    inBy: "kiosk",
    outBy: "MK",
    shiftId: "s6",
  },
  {
    date: "2026-11-10",
    name: "Ben Ott",
    token: "tB",
    status: "open",
    recordedIn: at("2026-11-10", "09:00"),
    statedIn: at("2026-11-10", "09:00"),
    inBy: "kiosk",
    shiftId: "s7",
  },
];

const REVIEW = [
  kioskShift("2026-11-02", "A", "t1", "09:00", "10:00", { status: "auto-closed", statedHours: 1 }),
  kioskShift("2026-11-02", "A", "t1", "11:00", "12:00", { outBy: "auto-close", statedHours: 1 }),
  kioskShift("2026-11-02", "B", "", "09:00", "10:00", { statedHours: 1 }),
  kioskShift("2026-11-03", "A", "t1", "09:00", "10:00", { statedHours: "" }),
  kioskShift("2026-11-03", "C", "t3", "09:00", "10:00", { statedHours: "2.5" }),
  kioskShift("2026-11-04", "C", "t3", "09:00", "10:00", { statedHours: -1 }),
  kioskShift("2026-11-05", "D", "t4", "09:00", "10:00", { statedHours: 1, inBy: "", outBy: "" }),
  kioskShift("2026-11-05", "D", "t4", "11:00", "12:00", { statedHours: 1, inBy: "J.P." }),
  { date: "11/02/2026", name: "E", token: "t5", status: "closed", shiftId: "x", statedHours: 1 },
  {},
  { date: "", name: "F", status: "open" },
  { date: "2026-11-06", name: "G", token: "t6", status: "", shiftId: "y", statedHours: 1 },
  kioskShift("2025-01-10", "A", "t1", "09:00", "10:00", { statedHours: 1.25 }),
];

const LABELS = [
  kioskShift("2026-10-05", "Ana Ruiz", "t1", "09:00", "10:00", { statedHours: 1 }),
  kioskShift("2026-11-03", "ana  ruiz", "t2", "09:00", "10:00", { statedHours: 1 }),
  kioskShift("2026-11-04", "Ana Ruiz", "t1", "09:00", "10:00", { statedHours: 1 }),
  kioskShift("2026-11-05", "Bo Li", "t3", "09:00", "10:00", { statedHours: 1 }),
  kioskShift("2026-11-06", "Bo Lee", "t3", "09:00", "10:00", { statedHours: 1 }),
  kioskShift("2026-11-03", "Cy Ma", "t9", "13:00", "14:00", { statedHours: 1 }),
  kioskShift("2026-11-03", "Cy Ma", "t8", "09:00", "10:00", { statedHours: 1 }),
  {
    date: "10/01/2026",
    name: "Ana Ruiz",
    token: "t1",
    status: "closed",
    statedHours: 1,
    shiftId: "u",
  },
];

const MILESTONES = deeFox("2026-11-06").concat([
  kioskShift("2026-11-20", "Eve Ng", "tE", "09:00", "10:00", { statedHours: 1, role: "Driver" }),
]);

// Paper-imported rows beside kiosk rows, in September and October 2026.
const IMPORTS = [
  importedShift("2026-09-02", "Ivy Paz", "tI", "09:00", "12:00", 3),
  importedShift("2026-09-03", "Ivy Paz", "tI", "09:00", "11:00", 2, { outBy: "" }),
  importedShift("2026-09-04", "Jo Kim", "tJ", "09:00", "10:30", 1.5, {
    inBy: " IMPORT ",
    outBy: "Import",
  }),
  importedShift("2026-09-05", "Jo Kim", "tJ", "09:00", "10:00", 1, { outBy: "auto-close" }),
  importedShift("2026-09-08", "Kai Roe", "import:kai roe", "09:00", "13:00", 4, {
    alerts: "name not matched to Volunteer Profiles",
  }),
  importedShift("2026-09-09", "Kai Roe", "import:kai roe", "09:00", "10:00", ""),
  importedShift("2026-09-10", "Ivy Paz", "tI", "13:00", "14:00", 1, { outBy: "kiosk" }),
  importedShift("2026-09-11", "Ivy Paz", "tI", "13:00", "14:00", 1, { outBy: "JP" }),
  importedShift("2026-09-12", "Jo Kim", "tJ", "09:00", "10:00", 1, { inBy: "" }),
  {
    date: "2026-09-15",
    name: "Lu Wei",
    token: "tL",
    status: "open",
    statedIn: at("2026-09-15", "09:00"),
    inBy: "import",
    shiftId: "imp-open",
  },
  kioskShift("2026-09-16", "Lu Wei", "tL", "09:00", "11:00", { statedHours: 2, inBy: "" }),
  kioskShift("2026-10-01", "Ivy Paz", "tI", "09:00", "11:00", { statedHours: 2 }),
  importedShift("2026-10-02", "Mo Day", "tM", "09:00", "10:00", 1),
];

/**
 * The golden Logs: name, rows, months to report (every month with a row, and an empty
 * one), and the Settings rates to report with (a number, or null for blank). without names
 * Log columns left off the header.
 */
export const GOLDEN_LOGS = [
  { name: "sample", rows: SAMPLE, months: ["2026-10", "2026-11", "2026-12"], rates: [3479, null] },
  { name: "review", rows: REVIEW, months: ["2025-01", "2026-11"], rates: [null] },
  { name: "labels", rows: LABELS, months: ["2026-10", "2026-11"], rates: [2500] },
  { name: "milestones", rows: MILESTONES, months: ["2026-10", "2026-11"], rates: [null] },
  {
    name: "milestones reordered",
    rows: MILESTONES.slice(-2, -1).concat(MILESTONES.slice(0, -2), MILESTONES.slice(-1)),
    months: ["2026-11"],
    rates: [null],
  },
  { name: "imports", rows: IMPORTS, months: ["2026-09", "2026-10"], rates: [3479] },
  {
    name: "no Role/Type or Activity",
    rows: SAMPLE,
    months: ["2026-11"],
    rates: [3479],
    without: ["role", "activity"],
  },
];

/** The initials and made-at text every golden report is made with. */
export const GOLDEN_MADE = { initials: "JP", madeAt: "2026-12-01 9:14 AM" };
