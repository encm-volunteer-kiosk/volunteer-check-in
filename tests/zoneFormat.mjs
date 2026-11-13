// A stand-in for Apps Script's Utilities.formatDate, built on Intl.DateTimeFormat, for the
// patterns the server uses: yyyy, MM, dd, HH, mm, ss, h and a, with any other characters
// copied as they are. Intl reads a time zone's whole history, local mean time included.

const formatters = new Map();

/** The wall-clock fields of a date in zone, as strings. */
export function zoneFields(date, zone) {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(zone, f);
  }
  const p = {};
  f.formatToParts(date).forEach((x) => (p[x.type] = x.value));
  return p;
}

/** Utilities.formatDate(date, zone, format) for the patterns above. */
export function formatInZone(date, zone, format) {
  const p = zoneFields(date, zone);
  const h = +p.hour;
  const tokens = {
    yyyy: p.year.padStart(4, "0"),
    MM: p.month,
    dd: p.day,
    HH: p.hour,
    mm: p.minute,
    ss: p.second,
    h: String(h % 12 || 12),
    a: h < 12 ? "AM" : "PM",
  };
  return format.replace(/yyyy|MM|dd|HH|mm|ss|h|a/g, (t) => tokens[t]);
}
