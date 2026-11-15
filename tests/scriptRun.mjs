// A server reply as the page receives it through google.script.run. The value goes through
// JSON, which leaves out undefined fields and functions, and every object field whose value
// is null is then left out, at every depth. On the live server a null inside the list reply
// arrived missing (a volunteer's openShiftId, a step's id), while a null at the top of a
// check-out reply (milestone) arrived; this stand-in drops both, so the page is tested
// against the harder case. Array items are kept as they are.

export function viaScriptRun(value) {
  return dropNullFields(JSON.parse(JSON.stringify(value) ?? "null"));
}

function dropNullFields(value) {
  if (Array.isArray(value)) return value.map(dropNullFields);
  if (typeof value !== "object" || value === null) return value;
  const out = {};
  for (const [key, v] of Object.entries(value)) {
    if (v !== null) out[key] = dropNullFields(v);
  }
  return out;
}
