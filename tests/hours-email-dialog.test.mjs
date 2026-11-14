// Tests for Kiosk admin > Email hours… in the browser: the Send and Preview state of the
// admin window. They run AdminDialog.html's whole <script> in node:vm against a stub
// document that makes one element per id on first use, and a stub google.script.run that
// records each call and lets the test answer it, refuse it or throw, in any order. After
// each step they read the Send button's disabled itself, and the window's ticket.
//
// The rule under test: Send is enabled exactly when no call is in flight, no send run is
// under way, and the window holds a ticket a Preview returned for the selection now (the
// ticked set, the month and the attach box). Any change of the selection, and every
// Preview press, clears the ticket at once.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const html = readFileSync(new URL("../apps-script/AdminDialog.html", import.meta.url), "utf8");
const SCRIPT = html.slice(html.indexOf("<script>") + 8, html.lastIndexOf("</script>"));

// ---------------------------------------------------------------------------
// The stub page

class El {
  constructor(tag, id = "") {
    this.tagName = tag;
    this.id = id;
    this.children = [];
    this.listeners = {};
    this.dataset = {};
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.value = "";
    this.type = "";
    this.className = "";
    this.options = [];
    this.selectedIndex = -1;
    this.scrolls = [];
    this.text = "";
  }
  get textContent() {
    if (!this.children.length) return this.text;
    return [this.text, ...this.children.map((c) => c.textContent)].filter(Boolean).join("\n");
  }
  set textContent(value) {
    this.text = String(value);
    this.children = [];
    this.options = [];
  }
  set innerHTML(value) {
    this.textContent = value;
  }
  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  add(option) {
    this.options.push(option);
  }
  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }
  fire(type) {
    for (const fn of this.listeners[type] || []) {
      fn({ type, target: this, preventDefault() {} });
    }
  }
  // Records what the element said when it was scrolled into view.
  scrollIntoView(options) {
    this.scrolls.push({ options, text: this.textContent });
  }
}

function dialog(mode, { contact = "" } = {}) {
  const els = new Map();
  const calls = [];
  const document = {
    body: { dataset: { key: "key-1", mode, contact } },
    getElementById(id) {
      if (!els.has(id)) els.set(id, new El("div", id));
      return els.get(id);
    },
    createElement: (tag) => new El(tag),
    querySelectorAll: () => [],
  };
  function chain(onOk, onFail) {
    return new Proxy(
      {},
      {
        get(_, prop) {
          if (prop === "withSuccessHandler") return (fn) => chain(fn, onFail);
          if (prop === "withFailureHandler") return (fn) => chain(onOk, fn);
          return (...args) => {
            const entry = {
              name: prop,
              args,
              settled: false,
              answer(reply) {
                assert.equal(entry.settled, false, "answered twice: " + prop);
                entry.settled = true;
                onOk(reply);
              },
              refuse(code, message = code + " message") {
                entry.answer({ ok: false, refusal: code, message });
              },
              throws(message) {
                assert.equal(entry.settled, false, "answered twice: " + prop);
                entry.settled = true;
                onFail(new Error(message));
              },
            };
            calls.push(entry);
          };
        },
      },
    );
  }
  const google = { script: { run: chain(), host: { close() {} } } };
  // The page's inputs whose type the tests click by.
  document.getElementById("email-attach").type = "checkbox";
  document.getElementById("email-this").type = "radio";
  document.getElementById("email-last").type = "radio";
  function Option(text, value) {
    this.text = text;
    this.value = value;
  }
  const ctx = vm.createContext({ document, google, Option, console });
  vm.runInContext(SCRIPT, ctx);
  const $ = (id) => document.getElementById(id);
  const state = (expr) => vm.runInContext(expr, ctx);
  const pending = () => calls.filter((c) => !c.settled);
  const last = () => calls[calls.length - 1];
  return { $, calls, pending, last, state, mode };
}

// ---------------------------------------------------------------------------
// Fixtures: invented people only.

const person = (n) => ({
  id: "v" + n,
  label: "Pat Example " + n,
  to: "pat.example." + n + "@example.org",
});
const roster = (count) => Array.from({ length: count }, (_, i) => person(i + 1));

const BODY = [
  "Hi Pat,",
  "",
  "Here are the volunteer hours we have for you as of Saturday, November 14, 2026:",
  "",
  "  November 2026 so far: 6.50 hours (2 shifts)",
  "  2026 so far: 48.25 hours (19 shifts)",
  "  All time: 112.00 hours (45 shifts), including 30.00 hours from our paper records",
  "",
  "Your shifts in November 2026:",
  "  Mon Nov 2: 3.00 hours",
  "  Thu Nov 12: 3.50 hours",
  "",
  "This email comes from an address that can't take replies. If anything looks wrong, please contact:",
  "Pat Example, pat@example.org",
  "",
  "Thank you for volunteering.",
].join("\n");

