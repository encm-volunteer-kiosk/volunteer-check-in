// The kiosk's data layer. Served by the Apps Script web app, the page talks to the server
// through google.script.run (gasApi). Anywhere else, such as `pnpm dev`, it uses the
// browser-only prototype store in data.ts (localApi), with invented volunteers.
//
// Every call resolves to its result or to a Refusal: a fixed code and a message to show
// the volunteer. A promise rejects only on a real failure.

import {
  checkIn,
  checkOut,
  isCheckedInAt,
  isToday,
  kioskStore,
  missedSignOut,
  type KioskData,
  type Milestone,
  type Volunteer,
} from "./data";
import { DEFAULT_LONG_SHIFT_HOURS, longShiftHoursOf } from "./cardTime";
import { nameKey } from "./sameName";

export type Refusal = { refusal: string; message: string };

export type VolunteerSummary = {
  id: string;
  firstName: string;
  lastName: string;
  // An open row the tablet can still check out: less than "Auto clock-out after hours" since
  // its check-in tap, past midnight too, or dated today with no readable time (then
  // openShiftArrival is null). The server's own test.
  checkedIn: boolean;
  // That row's stated arrival. After midnight it can be on yesterday's date.
  openShiftArrival: string | null;
  needsPhoneCheck: boolean;
};

// id is the volunteer the server acted on. In a same-name group the phone digits pick the
// member, so it can differ from the entry the volunteer tapped. missedSignOut is true when
// the volunteer's last shift ended without their own Check Out (still open, or closed by the
// auto clock-out or staff): the page then shows the missed check-out notice.
export type CheckInResult = {
  id: string;
  shiftId: string;
  arrivedAt: string;
  tappedAt: string;
  missedSignOut: boolean;
};
// signedOutAt is the stated check-out (the chosen time, or the tap when none was chosen);
// tappedAt is the server's clock at the tap.
export type CheckOutResult = {
  id: string;
  signedOutAt: string;
  tappedAt: string;
  minutes: number;
  milestone: Milestone | null;
};

// The list reply: the volunteers, and the sheet's "Long shift flag hours", past which a
// checked-in card turns amber (8 when the server sends none).
export type VolunteerList = { volunteers: VolunteerSummary[]; longShiftHours: number };

export interface KioskApi {
  checkAccess(code: string): Promise<true | Refusal>;
  listVolunteers(code: string): Promise<VolunteerList | Refusal>;
  // arrivalIso is the time chosen in the arrival picker, or null for now: the server then
  // uses its own clock, so the tablet's clock never reaches the Log.
  checkIn(
    code: string,
    id: string,
    arrivalIso: string | null,
    phoneLast4: string | null,
  ): Promise<CheckInResult | Refusal>;
  // checkOutIso is the time chosen in the check-out picker, or null for now, as for arrival.
  // It is the last argument, so the server still takes a call from an older page without it.
  checkOut(
    code: string,
    id: string,
    phoneLast4: string | null,
    checkOutIso: string | null,
  ): Promise<CheckOutResult | Refusal>;
}

export function isRefusal(value: unknown): value is Refusal {
  return typeof value === "object" && value !== null && "refusal" in value;
}

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
  };
}

// ---------------------------------------------------------------------------------------
// Apps Script

type Reply = { ok: true; [key: string]: unknown } | { ok: false; refusal: string; message: string };

function run(call: (runner: GoogleScriptRunner) => void): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const runner = google!
      .script!.run.withSuccessHandler((result) => {
        const reply = result as Reply | null;
        if (reply?.ok === true || (reply?.ok === false && typeof reply.refusal === "string")) {
          resolve(reply);
        } else {
          reject(new Error("Unexpected reply from the server"));
        }
      })
      .withFailureHandler(reject);
    call(runner);
  });
}

function refusalOf(reply: { refusal: string; message: string }): Refusal {
  return { refusal: reply.refusal, message: reply.message };
}

export const gasApi: KioskApi = {
  async checkAccess(code) {
    const reply = await run((r) => r.apiCheckAccess(code));
    return reply.ok ? true : refusalOf(reply);
  },
  async listVolunteers(code) {
    const reply = await run((r) => r.apiListVolunteers(code));
    if (!reply.ok) return refusalOf(reply);
    return {
      volunteers: reply.volunteers as VolunteerSummary[],
      longShiftHours: longShiftHoursOf(reply),
    };
  },
  async checkIn(code, id, arrivalIso, phoneLast4) {
    const reply = await run((r) => r.apiCheckIn(code, id, arrivalIso, phoneLast4));
    if (!reply.ok) return refusalOf(reply);
    const { id: actedOn, shiftId, arrivedAt, tappedAt } = reply;
    // A server older than the notice sends no missedSignOut: no notice.
    const missed = reply.missedSignOut === true;
    return { id: actedOn, shiftId, arrivedAt, tappedAt, missedSignOut: missed } as CheckInResult;
  },
  async checkOut(code, id, phoneLast4, checkOutIso) {
    const reply = await run((r) => r.apiCheckOut(code, id, phoneLast4, checkOutIso));
    if (!reply.ok) return refusalOf(reply);
    const { id: actedOn, signedOutAt, tappedAt, minutes, milestone } = reply;
    return { id: actedOn, signedOutAt, tappedAt, minutes, milestone } as CheckOutResult;
  },
};

