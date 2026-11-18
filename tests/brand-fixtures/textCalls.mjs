// The calls the default-words golden holds: every family of server text staff and
// volunteers read (refusals, Settings sentences, How to rows, email subjects and bodies,
// the hours report, log check and setup messages, header names and notes), as
// [function name, arguments]. make.mjs builds them with the earlier release's Logic.js (L),
// so inputs made by its own planners (an hours email plan, a month report) are that
// release's, and keeps each call's arguments beside its output.

import { GOLDEN_LOGS, GOLDEN_MADE, goldenEntries } from "../report-golden-logs.mjs";

const plain = (x) => JSON.parse(JSON.stringify(x));

export function textCalls(L) {
  const calls = [];
  const call = (fn, ...args) => calls.push([fn, plain(args)]);

  // Refusals, each code of the earlier release.
  for (const code of Object.keys(L.refusalMessages())) call("refusal", code);
  for (const [code, detail] of [
    ["IMPORT_FILE_ID", ""],
    ["IMPORT_FILE", ""],
    ["IMPORT_TAB", "Historical Hours"],
    ["IMPORT_HEADERS", "Date"],
  ]) {
    call("importRefusal", code, detail);
  }
  for (const [kind, code] of [
    ["in", "ALREADY_IN"],
    ["out", "NOT_IN"],
  ]) {
    call("tapRefusalReason", kind, "9:05 AM", code);
  }
  call("reportMonthRefusal", "2026-12", "2026-11-18");
  call("hourValueBlankMessage");
  call("hourValueUnreadableMessage");

  // Settings and How to.
  call("settingsDescriptionHeader");
  call(
    "settingsDescriptionColumn",
    L.settingsDefaults("2026-11-13").map((r) => r[0]),
  );
  call("howToRows");

  // Header names and notes.
  for (const fn of [
    "logHeaders",
    "logHeaderNames",
    "flagHeaders",
    "flagHeaderNames",
    "logHeaderNotes",
    "flagHeaderNotes",
    "hoursEmailHeaders",
    "hoursRequestHeaders",
    "hoursHeaderNames",
    "hoursHeaderNotes",
    "hoursDateNote",
    "hoursSortStatusText",
    "hoursSortFailedText",
    "logCheckNoIdText",
    "hoursEmailSameNameText",
    "hoursEmailNoFileText",
    "requiredProfileHeaders",
  ]) {
    call(fn);
  }

  // The hours email: a plan made by the earlier release from a golden Log.
  const log = GOLDEN_LOGS[0];
  const { entries } = goldenEntries(L, log);
  const token = entries.find((e) => e.token).token;
  const volunteer = {
    id: "id-1",
    firstName: "Robin",
    lastName: "Example",
    phoneLast4: "0101",
    startDate: "2026-01-05",
    needsPhoneCheck: false,
    token,
    row: 2,
  };
  for (const [choice, today] of [
    ["this", "2026-11-18"],
    ["last", "2026-12-03"],
  ]) {
    const plan = L.hoursEmailPlan({
      volunteer,
      entries,
      flags: [],
      period: L.hoursEmailPeriod(choice, today),
      todayDate: today,
      listedTokens: [token],
    });
    call("hoursEmailMessage", { firstName: "Robin", plan, attach: false, contact: "Pat" });
    call("hoursEmailMessage", {
      firstName: "Robin",
      plan,
      attach: true,
      contact: "Pat at 555-0100",
      signature: "Pat\nFront desk",
      request: { date: today, unchecked: 2 },
    });
  }
  call("hoursEmailFromLine", "kiosk@example.org");
  for (const problem of ["no-email", "bad-email", "duplicate-token", "no-email-column"]) {
    call("hoursEmailProblemText", problem, [7, 9], "robin@example");
  }
  for (const code of [
    "bad-email",
    "checked-in",
    "contact",
    "duplicate-token",
    "flags-unreadable",
    "no-email",
    "no-email-column",
    "not-found",
    "send-failed",
    "stopped",
  ]) {
    call("hoursRequestHoldReason", code, "the reason");
  }
  for (const n of [1, 3]) {
    call("hoursRequestUncheckedLine", n);
    call("hoursRequestLeftOutReason", n);
    call("hoursRequestNotListedLine", n);
  }
  call("hoursRequestRunText", { sent: 2, held: 1, waiting: 3 });
  for (const mode of ["off", "auto", "approve"]) call("hoursRequestModeText", mode);

  // The flags email.
  const recent = [
    { date: "2026-11-15", name: "Robin Example", reason: "arrival differs by 20 min" },
    { date: "2026-11-14", name: "Sam Sample", reason: "shift longer than 8 hours" },
  ];
  call("flagsEmailMessage", {
    summary: { recent, unreviewed: 3 },
    autoClockOut: { stale: false, lastRun: "2026-11-16 04:02" },
    flagsUrl: "https://example.org/sheet#gid=7",
  });
  call("flagsEmailMessage", {
    summary: { recent: [], unreviewed: 0 },
    autoClockOut: { stale: true, lastRun: "" },
    flagsUrl: "u",
  });

  // The hours report and its lines.
  for (const month of log.months) {
    const report = L.monthReport(entries, month, log.rates[0], goldenEntries(L, log).cols);
    call("reportRows", report, month, GOLDEN_MADE.initials, GOLDEN_MADE.madeAt);
  }
  call("openShiftsLine", 2, "November 2026");
  call("lastRunText", "2026-11-18 04:00", "closed 2");

  // The log check and setup messages.
  const result = (o) => ({
    kind: "done",
    checked: 0,
    found: 0,
    already: 0,
    flagged: 0,
    left: 0,
    byLabel: {},
    ms: 1200,
    message: "",
    ...o,
  });
  call("logCheckMessage", result({ checked: 20 }));
  call(
    "logCheckMessage",
    result({
      checked: 20,
      found: 3,
      flagged: 2,
      already: 1,
      byLabel: { "no check-out": 2, "long shift": 1 },
    }),
  );
  call("logCheckMessage", result({ kind: "busy" }));
  call("setupReportsMessage", {
    views: { added: 1, updated: 0 },
    warnings: { added: 2 },
    hours: { monthlyHours: "deleted" },
    trigger: { kind: "installed", account: "owner@example.org" },
  });

  // Admin labels for a list with a same name.
  call("adminRosterLabels", [
    { firstName: "Sam", lastName: "Sample", row: 4, needsPhoneCheck: true, phoneLast4: "0102" },
    { firstName: "Sam", lastName: "Sample", row: 9, needsPhoneCheck: true, phoneLast4: "" },
    { firstName: "Robin", lastName: "Example", row: 2, needsPhoneCheck: false },
  ]);
  return calls;
}
