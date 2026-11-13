// Tests for the time picker's rules (src/quickPicks.ts, imported as it is; Node strips its
// types): every time it can send is a quarter hour from the lower bound, rounded up, to now,
// rounded down, Central.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  QUICK_ANSWERS,
  agoText,
  canNudge,
  centralMinutes,
  clockText,
  fromTimeValue,
  nudge,
  quickAnswers,
  quickRange,
  toTimeValue,
} from "../src/quickPicks.ts";

const labels = (answers) => answers.map((answer) => answer.label);
const times = (answers) => answers.map((answer) => toTimeValue(answer.minutes));
const isQuarter = (minutes) => Number.isInteger(minutes) && minutes % 15 === 0;

// Lower bounds to sweep: arrival (0), whole quarters, odd minutes, and arrivals with
// seconds, which reach the page as fractions of a minute.
const MIN_MINUTES = [0, 0.5, 7, 14.99, 15, 15.01, 59.5, 600, 600.25, 601, 614.9, 615, 1380.5, 1425];

test("quick answers floor to the quarter hour", () => {
  const range = quickRange(0, 14 * 60 + 14);
  assert.deepEqual(range, { earliest: 0, latest: 14 * 60 });
  const answers = quickAnswers(range);
  assert.deepEqual(labels(answers), labels(QUICK_ANSWERS));
  assert.deepEqual(times(answers), ["14:00", "13:45", "13:30", "13:15", "13:00", "12:00"]);
});

test("quick answers outside the range are left out", () => {
  // Arrived at 1:20 PM; now 2:14 PM. Earliest 1:30, latest 2:00.
  const answers = quickAnswers(quickRange(13 * 60 + 20, 14 * 60 + 14));
  assert.deepEqual(labels(answers), ["Now", "15 min ago", "30 min ago"]);
  assert.deepEqual(times(answers), ["14:00", "13:45", "13:30"]);
});

test("quick answers and nudges never leave [earliest, latest]", () => {
  for (const minMinutes of MIN_MINUTES) {
    for (let now = 0; now < 24 * 60; now += 1) {
      const range = quickRange(minMinutes, now);
      if (range.earliest > range.latest) {
        assert.deepEqual(quickAnswers(range), [], `${minMinutes} at ${now}`);
        assert.equal(nudge(range.latest, -15, range), null);
        assert.equal(nudge(range.latest, 15, range), null);
        continue;
      }
      assert.ok(isQuarter(range.earliest) && isQuarter(range.latest));
      assert.ok(range.earliest >= minMinutes && range.earliest - minMinutes < 15);
      assert.ok(range.latest <= now && now - range.latest < 15);
      const answers = quickAnswers(range);
      assert.equal(answers[0].label, "Now", `${minMinutes} at ${now}`);
      assert.equal(answers[0].minutes, range.latest);
      for (const { minutes } of answers) {
        assert.ok(isQuarter(minutes), `${minutes}`);
        assert.ok(minutes >= range.earliest && minutes <= range.latest, `${minutes}`);
      }
      // Every answer in range is shown.
      const shown = QUICK_ANSWERS.filter(({ ago }) => range.latest - ago >= range.earliest);
      assert.equal(answers.length, shown.length);
      // From every minute of the day, in range or not, a nudge lands on a quarter hour in
      // range or is refused, and canNudge says which.
      for (let from = 0; from < 24 * 60; from += 7) {
        for (const step of [-15, 15]) {
          const next = nudge(from, step, range);
          assert.equal(next !== null, canNudge(from, step, range));
          if (next === null) continue;
          assert.ok(isQuarter(next), `${from}${step}`);
          assert.ok(next >= range.earliest && next <= range.latest, `${from}${step} -> ${next}`);
        }
      }
    }
  }
});

test("nudges step a quarter hour and stop at the ends", () => {
  const range = quickRange(600, 690); // 10:00 to 11:30
  assert.equal(nudge(645, -15, range), 630);
  assert.equal(nudge(645, 15, range), 660);
  assert.equal(nudge(600, -15, range), null);
  assert.equal(canNudge(600, -15, range), false);
  assert.equal(canNudge(600, 15, range), true);
  assert.equal(nudge(690, 15, range), null);
  assert.equal(canNudge(690, 15, range), false);
  assert.equal(canNudge(690, -15, range), true);
  // Holding −15 from the latest walks down to the earliest and stops.
  const seen = [];
  for (let value = 690; value !== null; value = nudge(value, -15, range)) seen.push(value);
  assert.deepEqual(seen.map(toTimeValue), [
    "11:30",
    "11:15",
    "11:00",
    "10:45",
    "10:30",
    "10:15",
    "10:00",
  ]);
  // A value off the quarter hour counts from the quarter hour at or before it.
  assert.equal(nudge(652, 15, range), 660);
  assert.equal(nudge(652, -15, range), 630);
});

