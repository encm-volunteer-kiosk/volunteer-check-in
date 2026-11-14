// The Log cache check the kiosk's next tap makes, for the tests of the script's other Log
// writers (Add, Fix, Remove and Restore a shift, the auto clock-out, an import block,
// setupSheets). Each of those writes the Log changed stamp; the kiosk path itself is tested
// in admin.test.mjs.

/**
 * A map of the Log as values hold it now (the data range, header first), as if a tap had
 * read the whole Log at readAt, and a function that says what the next tap at nowMs makes
 * of that map beside the stamp text given: "hit" or "miss (<reason>)". The map matches
 * the Log's layout, last row and volunteers, so only the stamp or the map's age can make
 * it a miss. ctx is a server scope with Logic.js and Sheets.js loaded.
 */
export function cachedLogMap(ctx, values, readAt) {
  const cols = ctx.logColumns(values[0].map((v) => ctx.cellText_(v)));
  const layout = ctx.logLayout(cols);
  const at = cols[ctx.logHeaderNames().token];
  const tokens = [
    ...new Set(
      values
        .slice(1)
        .map((row) => String(row[at] ?? "").trim())
        .filter(Boolean),
    ),
  ];
  const built = ctx.logTableStates(values, cols, ctx.logRead_(), [], tokens);
  const text = ctx.encodeLogMap({ readAt, layout, lastRow: values.length, states: built.states });
  return (stamp, nowMs) => {
    const got = ctx.logCacheRead(text, stamp, nowMs, layout, values.length, tokens);
    return got.miss ? "miss (" + got.miss + ")" : "hit";
  };
}
