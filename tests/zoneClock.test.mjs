// Tests for the wall-clock reads in apps-script/Sheets.js (centralDate_, cellText_,
// cellTime_, zoneDate_) and importCell_ in apps-script/Import.js. Each must return exactly
// what Utilities.formatDate returns for the same Date, zone and pattern. Each UTC hour's
// offset comes from Intl.DateTimeFormat, or from one formatDate call where Intl can't be
// used, rather than one formatDate call per cell. The stand-in formatDate here is built on
// Intl.DateTimeFormat (zoneFormat.mjs), separately from the server code, and counts its
// calls. Most checks run twice: with the context's own Intl, and with Intl taken away so
// every hour goes to formatDate.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { formatInZone, zoneFields } from "./zoneFormat.mjs";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const SERVER_FILES = ["Logic.js", "Sheets.js", "Import.js"].map((f) => [
  f,
  read("apps-script/" + f),
]);
const TZ = "America/Chicago";
const MINUTE = 60000;
const HOUR = 3600000;
const DAY = 24 * HOUR;

/** A deterministic stream of numbers in [0, 1). */
function random(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** zone's offset at ms, in milliseconds, from the reference. */
const offsetAt = (ms, zone) => {
  const p = zoneFields(new Date(ms), zone);
  const wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return wall - Math.floor(ms / 1000) * 1000;
};

/** "yyyy-MM-dd HH:mm" in zone to milliseconds; a time skipped in spring reads as the later one. */
const zoneMs = (text, zone) => {
  const [, y, mo, d, h, mi] = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(text).map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  const hit = [-1, 0, 1]
    .map((k) => wall - offsetAt(wall + k * 3 * HOUR, zone))
    .filter((ms) => ms + offsetAt(ms, zone) === wall)
    .sort((a, b) => b - a)[0];
  return hit ?? wall - offsetAt(wall - 3 * HOUR, zone);
};

/**
 * Logic.js, Sheets.js and Import.js in one scope, with a Log tab of logRows (header
 * included) and a Utilities whose formatDate calls are counted in calls.formatDate, each
 * call's Date in calls.dates. intl "none" takes Intl away; an object stands in for it.
 */
function server(logRows = [[]], { intl } = {}) {
  const calls = { formatDate: 0, dates: [] };
  const sheet = {
    getLastRow: () => logRows.length,
    getLastColumn: () => Math.max(...logRows.map((r) => r.length)),
    getRange: (row, col, rows, cols) => ({
      getValues: () =>
        Array.from({ length: rows }, (_, i) =>
          Array.from({ length: cols }, (_, j) => logRows[row - 1 + i][col - 1 + j] ?? ""),
        ),
    }),
  };
  const ctx = {
    console,
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ({
        getSheetByName: (name) => (name === "Log" ? sheet : null),
      }),
    },
    Utilities: {
      formatDate: (date, zone, format) => {
        calls.formatDate++;
        calls.dates.push(date.getTime());
        return formatInZone(date, zone, format);
      },
      parseDate: (text, zone, format) => {
        assert.equal(format, "yyyy-MM-dd HH:mm");
        return new Date(zoneMs(text, zone));
      },
    },
  };
  if (intl === "none") ctx.Intl = undefined;
  else if (intl) ctx.Intl = intl;
  vm.createContext(ctx);
  for (const [file, source] of SERVER_FILES) vm.runInContext(source, ctx, { filename: file });
  return { ctx, calls };
}

/** The two ways an hour's offset is read: Intl, and formatDate with no Intl. */
const MODES = [
  ["Intl", {}],
  ["formatDate", { intl: "none" }],
];

/** Checks every read of date against the reference formatDate. */
function assertReads(ctx, date) {
  const day = formatInZone(date, TZ, "yyyy-MM-dd");
  const clock = formatInZone(date, TZ, "HH:mm");
  const at = date.toISOString();
  assert.equal(ctx.centralDate_(date), day, "centralDate_ " + at);
  assert.equal(ctx.cellText_(date), day, "cellText_ " + at);
  const time = ctx.cellTime_(date);
  assert.equal(time.ms, date.getTime(), "cellTime_ ms " + at);
  assert.equal(time.date, day, "cellTime_ date " + at);
  assert.equal(time.clock, clock, "cellTime_ clock " + at);
}

