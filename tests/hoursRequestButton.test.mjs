// Tests for Request my hours (src/hoursRequestButton.ts, imported as it is; Node strips its
// types): when the welcome screen shows the link, what the confirm screen says before and
// after Send, and the wait for an answer. A source check of src/App.tsx ties the page to
// these functions, keeps the path from the link away from every check-in and check-out, and
// keeps the old button off the check-in and check-out screens.

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
  hoursConfirmText,
  hoursPhoneStepAfter,
  settleWithin,
  showsHoursLink,
} from "../src/hoursRequestButton.ts";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");

const L = {};
vm.runInNewContext(read("apps-script/Brand.js") + "\n" + read("apps-script/Logic.js"), L);
const serverText = L.refusalMessages();

// ---------------------------------------------------------------------------
// The link and the confirm screen

test("the link shows only when the list said requests are on", () => {
  assert.equal(showsHoursLink(true), true);
  assert.equal(showsHoursLink(false), false);
  assert.equal(showsHoursLink(undefined), false);
});

test("the confirm screen's sentence, word for word", () => {
  assert.equal(hoursConfirmText, "We'll email your hours to the address we have on file.");
  assert.doesNotMatch(hoursConfirmText, /@/);
});

test("PHONE_NEEDED and PHONE_WRONG bring the phone step back; nothing else does", () => {
  for (const code of ["PHONE_NEEDED", "PHONE_WRONG"]) {
    assert.equal(hoursPhoneStepAfter({ refusal: code, message: serverText[code] }), true, code);
  }
  for (const code of ["PHONE_MISSING", "NOT_FOUND", "BUSY", "ACCESS", "HOURS_REQUESTS_OFF"]) {
    assert.equal(hoursPhoneStepAfter({ refusal: code, message: serverText[code] }), false, code);
  }
  assert.equal(hoursPhoneStepAfter(true), false);
  assert.equal(hoursPhoneStepAfter("failed"), false);
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

test("requests turned off: the server's line, and Done in place of Send", () => {
  const reply = { refusal: "HOURS_REQUESTS_OFF", message: serverText.HOURS_REQUESTS_OFF };
  assert.deepEqual(afterHoursRequest(reply, "Ana"), {
    kind: "line",
    text: "Emailing hours from the kiosk is turned off right now. Please ask a board member.",
    again: false,
  });
  assert.equal(hoursRequestsOffText, serverText.HOURS_REQUESTS_OFF);
});

test("a phone or not-found refusal shows its own message, and Send comes back", () => {
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

test("busy, a failed call, a timeout or an unknown refusal: try again, with Send back", () => {
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

test("App.tsx: the check-in and check-out screens have no hours button, and no thank-you screen mentions it", () => {
  const confirmation = slice(app, "function Confirmation(", "\n}\n");
  const success = slice(app, "function Success(", "\n}\n");
  for (const [name, body] of Object.entries({ confirmation, success })) {
    assert.doesNotMatch(body, /hours|requestHours|HoursRequest/i, name);
  }
  assert.ok(!app.includes("function HoursRequestButton("));
  assert.ok(!app.includes("Email me my hours"));
  assert.ok(!app.includes("showsHoursRequest"));
  const screens = app.slice(app.indexOf("export default function App()"));
  const confirm = slice(screens, '{code && screen === "confirm" && selected && (', "\n      )}");
  const checkout = slice(screens, '{code && screen === "checkout" && selected && (', "\n      )}");
  for (const body of [confirm, checkout]) assert.doesNotMatch(body, /hours/i);
});

test("App.tsx: the welcome screen shows the link by showsHoursLink, and only there", () => {
  assert.equal(count(app, "showsHoursLink("), 1);
  assert.ok(app.includes("onRequestHours={showsHoursLink(hoursRequests) ? openHours : undefined}"));
  const welcomeScreen = slice(app, '{code && screen === "welcome" && (', "\n      )}");
  assert.ok(welcomeScreen.includes("onRequestHours="));
  const hoursScreen = slice(app, '{code && screen === "hours" && (', "\n      )}");
  assert.ok(!hoursScreen.includes("onRequestHours"), "no link inside the hours search");
});

test("App.tsx: nothing on the hours path reaches a check-in or check-out", () => {
  const forbidden = [
    "select(",
    "onSelect={select}",
    "handleConfirm",
    "handleCheckout",
    "instantTap",
    "beginSave",
    "changeSaves",
    "markBeforeSend",
    "foregroundMark",
    "kickRunner",
    "api.checkIn",
    "api.checkOut",
    "CheckedInSidebar",
  ];
  const hoursScreen = slice(app, '{code && screen === "hours" && (', "\n      )}");
  const confirmScreen = slice(
    app,
    '{code && screen === "hours-confirm" && hoursFor && (',
    "\n      )}",
  );
  const open = slice(app, "const openHours = () => {", "\n  };");
  const choose = slice(app, "const chooseForHours = (volunteer: Volunteer) => {", "\n  };");
  const request = slice(app, "async function requestHours()", "\n  }\n");
  const component = slice(app, "function HoursConfirm(", "\n}\n");
  assert.ok(hoursScreen.includes("onSelect={chooseForHours}"));
  assert.ok(confirmScreen.includes("onSend={requestHours}"));
  assert.ok(choose.includes('setScreen("hours-confirm")'));
  // The phone step asks by the check-in rule.
  assert.ok(choose.includes("digitsAskedAtTap(false, volunteer, shown)"));
  for (const [name, body] of Object.entries({
    hoursScreen,
    confirmScreen,
    open,
    choose,
    request,
    component,
  })) {
    for (const text of forbidden) assert.ok(!body.includes(text), `${name}: ${text}`);
  }
});

test("App.tsx: a request is its own call through settleWithin and afterHoursRequest, off the save queue", () => {
  const request = slice(app, "async function requestHours()", "\n  }\n");
  assert.ok(
    request.includes("api.requestHours(code, hoursFor.id, digitsToSend(digitsAsked, phoneDigits))"),
  );
  assert.ok(request.includes("HOURS_REQUEST_TIMEOUT_MS"));
  assert.ok(request.includes("hoursPhoneStepAfter(reply)"));
  assert.ok(request.includes("afterHoursRequest(reply, firstName)"));
  assert.ok(request.includes("lockKiosk(next.lock)"));
  // A reply is used only while its request is the current one.
  assert.ok(request.includes("if (seq !== hoursRequestSeq.current) return;"));
});

test("App.tsx: going home or choosing a name drops a reply", () => {
  const goHome = slice(app, "const goHome = (byTap = false) => {", "\n  };");
  const choose = slice(app, "const chooseForHours = (volunteer: Volunteer) => {", "\n  };");
  for (const [name, body] of Object.entries({ goHome, choose })) {
    assert.ok(body.includes("dropHoursRequest()"), name);
  }
  // The link starts from home: a fresh search, with the old reply dropped.
  assert.ok(slice(app, "const openHours = () => {", "\n  };").includes("goHome(true)"));
});

test("App.tsx: the confirm screen says the sentence, Sending… while it waits, then the answer's line", () => {
  const component = slice(app, "function HoursConfirm(", "\n}\n");
  assert.ok(component.includes("Your volunteer hours"));
  assert.ok(component.includes("Hi, {volunteer.firstName}!"));
  assert.ok(component.includes("hoursConfirmText"));
  assert.ok(component.includes("Sending…"));
  assert.ok(component.includes("Done"));
  assert.ok(component.includes("disabled={sending}"));
});

test("App.tsx: the flag comes only from a fresh list, never from the kept one", () => {
  assert.ok(app.includes("const [hoursRequests, setHoursRequests] = useState(false);"));
  assert.equal(count(app, "setHoursRequests("), 2, "the list reply, and false on a code change");
  assert.ok(app.includes("setHoursRequests(reply.hoursRequests);"));
  assert.ok(!/keptList\??\.hoursRequests/.test(app));
});

test("the hours screens' code never reads an email address", () => {
  const button = read("src/hoursRequestButton.ts");
  const component = slice(app, "function HoursConfirm(", "\n}\n");
  for (const source of [button, component]) {
    assert.doesNotMatch(source, /\.email\b|\bemail\s*:/i);
  }
});
