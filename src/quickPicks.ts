// The time picker behind the "Change your arrival time" / "Change your check-out time" link:
// the rules it obeys, kept apart from the component so the tests can run them in Node.
//
// Times are Central minutes since today's midnight. Every value the picker emits is a quarter
// hour from the earliest allowed (the lower bound rounded up to a quarter hour) to the latest
// (now, rounded down to a quarter hour), inclusive, as "HH:mm". The server checks every time
// it is sent as well.
//
// Plain TypeScript only (no enums, namespaces or parameter properties): the tests import
// this file in Node, which strips the types without a loader.

import { centralDay } from "./listStore.ts";

const TZ = "America/Chicago";
const QUARTER = 15;

export type QuickRange = { earliest: number; latest: number };
export type QuickAnswer = { label: string; minutes: number };

// How long ago each quick answer is, counted back from the latest quarter hour.
export const QUICK_ANSWERS: ReadonlyArray<{ label: string; ago: number }> = [
  { label: "Now", ago: 0 },
  { label: "15 min ago", ago: 15 },
  { label: "30 min ago", ago: 30 },
  { label: "45 min ago", ago: 45 },
  { label: "1 hour ago", ago: 60 },
  { label: "2 hours ago", ago: 120 },
];

export function floorQuarter(minutes: number) {
  return Math.floor(minutes / QUARTER) * QUARTER;
}

/** Central minutes since midnight of an instant, whole minutes. */
export function centralMinutes(date: Date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((item) => item.type === type)?.value ?? 0);
  return part("hour") * 60 + part("minute");
}

/**
 * The quarter hours that may be chosen. minMinutes may carry a fraction (an arrival at
 * 9:00:30 is 540.5), and a time before it can't be chosen, so the earliest rounds up.
 * earliest > latest means nothing can be chosen.
 */
export function quickRange(minMinutes: number, nowMinutes: number): QuickRange {
  return {
    earliest: Math.ceil(minMinutes / QUARTER) * QUARTER,
    latest: floorQuarter(nowMinutes),
  };
}

export function inRange(minutes: number, range: QuickRange) {
  return minutes >= range.earliest && minutes <= range.latest;
}

/** The quick answers inside the range; one outside it is left out. */
export function quickAnswers(range: QuickRange): QuickAnswer[] {
  return QUICK_ANSWERS.map(({ label, ago }) => ({ label, minutes: range.latest - ago })).filter(
    (answer) => inRange(answer.minutes, range),
  );
}

/**
 * The time a tapped quick answer sends. The chip printed the time it had at the last redraw,
 * and the clock may have passed a quarter hour since, so the printed time is sent while it is
 * still in the range at the tap. Only when it has left the range (past midnight, say) does
 * the answer count back from the tap's own latest quarter hour. Null when neither fits.
 */
export function pickMinutes(shown: number, ago: number, range: QuickRange) {
  if (inRange(shown, range)) return shown;
  const next = range.latest - ago;
  return inRange(next, range) ? next : null;
}

// The quarter hour a nudge counts from: the shown time moved into the range and onto a
// quarter hour, so a nudge from a stray value still lands on an allowed one.
function nudgeBase(minutes: number, range: QuickRange) {
  return Math.min(Math.max(floorQuarter(minutes), range.earliest), range.latest);
}

/** Whether a nudge of step minutes (+15 or -15) from minutes stays in the range. */
export function canNudge(minutes: number, step: number, range: QuickRange) {
  if (range.earliest > range.latest) return false;
  return inRange(nudgeBase(minutes, range) + step, range);
}

/** The time a nudge gives, or null when it would leave the range. */
export function nudge(minutes: number, step: number, range: QuickRange) {
  if (!canNudge(minutes, step, range)) return null;
  return nudgeBase(minutes, range) + step;
}

export function toTimeValue(minutes: number) {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

export function fromTimeValue(value: string) {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

/** "1:45 PM" */
export function clockText(minutes: number) {
  const hour = Math.floor(minutes / 60);
  return `${hour % 12 || 12}:${String(minutes % 60).padStart(2, "0")} ${hour >= 12 ? "PM" : "AM"}`;
}

/** How far a time is before the latest quarter hour: "Just now", "30 min ago", "1 hr 15 min ago". */
export function agoText(minutes: number, range: QuickRange) {
  const ago = range.latest - minutes;
  if (ago <= 0) return "Just now";
  const hours = Math.floor(ago / 60);
  const rest = ago % 60;
  return [hours ? `${hours} hr` : "", rest ? `${rest} min` : ""].filter(Boolean).join(" ") + " ago";
}

/**
 * A time the picker holds ("HH:mm") and the Central day it was picked on ("YYYY-MM-DD").
 * The time is sent when Check In or Check Out is tapped, which can be after midnight; it
 * stays on the day it was picked.
 */
export type PickedTime = { time: string; day: string };

/** time, picked at the instant now: it keeps now's Central day. */
export function pickTime(time: string, now: Date = new Date()): PickedTime {
  return { time, day: centralDay(now.getTime()) };
}

/** The instant a picked time names: its time on the day it was picked, Central, as ISO. */
export function pickedTimeToIso({ time, day }: PickedTime) {
  const [year, month, date] = day.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const desiredUtc = Date.UTC(year, month - 1, date, hour, minute);
  const zonedParts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const offsetAt = (timestamp: number) => {
    const parts = zonedParts.formatToParts(new Date(timestamp));
    const value = (type: Intl.DateTimeFormatPartTypes) =>
      Number(parts.find((item) => item.type === type)?.value);
    return (
      Date.UTC(
        value("year"),
        value("month") - 1,
        value("day"),
        value("hour"),
        value("minute"),
        value("second"),
      ) -
      Math.floor(timestamp / 1000) * 1000
    );
  };
  let timestamp = desiredUtc - offsetAt(desiredUtc);
  timestamp = desiredUtc - offsetAt(timestamp);
  return new Date(timestamp).toISOString();
}
