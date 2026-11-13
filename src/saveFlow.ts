// The tablet's check-in and check-out save, as plain rules the page follows. A save is one
// call to the server. While it runs the page shows only the save screen; only that call's
// reply or its watchdog leaves it. A reply for any other call is late: the page refreshes
// the list and does nothing else, so a slow reply can never land on the next volunteer's
// screen.
//
// Plain TypeScript only (no enums, namespaces or parameter properties): the tests import
// this file in Node, which strips the types without a loader.

export type Screen =
  | "welcome"
  | "confirm"
  | "checkout"
  | "saving"
  | "notice"
  | "success-in"
  | "success-out"
  | "unconfirmed";

export type SaveKind = "in" | "out";
// The screen a refusal or failure returns to.
export type SaveFrom = "confirm" | "checkout";

export type SaveRecord = {
  seq: number;
  kind: SaveKind;
  volunteerId: string;
  firstName: string;
  from: SaveFrom;
  // Date.now() when the save started; the slow line and the watchdog count from it.
  startedAt: number;
};

// The saves the page has started. lastSeq counts up per save, so a reply names its save.
export type SaveFlow = { pending: SaveRecord | null; lastSeq: number };

// What the result screens render from: copied out of the save record before it clears, so
// a volunteer who dropped off the list still gets their screen.
export type SaveOwner = { firstName: string; kind: SaveKind };

// "Still saving" shows from 8 s; at 45 s the save is given up and the page says so.
export const SLOW_LINE_MS = 8_000;
export const WATCHDOG_MS = 45_000;
// Back to the welcome screen after this long untouched. The missed check-out notice is
// shorter, so a volunteer who walked away doesn't hold up the next one, and the screen
// after a save that took too long is shorter again.
export const INACTIVITY_MS = 90_000;
export const NOTICE_INACTIVITY_MS = 60_000;
export const UNCONFIRMED_INACTIVITY_MS = 15_000;

export const noSaves: SaveFlow = { pending: null, lastSeq: 0 };

export function startSave(
  flow: SaveFlow,
  save: Omit<SaveRecord, "seq">,
): { flow: SaveFlow; record: SaveRecord } {
  const record = { ...save, seq: flow.lastSeq + 1 };
  return { flow: { pending: record, lastSeq: record.seq }, record };
}

/**
 * A reply for save seq arrived. When that save is the pending one it is applied: the record
 * clears and the reply's screen uses the returned record. Otherwise the reply is late and
 * nothing is returned; the page only refreshes the list.
 */
export function takeReply(flow: SaveFlow, seq: number): { flow: SaveFlow; save: SaveRecord | null } {
  if (flow.pending?.seq !== seq) return { flow, save: null };
  return { flow: { ...flow, pending: null }, save: flow.pending };
}

/**
 * Save seq's watchdog fired. When that save is still pending it is given up: the record
 * clears and the returned record names who the "taking too long" screen is for. Its reply
 * is late from then on.
 */
export function takeWatchdog(
  flow: SaveFlow,
  seq: number,
): { flow: SaveFlow; save: SaveRecord | null } {
  return takeReply(flow, seq);
}

/** The kiosk locked: a pending save is given up and its reply will be late. */
export function abandonSave(flow: SaveFlow): SaveFlow {
  return flow.pending ? { ...flow, pending: null } : flow;
}

/** The result state for a save's screen: the save's first name and kind, plus the reply's fields. */
export function resultOf<T extends object>(save: SaveRecord, fields: T): SaveOwner & T {
  return { ...fields, firstName: save.firstName, kind: save.kind };
}

export const slowLineShows = (elapsedMs: number) => elapsedMs >= SLOW_LINE_MS;
export const watchdogDue = (elapsedMs: number) => elapsedMs >= WATCHDOG_MS;
/** Milliseconds from elapsedMs until mark, never negative. */
export const msUntil = (mark: number, elapsedMs: number) => Math.max(0, mark - elapsedMs);

/** What a screen renders from: the tapped volunteer, the result state, or the pending save. */
export function rendersFrom(screen: Screen): "selected" | "result" | "save" | "nothing" {
  if (screen === "confirm" || screen === "checkout") return "selected";
  if (screen === "saving") return "save";
  if (screen === "welcome") return "nothing";
  return "result";
}

/**
 * Whether a new list sends the page home because it lost the selected volunteer. Only the
 * confirm and checkout screens show the volunteer from the list. A result screen keeps its
 * own copy, and the save screen waits: when its save ends on confirm or checkout this runs
 * again.
 */
export function goesHomeWhenListLosesVolunteer(
  screen: Screen,
  listState: string,
  selectedId: string | null,
  listed: boolean,
): boolean {
  return rendersFrom(screen) === "selected" && listState === "ready" && !!selectedId && !listed;
}

/** How long a screen waits untouched before going home, or null when it never does. */
export function inactivityMs(screen: Screen): number | null {
  if (screen === "welcome" || screen === "saving") return null;
  if (screen === "notice") return NOTICE_INACTIVITY_MS;
  if (screen === "unconfirmed") return UNCONFIRMED_INACTIVITY_MS;
  return INACTIVITY_MS;
}
