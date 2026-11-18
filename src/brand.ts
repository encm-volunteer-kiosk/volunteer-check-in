// The brand's own values on the page: its name, logo, closing lines and the prefix of
// every browser storage key and Web Lock name. Every other page file reads them here and
// names none of them itself. The server's are in apps-script/Brand.js, the colours and
// background graphic in brand.css.
//
// Node's tests import this file through listStore.ts and saveQueue.ts, so it imports no
// image: the logo is a URL Vite resolves, and inlines in the Apps Script build.

/**
 * The start of every localStorage, sessionStorage and Web Lock name. A tablet keeps what
 * it stored only while this stays the same.
 */
export const BRAND_STORAGE_PREFIX = "encm-";

/** A browser storage key or Web Lock name: the brand's prefix and the key's own suffix. */
export function brandKey(suffix: string): string {
  return BRAND_STORAGE_PREFIX + suffix;
}

/** The organisation's name, the logo's alt text while Settings "Organization name" is blank. */
export const BRAND_ORGANIZATION_NAME = "East Nashville Care Market";

/** The bundled logo, or null for a brand with none, which shows its name instead. */
export const BRAND_LOGO_URL: string | null = new URL("./assets/encm-logo.png", import.meta.url)
  .href;

/** The line under the appreciation message after a check-out. */
export const BRAND_THANKS_LINE = "Thanks for showing up for your East Nashville neighbors.";

/** The appreciation messages a check-in or check-out shows, in turn. */
export const BRAND_APPRECIATION_MESSAGES = [
  "Good neighbors show up. Thanks for being one.",
  "Your time helps make this community stronger.",
  "Every helping hand matters.",
  "East Nashville is better because neighbors care.",
  "Small acts of kindness make a big difference.",
  "Thanks for being part of what makes this neighborhood special.",
  "Neighbors helping neighbors. That's what it's all about.",
];

/** The local store's milestone messages (data.ts), by milestone id. */
export const BRAND_LOCAL_MILESTONE_MESSAGES: Record<string, string> = {
  "shift-1": "Your first day making a difference. Welcome to the neighborhood!",
  "shift-10": "10 times showing up for your neighbors. Thank you!",
  "shift-25": "25 shifts of showing up for East Nashville. That's something special.",
  "hours-50": "50 hours of care, kindness, and community.",
  "hours-100": "100 hours of making East Nashville stronger.",
};
