// The sheet's words on the page, and the Settings the page reads from the list reply.
//
// The page's text is written with the default words ("volunteer", "volunteers", "board
// member"). wordText gives it in the sheet's words, and gives it unchanged under the
// default words. It is the same rewrite as wordText in apps-script/Logic.js and the admin
// window's; a test holds the three to the same output.
//
// Plain TypeScript only (no enums, namespaces or parameter properties): the tests import
// this file in Node, which strips the types without a loader.

import { BRAND_LOGO_URL, BRAND_ORGANIZATION_NAME, BRAND_WORDS } from "./brand.ts";

/** The sheet's words. An article is "a" or "an". */
export type Words = {
  person: string;
  personArticle: string;
  people: string;
  staff: string;
  staffArticle: string;
};

const DEFAULT_WORDS: Words = {
  person: "volunteer",
  personArticle: "a",
  people: "volunteers",
  staff: "board member",
  staffArticle: "a",
};

/** The Settings the page reads from the list reply, as the server sends them. */
export type PageSettings = {
  words: Words;
  // Settings "Organization name", "" while blank.
  organizationName: string;
  // Settings "Logo link" when it starts https://, else "".
  logoLink: string;
  // The On/Off switches; missing (a server or a kept list older than them) reads all On.
  switches?: PageSwitches;
};

/** The Settings switches, true for On (kioskSwitches in apps-script/Logic.js). */
export type PageSwitches = {
  milestones: boolean;
  emailHours: boolean;
  importPastHours: boolean;
  arrivalChanges: boolean;
  checkOutChanges: boolean;
};

const SWITCH_NAMES: (keyof PageSwitches)[] = [
  "milestones",
  "emailHours",
  "importPastHours",
  "arrivalChanges",
  "checkOutChanges",
];

/**
 * The switches a reply sent: only false is Off, so a switch the reply doesn't carry reads On,
 * the kiosk as it was before it.
 */
function switchesOf(sent: unknown): PageSwitches {
  const r = typeof sent === "object" && sent !== null ? (sent as Record<string, unknown>) : {};
  return Object.fromEntries(SWITCH_NAMES.map((k) => [k, r[k] !== false])) as PageSwitches;
}

/** The switches the page goes by: the Settings', or all On when they have none. */
export const pageSwitchesOf = (s: PageSettings): PageSwitches => switchesOf(s.switches);

/** What the page shows while it has no list reply's Settings: the brand's. */
export const brandPageSettings: PageSettings = {
  words: BRAND_WORDS,
  organizationName: "",
  logoLink: "",
};

const wordsAreDefault = (w: Words) =>
  (Object.keys(DEFAULT_WORDS) as (keyof Words)[]).every((k) => w[k] === DEFAULT_WORDS[k]);

const capitalized = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);

const VERB_SENTENCES: [string, string][] = [
  ["Thank you for volunteering with us.", "Thank you."],
  ["Thank you for volunteering.", "Thank you."],
  ["Keep Volunteering", "Not yet"],
  ["without volunteering", "without doing the shift"],
];

const KEPT_NAMES = [
  "Volunteer Profiles",
  "volunteer profiles",
  "Volunteer First Name",
  "volunteer first name",
  "Volunteer Last Name",
  "volunteer last name",
  "Volunteer Phone",
  "volunteer phone",
  "Volunteer hour value",
  "Volunteer ID",
  "Volunteer Kiosk",
  "Volunteer Hours",
];

/**
 * Text written with the default words, in these words: the nouns, their capitals and the
 * article before them, with a sentence that uses the verb made neutral and interface names
 * kept. Under the default words, or none, the text comes back as it is.
 */
export function wordText(text: string, words?: Words): string {
  if (!words || wordsAreDefault(words) || text === "") return text;
  let out = text;
  for (const [from, to] of VERB_SENTENCES) out = out.split(from).join(to);
  return out.replace(
    /\b(?:([Aa]) )?(volunteer coordinator|[Vv]olunteers?|[Bb]oard members?)\b(?!-)/g,
    (match, article: string | undefined, noun: string, offset: number, whole: string) => {
      const rest = whole.slice(offset + (article ? 2 : 0));
      if (KEPT_NAMES.some((name) => rest.startsWith(name))) return match;
      const cap = (w: string, like: string) => (/^[A-Z]/.test(like) ? capitalized(w) : w);
      let word: string;
      let wordArticle = "a";
      if (/^volunteers$/i.test(noun)) {
        word = words.people;
      } else if (/^volunteer$/i.test(noun)) {
        word = words.person;
        wordArticle = words.personArticle;
      } else {
        // "a volunteer coordinator" is ENCM's other name for staff.
        word = /s$/.test(noun) ? words.staff + "s" : words.staff;
        wordArticle = words.staffArticle;
      }
      return article ? cap(wordArticle, article) + " " + word : cap(word, noun);
    },
  );
}

const isWord = (w: unknown) => typeof w === "string" && w.trim() !== "";
const isArticle = (a: unknown) => a === "a" || a === "an";

/** True for a words object the server sends: five non-blank words, each article a or an. */
export function isWords(w: unknown): w is Words {
  if (typeof w !== "object" || w === null) return false;
  const r = w as Record<string, unknown>;
  return (
    isWord(r.person) &&
    isArticle(r.personArticle) &&
    isWord(r.people) &&
    isWord(r.staff) &&
    isArticle(r.staffArticle)
  );
}

/**
 * The list reply's page Settings, or null when it sends no words: a server older than the
 * words, whose page reads as the brand's. A missing or bad organizationName or logoLink
 * reads as blank, the brand's, and a missing switch as On.
 */
export function pageSettingsOf(reply: Record<string, unknown>): PageSettings | null {
  if (!isWords(reply.words)) return null;
  const w = reply.words;
  const logo = reply.logoLink;
  return {
    words: {
      person: w.person,
      personArticle: w.personArticle,
      people: w.people,
      staff: w.staff,
      staffArticle: w.staffArticle,
    },
    organizationName: typeof reply.organizationName === "string" ? reply.organizationName : "",
    logoLink: typeof logo === "string" && logo.startsWith("https://") ? logo : "",
    switches: switchesOf(reply.switches),
  };
}

/** True for page Settings as pageSettingsOf gives them, as a kept list holds them. */
export function isPageSettings(s: unknown): s is PageSettings {
  if (typeof s !== "object" || s === null) return false;
  const r = s as Record<string, unknown>;
  return (
    isWords(r.words) &&
    typeof r.organizationName === "string" &&
    typeof r.logoLink === "string" &&
    (r.logoLink === "" || r.logoLink.startsWith("https://")) &&
    (r.switches === undefined ||
      (typeof r.switches === "object" &&
        r.switches !== null &&
        SWITCH_NAMES.every((k) => typeof (r.switches as Record<string, unknown>)[k] === "boolean")))
  );
}

/** The name the page shows for the organisation: Organization name, or the brand's. */
export const organizationNameOf = (s: PageSettings): string =>
  s.organizationName.trim() || BRAND_ORGANIZATION_NAME;

/** The logo the page shows: the Logo link, the brand's logo, or null for the name heading. */
export const logoUrlOf = (s: PageSettings): string | null => s.logoLink || BRAND_LOGO_URL;
