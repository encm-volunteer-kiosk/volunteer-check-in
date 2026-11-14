// The check-in time on a checked-in volunteer's card. The card shows the stated arrival
// ("in 2:55 PM"). Once the volunteer has been in for more than the sheet's "Long shift flag
// hours", the whole card turns amber and shows the time in instead ("10h 10m in"), so a
// forgotten check-out stands out. A checked-in volunteer with no readable time shows
// "no time" on an amber card: staff should look at that row.
//
// Worked out on the tablet from the list it holds and its own clock; no server call.
//
// Plain TypeScript only (no enums, namespaces or parameter properties): the tests import
// this file in Node, which strips the types without a loader.

import { centralDay } from "./listStore.ts";

// The sheet's "Long shift flag hours" when the list reply carries none (a server older than
// this page) or a bad one.
export const DEFAULT_LONG_SHIFT_HOURS = 8;

const TZ = "America/Chicago";

/** A Central clock time, as the page's other clock times. */
const clockTime = (ms: number) =>
  new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" }).format(
    new Date(ms),
  );

const timeIn = (minutes: number) =>
  minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;

/**
 * The card's time text, whether the card is amber, and the words a screen reader adds to the
 * card's label. arrival is the stated arrival (null when the open row's time can't be read).
 *
 * Minutes in are whole minutes from the arrival to nowMs, floored, never below 0. The card is
 * amber when they are more than the threshold in minutes, never at it, as the long-shift
 * flag counts. The threshold's minutes are rounded to a thousandth, so 8.2 hours is 492
 * minutes and not the 491.99… a float multiplication gives.
 *
 * An arrival on an earlier Central date than nowMs (an evening shift past midnight) shows the
 * time in, since a bare clock time would read as today's.
 */
export function cardTime(
  arrival: string | null,
  nowMs: number,
  longShiftHours: number,
): { text: string; late: boolean; label: string } {
  const arrivedMs = arrival === null ? Number.NaN : Date.parse(arrival);
  if (!Number.isFinite(arrivedMs)) {
    return { text: "no time", late: true, label: "check-in time not recorded" };
  }
  const minutes = Math.max(0, Math.floor((nowMs - arrivedMs) / 60_000));
  const thresholdMinutes = Math.round(longShiftHours * 60 * 1000) / 1000;
  const late = minutes > thresholdMinutes;
  const earlierDay = centralDay(arrivedMs) < centralDay(nowMs);
  const clock = clockTime(arrivedMs);
  return {
    text: late || earlierDay ? `${timeIn(minutes)} in` : `in ${clock}`,
    late,
    label: `checked in ${earlierDay ? "yesterday " : ""}at ${clock}`,
  };
}

/** The list reply's "Long shift flag hours": a finite number above 0, else 8. */
export function longShiftHoursOf(reply: { [key: string]: unknown }): number {
  const hours = reply.longShiftHours;
  return typeof hours === "number" && Number.isFinite(hours) && hours > 0
    ? hours
    : DEFAULT_LONG_SHIFT_HOURS;
}