const NO_EMAIL = "Volunteer Profiles row 30 has no email. Add it there, then press Preview again.";

function previewReply(
  ids,
  { ticket = "ticket-1", leftOut = [], warnings = {}, setProblems = [] } = {},
) {
  return {
    ok: true,
    from: "volunteer@example.org",
    month: "2026-11",
    asOf: "2026-11-14",
    volunteers: ids.map((id, i) => {
      const p = person(Number(id.slice(1)));
      const out = leftOut.includes(id);
      return {
        id,
        label: p.label,
        profilesRow: i + 2,
        startDate: "2026-02-15",
        to: out ? "" : p.to,
        subject: "Your volunteer hours for November 2026",
        body: BODY,
        attachment: null,
        warnings: warnings[id] || [],
        problems: out ? [NO_EMAIL] : [],
        lastSent: "never",
      };
    }),
    setProblems,
    sendIds: ids.filter((id) => !leftOut.includes(id)),
    chunkSize: 10,
    ticket,
  };
}

const sendResults = (ids, result = "sent") => ({
  ok: true,
  results: ids.map((id) => ({ id, result })),
  recordFailed: false,
});

const CONTROLS = [
  "email-this",
  "email-last",
  "email-attach",
  "email-search",
  "email-tick-all",
  "email-clear",
  "email-preview",
];

function rows(d) {
  return d.$("email-list").children;
}
function box(d, n) {
  return rows(d)[n - 1].children[0];
}
function click(d, el) {
  assert.equal(el.disabled, false, "clicked a disabled control");
  if (el.type === "checkbox") {
    el.checked = !el.checked;
    el.fire("change");
  } else el.fire("click");
}
function chooseLast(d) {
  assert.equal(d.$("email-last").disabled, false);
  d.$("email-this").checked = false;
  d.$("email-last").checked = true;
  d.$("email-last").fire("change");
}
function typeSearch(d, text) {
  d.$("email-search").value = text;
  d.$("email-search").fire("input");
}
const sendOff = (d) => d.$("save").disabled;
const controlsOff = (d) =>
  CONTROLS.map((id) => d.$(id).disabled).concat(rows(d).map((r) => r.children[0].disabled));
const allOff = (d) => controlsOff(d).every(Boolean);
const allOn = (d) => controlsOff(d).every((off) => !off);
// Values made inside the page's context, as plain test values.
const plain = (value) => JSON.parse(JSON.stringify(value));
const ticketOf = (d) => d.state("ticket");
const message = (d) => d.$("message").textContent;
const detail = (d) => d.$("email-detail").textContent;

// An email window with its roster loaded.
function loaded(count = 25, today = "2026-11-14") {
  const d = dialog("email");
  assert.equal(d.last().name, "adminRoster");
  d.last().answer({ ok: true, today, volunteers: roster(count) });
  return d;
}

// Ticks volunteers 1..n by clicking, presses Preview and answers it.
function withTicket(count = 25, ticks = 2, options = {}) {
  const d = loaded(count);
  if (ticks === count) click(d, d.$("email-tick-all"));
  else for (let n = 1; n <= ticks; n += 1) click(d, box(d, n));
  click(d, d.$("email-preview"));
  const call = d.last();
  assert.equal(call.name, "adminHoursPreview");
  call.answer(previewReply(call.args[1].ids, options));
  assert.equal(sendOff(d), false);
  return d;
}

const ids = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => "v" + (from + i));

// ---------------------------------------------------------------------------
// Loading

test("email window: while the roster loads and once it has, Send is off; this month, attach unticked", () => {
  const d = dialog("email");
  assert.equal(d.$("save").textContent, "Send email");
  assert.equal(d.$("note-block").hidden, true);
  assert.equal(d.$("email").hidden, false);
  assert.equal(sendOff(d), true);
  assert.ok(allOff(d));
  d.last().answer({ ok: true, today: "2026-11-14", volunteers: roster(25) });
  assert.equal(sendOff(d), true);
  assert.equal(ticketOf(d), "");
  assert.equal(d.$("email-this").checked, true);
  assert.equal(d.$("email-last").checked, false);
  assert.equal(d.$("email-attach").checked, false);
  assert.equal(d.$("email-this-label").textContent, "This month (November 2026)");
  assert.equal(d.$("email-last-label").textContent, "Last month (October 2026)");
  assert.equal(rows(d).length, 25);
  assert.equal(rows(d)[0].children[1].textContent, "Pat Example 1");
  assert.ok(rows(d).every((r) => !r.hidden && !r.children[0].checked));
  assert.ok(allOn(d));
});

