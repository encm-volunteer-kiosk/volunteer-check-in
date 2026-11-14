// Tests for the check-in time on a checked-in card (src/cardTime.ts, imported as it is; Node
// strips its types): the text, when the card turns amber, the screen-reader words, and the
// long-shift number read from the server's list reply.

import { test } from "node:test";
import assert from "node:assert/strict";
import { cardTime, DEFAULT_LONG_SHIFT_HOURS, longShiftHoursOf } from "../src/cardTime.ts";

const MIN = 60_000;
const iso = (ms) => new Date(ms).toISOString();
// The tablet's clock: 5:40 PM Central on 2026-11-13 (CST, UTC-6).
const NOW = Date.parse("2026-11-13T23:40:00Z");
// 12:40 AM and 12:00:20 AM Central the next morning.
const AFTER_MIDNIGHT = Date.parse("2026-11-14T06:40:00Z");
const JUST_AFTER_MIDNIGHT = Date.parse("2026-11-14T06:00:20Z");

const text = (arrival, now = NOW, hours = 8) => cardTime(arrival, now, hours).text;
const late = (arrival, now = NOW, hours = 8) => cardTime(arrival, now, hours).late;

test("the card shows the clock time in, or the time in once the card is amber", () => {
  assert.equal(text("2026-11-13T20:55:00.000Z"), "in 2:55 PM");
  // 30 seconds ago.
  assert.equal(text("2026-11-13T23:39:30.000Z"), "in 5:39 PM");
  // Ahead of the tablet's clock.
  assert.equal(text("2026-11-13T23:45:00.000Z"), "in 5:45 PM");
  // 7:30 AM: over 8 hours.
  assert.equal(text("2026-11-13T13:30:00.000Z"), "10h 10m in");
  assert.equal(text(null), "no time");
});

test("an arrival on an earlier Central date shows the time in", () => {
  // 9:02 PM the day before, read at 12:40 AM.
  assert.equal(text("2026-11-14T03:02:00.000Z", AFTER_MIDNIGHT), "3h 38m in");
  // 11:59:50 PM the day before, read at 12:00:20 AM: floored to whole minutes.
  assert.equal(text("2026-11-14T05:59:50.000Z", JUST_AFTER_MIDNIGHT), "0m in");
  // Minutes under an hour have no hours part.
  // 11:51 PM the day before, read at 12:00:20 AM.
  assert.equal(text("2026-11-14T05:51:00.000Z", JUST_AFTER_MIDNIGHT), "9m in");
});

test("the card is amber only past the threshold, never at it", () => {
  for (const hours of [8, 10, 8.2]) {
    const at = Math.round(hours * 60);
    assert.equal(late(iso(NOW - at * MIN), NOW, hours), false, `${hours} h: exactly ${at} min`);
    // Under a minute past it still floors to the threshold.
    assert.equal(
      late(iso(NOW - at * MIN - 59_000), NOW, hours),
      false,
      `${hours} h: ${at} min 59 s`,
    );
    assert.equal(late(iso(NOW - (at + 1) * MIN), NOW, hours), true, `${hours} h: ${at + 1} min`);
  }
  assert.equal(text(iso(NOW - 481 * MIN)), "8h 1m in");
  assert.equal(text(iso(NOW - 480 * MIN)), "in 9:40 AM");
});

test("no time on record is amber; an arrival the day before is amber only past the threshold", () => {
  assert.equal(late(null), true);
  assert.equal(late("not a time"), true);
  assert.equal(text("not a time"), "no time");
  assert.equal(late("2026-11-14T03:02:00.000Z", AFTER_MIDNIGHT), false);
  // Ahead of the tablet's clock is 0 minutes in, never amber.
  assert.equal(late("2026-11-13T23:45:00.000Z"), false);
});

test("the screen-reader words name the check-in time", () => {
  assert.equal(cardTime("2026-11-13T20:55:00.000Z", NOW, 8).label, "checked in at 2:55 PM");
  // Amber cards still give the clock time.
  assert.equal(cardTime("2026-11-13T13:30:00.000Z", NOW, 8).label, "checked in at 7:30 AM");
  assert.equal(
    cardTime("2026-11-14T03:02:00.000Z", AFTER_MIDNIGHT, 8).label,
    "checked in yesterday at 9:02 PM",
  );
  assert.equal(cardTime(null, NOW, 8).label, "check-in time not recorded");
});

test("the long-shift number comes from the list reply, else 8", () => {
  assert.equal(DEFAULT_LONG_SHIFT_HOURS, 8);
  assert.equal(longShiftHoursOf({ ok: true, volunteers: [], longShiftHours: 10 }), 10);
  assert.equal(longShiftHoursOf({ ok: true, volunteers: [], longShiftHours: 0.1 }), 0.1);
  for (const value of [undefined, 0, -2, "10", null, Number.NaN, Number.POSITIVE_INFINITY]) {
    const reply = { ok: true, volunteers: [] };
    if (value !== undefined) reply.longShiftHours = value;
    assert.equal(longShiftHoursOf(reply), 8, String(value));
  }
});
