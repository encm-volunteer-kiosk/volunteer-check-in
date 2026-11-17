// The page's record of its own server calls: when the server last answered, when a call last
// ended without an answer, and when each call still waiting started. Instant taps read it
// (savesGoingThrough in saveQueue.ts): a tap is instant only while the server is answering
// this page.
//
// The record bounds every call's wait by itself. A call still unanswered ATTEMPT_MS after it
// started counts as ended without a reply at its start + ATTEMPT_MS, worked out when the
// record is read, so no timer has to fire and no caller has to report anything. A reply that
// comes after that still counts as a reply when it comes.
//
// Plain TypeScript only (no enums, namespaces or parameter properties): the tests import
// this file in Node, which strips the types without a loader.

import { ATTEMPT_MS, type CallRecord } from "./saveQueue.ts";

export type CallLog = {
  // A call starts now; the number names it for its end.
  start(): number;
  // The server answered it: a result or a refusal, BUSY included.
  replied(call: number): void;
  // It ended without an answer: a failure handler, or a reply the page couldn't read.
  failed(call: number): void;
  // The record as of now.
  read(): CallRecord;
};

/** An empty call record, with the page's clock. */
export function callLog(now: () => number): CallLog {
  const waiting = new Map<number, number>();
  let next = 0;
  let latestReply: number | null = null;
  let latestEnded: number | null = null;

  const ended = (at: number) => {
    latestEnded = latestEnded === null ? at : Math.max(latestEnded, at);
  };
  // A call unanswered ATTEMPT_MS after its start ended then, without a reply.
  const expire = (at: number) => {
    for (const [call, startedAt] of waiting) {
      if (at - startedAt >= ATTEMPT_MS) {
        ended(startedAt + ATTEMPT_MS);
        waiting.delete(call);
      }
    }
  };
  const settle = (call: number) => {
    const at = now();
    expire(at);
    waiting.delete(call);
    return at;
  };

  return {
    start() {
      next += 1;
      waiting.set(next, now());
      return next;
    },
    // The latest reply and failure are the latest as they came, so a clock set back is
    // followed by the next answer rather than held at a time in the future.
    replied(call) {
      latestReply = settle(call);
    },
    failed(call) {
      latestEnded = settle(call);
    },
    read() {
      expire(now());
      return { latestReply, latestEnded, waiting: [...waiting.values()] };
    },
  };
}

/** Runs one call under the record: a resolved call is a reply, a rejected one ended without. */
export function recorded<T>(log: CallLog, call: () => Promise<T>): Promise<T> {
  const id = log.start();
  let promise: Promise<T>;
  try {
    promise = call();
  } catch (error) {
    promise = Promise.reject(error);
  }
  return promise.then(
    (value) => {
      log.replied(id);
      return value;
    },
    (error) => {
      log.failed(id);
      throw error;
    },
  );
}