// ---------------------------------------------------------------------------------------
// Local prototype

const refusalMessages: Record<string, string> = {
  ACCESS: "This kiosk needs to be set up. Please ask a board member.",
  NOT_FOUND: "We couldn't find your profile. Please see a board member.",
  ALREADY_IN: "You're already checked in.",
  NOT_IN: "You're not checked in.",
  ARRIVAL_FUTURE: "Your arrival time can't be in the future. Please choose an earlier time.",
  ARRIVAL_OTHER_DAY: "Please choose a time from today.",
  CHECKOUT_FUTURE: "Your check-out time can't be in the future. Please choose an earlier time.",
  CHECKOUT_OTHER_DAY: "Please choose a time from today.",
  CHECKOUT_BEFORE_ARRIVAL:
    "Your check-out time can't be before your arrival time. Please choose a later time.",
  PHONE_NEEDED: "Please enter the last four digits of your phone number.",
  PHONE_WRONG: "Those digits don't match our records. Please try again or see a board member.",
  PHONE_MISSING: "We need to confirm who you are. Please see a board member.",
};

const refuse = (code: string): Refusal => ({ refusal: code, message: refusalMessages[code] });

/** The server's message for a refusal code, for the page's own checks before a call. */
export const refusalMessage = (code: string) => refusalMessages[code];

// An invented second Jordan Rivera, so the phone step can be tried locally. The two
// Jordans' invented last four digits are below.
const localTwin: Volunteer = {
  id: "vol-25",
  firstName: "Jordan",
  lastName: "Rivera",
  active: true,
  expectedToday: false,
  currentCheckIn: null,
  completedShiftCount: 0,
  totalVolunteerMinutes: 0,
};
const localPhoneLast4: Record<string, string> = { "vol-12": "0142", "vol-25": "0187" };

const localMinCodeLetters = 16;
const localArrivalGraceMs = 5 * 60_000;

let localData: KioskData | null = null;

function withTwin(data: KioskData): KioskData {
  if (data.volunteers.some((v) => v.id === localTwin.id)) return data;
  return { ...data, volunteers: [...data.volunteers, localTwin] };
}

function loadLocal(): KioskData {
  localData ??= withTwin(kioskStore.load());
  return localData;
}

function sharesName(data: KioskData, volunteer: Volunteer) {
  return data.volunteers.some(
    (v) => v.active && v.id !== volunteer.id && nameKey(v) === nameKey(volunteer),
  );
}

// As the server's rule for a stated time: none chosen is now; up to the grace ahead of now
// is taken as now; later is the future; unreadable is another day. An arrival must also be
// today; a check-out, measured from a readable arrival, may be on any date.
function localStatedTime(
  iso: string | null,
  now: number,
  todayOnly: boolean,
): number | "FUTURE" | "OTHER_DAY" {
  if (iso === null) return now;
  const asked = Date.parse(iso);
  if (!Number.isFinite(asked)) return "OTHER_DAY";
  if (asked > now + localArrivalGraceMs) return "FUTURE";
  const ms = Math.min(asked, now);
  return !todayOnly || isToday(new Date(ms).toISOString()) ? ms : "OTHER_DAY";
}

function localCodeOk(code: string) {
  return code.toLowerCase().replace(/[^a-z]/g, "").length >= localMinCodeLetters;
}

// As on the server: in a same-name group the digits pick the member, so a volunteer who
// tapped another member's entry is still the one checked in or out.
function localResolve(
  data: KioskData,
  tapped: Volunteer,
  digits: string | null,
): Volunteer | string {
  if (!sharesName(data, tapped)) return tapped;
  if (!localPhoneLast4[tapped.id]) return "PHONE_MISSING";
  const given = (digits ?? "").replace(/\D/g, "");
  if (!given) return "PHONE_NEEDED";
  const matches = data.volunteers.filter(
    (v) => v.active && nameKey(v) === nameKey(tapped) && localPhoneLast4[v.id] === given,
  );
  return matches.length === 1 ? matches[0] : "PHONE_WRONG";
}

