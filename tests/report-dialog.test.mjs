// Tests for Kiosk admin > Hours report… in the browser: Report.html's whole <script> run in
// node:vm against a stub document that makes one element per id on first use, and a stub
// google.script.run that records each call and lets the test answer it.
//
// The window opens on Month, takes its lists, defaults and today from the one
// adminReportMonths reply, shows only the chosen kind's inputs, and sends only that kind's
// fields with the initials.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const html = readFileSync(new URL("../apps-script/Report.html", import.meta.url), "utf8");
const SCRIPT = html.slice(html.indexOf("<script>") + 8, html.lastIndexOf("</script>"));
const KINDS = ["month", "quarter", "year", "range", "all"];

class El {
  constructor(id) {
    this.id = id;
    this.listeners = {};
    this.hidden = false;
    this.disabled = false;
    this.value = "";
    this.className = "";
    this.textContent = "";
    this.options = [];
  }
  add(option) {
    this.options.push(option);
  }
  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }
  fire(type) {
    for (const fn of this.listeners[type] || []) fn({ type, target: this, preventDefault() {} });
  }
}

function dialog() {
  const els = new Map();
  const calls = [];
  const document = {
    body: { dataset: { key: "key-1", contact: "" } },
    getElementById(id) {
      if (!els.has(id)) els.set(id, new El(id));
      return els.get(id);
    },
  };
  function chain(onOk) {
    return new Proxy(
      {},
      {
        get(_, prop) {
          if (prop === "withSuccessHandler") return (fn) => chain(fn);
          if (prop === "withFailureHandler") return () => chain(onOk);
          return (...args) => calls.push({ name: prop, args, answer: onOk });
        },
      },
    );
  }
  const google = { script: { run: chain(), host: { close() {} } } };
  function Option(text, value) {
    this.text = text;
    this.value = value;
  }
  vm.runInContext(SCRIPT, vm.createContext({ document, google, Option, console }));
  return { $: (id) => document.getElementById(id), calls };
}

const REPLY = {
  ok: true,
  months: [
    { month: "2026-11", label: "November 2026" },
    { month: "2026-10", label: "October 2026" },
  ],
  defaultMonth: "2026-10",
  quarters: [
    { quarter: "2026-Q4", label: "Q4 2026 (October to December)" },
    { quarter: "2026-Q3", label: "Q3 2026 (July to September)" },
  ],
  defaultQuarter: "2026-Q3",
  years: [
    { year: "2026", label: "2026" },
    { year: "2025", label: "2025" },
  ],
  defaultYear: "2025",
  today: "2026-11-16",
};

function loaded() {
  const d = dialog();
  assert.equal(d.calls.length, 1);
  assert.equal(d.calls[0].name, "adminReportMonths");
  assert.deepEqual(d.calls[0].args, ["key-1"]);
  d.calls[0].answer(REPLY);
  return d;
}

const shown = (d) => KINDS.filter((k) => !d.$("row-" + k).hidden);

test("the window starts on Month, with only the month list shown", () => {
  const d = dialog();
  assert.equal(d.$("period").value, "month");
  assert.deepEqual(shown(d), ["month"]);
  assert.equal(d.$("make").disabled, true, "Make waits for the lists");
  d.calls[0].answer(REPLY);
  assert.equal(d.$("period").value, "month");
  assert.deepEqual(shown(d), ["month"]);
  assert.equal(d.$("make").disabled, false);
  assert.equal(d.$("period").disabled, false);
  assert.match(html, /<option value="month">Month<\/option>\s*<option value="quarter">/);
});

test("the lists and their defaults come from the reply", () => {
  const d = loaded();
  assert.deepEqual(
    d.$("month").options.map((o) => [o.text, o.value]),
    [
      ["November 2026 (2026-11)", "2026-11"],
      ["October 2026 (2026-10)", "2026-10"],
    ],
  );
  assert.equal(d.$("month").value, "2026-10");
  assert.deepEqual(
    d.$("quarter").options.map((o) => [o.text, o.value]),
    [
      ["Q4 2026 (October to December)", "2026-Q4"],
      ["Q3 2026 (July to September)", "2026-Q3"],
    ],
  );
  assert.equal(d.$("quarter").value, "2026-Q3");
  assert.deepEqual(
    d.$("year").options.map((o) => o.value),
    ["2026", "2025"],
  );
  assert.equal(d.$("year").value, "2025");
  assert.equal(d.$("from").value, "2026-01-01");
  assert.equal(d.$("to").value, "2026-11-16");
});

test("From carries max = today from the reply; To carries no max", () => {
  const d = loaded();
  assert.equal(d.$("from").max, "2026-11-16");
  assert.equal(d.$("to").max, undefined);
  for (const id of ["from", "to"]) {
    const tag = new RegExp('<input id="' + id + '"[^>]*>').exec(html)[0];
    assert.match(tag, /type="date"/);
    assert.doesNotMatch(tag, /\bmax=/, id + " has no max in the page itself");
  }
});

test("switching Period shows only that kind's inputs", () => {
  const d = loaded();
  for (const kind of [...KINDS, "month"]) {
    d.$("period").value = kind;
    d.$("period").fire("change");
    assert.deepEqual(shown(d), [kind], kind);
  }
});

test("Make sends only the chosen kind's fields and the initials", () => {
  const d = loaded();
  d.$("initials").value = "jp";
  d.$("from").value = "2026-03-15";
  d.$("to").value = "2026-06-30";
  const expected = {
    month: { period: "month", month: "2026-10" },
    quarter: { period: "quarter", quarter: "2026-Q3" },
    year: { period: "year", year: "2025" },
    range: { period: "range", from: "2026-03-15", to: "2026-06-30" },
    all: { period: "all" },
  };
  for (const kind of KINDS) {
    d.$("period").value = kind;
    d.$("period").fire("change");
    d.$("make").fire("click");
    const call = d.calls[d.calls.length - 1];
    assert.equal(call.name, "adminMonthlyReport", kind);
    assert.deepEqual(
      JSON.parse(JSON.stringify(call.args)),
      ["key-1", { ...expected[kind], initials: "jp" }],
      kind,
    );
    call.answer({ ok: true, tabName: "Report x", csvUrl: "c", pdfUrl: "p" });
    assert.equal(d.$("links").hidden, false);
  }
  assert.equal(d.calls.length, 1 + KINDS.length);
});