// ---------------------------------------------------------------------------
// The reference and the zone

test("the reference reads Central standard time on 1899-12-30 and local mean time before 1883", () => {
  // Sheets keeps a time typed with no date on 1899-12-30. Central time began on
  // 1883-11-18 at 18:00 UTC, so that date is plain CST (-6:00).
  assert.equal(formatInZone(new Date("1899-12-30T06:00:00Z"), TZ, "HH:mm:ss"), "00:00:00");
  assert.equal(formatInZone(new Date("1899-12-30T15:00:00Z"), TZ, "HH:mm"), "09:00");
  // Before that, Chicago's local mean time, -5:50:36, seconds included.
  assert.equal(formatInZone(new Date("1880-01-01T06:00:00Z"), TZ, "HH:mm:ss"), "00:09:24");
  assert.equal(formatInZone(new Date("1883-11-18T17:59:59Z"), TZ, "HH:mm:ss"), "12:09:23");
  assert.equal(formatInZone(new Date("1883-11-18T18:00:00Z"), TZ, "HH:mm:ss"), "12:00:00");
});

test("America/Chicago's offset changes only on a whole UTC hour, 1850 to 2100", () => {
  // The kiosk's zone is read one formatDate call per UTC hour; this is what makes that exact.
  const start = Date.UTC(1850, 0, 1);
  const end = Date.UTC(2100, 0, 1);
  let changes = 0;
  let prev = offsetAt(start, TZ);
  for (let d = start + DAY; d <= end; d += DAY) {
    const now = offsetAt(d, TZ);
    if (now !== prev) {
      for (let h = d - DAY; h < d; h += HOUR) {
        assert.equal(
          offsetAt(h + HOUR - 1000, TZ),
          offsetAt(h, TZ),
          "change inside the hour from " + new Date(h).toISOString(),
        );
        if (offsetAt(h + HOUR, TZ) !== offsetAt(h, TZ)) changes++;
      }
    }
    prev = now;
  }
  assert.ok(changes > 300, "found " + changes + " changes");
});

// ---------------------------------------------------------------------------
// Same text as formatDate

for (const [mode, opts] of MODES) {
  test(
    "Central reads match formatDate every 7 minutes across 2026, with seconds and milliseconds, offsets from " +
      mode,
    () => {
      const { ctx } = server([[]], opts);
      const next = random(2026);
      for (let ms = Date.UTC(2026, 0, 1, 6); ms < Date.UTC(2027, 0, 1, 6); ms += 7 * MINUTE) {
        assertReads(ctx, new Date(ms + Math.floor(next() * MINUTE)));
      }
    },
  );
}

for (const [mode, opts] of MODES) {
  test(
    "Central reads match formatDate minute by minute around both 2026 clock changes, offsets from " +
      mode,
    () => {
      const { ctx } = server([[]], opts);
      const next = random(311);
      // Daylight time starts 2026-03-08 at 2:00 CST (08:00 UTC) and ends 2026-11-01 at 2:00
      // CDT (07:00 UTC).
      for (const change of [Date.UTC(2026, 2, 8, 8), Date.UTC(2026, 10, 1, 7)]) {
        for (let ms = change - 3 * HOUR; ms <= change + 3 * HOUR; ms += MINUTE) {
          for (const shift of [0, -1, 1, 59999, Math.floor(next() * MINUTE)]) {
            assertReads(ctx, new Date(ms + shift));
          }
        }
      }
    },
  );
}