// As on the server, a check-out with no digits for a shared name acts on the tapped member
// when that member is the only one of the name checked in. Otherwise: nobody of the name in
// is NOT_IN, and anyone else in asks for the digits (PHONE_MISSING when the tapped member
// has none on record). With digits, or off a group, it is localResolve.
function localResolveCheckOut(
  data: KioskData,
  tapped: Volunteer,
  digits: string | null,
  now: number,
): Volunteer | string {
  if (!sharesName(data, tapped) || (digits ?? "").replace(/\D/g, "")) {
    return localResolve(data, tapped, digits);
  }
  const checkedIn = data.volunteers.filter(
    (v) => v.active && nameKey(v) === nameKey(tapped) && isCheckedInAt(v, now),
  );
  if (checkedIn.length === 0) return "NOT_IN";
  if (checkedIn.length === 1 && checkedIn[0].id === tapped.id) return tapped;
  return localPhoneLast4[tapped.id] ? "PHONE_NEEDED" : "PHONE_MISSING";
}

/** The volunteer acted on, or the refusal, common to check-in and check-out. */
function localLookup(code: string, id: string, digits: string | null, checkout = false) {
  if (!localCodeOk(code)) return { refusal: refuse("ACCESS") };
  const data = loadLocal();
  const tapped = data.volunteers.find((v) => v.id === id && v.active);
  if (!tapped) return { refusal: refuse("NOT_FOUND") };
  const volunteer = checkout
    ? localResolveCheckOut(data, tapped, digits, Date.now())
    : localResolve(data, tapped, digits);
  if (typeof volunteer === "string") return { refusal: refuse(volunteer) };
  return { data, volunteer };
}

export const localApi: KioskApi & { reset(): void } = {
  async checkAccess(code) {
    return localCodeOk(code) ? true : refuse("ACCESS");
  },
  async listVolunteers(code) {
    if (!localCodeOk(code)) return refuse("ACCESS");
    const data = loadLocal();
    const now = Date.now();
    const volunteers = data.volunteers
      .filter((v) => v.active)
      .map((v) => {
        const checkedIn = isCheckedInAt(v, now);
        return {
          id: v.id,
          firstName: v.firstName,
          lastName: v.lastName,
          checkedIn,
          openShiftArrival: checkedIn ? v.currentCheckIn : null,
          needsPhoneCheck: sharesName(data, v),
        };
      });
    return { volunteers, longShiftHours: DEFAULT_LONG_SHIFT_HOURS };
  },
  async checkIn(code, id, arrivalIso, phoneLast4) {
    const found = localLookup(code, id, phoneLast4);
    if (found.refusal) return found.refusal;
    const { data, volunteer } = found;
    const now = Date.now();
    if (isCheckedInAt(volunteer, now)) return refuse("ALREADY_IN");
    const arrived = localStatedTime(arrivalIso, now, true);
    if (typeof arrived === "string") return refuse(`ARRIVAL_${arrived}`);
    const arrivedAt = new Date(arrived).toISOString();
    const tappedAt = new Date(now).toISOString();
    // Read before the new shift is written, as on the server.
    const missed = missedSignOut(data, volunteer.id);
    const next = checkIn(data, volunteer.id, arrivedAt, tappedAt);
    await kioskStore.save(next);
    localData = next;
    return {
      id: volunteer.id,
      shiftId: next.events[next.events.length - 1].shiftId,
      arrivedAt,
      tappedAt,
      missedSignOut: missed,
    };
  },
  async checkOut(code, id, phoneLast4, checkOutIso) {
    const found = localLookup(code, id, phoneLast4, true);
    if (found.refusal) return found.refusal;
    const { data, volunteer } = found;
    const now = Date.now();
    if (!volunteer.currentCheckIn || !isCheckedInAt(volunteer, now)) return refuse("NOT_IN");
    const out = localStatedTime(checkOutIso, now, false);
    if (typeof out === "string") return refuse(`CHECKOUT_${out}`);
    // Equal to the arrival is accepted.
    if (out < Date.parse(volunteer.currentCheckIn)) return refuse("CHECKOUT_BEFORE_ARRIVAL");
    const signedOutAt = new Date(out).toISOString();
    const completed = checkOut(data, volunteer.id, signedOutAt, now);
    await kioskStore.save(completed.data);
    localData = completed.data;
    return {
      id: volunteer.id,
      signedOutAt,
      tappedAt: new Date(now).toISOString(),
      minutes: completed.duration,
      milestone: completed.earned,
    };
  },
  reset() {
    localData = withTwin(kioskStore.reset());
  },
};

export const usingLocalApi = typeof google === "undefined" || !google.script;

export const api: KioskApi = usingLocalApi ? localApi : gasApi;
