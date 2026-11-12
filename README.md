# Volunteer Check-In Kiosk

A tablet kiosk for the East Nashville Care Market (ENCM) volunteer break room, built at
GNTC Hack for the Community 2026 (Nashville Tech Builders). Volunteers type their name,
tap it, and sign in or out. Each shift becomes one row in a Google Sheet that ENCM owns,
so hours can be credited to each volunteer and reported to grantmakers.

## How it works

- **Kiosk page**: a React app (`src/`, from Josh's Figma Make design) with one search
  box and an on-screen keyboard. It is built into a single HTML file that the Apps
  Script web app serves. There is no name grid and no sign-up path, because every
  volunteer is registered before they volunteer.
- **Server**: Apps Script functions (`apps-script/Code.gs`) bound to a new Check-In Log
  spreadsheet with Log, Settings and Hours tabs.
- **Names**: read from ENCM's existing Volunteer Profiles sheet. The kiosk never writes
  to it.
- **Nightly**: a time-driven trigger closes shifts nobody signed out of, at that weekday's
  closing time from the Settings tab.

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

1. Install clasp, Google's command-line tool for Apps Script:
   `npm install -g @google/clasp`
2. Turn on the Apps Script API for your Google account at
   https://script.google.com/home/usersettings
3. Sign in: `clasp login`
4. Ask in Slack to be added as an editor on the shared development script. Its
   `.clasp.json` (script ID, `rootDir: apps-script`) gets committed once the script exists.
5. Push your changes: `clasp push`. Open the editor: `clasp open`.

The development script points at a copy of Volunteer Profiles built from the sample CSV,
never at ENCM's real file.

## Layout

```
src/, public/, index.html   kiosk front end (React 19, Vite, Tailwind 4) from Figma Make
.figma/, AGENTS.md          Figma Make's project files; keep them so Figma Make can re-import
apps-script/appsscript.json manifest: America/Chicago time zone, V8, web app settings
apps-script/Code.gs         server functions: doGet, getNames, getStatus, signIn, signOut, autoClose
apps-script/Index.html      the page doGet serves (placeholder until the build writes it)
sample-data/                invented volunteer profiles with the real column headers
```

Front end on its own: `pnpm install`, then `pnpm dev`. Until it is wired to Apps Script it
keeps data in the browser, with 24 invented volunteers. Shift+D opens its test tools.
