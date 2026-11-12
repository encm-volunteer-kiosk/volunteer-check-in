// The kiosk's data layer. Served by the Apps Script web app, the page talks to the server
// through google.script.run (gasApi). Anywhere else, such as `pnpm dev`, it uses the
// browser-only prototype store in data.ts (localApi), with invented volunteers.
//
// Every call resolves to its result or to a Refusal: a fixed code and a message to show
// the volunteer. A promise rejects only on a real failure.

import {
  checkIn,
  checkOut,
  isToday,
  kioskStore,
  type KioskData,
  type Milestone,
  type Volunteer,
} from "./data";

export type Refusal = { refusal: string; message: string };

export type VolunteerSummary = {
  id: string;
  firstName: string;
  lastName: string;
  openShiftArrival: string | null;
  needsPhoneCheck: boolean;
};

export type CheckInResult = { shiftId: string; arrivedAt: string; tappedAt: string };
export type CheckOutResult = { signedOutAt: string; minutes: number; milestone: Milestone | null };

export interface KioskApi {
  checkAccess(code: string): Promise<true | Refusal>;
  listVolunteers(code: string): Promise<VolunteerSummary[] | Refusal>;
  checkIn(
    code: string,
    id: string,
    arrivalIso: string,
    phoneLast4: string | null,
  ): Promise<CheckInResult | Refusal>;
  checkOut(code: string, id: string, phoneLast4: string | null): Promise<CheckOutResult | Refusal>;
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
    return reply.ok ? (reply.volunteers as VolunteerSummary[]) : refusalOf(reply);
  },
  async checkIn(code, id, arrivalIso, phoneLast4) {
    const reply = await run((r) => r.apiCheckIn(code, id, arrivalIso, phoneLast4));
    if (!reply.ok) return refusalOf(reply);
    const { shiftId, arrivedAt, tappedAt } = reply;
    return { shiftId, arrivedAt, tappedAt } as CheckInResult;
  },
  async checkOut(code, id, phoneLast4) {
    const reply = await run((r) => r.apiCheckOut(code, id, phoneLast4));
    if (!reply.ok) return refusalOf(reply);
    const { signedOutAt, minutes, milestone } = reply;
    return { signedOutAt, minutes, milestone } as CheckOutResult;
  },
};

// ---------------------------------------------------------------------------------------
// Local prototype

const refusalMessages: Record<string, string> = {
  ACCESS: "This kiosk needs to be set up. Please ask a board member.",
  NOT_FOUND: "We couldn't find your profile. Please see a board member.",
  ALREADY_IN: "You're already checked in today.",
  NOT_IN: "You're not checked in today.",
  ARRIVAL_FUTURE: "Your arrival time can't be in the future. Please choose an earlier time.",
  ARRIVAL_OTHER_DAY: "Please choose a time from today.",
  PHONE_NEEDED: "Please enter the last four digits of your phone number.",
  PHONE_WRONG: "Those digits don't match our records. Please try again or see a board member.",
  PHONE_MISSING: "We need to confirm who you are. Please see a board member.",
};

const refuse = (code: string): Refusal => ({ refusal: code, message: refusalMessages[code] });

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

const nameKey = (v: Volunteer) => `${v.firstName} ${v.lastName}`.trim().toLowerCase();

function sharesName(data: KioskData, volunteer: Volunteer) {
  return data.volunteers.some(
    (v) => v.active && v.id !== volunteer.id && nameKey(v) === nameKey(volunteer),
  );
}

function localCodeOk(code: string) {
  return code.toLowerCase().replace(/[^a-z]/g, "").length >= localMinCodeLetters;
}

function localPhoneRefusal(data: KioskData, volunteer: Volunteer, digits: string | null) {
  if (!sharesName(data, volunteer)) return null;
  const onFile = localPhoneLast4[volunteer.id];
  if (!onFile) return "PHONE_MISSING";
  const given = (digits ?? "").replace(/\D/g, "");
  if (!given) return "PHONE_NEEDED";
  return given === onFile ? null : "PHONE_WRONG";
}

/** The volunteer and the refusal, if any, common to check-in and check-out. */
function localLookup(code: string, id: string, digits: string | null) {
  if (!localCodeOk(code)) return { refusal: refuse("ACCESS") };
  const data = loadLocal();
  const volunteer = data.volunteers.find((v) => v.id === id && v.active);
  if (!volunteer) return { refusal: refuse("NOT_FOUND") };
  const phone = localPhoneRefusal(data, volunteer, digits);
  if (phone) return { refusal: refuse(phone) };
  return { data, volunteer };
}

export const localApi: KioskApi & { reset(): void } = {
  async checkAccess(code) {
    return localCodeOk(code) ? true : refuse("ACCESS");
  },
  async listVolunteers(code) {
    if (!localCodeOk(code)) return refuse("ACCESS");
    const data = loadLocal();
    return data.volunteers
      .filter((v) => v.active)
      .map((v) => ({
        id: v.id,
        firstName: v.firstName,
        lastName: v.lastName,
        openShiftArrival: v.currentCheckIn && isToday(v.currentCheckIn) ? v.currentCheckIn : null,
        needsPhoneCheck: sharesName(data, v),
      }));
  },
  async checkIn(code, id, arrivalIso, phoneLast4) {
    const found = localLookup(code, id, phoneLast4);
    if (found.refusal) return found.refusal;
    const { data, volunteer } = found;
    if (volunteer.currentCheckIn && isToday(volunteer.currentCheckIn)) return refuse("ALREADY_IN");
    const now = Date.now();
    const asked = Date.parse(arrivalIso);
    if (!Number.isFinite(asked)) return refuse("ARRIVAL_OTHER_DAY");
    if (asked > now + localArrivalGraceMs) return refuse("ARRIVAL_FUTURE");
    const arrivedAt = new Date(Math.min(asked, now)).toISOString();
    if (!isToday(arrivedAt)) return refuse("ARRIVAL_OTHER_DAY");
    const next = checkIn(data, id, arrivedAt);
    await kioskStore.save(next);
    localData = next;
    return {
      shiftId: next.events[next.events.length - 1].shiftId,
      arrivedAt,
      tappedAt: new Date(now).toISOString(),
    };
  },
  async checkOut(code, id, phoneLast4) {
    const found = localLookup(code, id, phoneLast4);
    if (found.refusal) return found.refusal;
    const { data, volunteer } = found;
    if (!volunteer.currentCheckIn || !isToday(volunteer.currentCheckIn)) return refuse("NOT_IN");
    const signedOutAt = new Date().toISOString();
    const completed = checkOut(data, id, signedOutAt);
    await kioskStore.save(completed.data);
    localData = completed.data;
    return { signedOutAt, minutes: completed.duration, milestone: completed.earned };
  },
  reset() {
    localData = withTwin(kioskStore.reset());
  },
};

export const usingLocalApi = typeof google === "undefined" || !google.script;

export const api: KioskApi = usingLocalApi ? localApi : gasApi;
