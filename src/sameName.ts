// Volunteers who share a first and last name: when the tablet asks for the last four digits
// of their phone number, when a call needs them, and what it sends. Every place the page
// decides about digits goes through these functions.
//
// Check-in always asks a shared name for digits. Check-out asks only when another volunteer
// of the name is checked in: otherwise the server acts on the tapped volunteer when the Log
// shows them as the only one of the name checked in, and answers PHONE_NEEDED when it
// doesn't (a list on the tablet that is out of date). The tablet's list only decides whether
// the digit step shows first; the server decides who is checked out.
//
// Plain TypeScript only (no enums, namespaces or parameter properties): the tests import
// this file in Node, which strips the types without a loader.

import type { Volunteer } from "./data";

// The server's same-name group key: first and last name, trimmed, spaces collapsed, any case.
export const nameKey = (v: Volunteer) =>
  [v.firstName, v.lastName].map((name) => name.trim().replace(/\s+/g, " ").toLowerCase()).join("|");

/** Check-out asks for digits: a shared name, and another of the name is checked in. */
export function checkOutAsksDigits(volunteer: Volunteer, volunteers: Volunteer[]): boolean {
  if (!volunteer.needsPhoneCheck) return false;
  const key = nameKey(volunteer);
  return volunteers.some(
    (v) => v.id !== volunteer.id && Boolean(v.checkedIn) && nameKey(v) === key,
  );
}

/** Whether the screen opened by a tap starts with the digit step. */
export function digitsAskedAtTap(
  checkout: boolean,
  volunteer: Volunteer,
  volunteers: Volunteer[],
): boolean {
  return checkout ? checkOutAsksDigits(volunteer, volunteers) : Boolean(volunteer.needsPhoneCheck);
}

/** A call that asked for digits is held until four are typed. */
export const digitsMissing = (asked: boolean, digits: string) => asked && digits.length !== 4;

/** The digits a call sends: the typed ones when they were asked for, else none. */
export const digitsToSend = (asked: boolean, digits: string) => (asked ? digits : null);

/**
 * What a phone refusal does to the screen, or null for any other refusal. The digit step
 * shows (asked). anotherIn is true only for PHONE_NEEDED to a check-out that sent no digits:
 * the server saw another of the name checked in, and the prompt says so in place of the
 * server's message. On a check-in the same answer means only that the name is now shared.
 */
export function afterPhoneRefusal(
  outcome: string,
  asked: boolean,
  checkout: boolean,
): { asked: true; anotherIn: boolean; showMessage: boolean } | null {
  if (outcome !== "phone-entry" && outcome !== "phone-missing") return null;
  const anotherIn = outcome === "phone-entry" && checkout && !asked;
  return { asked: true, anotherIn, showMessage: !anotherIn };
}