test("email window: in January, last month is December of the year before", () => {
  const d = loaded(3, "2027-01-05");
  assert.equal(d.$("email-this-label").textContent, "This month (January 2027)");
  assert.equal(d.$("email-last-label").textContent, "Last month (December 2026)");
});

// ---------------------------------------------------------------------------
// Preview

test("email window: Preview with nothing ticked makes no call and says so", () => {
  const d = loaded();
  const before = d.calls.length;
  click(d, d.$("email-preview"));
  assert.equal(d.calls.length, before);
  assert.equal(message(d), "Please tick at least one volunteer.");
  assert.equal(sendOff(d), true);
  assert.equal(ticketOf(d), "");
});

test("email window: while a Preview is pending every control is off; a reply with a ticket turns Send on", () => {
  const d = loaded();
  click(d, box(d, 3));
  click(d, box(d, 1));
  assert.equal(d.$("email-count").textContent, "2 ticked");
  click(d, d.$("email-attach"));
  chooseLast(d);
  click(d, d.$("email-preview"));
  const call = d.last();
  assert.equal(call.name, "adminHoursPreview");
  assert.deepEqual(plain(call.args), [
    "key-1",
    { ids: ["v1", "v3"], choice: "last", attach: true },
  ]);
  assert.equal(sendOff(d), true);
  assert.ok(allOff(d));
  call.answer(previewReply(["v1", "v3"], { ticket: "ticket-9" }));
  assert.equal(sendOff(d), false);
  assert.ok(allOn(d));
  const t = ticketOf(d);
  assert.equal(t.id, "ticket-9");
  assert.deepEqual(plain(t.pending), ["v1", "v3"]);
  assert.equal(t.key, d.state("selectionKey()"));
  const text = detail(d);
  assert.match(text, /2 ticked: 2 will be sent, 0 won't\./);
  assert.match(text, /To: Pat Example 1 <pat\.example\.1@example\.org>/);
  assert.match(text, /Volunteer Profiles row 2 · started 2026-02-15/);
  assert.match(text, /Last emailed: never/);
  assert.match(text, /November 2026 so far: 6\.50 hours \(2 shifts\)/);
  assert.match(text, /All time: 112\.00 hours \(45 shifts\)/);
  assert.match(
    text,
    /From: ENCM Volunteer Kiosk, from a no-reply address \(sent by volunteer@example\.org\)/,
  );
  assert.match(text, /Email text/);
});

test("email window: a Preview reply with no ticket leaves Send off and shows the set problem", () => {
  const d = loaded();
  click(d, box(d, 1));
  click(d, d.$("email-preview"));
  const problem =
    "Type who volunteers should contact about their hours in Hours email contact on the Settings tab, then press Preview again.";
  d.last().answer(previewReply(["v1"], { ticket: "", setProblems: [problem] }));
  assert.equal(sendOff(d), true);
  assert.equal(ticketOf(d), "");
  assert.equal(message(d), problem);
  assert.equal(d.$("message").className, "message error");
  assert.ok(allOn(d));
});

test("email window: a refused or thrown Preview leaves the ticket empty and Send off", () => {
  const d = loaded();
  click(d, box(d, 1));
  click(d, d.$("email-preview"));
  d.last().refuse("ADMIN_EXPIRED", "This window has expired.");
  assert.equal(sendOff(d), true);
  assert.equal(ticketOf(d), "");
  assert.equal(message(d), "This window has expired.");
  click(d, d.$("email-preview"));
  d.last().throws("Service Spreadsheets timed out");
  assert.equal(sendOff(d), true);
  assert.equal(ticketOf(d), "");
  assert.equal(message(d), "Service Spreadsheets timed out");
});

test("email window: a volunteer left out at Preview is shown with the problem and not in the ticket", () => {
  const d = loaded();
  for (const n of [1, 2, 3]) click(d, box(d, n));
  click(d, d.$("email-preview"));
  d.last().answer(previewReply(["v1", "v2", "v3"], { leftOut: ["v2"] }));
  assert.deepEqual(plain(ticketOf(d).pending), ["v1", "v3"]);
  assert.match(detail(d), /3 ticked: 2 will be sent, 1 won't\./);
  assert.match(detail(d), new RegExp("Pat Example 2: won't be sent\\. " + NO_EMAIL));
});

test("email window: Check before sending shows only when a volunteer has warnings", () => {
  const d = withTicket(25, 2);
  assert.equal(d.$("email-check").hidden, true);
  click(d, d.$("email-preview"));
  const flagged = {
    kind: "flags",
    count: 2,
    rows: [14, 220],
    text: "2 shifts with an unreviewed flag (Log rows 14, 220): check them on the Flags tab before sending",
  };
  d.last().answer(previewReply(["v1", "v2"], { warnings: { v2: [flagged] } }));
  assert.equal(d.$("email-check").hidden, false);
  assert.equal(
    d.$("email-check").textContent,
    "Check before sending: 1 volunteer has something to check below, 2 flagged shifts in all.",
  );
  assert.match(detail(d), /Check: 2 shifts with an unreviewed flag \(Log rows 14, 220\)/);

  // The count is of Log rows: a row with a flag and an alert counts once, across both
  // warnings; other warnings add none.
  click(d, d.$("email-preview"));
  const alerted = {
    kind: "alerts",
    count: 2,
    rows: [220, 301],
    text: "2 rows with Admin Alerts? set (Log rows 220, 301): read the Admin Alerts? cell on those Log rows before sending.",
  };
  const open = {
    kind: "open",
    count: 1,
    rows: [400],
    text: "1 open shift not counted (Log row 400): use Fix a sign-out… if they're finished.",
  };
  d.last().answer(previewReply(["v1", "v2"], { warnings: { v1: [open], v2: [flagged, alerted] } }));
  assert.equal(
    d.$("email-check").textContent,
    "Check before sending: 2 volunteers have something to check below, 3 flagged shifts in all.",
  );
  // With no flags or alerts, no count.
  click(d, d.$("email-preview"));
  d.last().answer(previewReply(["v1", "v2"], { warnings: { v1: [open] } }));
  assert.equal(
    d.$("email-check").textContent,
    "Check before sending: 1 volunteer has something to check below.",
  );
});

// ---------------------------------------------------------------------------
// The selection

const CHANGES = {
  "ticking a box": (d) => click(d, box(d, 5)),
  "unticking a box": (d) => click(d, box(d, 1)),
  "Tick all shown": (d) => click(d, d.$("email-tick-all")),
  Clear: (d) => click(d, d.$("email-clear")),
  "choosing last month": (d) => chooseLast(d),
  "ticking the attach box": (d) => click(d, d.$("email-attach")),
};

for (const [what, change] of Object.entries(CHANGES)) {
  test(`email window: with a ticket held, ${what} turns Send off at once and drops the ticket`, () => {
    const d = withTicket();
    const before = d.calls.length;
    change(d);
    assert.equal(d.calls.length, before, "no call");
    assert.equal(sendOff(d), true);
    assert.equal(ticketOf(d), "");
    assert.equal(detail(d), "");
    assert.equal(d.$("email-check").hidden, true);
  });
}

test("email window: Tick all shown ticks every row the search shows, and Clear unticks all", () => {
  const d = loaded(25);
  typeSearch(d, "Example 1");
  // "Pat Example 1", 10 to 19 and 21.
  const shown = rows(d).filter((r) => !r.hidden);
  assert.equal(shown.length, 12);
  click(d, d.$("email-tick-all"));
  assert.equal(d.$("email-count").textContent, "12 ticked");
  typeSearch(d, "");
  assert.equal(rows(d).filter((r) => r.children[0].checked).length, 12);
  click(d, d.$("email-clear"));
  assert.equal(d.$("email-count").textContent, "0 ticked");
  assert.ok(rows(d).every((r) => !r.children[0].checked));
});

test("email window: typing in the search box keeps the ticket, Send and the ticked count", () => {
  const d = withTicket(25, 2);
  const t = ticketOf(d);
  typeSearch(d, "Example 2");
  assert.equal(rows(d)[0].hidden, true, "Pat Example 1 is hidden");
  assert.equal(rows(d)[0].children[0].checked, true, "and still ticked");
  assert.equal(ticketOf(d), t);
  assert.equal(sendOff(d), false);
  assert.equal(d.$("email-count").textContent, "2 ticked");
});

test("email window: pressing Preview while a ticket is held turns Send off before the reply", () => {
  const d = withTicket();
  click(d, d.$("email-preview"));
  assert.equal(sendOff(d), true);
  assert.equal(ticketOf(d), "");
  assert.equal(detail(d), "");
  d.last().answer(previewReply(["v1", "v2"], { ticket: "ticket-2" }));
  assert.equal(ticketOf(d).id, "ticket-2");
  assert.equal(sendOff(d), false);
});

test("email window: a Preview reply for a selection that changed sets no ticket and shows no preview", () => {
  const d = loaded();
  click(d, box(d, 1));
  click(d, d.$("email-preview"));
  // As if the controls had not been turned off: the ticked set changes under the call.
  d.state('ticked.add("v2")');
  d.last().answer(previewReply(["v1"]));
  assert.equal(sendOff(d), true);
  assert.equal(ticketOf(d), "");
  assert.equal(detail(d), "");
});

// ---------------------------------------------------------------------------
// A send run

// A window holding a ticket for the first 23 volunteers, initials typed.
function ready23() {
  const d = withTicket(23, 23);
  d.$("initials").value = "jp";
  return d;
}

function pressSend(d) {
  const before = d.calls.length;
  click(d, d.$("save"));
  assert.equal(d.calls.length, before + 1, "one call at a time");
  return d.last();
}

test("email window: a run of 23 sends calls of 10, 10 and 3, one after another, with the initials read at the press", () => {
  const d = ready23();
  const t = ticketOf(d);
  const first = pressSend(d);
  d.$("initials").value = "zz";
  assert.equal(first.name, "adminSendHours");
  assert.deepEqual(plain(first.args), ["key-1", { ticket: t.id, ids: ids(1, 10), initials: "jp" }]);
  assert.equal(sendOff(d), true);
  assert.ok(allOff(d));
  assert.equal(message(d), "Sending… 0 of 23");

  first.answer(sendResults(ids(1, 10)));
  assert.equal(d.pending().length, 1);
  const second = d.last();
  assert.deepEqual(plain(second.args[1]), { ticket: t.id, ids: ids(11, 20), initials: "jp" });
  assert.equal(sendOff(d), true, "off between calls");
  assert.ok(allOff(d), "controls off between calls");
  assert.equal(message(d), "Sending… 10 of 23");

  second.answer(sendResults(ids(11, 20)));
  const third = d.last();
  assert.deepEqual(plain(third.args[1]), { ticket: t.id, ids: ids(21, 23), initials: "jp" });
  assert.equal(sendOff(d), true);
  assert.ok(allOff(d));

  third.answer(sendResults(ids(21, 23)));
  assert.equal(d.pending().length, 0);
  assert.equal(d.calls.filter((c) => c.name === "adminSendHours").length, 3);
  assert.equal(ticketOf(d), "");
  assert.equal(sendOff(d), true);
  assert.ok(allOn(d));
  assert.equal(message(d), "Sent 23 of 23.");
  assert.equal(d.$("message").className, "message ok");
  const lines = detail(d).split("\n");
  assert.equal(lines.length, 23);
  assert.equal(lines[0], "Pat Example 1: sent to pat.example.1@example.org");
  assert.equal(lines[22], "Pat Example 23: sent to pat.example.23@example.org");
});

test("email window: each result line is labelled from the preview reply", () => {
  const d = withTicket(25, 3);
  const call = pressSend(d);
  call.answer({
    ok: true,
    results: [
      { id: "v1", result: "sent" },
      { id: "v2", result: "failed: Invalid email: pat.example.2@example.org" },
      { id: "v3", result: "not sent: changed since the preview; press Preview again to check it" },
    ],
    recordFailed: true,
  });
  assert.deepEqual(detail(d).split("\n"), [
    "Pat Example 1: sent to pat.example.1@example.org",
    "Pat Example 2: failed: Invalid email: pat.example.2@example.org",
    "Pat Example 3: not sent: changed since the preview; press Preview again to check it",
  ]);
  assert.equal(
    message(d),
    "Sent 1 of 3. 2 weren't sent; see the list. Some couldn't be written on the Hours emails tab; the execution log has the details.",
  );
  assert.equal(d.$("message").className, "message error");
});

test("email window: the result list names who was left out at Preview", () => {
  const d = loaded();
  for (const n of [1, 2]) click(d, box(d, n));
  click(d, d.$("email-preview"));
  d.last().answer(previewReply(["v1", "v2"], { leftOut: ["v2"] }));
  pressSend(d).answer(sendResults(["v1"]));
  assert.deepEqual(detail(d).split("\n"), [
    "Pat Example 1: sent to pat.example.1@example.org",
    "Left out at Preview:",
    "Pat Example 2: " + NO_EMAIL,
  ]);
  assert.equal(message(d), "Sent 1 of 1.");
});

for (const code of ["BUSY", "ADMIN_INITIALS"]) {
  test(`email window: ${code} on the second call ends the run with the ticket kept for the 13 not handled`, () => {
    const d = ready23();
    const t = ticketOf(d);
    pressSend(d).answer(sendResults(ids(1, 10)));
    d.last().refuse(code, code + " message");
    assert.equal(d.state("running"), false);
    assert.equal(ticketOf(d), t);
    assert.deepEqual(plain(t.pending), ids(11, 23));
    assert.equal(sendOff(d), false);
    assert.ok(allOn(d));
    assert.equal(message(d), "Sent 10 of 23. 13 weren't sent; see the list. " + code + " message");
    const again = pressSend(d);
    assert.deepEqual(plain(again.args[1].ids), ids(11, 20));
    again.answer(sendResults(ids(11, 20)));
    assert.deepEqual(plain(d.last().args[1].ids), ids(21, 23));
    d.last().answer(sendResults(ids(21, 23)));
    const sends = d.calls.filter((c) => c.name === "adminSendHours");
    assert.equal(sends.length, 4);
    assert.deepEqual(plain(sends.slice(2).flatMap((c) => c.args[1].ids)), ids(11, 23));
    assert.equal(ticketOf(d), "");
    assert.equal(message(d), "Sent 13 of 13.");
  });
}

test("email window: ADMIN_INITIALS on the first call keeps the whole ticket, and the next Send sends all 23", () => {
  const d = ready23();
  d.$("initials").value = "";
  pressSend(d).refuse("ADMIN_INITIALS", "Please enter your initials, letters only.");
  assert.equal(sendOff(d), false);
  assert.deepEqual(plain(ticketOf(d).pending), ids(1, 23));
  d.$("initials").value = "jp";
  const first = pressSend(d);
  assert.deepEqual(plain(first.args[1]), { ticket: "ticket-1", ids: ids(1, 10), initials: "jp" });
  first.answer(sendResults(ids(1, 10)));
  d.last().answer(sendResults(ids(11, 20)));
  assert.deepEqual(plain(d.last().args[1].ids), ids(21, 23));
  d.last().answer(sendResults(ids(21, 23)));
  assert.equal(message(d), "Sent 23 of 23.");
});

for (const code of ["HOURS_EMAIL_STALE", "ADMIN_EXPIRED"]) {
  test(`email window: ${code} on the second call ends the run, drops the ticket and lists the 13 as not sent`, () => {
    const d = ready23();
    pressSend(d).answer(sendResults(ids(1, 10)));
    d.last().refuse(code, code + " message");
    assert.equal(ticketOf(d), "");
    assert.equal(sendOff(d), true);
    assert.ok(allOn(d));
    const lines = detail(d).split("\n");
    assert.equal(lines.length, 23);
    assert.equal(lines[0], "Pat Example 1: sent to pat.example.1@example.org");
    assert.equal(lines[10], "Pat Example 11: not sent: " + code + " message");
    assert.equal(lines[22], "Pat Example 23: not sent: " + code + " message");
    assert.equal(message(d), "Sent 10 of 23. 13 weren't sent; see the list. " + code + " message");
  });
}

test("email window: a thrown second call ends the run, drops the ticket, and lists its ten as unknown", () => {
  const d = dialog("email", { contact: "If this keeps happening, contact: Pat Example." });
  d.last().answer({ ok: true, today: "2026-11-14", volunteers: roster(23) });
  click(d, d.$("email-tick-all"));
  click(d, d.$("email-preview"));
  d.last().answer(previewReply(ids(1, 23)));
  d.$("initials").value = "jp";
  pressSend(d).answer(sendResults(ids(1, 10)));
  d.last().throws("NetworkError: connection lost");
  assert.equal(ticketOf(d), "");
  assert.equal(sendOff(d), true);
  const lines = detail(d).split("\n");
  assert.equal(lines.length, 23);
  assert.equal(
    lines[10],
    "Pat Example 11: not sent, or sent but the reply was lost: NetworkError: connection lost; check the Hours emails tab before sending again",
  );
  assert.equal(
    lines[19].startsWith("Pat Example 20: not sent, or sent but the reply was lost"),
    true,
  );
  assert.equal(lines[20], "Pat Example 21: not sent: NetworkError: connection lost");
  assert.equal(
    message(d),
    "Sent 10 of 23. 13 weren't sent; see the list. NetworkError: connection lost If this keeps happening, contact: Pat Example.",
  );
});

test("email window: a call that replies ok with ten not-sent results goes on to the next", () => {
  const d = ready23();
  pressSend(d).answer(sendResults(ids(1, 10)));
  d.last().answer(sendResults(ids(11, 20), "not sent: Service Spreadsheets timed out"));
  assert.equal(d.pending().length, 1);
  assert.deepEqual(plain(d.last().args[1].ids), ids(21, 23));
  d.last().answer(sendResults(ids(21, 23)));
  const lines = detail(d).split("\n");
  assert.equal(lines.length, 23);
  assert.equal(lines[10], "Pat Example 11: not sent: Service Spreadsheets timed out");
  assert.equal(message(d), "Sent 13 of 23. 10 weren't sent; see the list.");
  assert.equal(ticketOf(d), "");
  assert.equal(sendOff(d), true);
});

test("email window: after every reply the message line, as the reply left it, is scrolled into view", () => {
  const d = dialog("email");
  // The last scroll was of the message as it reads now.
  const scrolledNow = () => {
    const scrolls = d.$("message").scrolls;
    const last = scrolls[scrolls.length - 1];
    assert.ok(last, "scrolled");
    assert.deepEqual(plain(last.options), { block: "nearest" });
    assert.equal(last.text, message(d));
    d.$("message").scrolls = [];
  };
  d.last().answer({ ok: true, today: "2026-11-14", volunteers: roster(23) });
  scrolledNow();
  click(d, d.$("email-tick-all"));
  click(d, d.$("email-preview"));
  d.last().answer(previewReply(ids(1, 23)));
  scrolledNow();
  pressSend(d).answer(sendResults(ids(1, 10)));
  scrolledNow();
  d.last().refuse("BUSY", "The kiosk is busy. Please try again.");
  scrolledNow();
  pressSend(d).throws("timed out");
  scrolledNow();
  click(d, d.$("email-preview"));
  d.last().refuse("ADMIN_EXPIRED", "This window has expired.");
  scrolledNow();
});

// ---------------------------------------------------------------------------
// The other modes keep today's button

const LOADS = {
  add: ["adminRoster", { ok: true, today: "2026-11-14", volunteers: roster(2) }],
  fix: ["adminOpenShifts", { ok: true, shifts: [] }],
  remove: ["adminRoster", { ok: true, today: "2026-11-14", volunteers: roster(2) }],
  restore: ["adminRemovedShifts", { ok: true, shifts: [] }],
};

for (const [mode, [name, reply]] of Object.entries(LOADS)) {
  test(`${mode} window: Save is off while a call is pending and on after a reply or a thrown error`, () => {
    const answered = dialog(mode);
    assert.equal(answered.last().name, name);
    assert.equal(sendOff(answered), true);
    answered.last().answer(reply);
    assert.equal(sendOff(answered), false);
    assert.equal(answered.$("save").textContent, "");
    assert.equal(answered.$("message").scrolls.length, 0);

    const thrown = dialog(mode);
    assert.equal(sendOff(thrown), true);
    thrown.last().throws("Service Spreadsheets timed out");
    assert.equal(sendOff(thrown), false);

    const refused = dialog(mode);
    refused.last().refuse("ADMIN_EXPIRED", "This window has expired.");
    assert.equal(sendOff(refused), false);
  });
}

// ---------------------------------------------------------------------------
// The server's own replies
//
// tests/hours-email-replies.json holds a preview reply and a send reply as the server
// builds them; admin.test.mjs checks the file against adminHoursPreview and adminSendHours
// on its stand-in server. Here the window reads them, with the attach box ticked: Maria
// Alvarez, Ana Diaz (no shifts, so no file) and James Okafor sent, James with both a flag
// and an Admin Alerts? cell on one Log row, Dev Patel with no email, and one id no longer
// on the volunteer list.

const REPLIES = JSON.parse(
  readFileSync(new URL("./hours-email-replies.json", import.meta.url), "utf8"),
);

const blocks = (d) => d.$("email-detail").children;

test("email window: the server's own preview and send replies show line by line", () => {
  const { preview, send } = REPLIES;
  const d = dialog("email");
  d.last().answer({
    ok: true,
    today: preview.asOf,
    volunteers: preview.volunteers.map((v) => ({ id: v.id, label: v.label })),
  });
  click(d, d.$("email-attach"));
  click(d, d.$("email-tick-all"));
  click(d, d.$("email-preview"));
  const call = d.last();
  assert.equal(call.name, "adminHoursPreview");
  assert.deepEqual(plain(call.args[1]), {
    ids: preview.volunteers.map((v) => v.id),
    choice: "this",
    attach: true,
  });
  call.answer(preview);
  assert.equal(sendOff(d), false);
  assert.deepEqual(plain(ticketOf(d).pending), preview.sendIds);
  const shown = [...blocks(d)];
  assert.equal(shown.length, 6);
  assert.deepEqual(shown[0].text.split("\n"), [
    "From: ENCM Volunteer Kiosk, from a no-reply address (sent by staff@example.org)",
    "5 ticked: 3 will be sent, 2 won't.",
  ]);
  assert.deepEqual(shown[1].text.split("\n"), [
    "To: Maria Alvarez <maria.alvarez@example.org>",
    "Volunteer Profiles row 2 · started 2026-02-15",
    "Last emailed: 2026-11-03 by JP",
    "November 2026 so far: 6.50 hours (2 shifts)",
    "2026 so far: 8.50 hours (3 shifts)",
    "All time: 8.50 hours (3 shifts)",
    "Attached: volunteer-hours-to-2026-11-14.csv (3 shifts)",
  ]);
  assert.deepEqual(shown[2].text.split("\n"), [
    "To: Ana Diaz <ana.diaz@example.org>",
    "Volunteer Profiles row 5 · started 2026-02-15",
    "Last emailed: never",
    "We don't have any volunteer hours recorded for you yet.",
    "Check: This volunteer has no counted hours yet; the email will say so. The shifts file is left out, since there are no shifts to list.",
  ]);
  assert.deepEqual(shown[3].text.split("\n"), [
    "To: James Okafor <james.okafor@example.org>",
    "Volunteer Profiles row 3 · started 2026-02-15",
    "Last emailed: never",
    "November 2026 so far: 2.25 hours (1 shift)",
    "2026 so far: 2.25 hours (1 shift)",
    "All time: 2.25 hours (1 shift)",
    "Attached: volunteer-hours-to-2026-11-14.csv (1 shift)",
    "Check: 1 counted shift with an unreviewed flag (Log row 5): check them on the Flags tab before sending.",
    "Check: 1 row with Admin Alerts? set (Log row 5): read the Admin Alerts? cell on those Log rows before sending.",
  ]);
  assert.deepEqual(shown[4].text.split("\n"), [
    "Dev Patel: won't be sent. Volunteer Profiles row 4 has no email. Add it there, then press Preview again.",
    "Volunteer Profiles row 4 · started 2026-02-15",
    "Last emailed: never",
    "November 2026 so far: 1.00 hours (1 shift)",
    "2026 so far: 1.00 hours (1 shift)",
    "All time: 1.00 hours (1 shift)",
    "Attached: volunteer-hours-to-2026-11-14.csv (1 shift)",
  ]);
  assert.deepEqual(shown[5].text.split("\n"), [
    "Not on the volunteer list: won't be sent. Not on the volunteer list any more; press Preview again.",
    "Last emailed: never",
  ]);
  // James's one Log row has a flag and an alert: one flagged shift, not two.
  assert.equal(
    d.$("email-check").textContent,
    "Check before sending: 2 volunteers have something to check below, 1 flagged shift in all.",
  );
  // Each sendable block opens to the email exactly as the server built it; the one not on
  // the list has none.
  preview.volunteers.forEach((v, i) => {
    const details = shown[i + 1].children;
    if (!v.body) return assert.equal(details.length, 0);
    assert.equal(details[0].children[0].textContent, "Email text");
    assert.equal(details[0].children[1].textContent, "Subject: " + v.subject + "\n\n" + v.body);
  });

  d.$("initials").value = "JP";
  const sent = pressSend(d);
  assert.deepEqual(plain(sent.args[1]), {
    ticket: preview.ticket,
    ids: preview.sendIds,
    initials: "JP",
  });
  sent.answer(send);
  assert.equal(message(d), "Sent 3 of 3.");
  assert.deepEqual(detail(d).split("\n"), [
    "Maria Alvarez: sent to maria.alvarez@example.org",
    "Ana Diaz: sent to ana.diaz@example.org",
    "James Okafor: sent to james.okafor@example.org",
    "Left out at Preview:",
    "Dev Patel: Volunteer Profiles row 4 has no email. Add it there, then press Preview again.",
    "Not on the volunteer list: Not on the volunteer list any more; press Preview again.",
  ]);
  assert.equal(ticketOf(d), "");
  assert.equal(sendOff(d), true);
});

// ---------------------------------------------------------------------------
// The one writer

test("AdminDialog.html sets a button's disabled only inside buttonState()", () => {
  const start = SCRIPT.indexOf("function buttonState()");
  assert.notEqual(start, -1);
  const end = SCRIPT.indexOf("\n      }\n", start);
  const body = SCRIPT.slice(start, end);
  const all = [...SCRIPT.matchAll(/\.disabled\s*=(?!=)/g)].map((m) => m.index);
  assert.ok(all.length > 0);
  for (const at of all) assert.ok(at > start && at < end, "disabled written outside buttonState");
  assert.equal([...body.matchAll(/\$\("save"\)\.disabled\s*=(?!=)/g)].length, 2);
  assert.doesNotMatch(SCRIPT, /getElementById\("save"\)/);
});