for (const [mode, opts] of MODES) {
  test(
    "Central reads match formatDate for times typed with no date (1899-12-30), offsets from " +
      mode,
    () => {
      const { ctx } = server([[]], opts);
      const next = random(1899);
      for (let minutes = 0; minutes < 24 * 60; minutes += 15) {
        // How Sheets hands a Chicago spreadsheet's typed time to the script: that wall clock
        // on 1899-12-30, Central standard time.
        const ms = Date.UTC(1899, 11, 30) + minutes * MINUTE + 6 * HOUR;
        for (const shift of [0, 999, Math.floor(next() * MINUTE), -1]) {
          assertReads(ctx, new Date(ms + shift));
        }
      }
      assert.equal(ctx.cellTime_(new Date("1899-12-30T15:00:00Z")).clock, "09:00");
    },
  );
}

for (const [mode, opts] of MODES) {
  test(
    "Central reads match formatDate before 1970, across local mean time and 1883, offsets from " +
      mode,
    () => {
      const { ctx } = server([[]], opts);
      const next = random(1883);
      // Scattered, negative-epoch dates, 1850 to 1970, out of time order.
      for (let ms = Date.UTC(1850, 0, 1); ms < 0; ms += 61 * HOUR + 7 * MINUTE) {
        assertReads(ctx, new Date(ms + Math.floor(next() * HOUR)));
        assertReads(ctx, new Date(-ms + Date.UTC(1850, 0, 1) + Math.floor(next() * MINUTE)));
      }
      // Minute by minute across the change to Central time.
      const central = Date.UTC(1883, 10, 18, 18);
      for (let ms = central - 2 * HOUR; ms <= central + 2 * HOUR; ms += MINUTE) {
        for (const shift of [0, -1, 1, 36000]) assertReads(ctx, new Date(ms + shift));
      }
    },
  );
}

test("a date before 1583 or an unreadable Date goes to formatDate itself", () => {
  const { ctx, calls } = server();
  const old = new Date("1500-02-28T23:30:00Z");
  assert.equal(ctx.centralDate_(old), formatInZone(old, TZ, "yyyy-MM-dd"));
  assert.equal(ctx.cellTime_(old).clock, formatInZone(old, TZ, "HH:mm"));
  const before = calls.formatDate;
  ctx.centralDate_(old);
  assert.equal(calls.formatDate, before + 1, "no cached offset for a Julian-calendar year");
  assert.deepEqual({ ...ctx.cellTime_(new Date(NaN)) }, { ms: NaN, date: "", clock: "" });
});

// ---------------------------------------------------------------------------
// Other zones (Import.js reads a source sheet's dates in that sheet's own zone)

const ZONES = [
  TZ,
  "America/St_Johns", // -3:30, clocks change at 2:00 local: on a half UTC hour
  "Australia/Lord_Howe", // daylight time is half an hour
  "Asia/Kolkata",
  "Asia/Kathmandu",
  "Europe/Amsterdam", // +0:19:32 until 1937, then +0:20 until 1940
  "Pacific/Chatham",
  "Africa/Monrovia", // -0:44:30 until 1972: an odd-second offset after 1883
  "UTC",
];