test("minMinutes with fractions rounds the earliest up", () => {
  // Arrived at 9:00:30 (540.5): 9:00 is before the arrival, so 9:15 is the earliest.
  const range = quickRange(540.5, 600);
  assert.equal(range.earliest, 555);
  assert.deepEqual(times(quickAnswers(range)), ["10:00", "09:45", "09:30", "09:15"]);
  assert.equal(nudge(555, -15, range), null);
  // Arrived at exactly 9:15:00: 9:15 itself may be chosen.
  assert.equal(quickRange(555, 600).earliest, 555);
  // A fraction just past a quarter hour.
  assert.equal(quickRange(555.01, 600).earliest, 570);
});

test("a window that starts at midnight", () => {
  // Arrival: everything from midnight to now. At 1:05 AM the earliest is 00:00.
  const range = quickRange(0, 65);
  assert.deepEqual(range, { earliest: 0, latest: 60 });
  const answers = quickAnswers(range);
  assert.deepEqual(labels(answers), [
    "Now",
    "15 min ago",
    "30 min ago",
    "45 min ago",
    "1 hour ago",
  ]);
  assert.deepEqual(times(answers), ["01:00", "00:45", "00:30", "00:15", "00:00"]);
  assert.equal(nudge(0, -15, range), null);
  // No answer reaches back into yesterday.
  for (const { minutes } of answers) assert.ok(minutes >= 0);
});

test("now before 00:15", () => {
  for (let now = 0; now < 15; now += 1) {
    const range = quickRange(0, now);
    assert.deepEqual(range, { earliest: 0, latest: 0 });
    assert.equal(nudge(0, -15, range), null);
    assert.equal(nudge(0, 15, range), null);
  }
});

test("arrival 00:00-00:14 leaves only Now = 00:00", () => {
  for (let now = 0; now < 15; now += 1) {
    const answers = quickAnswers(quickRange(0, now));
    assert.deepEqual(labels(answers), ["Now"]);
    assert.deepEqual(times(answers), ["00:00"]);
  }
});

test("a lower bound past the latest quarter hour leaves nothing to choose", () => {
  // Arrived at 2:05 PM; now 2:14 PM: the earliest (2:15) is after the latest (2:00).
  const range = quickRange(14 * 60 + 5, 14 * 60 + 14);
  assert.deepEqual(quickAnswers(range), []);
  assert.equal(canNudge(14 * 60, -15, range), false);
  assert.equal(canNudge(14 * 60, 15, range), false);
});

test("time values and the readout text", () => {
  assert.equal(toTimeValue(0), "00:00");
  assert.equal(toTimeValue(13 * 60 + 45), "13:45");
  assert.equal(fromTimeValue("13:45"), 13 * 60 + 45);
  assert.equal(fromTimeValue(toTimeValue(1425)), 1425);
  assert.equal(clockText(0), "12:00 AM");
  assert.equal(clockText(12 * 60 + 15), "12:15 PM");
  assert.equal(clockText(13 * 60 + 45), "1:45 PM");
  const range = quickRange(0, 14 * 60 + 14);
  assert.equal(agoText(14 * 60, range), "Just now");
  assert.equal(agoText(13 * 60 + 30, range), "30 min ago");
  assert.equal(agoText(12 * 60 + 45, range), "1 hr 15 min ago");
  assert.equal(agoText(12 * 60, range), "2 hr ago");
});

test("centralMinutes reads the Central clock", () => {
  // 2026-11-13 20:14:59 UTC is 2:14 PM CST (UTC-6).
  assert.equal(centralMinutes(new Date("2026-11-13T20:14:59Z")), 14 * 60 + 14);
  // 2026-07-01 05:07 UTC is 00:07 CDT (UTC-5).
  assert.equal(centralMinutes(new Date("2026-07-01T05:07:00Z")), 7);
  // Midnight reads as 0, not 24:00.
  assert.equal(centralMinutes(new Date("2026-11-14T06:00:00Z")), 0);
});
