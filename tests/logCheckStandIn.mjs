// A stand-in for the Log check rules in Logic.js (logCheckProblems and the rest), for a
// server scope whose Logic.js doesn't define them. It knows two checks, "No Shift ID" and
// "Shift ID on more than one row", and keeps the real rules' keys, plan, counts and
// message, so the tests of the wiring in Jobs.js run either way. A scope that has the real
// rules keeps them: useLogCheckStandIn does nothing there. The fixtures in the tests that
// use it hold only problems of those two kinds, so both give the same answers.

import vm from "node:vm";

const SOURCE = `
function logCheckReasons() {
  return { "no-shift-id": "No Shift ID", "duplicate-id": "Shift ID on more than one row" };
}
function logCheckMaxNewFlags() {
  return 100;
}
function logCheckNoIdText() {
  return "(no Shift ID)";
}
function logCheckRowCount(entries) {
  return entries.filter((e) => !isBlankLogRow(e)).length;
}
function logCheckKey(shiftId, dateText, name, code) {
  return cellString(shiftId)
    ? "id|" + cellString(shiftId) + "|" + code
    : "row|" + cellString(dateText) + "|" + normalizeName(name) + "|" + code;
}
function logCheckProblems(entries, clock) {
  const reasons = logCheckReasons();
  const rows = entries.filter((e) => !isBlankLogRow(e));
  const byId = new Map();
  rows.forEach((e) => {
    const id = cellString(e.shiftId);
    if (id) byId.set(id, (byId.get(id) || []).concat([e.row]));
  });
  const out = [];
  const problem = (e, code, detail) =>
    out.push({
      code,
      key: logCheckKey(e.shiftId, e.dateText, e.name, code),
      label: reasons[code],
      reason: reasons[code] + ": " + detail,
      base: {
        date: cellString(e.dateText),
        name: e.name,
        shiftId: cellString(e.shiftId) || logCheckNoIdText(),
        logRow: e.row,
      },
    });
  rows.forEach((e) => {
    const id = cellString(e.shiftId);
    if (!id) problem(e, "no-shift-id", "the Shift ID cell is blank");
    const same = id ? byId.get(id) : [];
    if (same.length > 1 && same[0] === e.row) {
      problem(e, "duplicate-id", "rows " + same.join(", "));
    }
  });
  return out;
}
function logCheckFlagKey(flag) {
  if (cellString(flag.source) !== flagSourceLogCheck_()) return "";
  const reasons = logCheckReasons();
  const code = Object.keys(reasons).find(
    (c) => cellString(flag.reason).indexOf(reasons[c] + ":") === 0,
  );
  if (!code) return "";
  const id = cellString(flag.shiftId) === logCheckNoIdText() ? "" : flag.shiftId;
  return logCheckKey(id, flag.date, flag.name, code);
}
function flagSourceLogCheck_() {
  return flagSources().logCheck || "log check";
}
function logCheckPlan(problems, flags, nowMs, max) {
  const on = new Set(flags.map(logCheckFlagKey).filter((k) => k));
  const seen = new Set();
  const fresh = [];
  const byLabel = {};
  let already = 0;
  problems.forEach((p) => {
    if (seen.has(p.key)) return;
    seen.add(p.key);
    byLabel[p.label] = (byLabel[p.label] || 0) + 1;
    if (on.has(p.key)) already++;
    else fresh.push(p);
  });
  const newRows = fresh.slice(0, max).map(
    (p) =>
      flagRows(
        Object.assign({}, p.base, { raisedAtMs: nowMs, source: flagSourceLogCheck_() }),
        [p.reason],
      )[0],
  );
  return {
    newRows,
    found: seen.size,
    already,
    flagged: newRows.length,
    left: seen.size - already - newRows.length,
    byLabel,
  };
}
function logCheckMessage(r) {
  if (r.kind === "busy") return "The kiosk was busy, so nothing was flagged. Try again in a minute.";
  if (r.kind === "failed") return "The Log check failed: " + r.message;
  if (!r.found) return "Checked " + r.checked + " Log rows: no problems found.";
  const reasons = logCheckReasons();
  return (
    "Checked " + r.checked + " Log rows: found " + r.found + " problems. " +
    r.flagged + " flagged now on the Flags tab, " + r.already + " already flagged." +
    (r.left > 0 ? ", " + r.left + " more will be flagged next run" : "") +
    Object.keys(reasons)
      .filter((c) => r.byLabel[reasons[c]] > 0)
      .map((c) => "\\n  " + reasons[c] + ": " + r.byLabel[reasons[c]])
      .join("")
  );
}
`;

/** Puts the stand-in into ctx unless its Logic.js has the Log check rules. */
export function useLogCheckStandIn(ctx) {
  if (typeof ctx.logCheckProblems === "function") return false;
  vm.runInContext(SOURCE, ctx, { filename: "logCheckStandIn.mjs" });
  return true;
}
