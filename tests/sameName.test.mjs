// Tests for the tablet's same-name rules (src/sameName.ts, imported as it is; Node strips its
// types): when the digit step shows, what a call needs and sends, and what a phone refusal
// does to the screen. A source check of src/App.tsx ties every place the page decides about
// digits to these functions.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  afterPhoneRefusal,
  checkOutAsksDigits,
  digitsAskedAtTap,
  digitsMissing,
  digitsToSend,
  nameKey,
} from "../src/sameName.ts";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");

const volunteer = (id, firstName, lastName, extra = {}) => ({
  id,
  firstName,
  lastName,
  currentCheckIn: null,
  checkedIn: false,
  active: true,
  expectedToday: false,
  completedShiftCount: 0,
  totalVolunteerMinutes: 0,
  needsPhoneCheck: false,
  ...extra,
});

const ARRIVAL = "2026-11-13T20:55:00.000Z";
const checkedIn = { checkedIn: true, currentCheckIn: ARRIVAL };
const shared = { needsPhoneCheck: true };

// Two Jordan Riveras and an unrelated volunteer, in each combination of who is checked in.
function pair(firstIn, secondIn) {
  const first = volunteer("h-j1", "Jordan", "Rivera", { ...shared, ...(firstIn ? checkedIn : {}) });
  const second = volunteer("h-j2", "Jordan", "Rivera", {
    ...shared,
    ...(secondIn ? checkedIn : {}),
  });
  const other = volunteer("h-sam", "Sam", "Okafor", checkedIn);
  return { first, second, list: [first, second, other] };
}

test("nameKey groups names by first and last name, any case, spaces trimmed and collapsed", () => {
  const plain = volunteer("a", "Jordan", "Rivera");
  assert.equal(nameKey(volunteer("b", " jordan ", "RIVERA")), nameKey(plain));
  assert.equal(
    nameKey(volunteer("c", "Mary  Ann", "Lee")),
    nameKey(volunteer("d", "Mary Ann", "Lee")),
  );
  // First and last name stay apart: "Mary Ann" + "Lee" is not "Mary" + "Ann Lee".
  assert.notEqual(
    nameKey(volunteer("e", "Mary Ann", "Lee")),
    nameKey(volunteer("f", "Mary", "Ann Lee")),
  );
});

test("check-out asks for digits only when another of the name is checked in", () => {
  // Off a group: never, even with others checked in.
  const sam = volunteer("h-sam", "Sam", "Okafor", checkedIn);
  assert.equal(checkOutAsksDigits(sam, [sam, volunteer("h-x", "Sam", "Okafor", checkedIn)]), false);

  // In a group: only the tapped member in, no.
  let { first, list } = pair(true, false);
  assert.equal(checkOutAsksDigits(first, list), false);
  // Another member in, yes.
  ({ first, list } = pair(true, true));
  assert.equal(checkOutAsksDigits(first, list), true);
  // The other member in, the tapped one not: yes.
  ({ first, list } = pair(false, true));
  assert.equal(checkOutAsksDigits(first, list), true);
  // Nobody of the name in: no.
  ({ first, list } = pair(false, false));
  assert.equal(checkOutAsksDigits(first, list), false);

  // Names match ignoring case and extra spaces.
  const tapped = volunteer("h-j1", "Jordan", "Rivera", { ...shared, ...checkedIn });
  const spaced = volunteer("h-j2", "  JORDAN ", "rivera  ", { ...shared, ...checkedIn });
  assert.equal(checkOutAsksDigits(tapped, [tapped, spaced]), true);
  // Another name checked in doesn't count.
  const jordanEllis = volunteer("h-je", "Jordan", "Ellis", { ...shared, ...checkedIn });
  assert.equal(checkOutAsksDigits(tapped, [tapped, jordanEllis]), false);
});

test("the digit step at the tap: check-out by who is in, check-in always for a shared name", () => {
  let { first, list } = pair(true, false);
  assert.equal(digitsAskedAtTap(true, first, list), false, "check-out, the other not in");
  ({ first, list } = pair(true, true));
  assert.equal(digitsAskedAtTap(true, first, list), true, "check-out, the other in");
  ({ first, list } = pair(false, false));
  assert.equal(digitsAskedAtTap(false, first, list), true, "check-in, nobody of the name in");
  ({ first, list } = pair(false, true));
  assert.equal(digitsAskedAtTap(false, first, list), true, "check-in, the other in");

  const sam = volunteer("h-sam", "Sam", "Okafor");
  const samIn = volunteer("h-sam", "Sam", "Okafor", checkedIn);
  assert.equal(digitsAskedAtTap(false, sam, [sam]), false, "check-in off a group");
  assert.equal(digitsAskedAtTap(true, samIn, [samIn]), false, "check-out off a group");
});

