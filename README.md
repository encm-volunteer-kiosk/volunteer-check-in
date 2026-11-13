# Volunteer Check-In Kiosk

A tablet kiosk for the East Nashville Care Market (ENCM) volunteer break room, built at
GNTC Hack for the Community 2026 (Nashville Tech Builders). Volunteers type their name,
tap it, and sign in or out. Each shift becomes one row in a Google Sheet that ENCM owns,
so hours can be credited to each volunteer and reported to grantmakers.

## How it works

- **Kiosk page**: a React app (`src/`, from Josh's Figma Make design) with one search
  box that uses the tablet's own keyboard. The search ignores accents, apostrophes,
  periods, hyphens, capitals and extra spaces, so `jose` finds José and `obrien` finds
  O'Brien. It is built into a single HTML file that the Apps Script web app serves.
  There is no name grid and no sign-up path, because every volunteer is registered
  before they volunteer. The first time, a board member types the kiosk access code
  from the Settings tab; the tablet remembers it.
- **Server**: Apps Script (`apps-script/`) bound to a Check-In Log spreadsheet with Log
  and Settings tabs. Each shift is one Log row. The Log uses ENCM's own column names from
  their "2026-11 Log" sketch, then four columns of the kiosk's: Status, who entered the
  check-in, who entered the check-out, and Shift ID. Each end of a shift keeps two times:
  the time recorded when the volunteer tapped, and the time they stated.
- **Names**: read from ENCM's existing Volunteer Profiles sheet. The kiosk never writes
  to it. Volunteers who share a name confirm the last four digits of their phone, and the
  digits decide which of them is signed in or out.
- **Kiosk admin menu**: a menu in the Check-In Log spreadsheet for staff to add a shift a
  volunteer forgot to log, to close one they forgot to sign out of, or to make a monthly
  report (see below).
- **Flags tab**: each alert the kiosk writes is also copied to a Flags tab, one row per
  alert, for staff to tick off as reviewed (see Flags tab).
- **Reports**: a Monthly Hours tab that updates by itself, a frozen monthly report with
  CSV and PDF downloads, saved filter views on the Log, and a warning when someone edits
  a column the kiosk fills (see Reports).
- **Not built yet**: the nightly close of shifts nobody signed out of.

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

## The Log

The kiosk writes one tab named `Log`. A month is a filter on the Date column, not a tab of
its own. Other tabs in the spreadsheet, such as ENCM's "2026-11 Log", belong to staff; the
kiosk never reads or writes them. The one exception is `Import ledger`, which Import past
hours makes and adds to (see Kiosk admin menu).

Row 1 is the header and stays frozen. The kiosk finds each column by its header text, not
by its position, so staff can reorder columns, add columns of their own between them, and
sort rows. Line breaks, extra spaces and capital letters in a header don't matter. Don't
rename a kiosk header or keep two columns with the same kiosk header: the kiosk stops with
an error naming the column, and `setupSheets` puts a missing one back (see Setup).

| Column | Header                         | What it holds                                                          |
| ------ | ------------------------------ | ---------------------------------------------------------------------- |
| A      | Date                           | The shift's date in Central time, as `yyyy-MM-dd` text.                |
| B      | Day                            | The weekday of that date: Monday, Tuesday and so on.                   |
| C      | Volunteer Name                 | First and last name from Volunteer Profiles.                           |
| D      | Volunteer Role/Type            | Left blank for staff. The kiosk never writes it; reports group by it.  |
| E      | Check-In Recorded (timestamp)  | The server's clock when the volunteer tapped Check In.                 |
| F      | Check-In Stated (user)         | The arrival time the volunteer chose, or E when they chose none.       |
| G      | Check-Out Recorded (timestamp) | The server's clock when the volunteer tapped Check Out.                |
| H      | Check-Out Stated (user)        | The check-out time the volunteer chose, or G when they chose none.     |
| I      | Hours Served (timestamps)      | G minus E, in hours to 2 decimals.                                     |
| J      | Hours Served (stated)          | H minus F, in hours to 2 decimals.                                     |
| K      | Admin Alerts?                  | A note for staff when a stated time is far from the tap (below).       |
| L      | Activity                       | Left blank for staff. The kiosk never writes it; reports group by it.  |
| M      | Notes                          | Notes an admin types in the Kiosk admin menu; otherwise staff's own.   |
| N      | User Token                     | The volunteer's User Token from Volunteer Profiles, unhashed.          |
| O      | Status                         | `open` from check-in until check-out, then `closed`.                   |
| P      | Check-In Entered By            | `kiosk`, or the initials of the admin who entered the check-in.        |
| Q      | Check-Out Entered By           | `kiosk`, or the initials of the admin who entered the check-out.       |
| R      | Shift ID                       | A unique ID the kiosk gives each row; the admin menu finds rows by it. |

The letters are where a new Log puts each column. A to N are ENCM's headers, word for word.

### Recorded and stated times

A **recorded** time is the server's clock at the moment the volunteer tapped. A **stated**
time is the time the volunteer said, on the tablet's time picker, or the time an admin
entered in the menu. When a volunteer doesn't open the picker, the stated time is the
recorded time.

Each hours column pairs times of one kind: Hours Served (timestamps) uses the two recorded
times, Hours Served (stated) the two stated times. An hours cell is left blank when one of
its times is blank. Rows the admin menu adds or closes have no recorded time for the end
the admin entered, so their Hours Served (timestamps) is blank.

Milestones (first shift, 10 shifts, hours totals and so on) count Hours Served (stated),
from `closed` rows with the volunteer's User Token. Rows the admin menu writes count too,
but nobody is shown a milestone that a menu row crosses.

### Admin Alerts?

The kiosk writes these alerts here and nothing else:

- `arrival differs by N min`, at check-in, when the stated arrival is more than "Arrival
  flag minutes" (Settings) from the tap.
- `check-out differs by N min`, at check-out, when the stated check-out is more than
  "Check-out flag minutes" (Settings) from the tap.
- `check-in time unreadable, stated hours left blank`, at check-out, when someone has
  edited the row's check-in times into something the kiosk can't read, such as `9ish` or
  a time on another date. A time typed alone, such as `9:00 AM`, is read (see Rows typed
  by hand), so it doesn't raise this alert. The tablet still shows the volunteer as
  checked in, and the row still closes at check-out, with blank hours, and counts as a
  shift of 0 hours until staff fix the times and hours by hand.

Import past hours (Kiosk admin menu) writes one of these on an imported row whose name it
couldn't match to exactly one volunteer:

- `imported: no Volunteer Profiles match for this name; correct this row on the Log, not in
  the old sheet`
- `imported: name matches N Volunteer Profiles rows; correct this row on the Log, not in the
  old sheet`, when N volunteers share the name.

Check-out adds its alert after whatever the cell holds, joined with `; `. Text staff typed
there is kept.

Each alert the kiosk writes here is also copied to the Flags tab, one row per alert, for
review (see Flags tab). Text staff type here is not copied.

### User Token and who can see the Log

User Token is the same value as the Onboarding Token column in Volunteer Profiles; ENCM
prefers the name User Token. Profiles may head that column either "Onboarding Token" or
"User Token", but not both. The kiosk matches Log rows to a volunteer by this token.

The Log holds each volunteer's User Token unhashed, and the token is the secret in the
volunteer's onboarding link. **Share the Check-In Log spreadsheet as narrowly as Volunteer
Profiles.** The tablet never receives the token: it gets a hashed ID instead.

If a volunteer's token is regenerated in Profiles, the kiosk counts their shifts from zero
again. Staff can see the old token in the Log and change it by hand.

### Rows typed by hand

The admin menu is the supported way to add or fix a row. A row typed straight into the
sheet counts toward milestones only when it has the volunteer's User Token and Status
`closed`. The menu can close one only when it has a Shift ID and Status `open`. Leaving
Check-In Entered By and Check-Out Entered By blank marks a row as typed by hand.

Every time on a row is on that row's Date. A time typed alone, such as `9:00 AM` or
`2:30 pm`, is read as that time on the row's Date, in Central time, to the minute. This
works in a date-time cell, where Sheets stores it as a time on 30 December 1899, and in a
cell formatted as plain text. A full date and time, such as `2026-11-12 9:00 AM`, must
still be on the row's Date; one on any other day can't be read. Type a time, not a date
alone: a date with no time is not a time of day.

The kiosk takes a typed time as typed and never rewrites the cell. A check-out typed
before the check-in, such as `12:15 AM` for a shift that ran past midnight, is not
refused: its hours are whatever the hours cell holds, and the menu's overlap check passes
over that row. Hours already in a row are not worked out again when a time is fixed by
hand, so fix the hours too.

## Check-out time

Like the arrival time at check-in, the check-out time can be changed on the tablet. Most
volunteers never touch it: Check Out uses the server's clock.

After the phone step (for volunteers who share a name), the check-out screen shows "Forgot
to check out earlier? Change your check-out time". It opens the same hour, minute and
AM/PM buttons as the arrival picker, in 15-minute steps, and disables times later than now
or earlier than the volunteer's stated arrival. The link shows only when at least one
quarter-hour (:00, :15, :30, :45) falls between the stated arrival and now. It doesn't
show when the open row's check-in time can't be read (or, for volunteers who share a name,
any of their open rows'): there is no arrival to start from, so Check Out uses the
server's clock.

The server refuses a check-out time that is:

- more than 5 minutes in the future. Up to 5 minutes ahead is taken as now.
- on another day. The tablet only offers today.
- before the volunteer's stated arrival. Equal to it is accepted, for 0 hours.

A check-out earlier than the recorded check-in tap is allowed: a volunteer who states they
arrived at 9:00, taps in at 11:00 and states they left at 10:00 is credited 1 stated hour,
and the arrival alert marks the row. The server accepts any minute; the 15-minute steps
are only the tablet's.

## Flags tab

A flag is an alert the kiosk writes to Admin Alerts? on the Log: a stated arrival or
check-out far from the tap, a check-in time it couldn't read, or an imported name it
couldn't match. Each one is also copied
to a tab named `Flags`, one row per flag, so staff can tick it off once someone has looked
at it. The Log row is still the record: Admin Alerts? keeps every flag.

Only the kiosk adds Flags rows, at check-in and at check-out, and Import past hours, for
names it couldn't match. Add a shift and Fix a sign-out add none: shifts added or closed
with them carry the admin's initials in the Entered By columns and show in the `Kiosk:
Admin-entered` filter view (see Reports). Editing the Log by hand adds no Flags row.

Import past hours adds one Flags row per unmatched name per run, not one per row: Source
`import`, the Reason is the row's alert with the name's row count in that run added (`(14
rows in this import)`), and Date, Shift ID and Log Row are those of the name's first new
row. The other rows of that name carry the alert in Admin Alerts? and show in the `Kiosk:
Flagged` view.

| Column | Header         | What it holds                                                     |
| ------ | -------------- | ----------------------------------------------------------------- |
| A      | Date           | The Log row's Date.                                               |
| B      | Volunteer Name | The Log row's Volunteer Name.                                     |
| C      | Shift ID       | The Log row's Shift ID: the sure way to find the row on the Log.  |
| D      | Reason         | The alert, word for word as in Admin Alerts?.                     |
| E      | Raised At      | The server's clock when the kiosk raised it.                      |
| F      | Reviewed       | A tickbox. Tick it once you've looked at the flag.                |
| G      | Reviewed By    | Your initials.                                                    |
| H      | Notes          | What you found or did.                                            |
| I      | Source         | `kiosk check-in`, `kiosk check-out` or `import`.                  |
| J      | Log Row        | The Log row number then. A hint only: sorting the Log moves rows. |

To review: open Data > Filter views > `Flags: Unreviewed`. It shows the flags not yet
ticked, newest first. Tick Reviewed, type your initials in Reviewed By, and add a note if
there's something to say. A ticked flag leaves the view. The sheet's edit history (right
click a cell > Show edit history) shows who ticked it and when.

The kiosk only adds rows to this tab. It finds its columns by header, as on the Log. Only
the weekly flags email (see Daily jobs) reads Flags rows, and only to count and list them,
so sorting, filtering or deleting Flags rows is safe, and so are columns of your own.
Reviewed By and Notes are yours; the kiosk never writes them. There is no User Token on
this tab; find it on the Log row by Shift ID if you need it.

A flag can be missing from this tab only when the tab was broken at the time (renamed,
deleted or missing a header), or when a row typed by hand with no Shift ID is closed at
the tablet. The check-in or check-out still goes through, the
flag is still in Admin Alerts? and in the `Kiosk: Flagged` view, and the Apps Script
executions log has a line `Flags: not copied for Shift ID ...`. Run `setupSheets` to repair
the tab. Flags raised before the Flags tab was added are only in Admin Alerts?.

### Two counts of flagged

"Flagged rows" on Monthly Hours and the flagged rows in the monthly report count **Log
rows** in the month whose Admin Alerts? isn't blank, and the `Kiosk: Flagged` filter view
shows every such Log row. The Flags tab lists **each flag**, with whether someone has
reviewed it. A check-out can raise two flags on one row, and staff can type in Admin
Alerts? too, so the counts differ on purpose.

## Settings

The Settings tab holds one value per row, name in column A and value in column B.
`setupSheets` adds any missing row with its default and never changes a value that is
there.

| Setting                       | Default                         | What it does                                                                               |
| ----------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------ |
| Kiosk access code             | blank                           | The code a board member types on the tablet; at least 16 letters.                          |
| Volunteer Profiles file ID    | blank                           | The Volunteer Profiles spreadsheet the roster comes from.                                  |
| Volunteer Profiles tab        | Volunteer Profiles              | The tab in that file.                                                                      |
| Kiosk launch date             | the day `setupSheets` first ran | Only volunteers whose Profiles start date is on or after it get the first-shift milestone. |
| Arrival flag minutes          | 15                              | How far a stated arrival may be from the tap before it gets an alert.                      |
| Check-out flag minutes        | 15                              | How far a stated check-out may be from the tap before it gets an alert.                    |
| Volunteer hour value          | blank                           | The dollar value of one volunteer hour, for the monthly report (see Reports).              |
| Profiles problems             | blank                           | Written by the kiosk: Profiles rows it had to leave out, and why.                          |
| Closing time Monday to Sunday | 17:00                           | Not read. The auto clock-out takes shift times from the `Shifts` tab instead.              |
| Auto clock-out after hours    | 12                              | Hours after the check-in tap that an open row stays on the tablet. 10 to 24 (below).       |
| Auto clock-out last run       | blank                           | Written by the auto clock-out: when it last ran, Central, and how many rows it closed.     |
| Long shift flag hours         | 8                               | A tablet check-out crediting more hours than this is flagged (below).                      |
| Flags email                   | Off                             | `On` (any capitals) turns the weekly flags email on; anything else is off.                 |
| Flags email to                | blank                           | Who gets it: addresses separated by commas, semicolons, spaces or new lines.               |
| Flags email day               | Monday                          | The day it sends: an English weekday, in full or its first three letters.                  |
| Flags email hour              | 8                               | The hour it sends, Central: a whole number from 0 to 23.                                   |
| Flags email last run          | blank                           | Written by the weekly email: when it last ran, and `sent to N` or `nothing to send`.       |
| Daily jobs installed by       | blank                           | Written by `setupDailyJobs`: the account that owns the daily jobs.                         |
| Past hours file ID            | blank                           | Fills in the Import past hours window; an import that adds rows saves what it used.        |
| Past hours tab                | Historical Hours                | The same, for the tab.                                                                     |

"Auto clock-out after hours" is read as given from 10 to 24; anything else, blank or
unreadable, reads as 12. A window shorter than a shift plus some slack would take a
volunteer who is still there off the tablet: they would show as not checked in, could
check in a second time, and both rows would get a guessed time.

"Long shift flag hours": a tablet check-out whose stated hours (from the stated arrival to
the stated check-out, the hours the row is credited) are more than this gets an alert in
Admin Alerts? and a Flags row, whatever the clock or date. Exactly this many is not
flagged. A blank, 0, negative or unreadable value reads as 8.

"Check-out flag minutes" is new with the check-out time picker, "Volunteer hour value"
with the reports, and the rows from "Auto clock-out after hours" down with the daily jobs.
On a spreadsheet set up before them, run `setupSheets` once to add them.

## Kiosk admin menu

Opening the Check-In Log spreadsheet adds a **Kiosk admin** menu with four items: Add a
shift, Fix a sign-out, Monthly report, which is described under Reports, and Import past
hours. Anyone
who can edit the spreadsheet can use it. It runs as whoever has the sheet open, which at
ENCM is the shared account, so:

- that account must be able to read Volunteer Profiles, because the menu reads the roster
  from it;
- the first time the account uses the menu, Google asks it to authorize the script. Accept
  once and the menu works from then on.

Each item opens a small window. Every save asks for the admin's **initials**: 1 to 5
letters, with spaces and dots dropped, stored in capitals (`j.p.` is stored as `JP`). The
initials go in Check-In Entered By and Check-Out Entered By, since everyone at ENCM signs
in as the same account. A window stops working after 30 minutes; close it and open the
menu again. If a save is refused, the window says why and keeps what was typed.

The "type to search" box in Add a shift and Fix a sign-out ignores accents, apostrophes,
periods, hyphens, capitals and extra spaces, the same as the kiosk's name box. Every word
typed must appear in an entry, in any order.

### Add a shift

For a volunteer who forgot to check in and out and told an admin afterwards. The window
asks for:

- the volunteer, from a search over the roster. Volunteers who share a name are listed
  with their Profiles row and the last four digits of their phone, so you can tell them
  apart and check Profiles.
- the date, any day up to today.
- the check-in time and the check-out time, to the minute, as the volunteer reported
  them.
- an optional note, up to 500 characters.
- your initials.

It refuses, and says why, when:

- the initials are missing or aren't 1 to 5 letters. Type them again.
- the note is over 500 characters. Shorten it.
- the volunteer is no longer in Volunteer Profiles. Close the window and open it again
  to get the current roster.
- the date or a time can't be read. Enter it again.
- the date or a time is in the future. Up to 5 minutes ahead is taken as now.
- the check-out is before the check-in. Correct one of the times.
- the volunteer has an open shift on that date. Close it with Fix a sign-out first, then
  add the shift.
- the shift overlaps another of the volunteer's shifts that date. The message gives the
  other shift's times and its Log row. Correct the times, or fix that row in the sheet if
  it is the wrong one. Shifts that only touch, one ending as the other starts, are
  accepted.
- the window has been open more than 30 minutes. Close it and open the menu again.

The new row gets Date, Day, Volunteer Name, both stated times, Hours Served (stated), the
note in Notes, User Token, Status `closed`, a new Shift ID, and your initials in both
Entered By columns. The two recorded times and Hours Served (timestamps) stay blank, and
no alert is written.

### Fix a sign-out

For a volunteer who left without checking out. The window lists every `open` row that has
a Shift ID, from any date, newest first, and asks for the check-out time (to the minute),
an optional note and your initials. The time is on the row's own date.

It refuses, and says why, when:

- the initials are missing or aren't 1 to 5 letters, or the note is over 500 characters,
  as for Add a shift.
- the row is no longer open: it was closed, deleted or had its Shift ID changed since the
  window opened. Close the window and open Fix a sign-out again.
- more than one open row has that Shift ID, as when a row was copied in the sheet. Fix or
  delete the extra row in the sheet, then try again.
- the row's Date or check-in time can't be read, so its hours can't be worked out: a
  check-in such as `9ish`, or a time on another date. A time typed alone, such as
  `9:00 AM`, is read on the row's Date. The list shows such a row as "check-in time
  unreadable". Fix the Date or check-in time in the sheet, then try again.
- the time can't be read, or is in the future. Up to 5 minutes ahead is taken as now.
- the time is before the row's check-in. Correct the time; if the check-in time itself
  is wrong, fix it in the sheet first.
- the shift would overlap another of the volunteer's shifts that date. The message gives
  the other shift's times and its Log row. If the open row's check-in falls inside that
  other shift, every check-out time would overlap it, and the message says so: correct or
  delete one of the two rows in the sheet first.
- the window has been open more than 30 minutes. Close it and open the menu again.

The row gets Check-Out Stated, Hours Served (stated), Status `closed` and your initials in
Check-Out Entered By. A note is added after whatever Notes holds. Check-Out Recorded and
Hours Served (timestamps) stay blank. Any open row can be fixed, today's included; the
tablet shows the volunteer as not checked in at its next refresh.

### Import past hours

For bringing shifts from an old hours sheet into the Log, such as ENCM's "Old Volunteer
Hours". It can be run again at any time: it never brings in the same shift twice.

The window asks for the spreadsheet (paste its link or its ID), the tab, and your initials.
The account at the sheet needs to be able to open that spreadsheet. The first time, the tab
is `Historical Hours`; after a run that writes, the window offers the spreadsheet and tab
that run used, kept in the Settings rows "Past hours file ID" and "Past hours tab".

**The tab's layout**: a header row, then one row per shift. Columns are found by header,
as on the Log:

- `Date`, `First name` and `Last name` must be there.
- Hours are in the column headed `Hours`, or, when there is none, in the column right
  after `Last name` (ENCM's tab leaves it without a header).
- `Source cell`, and the column without a header just left of it, which names the month
  tab, are optional. They are copied into the row's Notes.

**Preview** reads the tab and writes nothing. It shows the rows read; how many it would
import, split into names matched to Volunteer Profiles and names not matched; the
unmatched names with their row counts, so you can fix Profiles first; how many are already
imported; rows left out, with their row numbers and why; and the hours it would add.
**Import** works the list out again and writes it, then says what it did.

A row is **left out** when its Date isn't a day (`yyyy-MM-dd`, `m/d/yyyy` or a date the
sheet holds as a date), its Date is after today or on or after "Kiosk launch date", it
has no first or last name, or its hours aren't a number above 0 and at most 24. Left-out
rows aren't remembered: fix them in the old sheet and run the import again.

Both Preview and Import refuse while "Kiosk launch date" in Settings is blank or isn't a
date. Shifts from the launch date on are the kiosk's own, and importing them would count
them twice.

Each imported row gets:

- Date and Day; the source's hours in Hours Served (stated); Status `closed`; `import` in
  both Entered By columns; and a Shift ID starting `import-`.
- No times: the four time columns and Hours Served (timestamps) stay blank.
- When the name matches exactly one volunteer in Profiles (first and last name, ignoring
  capitals and extra spaces), that volunteer's name and User Token.
- When it matches none, or several volunteers who share the name: the name as written in
  the old sheet, the stand-in User Token `import:` followed by the name in small letters
  (`import:jane doe`), and an alert in Admin Alerts?. One Flags row per name (see Flags
  tab). The rows count in every report under that name, as one volunteer. When you know
  who it is, type the volunteer's real User Token over the stand-in on each row. Nothing
  changes or deletes these rows on its own.
- In Notes, when the Log has a Notes column: `Imported by JP from Old Volunteer Hours ›
  Historical Hours row 12 (2025.12 C3)`.

**The Import ledger.** The first run that writes makes a tab named `Import ledger`, and
every run adds one line per imported shift: its source key, Shift ID, when and by whom,
and the file, tab and row it came from. A shift's source key is its date, its name as
written, and its count among rows with that date and name. A run skips every key the
ledger holds, so a second run adds nothing, and a row you delete from the Log stays
deleted. Deleting the ledger tab, or lines of it, makes those shifts come back on the next
run. Don't edit it.

**Correct an imported row on the Log, never in the old sheet.** Its name and date are its
key, so a name or date fixed in the old sheet looks like a new shift, and the next run
would import it again beside the old row. Fix the name, User Token, date or hours on the
Log. Only rows the preview left out are fixed in the old sheet.

Rows are written in blocks of 250, each taking the kiosk's lock for a few seconds, so the
tablet keeps working during an import. If a run stops part way (the kiosk was busy, or
Google's 6-minute limit was near), the window says so; whole blocks are kept, and running
it again brings in the rest.

### What the menu won't do

It doesn't edit a closed row, change a check-in time, or delete a row. Staff change those
cells by hand in the sheet.

It can't close an open row whose Date or check-in time can't be read. Fix that cell by
hand first, then use Fix a sign-out. If the row is dated today, the volunteer can still
check out on the tablet instead: the row closes with blank hours and the
`check-in time unreadable, stated hours left blank` alert, and staff then fix the times
and hours by hand.

A note needs a Notes column. If the Log has none, the save stops with an error that says
to run `setupSheets`, which adds it.

The menu can't be reached from the kiosk page. Every menu function checks that it was
called from the open spreadsheet, through a window the menu opened.

## Daily jobs

Jobs the script runs on its own, on Google's timed triggers: the weekly flags email,
checked every hour. They live in `apps-script/Jobs.js`.

### Who runs them

The jobs run as the account that installed them, and only that account. At ENCM that is
a Workspace account kept for the kiosk. It needs edit access to the Check-In Log
spreadsheet; it doesn't need Volunteer Profiles.

To install them, sign in to Google as that account, open the Check-In Log, then
Extensions > Apps Script, choose `setupDailyJobs` in the function list and Run it. Accept
the permissions Google asks for. It deletes that account's own earlier job triggers,
makes one trigger per job, and writes the account into Settings "Daily jobs installed
by". Running it again replaces the account's triggers, so there is never a second copy.
The editor's Triggers page (the clock icon) shows them.

- **Failures.** When a job fails, Google emails a failure summary to the account that
  owns the trigger, and to nobody else. Make sure someone reads that account's mail, or
  forward it.
- **After a push that adds a permission**, the owner must open the Apps Script editor and
  run `setupDailyJobs` again (or any function) to authorize it. Until then every job run
  fails, and only the owner hears about it.
- **Other accounts are asked too.** Google's permissions belong to the whole script, so
  the account that deploys the web app and the account that uses the Kiosk admin menu are
  also asked to allow sending email and managing triggers the next time they run
  something. They never send email or install a trigger; accept so the menu and kiosk keep
  working.
- **Moving the jobs to another account.** Google lets an account see and delete only its
  own triggers. Signed in as the old owner, run `removeDailyJobs`: it deletes that
  account's job triggers and clears "Daily jobs installed by" if it names that account.
  Then install them as the new owner. If the old account can't sign in any more, its
  triggers stop when the account is disabled or removed.

`setupDailyJobs` and `removeDailyJobs` run only from the editor. The jobs themselves run
only from their own triggers: run from the editor or the kiosk page they refuse. Two
accounts' triggers running side by side would not send twice; each job checks its
last-run row first, under the kiosk's lock.

### Weekly flags email

Every hour the email job checks Settings. It sends nothing until "Flags email" is `On`
and "Flags email to" holds at least one address. Then it sends once a week, at the first
hourly run on or after "Flags email day" at "Flags email hour" (Central), and writes
"Flags email last run". A run that couldn't send is caught up by the next hourly run. A
changed day or hour applies at once. To send again this week, clear "Flags email last
run": the next hourly run sends.

The email comes from the owner account's domain no-reply address, named "ENCM Volunteer
Kiosk". It says:

- how many flags were raised in the last 7 days, and how many are still unreviewed, of
  any age (rows with a Volunteer Name or Shift ID whose Reviewed isn't ticked, the same
  rows the `Flags: Unreviewed` view shows plus any staff typed without a Shift ID);
- a link that opens the Flags tab;
- the week's flags, newest first: date, name and reason, up to 25, then "and N more";
- first, when the auto clock-out hasn't run for more than 2 days (or ever), a warning that
  open shifts aren't being closed, with when it last ran;
- last, any entries in "Flags email to" that aren't email addresses, which were skipped.

When there is no new flag, none unreviewed and no warning, it sends nothing and writes
`nothing to send`. The email holds volunteers' names and flag reasons, never a User
Token. A missing or broken Flags tab makes the run fail (and the owner gets Google's
failure email) rather than send a wrong count. If the run finds the kiosk's lock busy for
30 seconds, it stops and the next hourly run catches up.

## Reports

There are four tools for staff. All of them read the Log tab and none of them changes a
Log cell. No report shows a User Token: tokens are read only to tell volunteers apart.

- the **Monthly Hours** tab, a live table for the month you pick;
- **Monthly report** in the Kiosk admin menu, which writes a report tab for a month and
  gives you that tab as a CSV or PDF download;
- saved **filter views** on the Log, for finding rows to check;
- a **warning** when someone edits a column the kiosk fills.

`setupReports` builds the first, third and fourth (see Setting up the reports).

### Which rows count

- A row **counts** when its Status is `closed` and it has a User Token. Only counted rows
  add shifts, hours or volunteers to any figure.
- **Hours** means Hours Served (stated), the hours ENCM credits and milestones count. The
  only figure that uses Hours Served (timestamps) is the adjustments line (calculation 8).
- A row's **month** comes from its Date, which must be a real day written `yyyy-MM-dd`
  (a date the sheet holds as a date works too). A row with any other Date is in no month:
  it counts in no month's figures and is listed for review in every report. The Day
  column is never read; the weekday comes from the Date.
- A **volunteer** is a User Token. The report shows the Volunteer Name from that
  volunteer's latest counted shift in the month.
- An **open** row (Status `open`) counts nowhere: no shift, no hours, not a volunteer.
  The report lists open rows first under rows to review, and its first lines say how many
  there are: "N open shifts in this month are not counted. Close them with Fix a
  sign-out, then make the report again."
- A row **added or closed with the Kiosk admin menu** counts like any other closed row
  with a User Token, using its stated hours. It has no recorded time for the end the admin
  entered, so it is never in the adjustments comparison. It is listed under rows entered
  by an admin, with the initials.
- **Auto-closed rows**: the nightly close isn't built, and what it will write isn't
  decided. Whatever it writes, a row with a Status other than `open` or `closed` is not
  counted and is listed for review. A row whose Check-In Entered By or Check-Out Entered
  By holds something other than `kiosk` or initials, such as `auto-close`, is listed for
  review too, and counts if it is `closed` with a User Token.
- **Imported rows** (Import past hours, Kiosk admin menu) are `closed`, have a User
  Token and Hours Served (stated), and count in the month of their Date. They have no
  times, so they are never in the adjustments comparison; a report lists them under rows
  entered another way (`in "import", out "import"`), and an unmatched one under flagged
  rows too. A report for an imported month lists every imported row for review. Importing
  changes reports made afterwards, including for kiosk months:
  - **New volunteers**: a volunteer's first shift is their first in the whole Log, so a
    volunteer with imported shifts is new in the month of the earliest, not when they first
    used the kiosk.
  - **Milestones** are counted over every counted row, so a milestone may now be crossed
    in an imported month instead of a later one. The kiosk counts imported hours toward
    milestones too, so a volunteer with years of hours isn't told at check-out that they
    reached 50 hours for the first time.
  - The **`Kiosk: Other status or source`** view shows every imported row.

### Monthly Hours tab

Pick a month in B1 from the list. The list has every month with a Log row, up to this
month, newest first. The tab then shows that month's stated hours, shifts, volunteers,
average shift, open shifts not counted, and flagged rows, and under them each volunteer
with their shifts and stated hours, sorted by name.

The tab updates by itself as the Log changes. It changes nothing in the Log. Hidden
columns hold the month's rows that the formulas read; leave them hidden.

Two volunteers with the same name show as two lines with the same name here. The monthly
report tells them apart.

The tab warns before any edit except the month in B1. If someone types over a formula
anyway, or the tab shows `#REF!`, run `setupReports` to put it back.

### Monthly report

**Monthly report** in the Kiosk admin menu opens a small window. Choose the month (it
starts on last month, or this month when last month has no rows) and type your initials,
as for the other menu items.

The report is written to a new tab named for the month, such as `Report 2026-11`. Making
a second report for the same month makes a new tab, `Report 2026-11 (2)`. The script
never changes a report tab after writing it, so each one is a record of the Log as it was
when the report was made. Delete old report tabs by hand when you no longer need them.
Report tabs warn before an edit.

The window then shows two links, **Download CSV** and **Download PDF**. Each downloads
that report tab only, not the rest of the spreadsheet. The links work for anyone signed in
to Google who can open the spreadsheet.

The report's first lines say what it counts and who made it: "Counts closed shifts with a
User Token, using stated hours. Made 2026-12-01 9:14 AM by JP from the Log tab." Log row
numbers in the report are as of that moment; sorting the Log later changes them.

The window refuses, and says why, when:

- the initials are missing or aren't 1 to 5 letters;
- no month is chosen ("Please choose a month."), or the month is after this one;
- the kiosk is busy writing a row. Try again in a moment;
- the window has been open more than 30 minutes. Close it and open the menu again.

If the Log is missing a column the kiosk needs, the window shows the same message the kiosk
gives, and no report is made. Run `setupSheets`, then try again.

### What the report shows

Every figure uses the month's counted rows and their stated hours, unless it says
otherwise.

1. **Stated hours**: the month's stated hours added up. A stated hours cell that is blank,
   negative or not a number adds nothing. A number typed as text, such as "2.5", is read
   as that number. Each such row is listed for review, which is why the total can differ
   from a plain SUM of the column on those rows.
2. **Hours per volunteer**: each volunteer's shifts and stated hours, by name, with a
   total line. When two volunteers share a name, each name gets the date of that
   volunteer's first shift ("Ana Ruiz · first shift 2026-11-03"), and the Log row too if
   that date is the same.
3. **Shifts and volunteers**: shifts is the number of counted rows; volunteers is the
   number of different User Tokens among them.
4. **New volunteers**: volunteers whose first counted shift in the whole Log is in this
   month, with their names. Only the Log tab is read, so in the first month the kiosk is
   used, every volunteer is new.
5. **Average shift**: stated hours divided by shifts, to two decimals. Blank when there
   are no shifts.
6. **Hours by weekday**: shifts and stated hours for each day, Monday to Sunday, from the
   Date.
7. **Hours by Role/Type, and by Activity**: shifts and stated hours for each value in
   those columns. Capital letters don't matter. A blank cell shows as "(not set)". If the
   Log has no such column, the table says "(no Role/Type column)" or "(no Activity
   column)".
8. **Adjustments**: the only figure that uses Hours Served (timestamps). It looks at
   counted shifts that have all four times and a number in Hours Served (timestamps),
   which in practice means shifts signed in and out at the kiosk. A shift is adjusted when, at either end, the
   stated time is 30 seconds or more from the tap. The report gives how many were
   adjusted of how many it looked at, and stated hours minus timestamp hours over those
   shifts.
9. **Rows to review**: lines with the date, name, Status and Log row, in these groups,
   each with its count:
   - open shifts in the month, not counted;
   - flagged rows in the month (Admin Alerts? not blank);
   - rows in the month entered by an admin, with the initials;
   - rows in the month whose Status is not `open` or `closed`, not counted;
   - rows in the month with an end typed into the sheet or entered another way;
   - counted shifts in the month whose stated hours are blank, text or negative;
   - closed rows in the month with no User Token, not counted;
   - rows anywhere in the Log whose Date isn't `yyyy-MM-dd`, in no month.
10. **Year to date and milestones**: stated hours, shifts and volunteers from 1 January to
    the end of the month. Then every milestone a volunteer crossed this month (10 shifts,
    50 hours and so on), counted over the whole Log with stated hours, the way the kiosk
    counts them. A milestone is listed on the date of the shift that reached it. A shift
    added later with Add a shift for an earlier date can move that date. The first
    completed shift isn't listed here; new volunteers covers it. A shift whose Date can't
    be read has no place in date order, so it is left out of new volunteers and
    milestones, and listed for review.
11. **Volunteer value**: stated hours times the "Volunteer hour value" in Settings, to the
    cent.
12. **Month over month**: stated hours, shifts, volunteers and new volunteers for this
    month and the month before, with the change and the percent change to one decimal.
    The percent shows "n/a" when the month before had none.

### Volunteer hour value

This Settings row is blank until ENCM sets its rate. Type a dollar amount, such as
`34.79` or `$34.79`. While it is blank, the report prints "Set Volunteer hour value in
Settings" where the value would be. If the cell holds something that isn't a dollar
amount, the report says it can't be read.

### Filter views

`setupReports` saves these filter views on the Log. In the Log, open Data > Filter views
and pick one. A filter view changes only what you see; it changes nothing in the Log and
nothing others see. Each title starts `Kiosk: `.

| Title                           | Shows the rows where                                                                                   |
| ------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `Kiosk: This month`             | the Date is in this month. It moves on by itself each month.                                           |
| `Kiosk: Last month`             | the Date is in last month.                                                                             |
| `Kiosk: Open shifts`            | Status is `open`.                                                                                      |
| `Kiosk: Flagged`                | Admin Alerts? is not blank.                                                                            |
| `Kiosk: Admin-entered`          | either Entered By column holds an admin's initials.                                                    |
| `Kiosk: Typed into the sheet`   | Shift ID or Check-In Entered By is blank, or the row isn't open and Check-Out Entered By is blank.     |
| `Kiosk: Other status or source` | Status is not `open` or `closed`, or either Entered By holds something other than `kiosk` or initials. |

Empty rows (no Date, name, User Token, Status or Shift ID) never show. Don't rename a
`Kiosk: ` view: `setupReports` would add the view again under its own title. Views you
make with other titles are yours, and `setupReports` leaves them alone.

### Warnings on kiosk columns

`setupReports` puts a warning on the Log columns the kiosk and the menu fill: Date, Day,
Volunteer Name, the four time columns, both hours columns, User Token, Status, both
Entered By columns and Shift ID. Editing one of them asks you to confirm first. Nothing is
blocked: confirm, and the edit goes ahead. The kiosk and the menu write as before.

Role/Type, Activity, Notes and Admin Alerts? have no warning; staff fill those.

**Sorting the Log asks for confirmation too**, because a sort moves cells in the warned
columns. Confirm, and the sort goes ahead. Sorting is still safe for the kiosk (see The
Log).

### Setting up the reports

Run `setupReports` from the Apps Script editor, like `setupSheets`. The first time, Google
asks to authorize the script again, for the Sheets service it uses to save filter views.
Accept.

It makes or repairs the Monthly Hours tab, the filter views and the warnings, from the
Log's current columns. It keeps the month picked in B1. It changes only what it made: the
Monthly Hours tab, the views titled `Kiosk: ` and the warnings it put on the Log. It never
changes a Log cell, a report tab or any other tab, so running it again changes nothing. If
the Log is missing a column the kiosk needs, it stops with the kiosk's message; run
`setupSheets` first.

**After inserting, deleting or moving a Log column, run `setupReports` again**, so the
filter views and the Monthly Hours formulas follow the columns.

To add the reports to a spreadsheet already in use, do these steps in this order:

1. `pnpm push`. The kiosk page doesn't change, so a versioned web app deployment needs no
   update, and the menu runs the pushed code.
2. Run `setupSheets` from the editor. It adds the "Volunteer hour value" row to Settings.
3. Run `setupReports` from the editor, and authorize it when asked.

## Setup

1. `pnpm install`
2. Install clasp, Google's command-line tool for Apps Script:
   `npm install -g @google/clasp`
3. Turn on the Apps Script API for your Google account at
   https://script.google.com/home/usersettings
4. Sign in: `clasp login`
5. Ask in Slack to be added as an editor on the shared development script. Its
   `.clasp.json` (script ID, `rootDir: apps-script`) is committed at the repo root.
6. `pnpm push` builds the page and pushes everything in `apps-script/`. A push replaces
   the whole remote project, so change code here, never in the Apps Script editor.
7. Once, in the Apps Script editor, run `setupSheets` (creates the Log, Settings and
   Flags tabs), then `setupSampleProfiles` (builds an invented Volunteer Profiles file and
   points Settings at it). Then put a kiosk access code of at least 16 letters in Settings.
   Then run `setupReports` (see Reports). All three run only from the editor: called
   through the web app by anyone but the account it runs as, they refuse.

The development script points at a copy of Volunteer Profiles built from invented
sample data, never at ENCM's real file.

### Setting up the iPad

The kiosk is built for an iPad in landscape, in Safari. Google shows the kiosk page inside
a frame from another Google address. With Safari's default privacy setting, Safari keeps
that frame's stored data only for the session, so the iPad forgets the access code
whenever the page reloads. To make the iPad remember it:

1. Open **Settings > Apps > Safari** (on iPadOS 17 and earlier, **Settings > Safari**)
   and turn off **Prevent Cross-Site Tracking**. This switch covers all of Safari on the
   iPad, so use an iPad kept for the kiosk.
2. In Safari, use a normal tab, not a Private Browsing tab.
3. Open the kiosk link and type the access code once.
4. Reload the page. The kiosk should open without asking for the code again.

If the kiosk ever asks for the code again after a long closure, type it once more. These
steps have not yet been tried on ENCM's iPad; check step 4 when you set it up.

### What setupSheets does

`setupSheets` writes only empty cells, creates or renames tabs, and sets formats, the
Flags tab's Reviewed tickbox and its `Flags: Unreviewed` filter view. It never changes a
cell with text in it and never deletes a row, so running it again changes nothing.

- No Log tab: it creates one with the full header, A to R as in the table above.
- A Log tab in the kiosk's old layout (first columns Shift ID, Volunteer ID, First name,
  Last name, Date, ...): it renames that tab `Log (old layout)` and creates a new Log with
  the full header. The old rows are not converted and don't count toward milestones. If a
  `Log (old layout)` tab already exists, it stops and says so; rename or remove that tab
  and run it again.
