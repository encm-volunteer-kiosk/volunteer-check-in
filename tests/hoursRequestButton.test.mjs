// Tests for the Email me my hours button (src/hoursRequestButton.ts, imported as it is; Node
// strips its types): when the check-in and check-out screens offer it, the line each answer
// puts in its place, and the wait for an answer. A source check of src/App.tsx ties the page
// to these functions, and the screen's lines are checked against the server's texts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import {
  afterHoursRequest,
  HOURS_REQUEST_TIMEOUT_MS,
  hoursRequestFailedText,
  hoursRequestRecordedText,
  hoursRequestsOffText,
  settleWithin,
  showsHoursRequest,
} from "../src/hoursRequestButton.ts";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");

const L = {};
vm.runInNewContext(read("apps-script/Logic.js"), L);
const serverText = L.refusalMessages();

const volunteer = (extra = {}) => ({
  id: "h-ana",
  firstName: "Ana",
  lastName: "Lopez",
  currentCheckIn: null,
  checkedIn: false,
  active: true,
  expectedToday: false,
  completedShiftCount: 0,
  totalVolunteerMinutes: 0,
  needsPhoneCheck: false,
  ...extra,
});

/** A screen with the button showing; extra changes one thing. */
const screen = (extra = {}) => ({
  hoursRequests: true,
  phoneStep: null,
  picker: false,
  saving: false,
  volunteer: volunteer(),
  digitsAsked: false,
  digits: "",
  ...extra,
});

// ---------------------------------------------------------------------------
// When the button shows

test("the button shows with requests on, and no phone step, picker or save on screen", () => {
  assert.equal(showsHoursRequest(screen()), true);
  assert.equal(showsHoursRequest(screen({ hoursRequests: false })), false, "requests off");
  assert.equal(showsHoursRequest(screen({ phoneStep: "entry" })), false, "phone step");
  assert.equal(showsHoursRequest(screen({ phoneStep: "missing" })), false, "no phone on record");
  assert.equal(showsHoursRequest(screen({ picker: true })), false, "time picker open");
  assert.equal(showsHoursRequest(screen({ saving: true })), false, "a save running");
});

test("a shared name sees the button only once the screen holds its four digits", () => {
  const shared = volunteer({ needsPhoneCheck: true });
  // Check-in: digits asked, then typed and the phone step closed.
  assert.equal(
    showsHoursRequest(screen({ volunteer: shared, digitsAsked: true, digits: "0142" })),
    true,
  );
  assert.equal(
    showsHoursRequest(screen({ volunteer: shared, digitsAsked: true, digits: "014" })),
    false,
  );
  // A check-out screen that didn't ask for digits: hidden.
  assert.equal(
    showsHoursRequest(screen({ volunteer: shared, digitsAsked: false, digits: "" })),
    false,
  );
});

test("digits a phone refusal asked for must be typed before the button shows", () => {
  // The list said the name wasn't shared, but a refusal since asked for digits.
  assert.equal(showsHoursRequest(screen({ digitsAsked: true, digits: "" })), false);
  assert.equal(showsHoursRequest(screen({ digitsAsked: true, digits: "0142" })), true);
});

// ---------------------------------------------------------------------------
// What the screen says

test("a recorded request and one already open read the same, with the first name", () => {
  assert.deepEqual(afterHoursRequest(true, "Ana"), {
    kind: "line",
    text: "Got it, Ana. Your hours will be emailed to you. If nothing arrives in a few days, please ask a board member.",
    again: false,
  });
  assert.equal(hoursRequestRecordedText("Ana"), afterHoursRequest(true, "Ana").text);
});

test("requests turned off: the server's line, and the button doesn't come back", () => {
  const reply = { refusal: "HOURS_REQUESTS_OFF", message: serverText.HOURS_REQUESTS_OFF };
  assert.deepEqual(afterHoursRequest(reply, "Ana"), {
    kind: "line",
    text: "Emailing hours from the kiosk is turned off right now. Please ask a board member.",
    again: false,
  });
  assert.equal(hoursRequestsOffText, serverText.HOURS_REQUESTS_OFF);
});

test("a phone or not-found refusal shows its own message, and the button comes back", () => {
  for (const code of ["PHONE_NEEDED", "PHONE_WRONG", "PHONE_MISSING", "NOT_FOUND"]) {
    const reply = { refusal: code, message: serverText[code] };
    assert.deepEqual(
      afterHoursRequest(reply, "Ana"),
      {
        kind: "line",
        text: serverText[code],
        again: true,
      },
      code,
    );
  }
});