for (const [mode, opts] of MODES) {
  test(
    "importCell_ reads each zone's dates as formatDate does, the zones interleaved, offsets from " +
      mode,
    () => {
      const { ctx } = server([[]], opts);
      const next = random(7);
      const check = (ms) => {
        for (const zone of ZONES) {
          const date = new Date(ms);
          assert.equal(
            ctx.importCell_(date, zone),
            formatInZone(date, zone, "yyyy-MM-dd"),
            zone + " " + date.toISOString(),
          );
        }
      };
      for (let ms = Date.UTC(2026, 0, 1); ms < Date.UTC(2027, 0, 1); ms += 97 * MINUTE) {
        check(ms + Math.floor(next() * MINUTE));
      }
      for (
        let ms = Date.UTC(1930, 0, 1);
        ms < Date.UTC(1945, 0, 1);
        ms += 23 * HOUR + 11 * MINUTE
      ) {
        check(ms + Math.floor(next() * HOUR));
      }
      // Minute by minute across each 2026 clock change in St. John's, Lord Howe and Chatham,
      // and Amsterdam's 1937 change from +0:19:32 to +0:20 (at 00:00 local).
      const changes = [
        Date.UTC(2026, 2, 8, 5, 30),
        Date.UTC(2026, 10, 1, 4, 30),
        Date.UTC(2026, 3, 4, 15),
        Date.UTC(2026, 9, 3, 15, 30),
        Date.UTC(2026, 3, 4, 14),
        Date.UTC(2026, 8, 26, 14),
        Date.UTC(1937, 5, 30, 23, 40, 28),
      ];
      for (const change of changes) {
        for (let ms = change - 2 * HOUR; ms <= change + 2 * HOUR; ms += MINUTE) {
          for (const shift of [0, -1, 1, 28000]) check(ms + shift);
        }
      }
      assert.equal(ctx.importCell_(12.5, "Asia/Kolkata"), 12.5);
      assert.equal(ctx.importCell_("  text ", "Asia/Kolkata"), "text");
    },
  );
}

test("importCell_ calls formatDate at most twice per distinct UTC hour of a zone, none with Intl in Chicago", () => {
  const { ctx, calls } = server();
  const zone = "America/St_Johns";
  // A source sheet's dates: midnight in its own zone, many rows a day across 2026.
  const hours = new Set();
  for (let day = 0; day < 365; day++) {
    const midnight = zoneMs(
      new Date(Date.UTC(2026, 0, 1) + day * DAY).toISOString().slice(0, 10) + " 00:00",
      zone,
    );
    for (let row = 0; row < 20; row++) {
      ctx.importCell_(new Date(midnight), zone);
      hours.add(Math.floor(midnight / HOUR));
    }
  }
  assert.ok(calls.formatDate <= 2 * hours.size, calls.formatDate + " calls");
  assert.ok(calls.formatDate < 7300 / 5, calls.formatDate + " calls for 7,300 rows");
  // With Intl, a Chicago source sheet's dates make none at all.
  const { ctx: withIntl, calls: intlCalls } = server();
  for (let day = 0; day < 365; day++) {
    const date = new Date(Date.UTC(2026, 0, 1, 6) + day * DAY);
    assert.equal(withIntl.importCell_(date, TZ), formatInZone(date, TZ, "yyyy-MM-dd"));
  }
  assert.equal(intlCalls.formatDate, 0);
});

// ---------------------------------------------------------------------------
// Reading the Log

