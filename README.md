# Volunteer Check-In Kiosk

A tablet kiosk for the East Nashville Care Market (ENCM) volunteer break room, built at
GNTC Hack for the Community 2026 (Nashville Tech Builders). Volunteers type their name,
tap it, and sign in or out. Each shift becomes one row in a Google Sheet that ENCM owns,
so hours can be credited to each volunteer and reported to grantmakers.

## How it works

- **Kiosk page**: a React app (`src/`, from Josh's Figma Make design) with one search
  box that uses the tablet's own keyboard. It is built into a single HTML file that the
  Apps Script web app serves. There is no name grid and no sign-up path, because every
  volunteer is registered before they volunteer. The first time, a board member types
  the kiosk access code from the Settings tab; the tablet remembers it.
- **Server**: Apps Script (`apps-script/`) bound to a Check-In Log spreadsheet with Log
  and Settings tabs. Each shift is one Log row.
- **Names**: read from ENCM's existing Volunteer Profiles sheet. The kiosk never writes
  to it. Volunteers who share a name confirm the last four digits of their phone.
- **Not built yet**: the nightly close of shifts nobody signed out of, and an Hours tab.

Team design pages (private; ask Ethan for access):

- Architecture: https://claude.ai/artifact/G8J4rZYRa7iFwu4m5Kbn9t
- Open design questions: https://claude.ai/artifact/WZBAy72yrVp2p4wTRHyUe9

## Volunteer data rule

Real volunteer records (names, birth dates, addresses, phones, emergency contacts) never
go in this repo, a screenshot, a Slack message or a test. Build and test against
`sample-data/volunteer-profiles-sample.csv`. It has the real column headers and invented
people, including two volunteers named Maria and a Kate Sullivan beside a Kate
Sullivan-Price, for testing how the kiosk tells people apart. `.gitignore` blocks `*.xlsx`, `*.csv` (except `sample-data/`)
and `data/`. If you think real data got committed, say so in Slack right away; don't try
to fix it quietly.

## Setup

1. `pnpm install`
2. Install clasp, Google's command-line tool for Apps Script:
   `npm install -g @google/clasp`
3. Turn on the Apps Script API for your Google account at
   https://script.google.com/home/usersettings
4. Sign in: `clasp login`
5. Ask in Slack to be added as an editor on the shared development script. Its
   `.clasp.json` (script ID, `rootDir: apps-script`) is committed at the repo root once
   the script exists.
6. `pnpm push` builds the page and pushes everything in `apps-script/`. A push replaces
   the whole remote project, so change code here, never in the Apps Script editor.
7. Once, in the Apps Script editor, run `setupSheets` (creates the Log and Settings tabs),
   then `setupSampleProfiles` (builds an invented Volunteer Profiles file and points
   Settings at it). Then put a kiosk access code of at least 16 letters in Settings.

The development script points at a copy of Volunteer Profiles built from invented
sample data, never at ENCM's real file.

## Commands

```
pnpm dev         front end alone, with invented volunteers kept in the browser (two
                 Jordan Riveras try the phone step: 0142 and 0187). Any code of 16+
                 letters opens it; Shift+D opens its test tools.
pnpm test        server logic tests (Node)
pnpm build       the Figma Make build
pnpm build:gas   one self-contained page, copied to apps-script/Index.html
pnpm push        build:gas, then clasp push
```

## Layout

```
src/, public/, index.html   kiosk front end (React 19, Vite, Tailwind 4) from Figma Make
src/api.ts                  the page's calls: Apps Script when served by it, else local
.figma/, AGENTS.md          Figma Make's project files; keep them so Figma Make can re-import
apps-script/Api.js          doGet and the api* functions the page calls
apps-script/Logic.js        the rules, as plain functions the Node tests load
apps-script/Sheets.js       Log, Settings and Profiles access; setupSheets, setupSampleProfiles
apps-script/SampleData.js   invented Volunteer Profiles rows for development
apps-script/Index.html      the page doGet serves; a build output, not committed
scripts/copy-to-gas.mjs     checks the single-file build and copies it into apps-script/
tests/                      logic tests
sample-data/                invented volunteer profiles with the real column headers
```