test("busy, a failed call, a timeout or an unknown refusal: try again, the button back", () => {
  const expected = {
    kind: "line",
    text: "That didn't go through. Please try again.",
    again: true,
  };
  assert.equal(hoursRequestFailedText, expected.text);
  assert.deepEqual(
    afterHoursRequest({ refusal: "BUSY", message: serverText.BUSY }, "Ana"),
    expected,
  );
  assert.deepEqual(afterHoursRequest("failed", "Ana"), expected);
  assert.deepEqual(afterHoursRequest({ refusal: "SOMETHING_NEW", message: "?" }, "Ana"), expected);
});

test("ACCESS locks the kiosk with the server's message", () => {
  const reply = { refusal: "ACCESS", message: serverText.ACCESS };
  assert.deepEqual(afterHoursRequest(reply, "Ana"), { lock: serverText.ACCESS });
});

test("no line names an address or says who sends", () => {
  const lines = [hoursRequestRecordedText("Ana"), hoursRequestsOffText, hoursRequestFailedText];
  for (const line of lines) {
    assert.doesNotMatch(line, /@/);
    assert.doesNotMatch(line, /\b(address|staff|automatic|job|again soon|already)\b/i, line);
  }
});

// ---------------------------------------------------------------------------
// The wait

test("settleWithin gives the answer, or failed on a rejection or after the wait", async () => {
  assert.equal(await settleWithin(Promise.resolve(true), 50), true);
  assert.equal(await settleWithin(Promise.reject(new Error("offline")), 50), "failed");
  assert.equal(await settleWithin(new Promise(() => {}), 20), "failed");
  assert.equal(HOURS_REQUEST_TIMEOUT_MS, 30_000);
});

// ---------------------------------------------------------------------------
// App.tsx goes through these functions

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

test("App.tsx: Confirmation decides the button with showsHoursRequest and its own screen state", () => {
  const confirmation = slice(app, "function Confirmation(", "\nfunction ");
  const call = slice(confirmation, "showsHoursRequest({", "});");
  for (const field of [
    "hoursRequests",
    "phoneStep",
    "picker",
    "saving",
    "volunteer",
    "digitsAsked",
    "digits: phoneDigits",
  ]) {
    assert.ok(call.includes(field), field);
  }
  assert.ok(confirmation.includes("{offersHours && <HoursRequestButton"));
  assert.equal(count(app, "showsHoursRequest("), 1, "one place decides");
});

test("App.tsx: both Confirmation screens get the list's flag and the button's state", () => {
  const appBody = app.slice(app.indexOf("export default function App()"));
  assert.equal(count(appBody, "hoursRequests={hoursRequests}"), 2);
  assert.equal(count(appBody, "hoursRequest={hoursRequest}"), 2);
  assert.equal(count(appBody, "onRequestHours={requestHours}"), 2);
});

test("App.tsx: a request is its own call through settleWithin and afterHoursRequest, off the save queue", () => {
  const request = slice(app, "async function requestHours()", "\n  }\n");
  assert.ok(
    request.includes("api.requestHours(code, selected.id, digitsToSend(digitsAsked, phoneDigits))"),
  );
  assert.ok(request.includes("HOURS_REQUEST_TIMEOUT_MS"));
  assert.ok(request.includes("afterHoursRequest(reply, firstName)"));
  assert.ok(request.includes("lockKiosk(next.lock)"));
  // A reply is used only while its request is the current one.
  assert.ok(request.includes("if (seq !== hoursRequestSeq.current) return;"));
  for (const queued of ["beginSave", "changeSaves", "markBeforeSend", "kickRunner", "setScreen"]) {
    assert.ok(!request.includes(queued), queued);
  }
});

test("App.tsx: leaving the screen, choosing a name, or tapping Check In or Out drops a reply", () => {
  const goHome = slice(app, "const goHome = (byTap = false) => {", "\n  };");
  const select = slice(app, "const select = (volunteer: Volunteer) => {", "\n  };");
  const confirm = slice(app, "async function handleConfirm()", "\n  }\n");
  const checkout = slice(app, "async function handleCheckout()", "\n  }\n");
  for (const [name, body] of Object.entries({ goHome, select, confirm, checkout })) {
    assert.ok(body.includes("dropHoursRequest()"), name);
  }
});

test("App.tsx: the flag comes only from a fresh list, never from the kept one", () => {
  assert.ok(app.includes("const [hoursRequests, setHoursRequests] = useState(false);"));
  assert.equal(count(app, "setHoursRequests("), 2, "the list reply, and false on a code change");
  assert.ok(app.includes("setHoursRequests(reply.hoursRequests);"));
  assert.ok(!/keptList\??\.hoursRequests/.test(app));
});

test("the button's code never reads an email address", () => {
  const button = read("src/hoursRequestButton.ts");
  const component = slice(app, "function HoursRequestButton(", "\n}\n");
  for (const source of [button, component]) {
    assert.doesNotMatch(source, /\.email\b|\bemail\s*:/i);
  }
});