for (const [mode, opts] of MODES) {
  test(
    "readLog_ matches a per-cell read, offsets from " +
      mode +
      (mode === "Intl"
        ? ", with no formatDate call"
        : ", one formatDate call per UTC hour at most"),
    () => {
      const next = random(20);
      const { ctx: probe } = server();
      const H = probe.logHeaderNames();
      const header = probe.logHeaders();
      const at = (h) => header.indexOf(h);
      const rows = [header];
      const dates = [];
      const typed = (minutes) => new Date(Date.UTC(1899, 11, 30) + minutes * MINUTE + 6 * HOUR);
      // 2,000 shifts across 2026, a few a day, every tap time distinct.
      for (let i = 0; i < 2000; i++) {
        const day = Date.UTC(2026, 0, 1) + Math.floor(i / 6) * DAY;
        const dayText = new Date(day).toISOString().slice(0, 10);
        const inMs = zoneMs(dayText + " 08:00", TZ) + Math.floor(next() * 4 * HOUR);
        const outMs = inMs + HOUR + Math.floor(next() * 5 * HOUR);
        const row = header.map(() => "");
        row[at(H.date)] = new Date(zoneMs(dayText + " 00:00", TZ));
        row[at(H.name)] = "Volunteer " + i;
        row[at(H.recordedIn)] = new Date(inMs);
        row[at(H.statedIn)] = typed(8 * 60 + (i % 240));
        row[at(H.recordedOut)] = new Date(outMs);
        row[at(H.statedOut)] = typed(13 * 60 + (i % 240));
        row[at(H.status)] = "Closed";
        row[at(H.shiftId)] = "shift-" + i;
        row[at(H.token)] = "token-" + (i % 50);
        rows.push(row);
        for (const c of [H.date, H.recordedIn, H.statedIn, H.recordedOut, H.statedOut]) {
          dates.push(row[at(c)].getTime());
        }
      }
      const { ctx, calls } = server(rows, opts);
      const entries = ctx.readLog_(ctx.readLogColumns_());
      assert.equal(entries.length, 2000);

      // The entries are those of a read that calls formatDate for every cell.
      const reference = {
        text: (v) => (ctx.isDate_(v) ? formatInZone(v, TZ, "yyyy-MM-dd") : ctx.cellString(v)),
        time: (v) => ({
          ms: v.getTime(),
          date: formatInZone(v, TZ, "yyyy-MM-dd"),
          clock: formatInZone(v, TZ, "HH:mm"),
        }),
        at: (dateText, clock) => {
          const text = ctx.adminDateTimeText(dateText, clock);
          if (!text) return { ms: NaN, date: "" };
          const ms = zoneMs(text, TZ);
          return { ms, date: formatInZone(new Date(ms), TZ, "yyyy-MM-dd") };
        },
      };
      const cols = ctx.readLogColumns_();
      rows.slice(1).forEach((cells, i) => {
        assert.deepEqual({ ...entries[i] }, { ...ctx.logEntry(cells, i + 2, cols, reference) });
      });

      if (mode === "Intl") {
        // A 2026 Log, typed 1899 times included, needs no formatDate call at all.
        assert.equal(calls.formatDate, 0);
        return;
      }
      // Each call reads the start of a UTC hour the read needed, and no hour twice: the
      // hours of the Date cells and of the typed times put on their row's day.
      const hourOf = (ms) => Math.floor(ms / HOUR);
      assert.ok(
        calls.dates.every((ms) => ms % HOUR === 0),
        "hour starts only",
      );
      const asked = calls.dates.map(hourOf);
      assert.equal(new Set(asked).size, asked.length, "no hour asked twice");
      const needed = new Set(dates.map(hourOf));
      for (const e of entries) {
        needed.add(hourOf(e.statedInMs));
        needed.add(hourOf(e.statedOutMs));
      }
      assert.ok(
        asked.every((h) => needed.has(h)),
        "only hours the read needed",
      );
      assert.ok(calls.formatDate <= needed.size);
      // A read that called formatDate per cell made 22,000 calls here: 2 for each of the
      // 8,000 date-time cells, 1 for each Date column cell and 1 for each typed time put on
      // its day.
      assert.ok(calls.formatDate < dates.length / 3, calls.formatDate + " calls");
    },
  );
}

// ---------------------------------------------------------------------------
// When Intl isn't used

test("with Intl, formatDate is asked only for Chicago hours before Central time began", () => {
  const { ctx, calls } = server();
  const next = random(1850);
  // 1850 to 2027 every 13 hours and a bit, and minute by minute across 1883-11-18 18:00Z.
  for (let ms = Date.UTC(1850, 0, 1); ms < Date.UTC(2027, 0, 1); ms += 13 * HOUR + 17 * MINUTE) {
    assertReads(ctx, new Date(ms + Math.floor(next() * HOUR)));
  }
  const central = Date.UTC(1883, 10, 18, 18);
  for (let ms = central - 20 * HOUR; ms <= central + 2 * HOUR; ms += MINUTE) {
    assertReads(ctx, new Date(ms));
  }
  // Local mean time: every hour before 1883-11-18 (the cutoff), and the hours of the 18th
  // still on -5:50:36, whose offset isn't a whole minute.
  assert.ok(calls.formatDate > 1000, calls.formatDate + " calls");
  assert.ok(
    calls.dates.every((ms) => ms < central),
    "a call after " + new Date(central).toISOString(),
  );
  assert.ok(calls.dates.some((ms) => ms >= Date.UTC(1883, 10, 18)));
});

