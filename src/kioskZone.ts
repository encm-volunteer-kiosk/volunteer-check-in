// The kiosk's time zone on the page: the zone of Settings "Time zone", which the list reply
// carries (timeZone in the page's Settings). The page shows every clock time in it, and
// tells one day from the next by it, as the server does.
//
// A list reply or a kept list without the zone (a server or a page older than the setting)
// reads as America/Chicago, the zone the kiosk always had, and so does a name this
// browser's Intl doesn't know. Until the page has a list it works on America/Chicago too.
//
// Plain TypeScript only (no enums, namespaces or parameter properties): the tests import
// this file in Node, which strips the types without a loader.

/** The zone of a reply or kept list that names none. */
export const UNNAMED_ZONE = "America/Chicago";

let zone = UNNAMED_ZONE;

/** True when this browser's Intl knows the zone name. */
function knownZone(name: unknown): name is string {
  if (typeof name !== "string" || name === "") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/** The zone a timeZone the server sent names: it, or America/Chicago (above). */
export const zoneOf = (sent: unknown): string => (knownZone(sent) ? sent : UNNAMED_ZONE);

/** The zone the page works in now. */
export const kioskZone = (): string => zone;

/** Makes the page work in the zone a timeZone the server sent names (zoneOf). */
export function setKioskZone(sent: unknown): void {
  zone = zoneOf(sent);
}

/** The calendar day of an instant in the kiosk's zone, or in tz, as YYYY-MM-DD. */
export function kioskDay(ms: number, tz: string = zone): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}
