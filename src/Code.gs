/**
 * Volunteer check-in kiosk: server side.
 *
 * This script is bound to the Check-In Log spreadsheet (tabs: Log, Settings, Hours).
 * It reads names from the Volunteer Profiles spreadsheet, whose file ID is on the
 * Settings tab, and never writes to it.
 */

/** Serves the kiosk page. */
function doGet() {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('Volunteer Check-In')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * Returns [{key, first, last}] for every volunteer in Volunteer Profiles.
 * key is a SHA-256 hash of the profile email, so email never reaches the tablet.
 * Never return phone, birth date, address or emergency contact.
 */
function getNames() {
  // TODO: read Profiles by ID from Settings, cache with CacheService.
  return [];
}

/** Returns {open: boolean, signedInAt: string|null} for today's shift. */
function getStatus(key) {
  throw new Error('getStatus is not built yet');
}

/** Appends an open shift row to the Log tab. Hold LockService.getScriptLock() while writing. */
function signIn(key) {
  throw new Error('signIn is not built yet');
}

/** Closes the open shift: sign-out time, hours, status closed. Same lock as signIn. */
function signOut(key) {
  throw new Error('signOut is not built yet');
}

/**
 * Runs nightly from a time-driven trigger. Closes shifts nobody signed out of,
 * using that weekday's closing time from the Settings tab, and flags them for staff.
 * What it records as hours is still an open question for ENCM.
 */
function autoClose() {
  throw new Error('autoClose is not built yet');
}
