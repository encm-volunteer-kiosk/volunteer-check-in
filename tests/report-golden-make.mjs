// Writes tests/report-golden.json: every golden Log's month reports (reportRows of
// monthReport: values, formats and kinds) as main 2e7c0da's Logic.js made them, before the
// report took periods. The golden month test in tests/reports.test.mjs holds today's month
// reports to this file. Run once, from the repo root:
//
//   node tests/report-golden-make.mjs [rev]
//
// rev defaults to 2e7c0da; Logic.js is read from that commit with git show.

import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import vm from "node:vm";
import { GOLDEN_LOGS, GOLDEN_MADE, goldenEntries } from "./report-golden-logs.mjs";

const rev = process.argv[2] || "2e7c0da";
const root = new URL("../", import.meta.url);
const source = execFileSync("git", ["show", rev + ":apps-script/Logic.js"], {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});
const L = {};
vm.runInNewContext(source, L);
const plain = (x) => JSON.parse(JSON.stringify(x));

const cases = [];
for (const log of GOLDEN_LOGS) {
  const { entries, cols } = goldenEntries(L, log);
  for (const month of log.months) {
    for (const rate of log.rates) {
      const report = L.monthReport(entries, month, rate, cols);
      const rows = plain(L.reportRows(report, month, GOLDEN_MADE.initials, GOLDEN_MADE.madeAt));
      cases.push({ log: log.name, month, rate, ...rows });
    }
  }
}
writeFileSync(
  new URL("tests/report-golden.json", root),
  '{"rev":' +
    JSON.stringify(rev) +
    ',"cases":[\n' +
    cases.map((c) => JSON.stringify(c)).join(",\n") +
    "\n]}\n",
);
console.log("wrote " + cases.length + " month reports from " + rev);
