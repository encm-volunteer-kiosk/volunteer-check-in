// Request my hours: the welcome screen's link, and what its confirm screen says after Send.
// Every place the page decides about a request goes through these functions.
//
// The request starts at the welcome screen's Request my hours link, which opens a name
// search; a tap on a name opens the phone step (a name two volunteers share) or the confirm
// screen. Send only records a request (apiRequestHours, Api.js); an email goes later, sent by
// staff from Email hours or by the hours request job. The request is its own call, outside
// the save queue: it isn't queued or retried offline. Nothing on that path checks anyone in
// or out. The screens never show an email address or say whether the volunteer has one,
// whether they asked before, or whether a person or the job will send it.
//
// Plain TypeScript only (no enums, namespaces or parameter properties): the tests import
// this file in Node, which strips the types without a loader.

import type { Refusal } from "./api";
import { wordText, type Words } from "./words.ts";

/** How long the tablet waits for the server's answer before it says to try again. */
export const HOURS_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Whether the welcome screen shows the Request my hours link: only when the list said
 * requests are on (Settings "Hours requests" is Approve or Auto). The kept list doesn't hold
 * the flag, so after a reload the link stays hidden until a fresh list arrives.
 */
export const showsHoursLink = (hoursRequests: boolean) => hoursRequests === true;

/** The confirm screen's sentence, before Send and while it waits. */
export const hoursConfirmText = "We'll email your hours to the address we have on file.";

/**
 * Whether an answer brings the phone step back, with its message: the server wants digits
 * (the name is now shared) or the digits didn't match.
 */
export function hoursPhoneStepAfter(reply: true | Refusal | "failed"): boolean {
  return (
    typeof reply === "object" &&
    (reply.refusal === "PHONE_NEEDED" || reply.refusal === "PHONE_WRONG")
  );
}

/** The confirm screen's state. */
export type HoursRequestState =
  | { kind: "ready" }
  | { kind: "sending" }
  // A line in the sentence's place; again: Send and Go back come back under it, else Done.
  | { kind: "line"; text: string; again: boolean };

export const hoursRequestReady: HoursRequestState = { kind: "ready" };

export const hoursRequestRecordedText = (firstName: string) =>
  `Got it, ${firstName}. Your hours will be emailed to you. If nothing arrives in a few days, please ask a board member.`;
export const hoursRequestsOffText =
  "Emailing hours from the kiosk is turned off right now. Please ask a board member.";
export const hoursRequestFailedText = "That didn't go through. Please try again.";

// Refusals whose own message the screen shows, with Send back.
const shownRefusals = ["PHONE_NEEDED", "PHONE_WRONG", "PHONE_MISSING", "NOT_FOUND"];

/**
 * What a request's answer does. reply is the call's result, or "failed" for a call that
 * failed or timed out. A recorded request and one already open read the same. ACCESS locks
 * the kiosk to the setup screen, as a list's ACCESS does. The page's own lines are given in
 * words (wordText, words.ts); a refusal's message comes in them from the server.
 */
export function afterHoursRequest(
  reply: true | Refusal | "failed",
  firstName: string,
  words?: Words,
): { lock: string } | HoursRequestState {
  if (reply === true)
    return {
      kind: "line",
      text: wordText(hoursRequestRecordedText(firstName), words),
      again: false,
    };
  if (reply === "failed") return { kind: "line", text: hoursRequestFailedText, again: true };
  if (reply.refusal === "ACCESS") return { lock: reply.message };
  if (reply.refusal === "HOURS_REQUESTS_OFF") {
    return { kind: "line", text: wordText(hoursRequestsOffText, words), again: false };
  }
  if (shownRefusals.includes(reply.refusal)) {
    return { kind: "line", text: reply.message, again: true };
  }
  // BUSY, or any refusal the tablet doesn't know.
  return { kind: "line", text: hoursRequestFailedText, again: true };
}

/** The call's result, or "failed" when it rejects or hasn't answered within ms. */
export function settleWithin<T>(call: Promise<T>, ms: number): Promise<T | "failed"> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve("failed"), ms);
    call.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve("failed");
      },
    );
  });
}