test("digits are missing only when they were asked for and aren't four long; sent only when asked", () => {
  assert.equal(
    digitsMissing(false, ""),
    false,
    "Check Out is enabled with no digits when none were asked",
  );
  assert.equal(digitsMissing(true, ""), true);
  assert.equal(digitsMissing(true, "123"), true);
  assert.equal(digitsMissing(true, "1234"), false);
  assert.equal(digitsToSend(false, "1234"), null);
  assert.equal(digitsToSend(false, ""), null);
  assert.equal(digitsToSend(true, "1234"), "1234");
});

test("a phone refusal opens the digit step; only a check-out sent without digits says another is in", () => {
  // PHONE_NEEDED to a check-out that sent no digits: another of the name is in.
  assert.deepEqual(afterPhoneRefusal("phone-entry", false, true), {
    asked: true,
    anotherIn: true,
    showMessage: false,
  });
  // The same answer to a check-in says only that the name is now shared.
  assert.deepEqual(afterPhoneRefusal("phone-entry", false, false), {
    asked: true,
    anotherIn: false,
    showMessage: true,
  });
  // Digits were sent (PHONE_WRONG), either screen.
  for (const checkout of [true, false]) {
    assert.deepEqual(afterPhoneRefusal("phone-entry", true, checkout), {
      asked: true,
      anotherIn: false,
      showMessage: true,
    });
  }
  // No usable phone: the phone-missing path, its message shown.
  for (const asked of [true, false]) {
    for (const checkout of [true, false]) {
      assert.deepEqual(afterPhoneRefusal("phone-missing", asked, checkout), {
        asked: true,
        anotherIn: false,
        showMessage: true,
      });
    }
  }
  // Any other refusal is not a phone refusal.
  for (const outcome of ["message", "status", "lock"]) {
    assert.equal(afterPhoneRefusal(outcome, false, true), null, outcome);
  }
});

// ---------------------------------------------------------------------------
// App.tsx goes through these functions at every site

const app = read("src/App.tsx");

/** The source from `start` up to the first `end` after it. */
function slice(source, start, end) {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `${start} not found`);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `end of ${start} not found`);
  return source.slice(from, to);
}

const count = (source, text) => source.split(text).length - 1;

test("App.tsx: Confirmation and App each check digitsMissing(digitsAsked, phoneDigits)", () => {
  const confirmation = slice(app, "function Confirmation(", "\nfunction ");
  const appBody = app.slice(app.indexOf("export default function App()"));
  assert.ok(confirmation.includes("digitsMissing(digitsAsked, phoneDigits)"), "Confirmation");
  assert.ok(appBody.includes("digitsMissing(digitsAsked, phoneDigits)"), "App");
  // No local copy shadows the shared function.
  assert.doesNotMatch(app, /const digitsMissing\b/);
});

test("App.tsx: both calls send digitsToSend(digitsAsked, phoneDigits)", () => {
  assert.equal(count(app, "digitsToSend(digitsAsked, phoneDigits)"), 2);
});

test("App.tsx: select() decides the digit step with digitsAskedAtTap", () => {
  const select = slice(app, "const select = (volunteer: Volunteer) => {", "\n  };");
  assert.ok(select.includes("digitsAskedAtTap("));
});

test("App.tsx: showRefusal goes through afterPhoneRefusal with the save's kind", () => {
  const showRefusal = slice(app, "function showRefusal(", "\n  }\n");
  assert.match(showRefusal, /afterPhoneRefusal\([^)]*save\.kind === "out"/);
});

test("App.tsx: App passes anotherIn to Confirmation, which reads it", () => {
  const appBody = app.slice(app.indexOf("export default function App()"));
  assert.equal(count(appBody, "anotherIn={anotherIn}"), 2, "both Confirmation screens");
  const confirmation = slice(app, "function Confirmation(", "\nfunction ");
  const body = confirmation.slice(confirmation.indexOf("}) {"));
  assert.ok(body.includes("anotherIn"));
});

test("App.tsx: needsPhoneCheck is read only in checkOutLowerBound", () => {
  const lowerBound = slice(app, "function checkOutLowerBound(", "\n}\n");
  assert.ok(count(lowerBound, "needsPhoneCheck") > 0);
  assert.equal(count(app, "needsPhoneCheck"), count(lowerBound, "needsPhoneCheck"));
});