- Any other Log: each kiosk column the header lacks (and Notes, if there is no Notes
  column) is written into the empty cells to the right of the last header. Role/Type and
  Activity are not added; they are staff's.
- It then sets each kiosk column's format (text, date and time, or hours to 2 decimals)
  by its header, freezes row 1, and adds any missing Settings row.
- Last, the Flags tab: it creates the tab if there is none and writes any missing header
  after the last one (Reviewed By and Notes are not added; they are staff's). It sets each
  Flags column's format, puts the tickbox on Reviewed from row 2 to the bottom of the tab
  (only that column), freezes row 1, and adds or updates the `Flags: Unreviewed` filter
  view. That view uses the Sheets API advanced service, as `setupReports` does, so the
  first run may ask you to authorize the script again. If the view can't be made,
  `setupSheets` stops with a message saying so; everything before it is done, and the
  kiosk copies flags to the tab without the view.

### Updating a sheet that's already in use

The web app must never run code older than the Log's layout. When an update changes the
Log's columns, as the move to ENCM's column names did, do these steps in this order:

1. `pnpm push`.
2. If the web app is a versioned deployment, update it to the new version:
   `clasp deploy -i <deployment id>`, or Deploy > Manage deployments in the editor. A head
   deployment (the `/dev` URL) already runs the pushed code.
3. Run `setupSheets` from the editor.

Between steps 2 and 3 the new code meets the old header, and the tablet shows that it
can't reach the volunteer list. That clears as soon as step 3 finishes. Doing it in this
order means old code never writes into the new layout.

To add the Flags tab to a sheet in use, do the same three steps: `pnpm push`, update a
versioned deployment, then run `setupSheets`. Until `setupSheets` has made the tab, the
kiosk works as before and its flags go to Admin Alerts? only; each one it couldn't copy
is named in the executions log. `setupReports` doesn't need running again.

To add the reports to a sheet in use, follow the steps under Setting up the reports.

## Commands

```
pnpm dev         front end alone, with invented volunteers kept in the browser (two
                 Jordan Riveras try the phone step: 0142 and 0187). Any code of 16+
                 letters opens it; Shift+D opens its test tools.
pnpm test        server logic and setup tests (Node)
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
apps-script/Admin.js        the Kiosk admin menu and its dialogs' server functions
apps-script/AdminDialog.html the admin dialogs (plain HTML and JavaScript, committed source)
apps-script/Reports.js      setupReports and the Monthly report menu item's server functions
apps-script/Jobs.js         the daily jobs: setupDailyJobs, removeDailyJobs, the weekly flags email
apps-script/Report.html     the Monthly report window (plain HTML and JavaScript, committed source)
apps-script/Import.js       the Import past hours menu item: preview, write, ledger and flags
apps-script/ImportDialog.html the Import past hours dialog (plain HTML and JavaScript, committed source)
apps-script/Logic.js        the rules, as plain functions the Node tests load
apps-script/Sheets.js       Log, Settings, Flags and Profiles access; setupSheets, setupSampleProfiles
apps-script/SampleData.js   invented Volunteer Profiles rows for development
apps-script/Index.html      the page doGet serves; a build output, not committed
scripts/copy-to-gas.mjs     checks the single-file build and copies it into apps-script/
tests/                      logic tests, and setupSheets run against an in-memory sheet
sample-data/                invented volunteer profiles with the real column headers
```
