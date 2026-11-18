/**
 * The brand's own values on the server: its names, its milestone texts and the Settings
 * defaults it gives a new row. Every other server file reads them through these
 * functions and names none of them itself. The page's are in src/brand.ts.
 *
 * Functions only: Apps Script loads its files in an order the code can't rely on, so a
 * value here is read when a function runs, never while a file loads.
 */

/** The organisation's name, used where Settings "Organization name" is blank. */
function brandOrganizationName() {
  return "East Nashville Care Market";
}

/** The sender name of the kiosk's emails, used where Settings "Organization name" is blank. */
function brandSenderName() {
  return "ENCM Volunteer Kiosk";
}

/**
 * Settings rows whose default on a new sheet is the brand's own, as {row name: value}.
 * setupSheets writes a missing row with this value, and with the code's default
 * (settingsDefaults in Logic.js) for every row not named here. This brand names none.
 */
function brandSettingsDefaults() {
  return {};
}

/** Each milestone's message, by milestone id (milestones() in Logic.js). */
function brandMilestoneMessages() {
  return {
    "shift-1": "Your first day making a difference. Welcome to the neighborhood!",
    "shift-10": "10 shifts checked in here. Thank you for showing up for your neighbors!",
    "shift-25": "25 shifts checked in here. That's something special.",
    "hours-50": "50 hours logged here. 50 hours of care, kindness, and community.",
    "hours-100": "100 hours logged here, making East Nashville stronger.",
  };
}

/**
 * The sheet's colours (lookPalette in Logic.js): the page's colour tokens in brand.css
 * where they share a name, and light tints of them.
 */
function brandLookPalette() {
  return {
    navy: "#062f5a",
    teal: "#168c86",
    white: "#ffffff",
    band: "#eef7fc",
    open: "#fff4d6",
    alert: "#fbe3e2",
    reviewed: "#8a9aa8",
    section: "#dff3fb",
    yellow: "#f9bd2f",
    grey: "#52687b",
    blue: "#0669a9",
  };
}
