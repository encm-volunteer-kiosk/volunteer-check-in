// Server replies as the page reads them.
//
// google.script.run leaves out an object field whose value is null on the way from the
// server to the page: inside the list reply a checked-out volunteer arrives with no
// openShiftArrival, openShiftId, openUntil or checkOutMilestones, and the no-milestone step
// {fromMinutes: 0, id: null} arrives as {fromMinutes: 0}. The page reads every reply through
// the functions below, which give each field the server may send as null its null back when
// it is missing, so every reader sees the shape the server sent. They change nothing else:
// a field of the wrong type is left as it came, for the checks that read it to refuse.
//
// Plain TypeScript only (no enums, namespaces or parameter properties): the tests import
// this file in Node, which strips the types without a loader.

import type { CheckInResult, CheckOutResult, VolunteerSummary } from "./api";
import type { MilestoneStep, Volunteer } from "./data";

const orNull = (v: unknown) => (v === undefined ? null : v);

/** Milestone steps with a missing id read as null (no milestone). Anything else as it came. */
export function stepsWithNulls(steps: unknown): MilestoneStep[] | null {
  if (!Array.isArray(steps)) return orNull(steps) as MilestoneStep[] | null;
  return steps.map((s) =>
    typeof s === "object" && s !== null && !("id" in s) ? { ...s, id: null } : s,
  );
}

/**
 * A volunteer of the list reply with its missing nullable fields read as null. missedSignOut
 * is never null, so a missing one stays missing: the server is older than instant results.
 */
export function summaryFromServer(raw: unknown): VolunteerSummary {
  const r = raw as Record<string, unknown>;
  return {
    ...r,
    openShiftArrival: orNull(r.openShiftArrival),
    openShiftId: orNull(r.openShiftId),
    openUntil: orNull(r.openUntil),
    checkOutMilestones: stepsWithNulls(r.checkOutMilestones),
  } as VolunteerSummary;
}

/** A check-in reply's result. A server older than the notice sends no missedSignOut. */
export function checkInFromServer(reply: Record<string, unknown>): CheckInResult {
  return {
    id: reply.id,
    shiftId: reply.shiftId,
    arrivedAt: orNull(reply.arrivedAt),
    tappedAt: orNull(reply.tappedAt),
    missedSignOut: reply.missedSignOut === true,
    replayed: reply.replayed === true,
  } as CheckInResult;
}

/** A check-out reply's result. */
export function checkOutFromServer(reply: Record<string, unknown>): CheckOutResult {
  return {
    id: reply.id,
    signedOutAt: orNull(reply.signedOutAt),
    tappedAt: orNull(reply.tappedAt),
    minutes: orNull(reply.minutes),
    milestone: orNull(reply.milestone),
    replayed: reply.replayed === true,
  } as CheckOutResult;
}

/**
 * The list reply's hoursRequests: true only when the server sent true. A server older than
 * hours requests sends none, and the button stays hidden.
 */
export const hoursRequestsOf = (reply: Record<string, unknown>): boolean =>
  reply.hoursRequests === true;

/** A server volunteer in the shape the screens use. */
export function toVolunteer(summary: VolunteerSummary): Volunteer {
  return {
    id: summary.id,
    firstName: summary.firstName,
    lastName: summary.lastName,
    currentCheckIn: summary.openShiftArrival,
    checkedIn: summary.checkedIn,
    active: true,
    expectedToday: false,
    completedShiftCount: 0,
    totalVolunteerMinutes: 0,
    needsPhoneCheck: summary.needsPhoneCheck,
    missedSignOut: typeof summary.missedSignOut === "boolean" ? summary.missedSignOut : undefined,
    openShiftId: summary.openShiftId,
    openUntil: summary.openUntil,
    checkOutMilestones: summary.checkOutMilestones,
  };
}