test("Intl missing, or throwing, leaves every Chicago hour to formatDate", () => {
  const throwing = {
    DateTimeFormat: function () {
      throw new RangeError("no time zones here");
    },
  };
  for (const intl of ["none", throwing]) {
    const { ctx, calls } = server([[]], { intl });
    for (let ms = Date.UTC(2026, 0, 1); ms < Date.UTC(2026, 0, 3); ms += 7 * MINUTE) {
      assertReads(ctx, new Date(ms));
    }
    assert.equal(calls.formatDate, 48, "one call per hour");
  }
});

test("zones other than America/Chicago are read with formatDate, as before", () => {
  // Intl and formatDate can carry different releases of the time zone rules, so only the
  // kiosk's zone is read through Intl.
  for (const zone of ["America/St_Johns", "America/Vancouver", "Africa/Monrovia", "MST", "UTC"]) {
    const { ctx, calls } = server();
    for (const ms of [Date.UTC(1960, 6, 1, 12), Date.UTC(2026, 11, 1, 12)]) {
      const date = new Date(ms);
      assert.equal(ctx.importCell_(date, zone), formatInZone(date, zone, "yyyy-MM-dd"), zone);
    }
    assert.ok(calls.formatDate >= 2, zone);
  }
});

test("Intl parts that don't read back as one wall-clock time go to formatDate", () => {
  // Intl stand-ins whose parts are bent one way each; the real parts come from Node's Intl.
  const bent = (bend) => ({
    DateTimeFormat: function (locale, options) {
      const real = new Intl.DateTimeFormat(locale, options);
      return { formatToParts: (date) => bend(real.formatToParts(date)) };
    },
  });
  const set = (type, value) => (parts) => parts.map((p) => (p.type === type ? { type, value } : p));
  const bends = {
    "hour 24": set("hour", "24"),
    "minute 60": set("minute", "60"),
    "second 60": set("second", "60"),
    "month 13": set("month", "13"),
    "day 0": set("day", "0"),
    "an era": (parts) => [...parts, { type: "era", value: "BC" }],
    "a day period": (parts) => [...parts, { type: "dayPeriod", value: "AM" }],
    "other digits": set("minute", "\u0660\u0660"),
    "no seconds": (parts) => parts.filter((p) => p.type !== "second"),
    "a year off": (parts) => parts.map((p) => (p.type === "year" ? { ...p, value: "2027" } : p)),
    "a 1700s year": set("year", "1700"),
    "half a minute off": set("second", "30"),
    throws: () => {
      throw new RangeError("bent");
    },
  };
  for (const [name, bend] of Object.entries(bends)) {
    const { ctx, calls } = server([[]], { intl: bent(bend) });
    const date = new Date(Date.UTC(2026, 6, 1, 17, 25, 9));
    assertReads(ctx, date);
    assert.ok(calls.formatDate > 0, name);
  }
});

test("a time before 1883-11-18 goes to formatDate even when Intl reads a whole minute", () => {
  // An Intl that drops the seconds reads Chicago's -5:50:36 of 1880 as -5:51:00.
  const wholeMinutes = {
    DateTimeFormat: function (locale, options) {
      const real = new Intl.DateTimeFormat(locale, options);
      return {
        formatToParts: (date) =>
          real.formatToParts(date).map((p) => (p.type === "second" ? { ...p, value: "00" } : p)),
      };
    },
  };
  const { ctx, calls } = server([[]], { intl: wholeMinutes });
  for (let ms = Date.UTC(1880, 0, 1); ms < Date.UTC(1880, 0, 3); ms += 7 * MINUTE) {
    assertReads(ctx, new Date(ms));
  }
  assert.equal(calls.formatDate, 48, "one call per hour");
  const before = calls.formatDate;
  assertReads(ctx, new Date(Date.UTC(2026, 0, 1, 12, 34, 56)));
  assert.equal(calls.formatDate, before, "2026 still read through Intl");
});
