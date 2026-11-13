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
- **Check-out reminders**: every check-in ends on a "You're checked in." screen with the
  line "Don't forget to check out before you leave." When the volunteer's last shift
  ended without their own Check Out, a notice comes first: "Welcome back, Sam! Last time
  you didn't check out. Please tap Check Out before you leave today." It has one button,
  Got it, which leads to the checked-in screen, and it never shows a time. Left untouched
  for 60 seconds it goes back to the welcome screen; the check-in is already saved. The
  last shift counts as missed when it is still open, or was closed by anything other than
  the volunteer's tap: the auto clock-out, Fix a sign-out, Add a shift, or a row typed by
  hand. Only shifts dated on or after "Kiosk launch date" count, and rows from Import past
  hours (Shift ID starting `import-`) are skipped, so a paper shift is never taken for a
  missed check-out. Nothing is stored for it: the check-in that shows the notice is the
  shift looked at next time, so each missed check-out shows it once.
- **Server**: Apps Script (`apps-script/`) bound to a Check-In Log spreadsheet with Log
  and Settings tabs. Each shift is one Log row. The Log uses ENCM's own column names from
  their "2026-11 Log" sketch, then four columns of the kiosk's: Status, who entered the
  check-in, who entered the check-out, and Shift ID. Each end of a shift keeps two times:
  the time recorded when the volunteer tapped, and the time they stated.
- **Names**: read from ENCM's existing Volunteer Profiles sheet. The kiosk never writes
  to it. Volunteers who share a name confirm the last four digits of their phone, and the
  digits decide which of them is signed in or out.
- **Kiosk admin menu**: a menu in the Check-In Log spreadsheet for staff to add a shift a
  volunteer forgot to log, to close one they forgot to sign out of, to move a wrong shift
  out of the Log and back, to check the Log for broken rows, to make a monthly report, or to
  refresh the Hours tab (see below).
- **Flags tab**: each alert the kiosk writes is also copied to a Flags tab, one row per
  alert, for staff to tick off as reviewed (see Flags tab).
- **Reports**: the Hours tab, tables and slicers for hours over any period you pick, a
  frozen monthly report with CSV and PDF downloads, saved filter views on the Log, and a
  warning when someone edits a column the kiosk fills (see Reports).
- **Daily jobs**: a weekly email of flags to staff, an auto clock-out at about 4 AM that
  closes shifts nobody checked out of, with a guessed time, flagged, and a refresh of the
  Hours tab at about 5 AM (see Daily jobs).

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
kiosk never reads or writes them. The exceptions are `Import ledger`, which Import past
hours makes and adds to (see Kiosk admin menu), `Removed shifts`, which Remove a shift
makes and Restore a shift takes rows back from (see Kiosk admin menu), and `Shifts`, staff's
shift schedule, which the auto clock-out reads and never writes (see Daily jobs).

Row 1 is the header and stays frozen. The kiosk finds each column by its header text, not
by its position, so staff can reorder columns, add columns of their own between them, and
sort rows. Line breaks, extra spaces and capital letters in a header don't matter. Don't
rename a kiosk header or keep two columns with the same kiosk header: the kiosk stops with
an error naming the column, and `setupSheets` puts a missing one back (see Setup).

Each kiosk header carries a hover note for staff saying what the column holds; the same
notes are listed at the end of the How to tab (see What setupSheets does). `setupSheets`
writes a note only where the cell's note is empty or is still exactly one of the kiosk's
own note texts, so a note staff wrote or changed is left as it is, unless it is exactly
one of the kiosk's texts.

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
| Q      | Check-Out Entered By           | `kiosk`, an admin's initials, or `auto-close` (see Daily jobs).        |
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
- `long shift: 10.25 h stated, over 8 h`, at check-out, when the shift's stated hours are
  more than "Long shift flag hours" (Settings), whatever the clock or date (see Check-out
  time).
- `check-in time unreadable, stated hours left blank`, at check-out, when someone has
  edited the row's check-in times into something the kiosk can't read, such as `9ish` or
  a time on another date. A time typed alone, such as `9:00 AM`, is read (see Rows typed
  by hand), so it doesn't raise this alert. The tablet still shows the volunteer as
  checked in, and the row still closes at check-out, with blank hours, and counts as a
  shift of 0 hours until staff fix the times and hours by hand.

The auto clock-out (see Daily jobs) writes one of these:

- `auto clock-out at 1:30 PM, ...`, on a row it closed, ending with where the time came
  from: `usual Tuesday length`, `Finish of the 9:00 AM Shifts window`, `arrival + 3 h`,
  `time of the check-in tap`, `start of the next shift` or `time of this run`. The time
  carries its weekday (`at Friday 2:00 AM`) when it is on another day than the row's Date.
- `auto clock-out skipped: check-in time unreadable`, once, on an open row it couldn't
  close because no time on it reads.

Import past hours (Kiosk admin menu) writes one of these on an imported row:

- `imported: no Volunteer Profiles match for this name; correct this row on the Log, not in
  the old sheet`, when the name matches no volunteer.
- `imported: name matches N Volunteer Profiles rows; correct this row on the Log, not in the
  old sheet`, when N volunteers share the name.
- `imported: paper and kiosk shift on the same day; if both are the same shift, remove this
  imported row with Kiosk admin > Remove a shift…`, on an imported row whose volunteer also
  has a shift that day that didn't come from an import.

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
server's clock. It doesn't show either when the stated arrival is on an earlier date than
today (for volunteers who share a name, the earliest of their arrivals): the picker offers
times of today only, so Check Out uses the server's clock.

The check-out screen says "You checked in at 9:45 PM.", or "You checked in yesterday at
11:00 PM." after midnight, and shows "Your time so far".

The server refuses a check-out time that is:

- more than 5 minutes in the future. Up to 5 minutes ahead is taken as now.
- before the volunteer's stated arrival. Equal to it is accepted, for 0 hours.
- on another day than today, but only when the open row's check-in time can't be read.
  Otherwise any time from the arrival up to now is accepted, past midnight too.

A check-out earlier than the recorded check-in tap is allowed: a volunteer who states they
arrived at 9:00, taps in at 11:00 and states they left at 10:00 is credited 1 stated hour,
and the arrival alert marks the row. The server accepts any minute; the 15-minute steps
are only the tablet's.

### Overnight shifts

A volunteer stays checked in on the tablet for "Auto clock-out after hours" (Settings,
12 by default) after they tapped Check In, whatever arrival time they chose and past
midnight too. A volunteer who checks in at 10 PM can check out at 1 AM, and is listed in
the Checked-in sidebar until then. After midnight the check-out screen says "You checked
in yesterday at 10:00 PM." and has no "Change your check-out time" link. Once that time has passed since the tap, the row is
the auto clock-out's (see Daily jobs): the tablet shows the volunteer as not checked in,
and they can check in again. Check Out with no chosen time uses the server's clock,
whatever the date.

A check-out past midnight is written as a date and time on its own date. The Log reads
every time on a row as being on the row's Date, so the kiosk and the reports read that
check-out as unreadable. The hours are safe: Hours Served (stated) is worked out when the
row is written, and every report counts that cell. Two things leave the row out: the
monthly report's adjustments comparison, which needs all four times, and the admin
overlap check, as for a check-out typed before the check-in.

### Long shifts

A tablet check-out whose stated hours (from the stated arrival to the stated check-out,
the hours the row is credited) are more than "Long shift flag hours" (Settings, 8 by
default) gets the alert `long shift: 10.25 h stated, over 8 h` in Admin Alerts? and a
Flags row, whatever the clock or date. Exactly that many hours is not flagged. It catches
a sign-out made the next morning that credits the whole night; a short overnight shift,
such as 11 PM to 2 AM, is not flagged. Fix a sign-out, Add a shift and the auto clock-out
don't raise it: staff typed those times, and every auto clock-out is flagged anyway.

## Flags tab

A flag is an alert the kiosk writes to Admin Alerts? on the Log: a stated arrival or
check-out far from the tap, a long shift, a check-in time it couldn't read, a time the
auto clock-out guessed, an imported name it couldn't match, or a paper shift imported for a
day the volunteer also has a kiosk shift. Each one is also copied to a tab named `Flags`,
one row per flag, so staff can tick it off once someone has looked at it. The Log row is
still the record: Admin Alerts? keeps every flag. The Log check (see below) adds a second
kind: a problem it found on a Log row. Those are on the Flags tab only, never in Admin
Alerts?.

Only the kiosk adds Flags rows, at check-in and at check-out, the auto clock-out, one per
row it closes or skips, Import past hours, for names it couldn't match and for paper shifts
on a day with a kiosk shift, and the Log check.
Add a shift and Fix a sign-out add none: shifts added or closed
with them carry the admin's initials in the Entered By columns and show in the `Kiosk:
Admin-entered` filter view (see Reports). Editing the Log by hand adds no Flags row.

Import past hours adds one Flags row per unmatched name per run, not one per row: Source
`import`, the Reason is the row's alert with the name's row count in that run added (`(14
rows in this import)`), and Date, Shift ID and Log Row are those of the name's first new
row. The other rows of that name carry the alert in Admin Alerts? and show in the `Kiosk:
Flagged` view.

Import past hours also adds one Flags row per imported row whose volunteer also has a kiosk
shift that day: Source `import`, the Reason as in Admin Alerts?, and the imported row's
Date, Shift ID and Log Row. It goes under the last used row like every flag. If the paper
row is the double, Remove a shift on it ticks the flag; if the kiosk row is, tick the flag
yourself.

Each Flags header carries a hover note for staff, written the same way as the Log's: only
where the cell's note is empty or still exactly one of the kiosk's own texts, so a note
staff wrote or changed stays. The notes are also listed at the end of the How to tab.

| Column | Header         | What it holds                                                               |
| ------ | -------------- | --------------------------------------------------------------------------- |
| A      | Date           | The Log row's Date.                                                         |
| B      | Volunteer Name | The Log row's Volunteer Name.                                               |
| C      | Shift ID       | The Log row's Shift ID: the sure way to find the row on the Log.            |
| D      | Reason         | The alert, word for word as in Admin Alerts?.                               |
| E      | Raised At      | The server's clock when the kiosk raised it.                                |
| F      | Reviewed       | A tickbox. Tick it once you've looked at the flag.                          |
| G      | Reviewed By    | Your initials.                                                              |
| H      | Notes          | What you found or did.                                                      |
| I      | Source         | `kiosk check-in`, `kiosk check-out`, `auto-close`, `import` or `log check`. |
| J      | Log Row        | The Log row number then. A hint only: sorting the Log moves rows.           |

To review: open Data > Change view > `Flags: Unreviewed`. It shows the flags not yet
ticked, newest first. Tick Reviewed, type your initials in Reviewed By, and add a note if
there's something to say. A ticked flag leaves the view. The sheet's edit history (right
click a cell > Show edit history) shows who ticked it and when.

The kiosk only adds rows to this tab. It finds its columns by header, as on the Log.
Three things read Flags rows back: the weekly flags email (see Daily jobs) and row 3 of the
Hours tab, to count and list them, and the Log check, to skip what it has already
flagged. So sorting, filtering or deleting Flags rows is safe, and so are columns of your
own; a deleted Log check row is raised again on the next check. Reviewed By and Notes are
yours; the kiosk never writes them, except that Remove a shift and Restore a shift add a
note (below). There is no User Token on this tab; find it on the Log row by Shift ID if you
need it.

**Where new rows go.** A new flag goes on the row right under the last row that holds
anything other than an unticked Reviewed box. `setupSheets` puts a box on every row of the
tab, so the tab's last row is far below the last flag; new flags don't go there. A row
counts as used when any cell holds something, a column of your own included, or when its
Reviewed box is ticked. If you clear a row in the middle, it stays empty: new flags go
under the last used row, not into gaps.

A flag can be missing from this tab only when the tab was broken at the time (renamed,
deleted or missing a header), or when a row typed by hand with no Shift ID is closed at
the tablet. The check-in or check-out still goes through, the
flag is still in Admin Alerts? and in the `Kiosk: Flagged` view, and the Apps Script
executions log has a line `Flags: not copied for Shift ID ...`. Run `setupSheets` to repair
the tab. Flags raised before the Flags tab was added are only in Admin Alerts?.

### Log check flags

The Log check (see Daily jobs) gives each problem it finds one Flags row, Source `log
check`. The Reason is the problem's label, a colon and the detail, for example `Check-out
before check-in: recorded in 10:00 AM, out 9:06 AM`. Date, Volunteer Name, Shift ID and Log
Row are the Log row's. A row with no Shift ID gets `(no Shift ID)` in that column.

A problem is flagged once, ever. A problem already on the tab, Reviewed or not, isn't
raised again, so ticking Reviewed is how you say "seen, leave it". The check knows a
problem by the Shift ID and the label (for a row with no Shift ID, by its Date, Volunteer
Name and label). If you delete its Flags row and the problem is still on the Log, the next
check raises it again. Two rows that share a Shift ID get one flag per label between them.

One run adds at most 100 rows. When it finds more, the rest wait for the next run, which
adds up to 100 more, and so on: on a Log with 150 problems, the first run flags 100 and
the next 50, and a third adds none. Fixing the Log row doesn't remove or tick its flag:
tick it yourself.

**Remove a shift and Restore a shift.** Removing a Log row (Kiosk admin > Remove a shift…)
ticks Reviewed on that row's Flags rows, puts the initials in Reviewed By when it is blank,
and adds a note saying who removed it, why and when to Notes. When the Shift ID is on no
other Log row, that is every Flags row with the Shift ID. When another row still has the
same Shift ID, only the flags whose Log Row, Date and Volunteer Name all match the removed
row are ticked, plus the `Shift ID on more than one row` flag when one copy is left; the
other copy's flags are left alone, and a flag whose Log Row went stale (the Log was sorted)
is left for you to tick. Restoring the row adds a note to its Flags rows and leaves
Reviewed as it is. Their rows stay on the tab, so the Log check doesn't raise them again;
untick one if you want it looked at again.

### Two counts of flagged

The flagged rows in the monthly report count **Log rows** in the month whose Admin
Alerts? isn't blank. Row 3 of the Hours tab counts every such row in the whole Log, and
the `Kiosk: Flagged` filter view shows them. The Flags tab lists **each flag**, with
whether someone has reviewed it, and row 3 of the Hours tab counts its unreviewed rows
too. A check-out can raise two flags on one row, and staff can type in Admin Alerts?
too, so the counts differ on purpose.

## Settings

The Settings tab holds one value per row, name in column A and value in column B.
`setupSheets` adds any missing row with its default and never changes a value that is
there.

Column C, **What it does**, is for staff: one plain sentence per setting, the same
sentences as the table below. The kiosk writes the column and rewrites it on every
`setupSheets` run, so staff can't keep their own text there. A row whose name appears
again lower down gets "Not used: an earlier row has the same name, and only the first one
counts.", a name the kiosk doesn't know gets "The kiosk doesn't use this row.", and a row
with no name gets nothing; this is what the kiosk does with each row when it reads
Settings. Text left in C below the last named row is cleared. Column C has a warning-only
protection, so typing in it warns first. When the kiosk itself adds a missing row (for
example "Flags email last run" after someone deleted it), the row gets its sentence at
once.

| Setting                    | Default                         | What it does                                                                                                                                                                                                                                                                           |
| -------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kiosk access code          | blank                           | The code a board member types on the tablet to open the kiosk: at least 16 letters (only letters count, and capitals are the same as small letters), and while it's blank or shorter no tablet can open.                                                                               |
| Volunteer Profiles file ID | blank                           | Which spreadsheet the volunteer list comes from, as the long ID in its link between /d/ and /edit; while it's blank, no volunteer can be found on the tablet or in the menu.                                                                                                           |
| Volunteer Profiles tab     | Volunteer Profiles              | The tab in that spreadsheet that holds the volunteer list; blank means a tab named Volunteer Profiles.                                                                                                                                                                                 |
| Kiosk launch date          | the day `setupSheets` first ran | The day the kiosk started, as yyyy-mm-dd: only volunteers who started on or after it get the first-shift welcome, and the nightly auto clock-out closes only shifts on or after it, so never leave it blank.                                                                           |
| Arrival flag minutes       | 15                              | How many minutes a volunteer's chosen arrival time can be from the moment they tapped in before the shift is flagged, as a number 0 or more; blank means 15.                                                                                                                           |
| Check-out flag minutes     | 15                              | How many minutes a volunteer's chosen check-out time can be from the moment they tapped out before the shift is flagged, as a number 0 or more; blank means 15.                                                                                                                        |
| Volunteer hour value       | blank                           | The dollar value of one volunteer hour, such as 34.79, used in the monthly report; while it's blank the report leaves the value out and says to set it here.                                                                                                                           |
| Profiles problems          | blank                           | Written by the kiosk: rows of Volunteer Profiles it had to leave out, and why (blank means none), so fix them in Volunteer Profiles, not here.                                                                                                                                         |
| Auto clock-out after hours | 12                              | How many hours after check-in a shift nobody checked out of stays open on the tablet before the nightly auto clock-out closes it, from 10 to 24; blank or anything else means 12.                                                                                                      |
| Auto clock-out last run    | blank                           | Written by the kiosk: when the nightly auto clock-out last ran and how many shifts it closed, so leave it alone.                                                                                                                                                                       |
| Long shift flag hours      | 8                               | A tablet check-out that credits more hours than this is flagged as a long shift, as a number above 0; blank or anything else means 8.                                                                                                                                                  |
| Flags email                | Off                             | Type On to send the weekly flags email; anything else, blank included, keeps it off.                                                                                                                                                                                                   |
| Flags email to             | blank                           | Who gets the weekly flags email, as one or more email addresses separated by commas, spaces or new lines; blank sends nothing.                                                                                                                                                         |
| Flags email day            | Monday                          | The weekday the weekly flags email goes out if there is anything to report, such as Monday or Mon; blank or anything else means Monday, and the first one after a change, or after turning the email On, can come sooner (see the How to tab).                                         |
| Flags email hour           | 8                               | The hour, Central time, the weekly flags email goes out if there is anything to report, as a whole number from 0 to 23 (8 is 8 AM, 14 is 2 PM); blank or anything else means 8, and the first one after a change, or after turning the email On, can come sooner (see the How to tab). |
| Flags email last run       | blank                           | Written by the kiosk: when the weekly flags email last checked and whether it sent or had nothing to send; while the email is On with an address, clearing it makes the next hourly check run again, which sends only if there is anything to report.                                  |
| Daily jobs installed by    | blank                           | Written by the kiosk: the Google account that runs the nightly jobs and the weekly email, so leave it alone.                                                                                                                                                                           |
| Past hours file ID         | blank                           | The old hours spreadsheet that Kiosk admin > Import past hours… offers first; an import fills it in, and blank just means the window starts empty.                                                                                                                                     |
| Past hours tab             | Historical Hours                | The tab in that old hours spreadsheet that Import past hours… offers first; blank means Historical Hours.                                                                                                                                                                              |
| Kiosk contact              | blank                           | Who to ask when the kiosk or this sheet isn't working, such as a name and an email or phone: the How to tab shows it, and so does the Kiosk admin menu when something goes wrong; while it's blank, the How to tab says to ask whoever looks after the kiosk.                          |

"Flags email to" also splits on semicolons; the sentence leaves that out to stay short.
"Daily jobs installed by" is written by `setupDailyJobs`, and the two Past hours rows by an
import that adds rows.

"Auto clock-out after hours" is read as given from 10 to 24; anything else, blank or
unreadable, reads as 12. A window shorter than a shift plus some slack would take a
volunteer who is still there off the tablet: they would show as not checked in, could
check in a second time, and both rows would get a guessed time.

"Long shift flag hours": a tablet check-out whose stated hours (from the stated arrival to
the stated check-out, the hours the row is credited) are more than this gets an alert in
Admin Alerts? and a Flags row, whatever the clock or date. Exactly this many is not
flagged. A blank, 0, negative or unreadable value reads as 8.

"Kiosk contact" is who staff should ask when the kiosk or the sheet isn't working, typed
as staff like it (a name and an email or phone, on one line or several). The kiosk never
checks or shortens it. The How to tab's first section shows it, read live from this row
(see What setupSheets does), and the Kiosk admin menu adds it to an error (see Kiosk admin
menu). The tablet never shows it or receives it: volunteers use it in a public room and
are sent to a board member on site. It is the last row, added blank by `setupSheets` on a
sheet set up before it; this repository holds no real contact, only examples such as
"Pat Example, pat@example.org" or "555-0100".

"Check-out flag minutes" is new with the check-out time picker, "Volunteer hour value"
with the reports, and the rows from "Auto clock-out after hours" down with the daily jobs.
On a spreadsheet set up before them, run `setupSheets` once to add them.

When a change applies: a check-in or check-out uses a copy of Settings the kiosk keeps
for up to 5 minutes, so it doesn't wait to read the tab. Typing in a Settings cell, or
the kiosk writing one itself, makes the next tap read the tab again, so the change
applies from the next tap, a second or two after the edit. Any other change, such as
inserting, deleting or sorting rows or restoring an older version, applies within 5
minutes, usually sooner, since the tablet's list refresh reads the tab. Until then a
replaced access code can still check volunteers in and out. A new access code works at
once.

## Kiosk admin menu

Opening the Check-In Log spreadsheet adds a **Kiosk admin** menu with eight items: Add a
shift, Fix a sign-out, Remove a shift, Restore a shift, Monthly report, Import past hours,
Refresh Hours and Check the Log now. Monthly report and Refresh Hours are described under
Reports. The sheet's How to tab (see What setupSheets does) walks staff through each item
in plain words. Check the Log now runs the Log check that otherwise runs at about 5 AM (see Daily
jobs) and says what it found and how many new Flags rows it added. Anyone who can edit the
spreadsheet can use it. It runs as whoever has the sheet open, which at
ENCM is the shared account, so:

- that account must be able to read Volunteer Profiles, because the menu reads the roster
  from it;
- the first time the account uses the menu, Google asks it to authorize the script. Accept
  once and the menu works from then on.

> **Warning: use the menu with only one Google account signed in.** If the browser is
> signed into more than one Google account, the menu's windows can fail with "We're sorry,
> a server error occurred while reading from storage. Error code PERMISSION_DENIED".
> Google sends the window's requests as the browser's _default_ account (the first one
> signed in) rather than the account that has the sheet open. To fix it, open the sheet in
> an incognito/private window signed into only the shared account, or give that account its
> own browser profile.

Each item except Refresh Hours and Check the Log now opens a small window. Every save asks
for the admin's **initials**: 1 to 5 letters, with spaces and dots dropped, stored in capitals (`j.p.` is stored as `JP`). The
initials go in Check-In Entered By and Check-Out Entered By, since everyone at ENCM signs
in as the same account. A window stops working after 30 minutes; close it and open the
menu again. If a save is refused, the window says why and keeps what was typed.

When something goes wrong that isn't a refusal, the window shows the error, and while the
Settings row "Kiosk contact" has a value the error ends with "If this keeps happening,
contact: " and that value, its lines joined with commas. That covers every error that
reaches a window's failure handler (one from Google, or a missing tab the kiosk names) and
a reply with no message. Refresh Hours and Check the Log now add the same line to an alert
that reports an error: a refresh that failed or found no Hours tabs, or a Log check that
failed. A refusal, a busy message or a run's result is shown as it is, since each says
what to do. With the row blank, the error is shown alone. A Settings tab that can't be
read doesn't stop the shift or Monthly report windows opening; they just have no contact
line. Import past hours needs Settings to open, so there it stops with Google's error.

The "type to search" box in Add a shift, Fix a sign-out, Remove a shift and Restore a
shift ignores accents, apostrophes, periods, hyphens, capitals and extra spaces, the same
as the kiosk's name box. Every word
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

### Remove a shift

For a Log row that shouldn't be there: a shift typed twice, a test row, a row for the
wrong volunteer. The row isn't lost: it moves to a tab named `Removed shifts`, and Restore
a shift puts it back.

Find the row by pasting its **Shift ID**, or by choosing the **volunteer** and the
**date** (today unless you change it), then press Find. Pick the row from the list; the
window shows its date, name, status, stated and recorded times, both hours, both Entered
By, alerts and notes, so you can check it is the right one. Then give a **reason** (up to
500 characters) and your initials, and save.

Only rows with a Shift ID can be removed. A row with no Shift ID isn't listed: delete it
in the sheet by hand (the Log check flags such rows as "No Shift ID").

On save, the row is copied to `Removed shifts`, column by column under the same headers,
with three more columns: **Removed by** (your initials), **Removed at** and **Removed
reason**. Then it is deleted from the Log, so the rows below it move up. Its Flags rows
are ticked Reviewed, get your initials in Reviewed By when that is blank, and get
`Log row removed by JP on 2026-11-13: <reason>` added to their Notes. When another Log row
still has the same Shift ID (a copied row), only the removed row's own flags are ticked:
those whose Log Row, Date and Volunteer Name match it. The Log check's "Shift ID on more
than one row" flag is ticked too once only one row is left. The rest stay for the row that
remains, and the window says how many it left. A flag whose Log Row is out of date, because
the Log was sorted, is left unticked; tick it by hand.

Hours and the reports drop the row at their next read. The Hours tab shows it after its
next refresh, at about 5 AM, or Kiosk admin > Refresh Hours.

It refuses, and says why, when:

- the initials are missing, or the reason is missing or over 500 characters.
- no Log row has that Shift ID any more, or the row moved since you found it (for
  example the Log was sorted while two rows share the Shift ID). Find the shift again.
- the row has a value in a column whose header is blank, repeated, or named Removed by,
  Removed at or Removed reason. The value couldn't be moved and brought back, so the
  message names the column: give it a unique header first.
- the window has been open more than 30 minutes. Close it and open the menu again.

**The `Removed shifts` tab** is made by the first Remove, with the Log's header row as it
is then, then the three columns above. A later Remove adds any new Log header at the
right. Row 1 is frozen, and the tab warns before anyone edits it. Nothing else reads it:
not Hours, the reports, the Log check or the email. If a Remove is cut off part way, the
row can be on both tabs; Restore then refuses it, and staff delete the extra copy by hand.

### Restore a shift

Puts a removed row back. The window lists the rows on `Removed shifts`, newest first, with
who removed each, when and why. Search the list, pick a row, enter your initials and save.
The row is written below the Log's last row, column by column under the same headers (the
three Removed columns aren't copied back), and deleted from `Removed shifts`. Its Flags
rows get `Log row restored by JP on 2026-11-13.` added to their Notes and otherwise stay
as Remove left them, ticked; untick one if you want it looked at again. The Hours tab
shows the row after its next refresh.

An open row that comes back is the tablet's again while it is younger than "Auto clock-out
after hours"; otherwise the next auto clock-out closes it.

It refuses, and says why, when:

- the initials are missing.
- the row is no longer on `Removed shifts`, or moved there since the list was made. Close
  the window and open Restore a shift again.
- a Log row already has that Shift ID.
- the row is open and the volunteer already has an open row in the Log. Close that one
  with Fix a sign-out first.
- the row has a value in a column the Log no longer has, or has twice. The message names
  the column: give the Log one column with that header first.

### Import past hours

For bringing shifts from an old hours sheet into the Log, such as ENCM's "Old Volunteer
Hours". It can be run again at any time: it brings in only rows it hasn't brought in
before. A row changed in the old sheet after it was imported can come in a second time, so
read "Correct an imported row on the Log" below.

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
import, split into names matched to Volunteer Profiles and names not matched, and how many
of the matched ones are on the same day as a kiosk shift; the unmatched names with their
row counts, so you can fix Profiles first; the same-day rows, each with its name, date and
source row; how many are already imported; rows left out, with their row numbers and why;
and the hours it would add.
**Import** works the list out again and writes it, then says what it did.

A row is **left out** when its Date isn't a day (`yyyy-MM-dd`, `m/d/yyyy` or a date the
sheet holds as a date), its Date is after today, it has no first or last name, or its
hours aren't a number above 0 and at most 24. Left-out rows aren't remembered: fix them in
the old sheet and run the import again.

A Date the old sheet holds as a date is read in that spreadsheet's own time zone (File →
Settings there), so its rows land on the day the sheet shows whatever zone it is set to.
Dates typed as text are read as written.

**Same day as a kiosk shift.** Rows come in from any date up to today; the import doesn't
read "Kiosk launch date". A row whose name matched a volunteer who also has a shift on the
Log that day (open or closed, and not from an import: from the tablet, the menu, or typed
by hand) still comes in, with the same-day alert in Admin Alerts? and a Flags row, so you
can check it isn't the same shift counted twice. Rows on the Removed shifts tab don't
count. Unmatched names aren't checked. The check is made only when the row is imported: a
shift added to the Log for that day later raises no flag. Preview shows the count and the
rows; each block of the import looks at the Log again, so Import's count can differ if the
Log changed in between.

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
- When its volunteer also has a kiosk shift that day: the same-day alert in Admin Alerts?
  and one Flags row (see Same day as a kiosk shift above).
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

This matters more now that paper rows keep coming in after launch. The import can't tell
when a row it already brought in is changed in the old sheet, and nothing warns you. A
fixed date or name brings the shift in a second time. A fixed number of hours never
reaches the Log. A row typed above an imported one with the same date and name makes the
older row come in again, and the new one is skipped; sorting the tab can do the same. So
add new rows at the bottom of the tab, and fix imported rows on the Log. If a shift comes
in twice after a date or name was fixed, remove the extra row with Kiosk admin > Remove a
shift…; the ledger keeps its key, so it doesn't come back. If it came in again because a
row was typed above it, the second copy stands for the new paper shift but carries the old
row's hours: correct that row's hours on the Log instead of removing it.

Rows are written in blocks of 250, each taking the kiosk's lock for a few seconds, so the
tablet keeps working during an import. Each block checks the Log again for Shift IDs and
same-day kiosk shifts, and writes one line to the execution log with its counts and how
long it held the lock. If a run stops part way (the kiosk was busy, or Google's 6-minute
limit was near), the window says so; whole blocks are kept, and running it again brings in
the rest.

### What the menu won't do

It doesn't edit a closed row or change a check-in time; staff change those cells by hand
in the sheet. It removes a row only through Remove a shift, which keeps a copy on
`Removed shifts`, and only a row that has a Shift ID.

It can't close an open row whose Date or check-in time can't be read. Fix that cell by
hand first, then use Fix a sign-out. If the row is dated today, the volunteer can still
check out on the tablet that day instead: the row closes with blank hours and the
`check-in time unreadable, stated hours left blank` alert, and staff then fix the times
and hours by hand.

A note needs a Notes column. If the Log has none, the save stops with an error that says
to run `setupSheets`, which adds it.

The menu can't be reached from the kiosk page. Every menu function checks that it was
called from the open spreadsheet, through a window the menu opened.

## Daily jobs

Jobs the script runs on its own, on Google's timed triggers: the weekly flags email,
checked every hour, the auto clock-out, once a day at about 4 AM Central, and the Hours
refresh, once a day at about 5 AM Central, followed by the Log check. They live in
`apps-script/Jobs.js`.

On a sheet whose jobs were installed before the Hours refresh was added, the account that
owns them must run `setupDailyJobs` once more to add it (see Who runs them). Until then
Hours is refreshed only from the menu and by `setupReports`. `setupReports`' finish
message says so too.

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

Every hour the email job checks Settings. It does nothing, and writes nothing, until
"Flags email" is `On` and "Flags email to" holds at least one address. Then a check runs
when "Flags email last run" is blank, unreadable or older than the latest "Flags email
day" at "Flags email hour" (Central) at or before now. So the first check after turning
the email on, or after changing the day or hour, can run within the hour, on any day;
after that a check runs once a week, at the first hourly run on or after that day and
hour. A check sends only if there is something to report (below), and writes "Flags email
last run" either way: `sent to N`, or `nothing to send` when there was nothing. A run that
couldn't send is caught up by the next hourly run. Clearing "Flags email last run" makes
the next hourly run check again, which likewise sends only if there is something to
report.

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

### Auto clock-out

Once a day, at some minute between 4 and 5 AM Central, the auto clock-out closes shifts
nobody checked out of. It closes every `open` row dated on or after "Kiosk launch date"
whose check-in tap was at least "Auto clock-out after hours" ago (or, for a row with no
recorded tap, its stated arrival). That is the same line at which the tablet stops
offering the row, so a row is never both the tablet's and the job's. It closes old rows
as well as last night's, so a run that was missed is caught up the next day. A blank or
unreadable "Kiosk launch date" makes the run fail, and the owner gets Google's failure
email, rather than close every open row the Log has ever had.

The time it writes is a guess, and never before the volunteer tapped in, after the run, or
after the start of the volunteer's next shift. It tries, in order:

1. **The volunteer's usual length** on that weekday: the middle value of their stated
   hours on the same weekday in the last 26 weeks, from up to 8 of their most recent
   shifts checked out at the tablet, by an admin, or typed by hand (never auto-closed or
   imported ones). It needs at least 3 such shifts, and two thirds of them within an hour
   of each other.
2. **The Finish of their shift on the `Shifts` tab**: the window on that weekday whose
   Start is nearest their arrival, counting an arrival up to 30 minutes early. A Finish
   not after its Start is the next morning.
3. **Their arrival plus 3 hours**, moved up to their check-in tap when that was later,
   and back to their next shift's start when that was earlier.

The row gets the guess in Check-Out Stated, Hours Served (stated) from the arrival to the
guess, Status `closed`, and `auto-close` in Check-Out Entered By. Check-Out Recorded and
Hours Served (timestamps) stay blank: nobody tapped. Admin Alerts? gets
`auto clock-out at 1:30 PM, ...` naming where the time came from, and the Flags tab a row
with Source `auto-close`. The guessed hours count in reports straight away. At the end it
writes "Auto clock-out last run": when it ran and how many rows it closed. The weekly email
warns when that is more than 2 days old.

**The `Shifts` tab** is staff's; the job only reads it. It finds the columns by their
headers, `Shifts` (the weekday, in full or its first three letters), `Start` and
`Finish`, in the first of the tab's top rows that has all three; other columns, such as
`Shift Schedule`, are ignored. Times may be sheet times or text such as `9:00 AM` or
`9 AM`. A row missing any of the three is skipped. With no `Shifts` tab, or no such headers,
step 2 is skipped and the run logs one line saying so.

**To correct a guessed time**, edit the row on the Log by hand: Check-Out Stated and Hours
Served (stated). Fix a sign-out only takes open rows. Tick the Flags row once done.

**An open row whose check-in time can't be read** (such as `9ish`) can't be guessed for.
From the day after its Date, the run leaves it open, gives it a Shift ID if it has none,
and flags it once with `auto clock-out skipped: check-in time unreadable`. To clear it,
type its check-in time on the Log, then close it with Fix a sign-out, or let the next run
guess it.

Open rows dated before "Kiosk launch date", or whose Date can't be read, are never closed
or flagged. An open row counts no hours, and doesn't stop the volunteer checking in.

Each run takes the kiosk's lock, so a tablet tap at that minute may wait or see "The kiosk
is busy". A run that finds the lock busy for 30 seconds fails, and the next day's run
catches up. A first run at ENCM may close a backlog of old open rows: `setupDailyJobs`
logs how many a run would close now. A run stops starting new rows after 4.5 minutes,
inside Google's 6-minute limit, and leaves the rest for the next day. Just before it
writes a row, it reads that row again; if staff have sorted, inserted, deleted or edited
Log rows so the row is no longer the open one it read at the start, it leaves it alone,
logs one line, and the next day's run picks it up where it now is.

### Nightly Hours refresh

Once a day, at some minute between 5 and 6 AM Central, the job refreshes the Hours tab as
Kiosk admin > Refresh Hours does (see Hours tab). It runs an hour after the auto
clock-out, so the rows that run closed show. It always writes the whole table again, which
also undoes any hand edit on Hours data.

It never takes the kiosk's lock, so a tap at that minute doesn't wait for it. If another
refresh or `setupReports` is writing Hours, it waits up to 2 minutes. The run fails, and
the owner gets Google's failure email, when it still can't start after that, when Hours
isn't set up (run `setupReports`), or when the refresh itself fails. When it got as far
as writing, B1 on the Hours tab says what happened. Use Refresh Hours, or let the next
night's run catch up.

### Nightly Log check

Right after the nightly Hours refresh, the same run checks every Log row for problems
that hand edits leave, and flags each one once on the Flags tab (see Log check flags). It
reports; it never changes the Log. Kiosk admin > Check the Log now runs the same check at
once and shows what it found.

| Label                          | When                                                                                                       |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| No Shift ID                    | The Shift ID is blank.                                                                                     |
| Shift ID on more than one row  | Two or more rows have the same Shift ID. One flag, at the first row, naming the rows.                      |
| Date isn't a full date         | The Date holds only a time, can't be read as a date, is before 2000, or is after this month.               |
| Recorded time has no date      | A Recorded (timestamp) cell holds a time with no date. The kiosk always writes a full date and time there. |
| Status isn't open or closed    | Status is anything else, blank included. Such rows count nowhere.                                          |
| Check-in missing or unreadable | No check-in time reads on the row's Date, and Admin Alerts? doesn't already say so.                        |
| Check-out before check-in      | The recorded or stated check-out is before its check-in.                                                   |
| Closed with no check-out       | Status is closed and both check-out cells are blank.                                                       |
| Hours don't match the times    | A closed row's hours cell is blank or more than 0.01 off the hours between its times.                      |
| Impossible shift length        | An hours cell is below 0 or above 16, or the times are more than 16 hours apart.                           |

Rows from Import past hours have no times, so the time checks skip them. Notes and other
staff columns aren't checked.

It uses the Log the Hours refresh read, so the Log is read once; when the refresh didn't
read it (Hours isn't set up, or the read failed), the check reads it itself. It asks for
the kiosk's lock only after the refresh has let go of its own, waits up to 30 seconds,
and holds it only while it reads the Flags tab and adds the rows, so a tap waits a few
seconds at most. The run logs one line, `Log check (nightly): done; checked ... rows,
found ..., already flagged ..., flagged ... new, ... left for the next run`.

The refresh's failure, if any, is what the run throws, as before. When the refresh went
well but the check couldn't take the lock or failed (for example, no Flags tab), the run
throws `Log check (nightly): ...`, so the owner gets Google's failure email. The next
night's run, or Check the Log now, catches up.

## Reports

There are four tools for staff. All of them read the Log tab and none of them changes a
Log cell. No report shows a User Token: tokens are read only to tell volunteers apart.

- the **Hours** tab, tables of stated hours, shifts and volunteers for any period you pick
  with its slicers, as of its last refresh;
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
  volunteer's latest counted shift in the month; the Hours tab shows it from their latest
  counted shift in the whole Log (see Hours tab).
- An **open** row (Status `open`) counts nowhere: no shift, no hours, not a volunteer.
  The report lists open rows first under rows to review, and its first lines say how many
  there are: "N open shifts in this month are not counted. Close them with Fix a
  sign-out, then make the report again."
- A row **added or closed with the Kiosk admin menu** counts like any other closed row
  with a User Token, using its stated hours. It has no recorded time for the end the admin
  entered, so it is never in the adjustments comparison. It is listed under rows entered
  by an admin, with the initials.
- **Auto-closed rows** (see Daily jobs) are `closed`, keep their User Token, and count
  with the hours from the guessed time. They have no Check-Out Recorded, so they are never
  in the adjustments comparison. A report lists them under flagged rows and under rows
  entered another way (`out "auto-close"`), and the `Kiosk: Flagged` and `Kiosk: Other
  status or source` views show them. A row with a Status other than `open` or `closed` is
  not counted and is listed for review.
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
    reached 50 hours for the first time. The same goes for the first-shift welcome: a paper
    shift imported before a new volunteer's first check-out at the tablet is their first
    shift, so the welcome doesn't show at that check-out. Whether it shows depends on when
    the import was run.
  - The **`Kiosk: Other status or source`** view shows every imported row.
- **The Hours tab** counts exactly these rows, with their stated hours, using the monthly
  report's own code. "All time" there means every counted row with a month. A counted row
  with no month is in no period, all time included; row 3 counts them. An imported row has
  no time, so its Start shows `no time`. The tab shows the Log as of its last refresh,
  which B1 names.

### Hours tab

The Hours tab shows stated hours, shifts and volunteers for any period you pick: a year, a
month, several months, a range of days or all time, narrowed to a role, an activity or a
volunteer if you want. `setupReports` builds it (see Setting up the reports). It replaces
the old Monthly Hours tab, so there is no month to pick in B1 any more.

- **Row 1**: the title, and in B1 when the tables are from (below). Row 1 stays on screen
  when you scroll.
- **Row 2**: a short note on how to use the tab.
- **Row 3**: counts for the whole Log that don't follow the slicers (below).
- **Row 4**: one line on the slicers and the sort boxes: "In a slicer, click Clear, then
  tick what you want. Reload the page to clear every slicer. A sort box takes up to 20
  seconds."
- **Row 5**: five slicers: Year, Month, Role/Type, Activity and Volunteer.
- **Row 6**: two more slicers, From date and To date, for a range of days. The note in F6
  says how to use them.
- **Row 7**: a sort box above each table (see Sorting).
- **From row 8**, three tables side by side, each with a Grand Total row:
  - **Hours by volunteer**: shifts and hours per volunteer;
  - **Hours by month**: shifts, hours, volunteers and average shift per month;
  - **Shifts**: one line per shift with its role/type, activity and hours (see The Shifts
    table).

**Picking a period.** Click a slicer, click Clear, then tick what you want. Every slicer
filters all three tables. Pick a year for that year, a month for that month, or several
months together. The Grand Total rows are then the period's stated hours, shifts,
volunteers and average shift. With every slicer cleared, the tables show all time.

**A range of days.** Use the From date and To date slicers in row 6:

1. Click From date. Choose Filter by condition, then Greater than or equal to, and type
   the first day, written like 2026-11-01. Click OK.
2. Click To date. Choose Filter by condition, then Less than or equal to, and type the
   last day. Click OK.

Both days you typed are included. The range works with the other slicers too: a range of
days and one activity, for example.

**Clearing every slicer.** Reload the page. That clears every pick at once, the date range
included. To clear one slicer, click it and click Clear.

**Your picks are yours alone.** A slicer pick shows only in the window you made it in:
nobody else sees it, and it's gone when you reload the page or close the tab. A refresh
keeps it: if Hours is refreshed while your tab is open, the new tables still follow your
picks.

Don't use "Set current filters as default" in a slicer's menu. It saves the pick for
everyone, and it comes back after a reload. Because a slicer saves the values it hides,
months and volunteers added later show in that default until someone clears it.
`setupReports` clears a saved default.

**Sorting.** Each table has a sort box above it, in row 7. Click the box and pick an order.
The table sorts itself. The new order can take up to 20 seconds to show. The choices, with
the one each table starts with first:

- **Hours by volunteer** (the box in A7): most hours first, fewest hours first, most
  shifts first, name A to Z, name Z to A.
- **Hours by month** (E7): oldest month first, newest month first, most hours first, most
  shifts first, most volunteers first.
- **Shifts** (K7): newest first, oldest first, most hours first, fewest hours first. The
  Shifts table below says how each day's shifts are ordered.

Each choice starts "Sort: " in the box. On name A to Z, `(no name)` comes first, and "Ann
Lee" comes before "Ann Lee (2)". Name Z to A turns both round. Lines with the same hours,
or the same number of shifts, can come in any order among themselves.

A sort is shared. It changes the order for everyone who has the sheet open, not just for
you. Only people who can edit the spreadsheet can change a box: with view-only access you
can't.

A sort stays through every refresh and through `setupReports`. To go back to a table's
first order, pick its first choice.

- If a table doesn't follow its box, pick the order again.
- A pick made while Hours is refreshing waits for the refresh to finish, then sorts.
- The box takes only its own choices: typing anything else is refused. If a box is emptied,
  or something else is pasted into it, it goes back to its first choice and its table
  follows.
- Don't sort a table in the editor that opens when you click it (the pivot table editor).
  That sort no longer lasts: the next pick in any box, or the next `setupReports`, puts the
  table back in its box's order. Any other change made in that editor goes too.
- Don't rename the Hours tab. The boxes work only on a tab named Hours. Renamed, they do
  nothing until you rename it back.
- If no pick ever re-sorts a table, the boxes' trigger may be missing (see Setting up the
  reports).

**The Shifts table.** One line per shift. Its first column, Shift, is a label made from the
shift's date, weekday, start time and volunteer: "2026-11-13 Fri 09:00 · Ann Lee". A shift
with no start time, such as an imported one, shows `no time` in its place: "2026-11-13 Fri
no time · Ann Lee". Then come the shift's Role/Type, Activity and Hours. There are no
separate Date, Start or Volunteer columns: all three are in the label. To find a Shifts
line on the Log, look for its Date, Start and Volunteer.

If one volunteer has two shifts that start the same minute on one day, the second gets
"(2)" at the end of its label, so each shift has its own line. The same goes for two
volunteers with no name. A label never changes when newer shifts come in.

How the Shifts choices order the lines:

- **Newest first**: the newest day first. Within a day, the `no time` shifts first, then
  the latest start to the earliest. Shifts that start the same minute go by the
  volunteer's name, Z to A.
- **Oldest first**: the oldest day first. Within a day, the earliest start first and the
  `no time` shifts last. Shifts that start the same minute go by the volunteer's name, A
  to Z.
- **Most hours first** and **fewest hours first**: by each shift's hours.

**The shifts behind a number.** Double-click a number in a table and Sheets opens a new tab
listing the Hours data rows behind it, with Hours data's columns (below). Each
double-click makes another tab, so they pile up; delete them when you're done. They hold no
User Token. Date and To date there hold the same day, shown as a date such as 2026-11-13.

**When the tables are from.** The tables aren't live. They show the Log as of the last
refresh, and B1 says when that was, such as "As of 2026-11-13 9:14 AM, refreshed from the
menu." A tap made since then shows at the next refresh. Nothing on the tab is a formula
over the Log, so a tap on the kiosk never waits for Hours, and a refresh never makes the
kiosk wait.

**When Hours is refreshed.** From Kiosk admin > Refresh Hours, each night at about 5 AM
(see Daily jobs), and by `setupReports`. Opening the spreadsheet doesn't refresh it; B1
then says "Not refreshed on open at ...: use Kiosk admin > Refresh Hours for newer taps."
(If a refresh is writing Hours at that moment, opening leaves B1 as it is.) Use Refresh
Hours when you need the latest taps.

**Refresh Hours** in the Kiosk admin menu opens no window and asks for no initials. It
reads the Log, writes the tables again and shows what B1 now says. Other answers:

- "Another refresh or setupReports is writing Hours. Try again in a minute." It waited 30
  seconds and changed nothing.
- "Another refresh already put in newer tables." Another refresh finished first, with
  newer taps; this one changed nothing.
- "This refresh failed: ..." with the reason, then what B1 now says.
- "Run setupReports." Hours isn't set up yet, or a tab named Hours isn't the kiosk's. If
  the kiosk's Hours tab has been copied, it names the copies to delete instead.

**What else B1 can say.**

- "Refreshing since ...": a refresh is writing the tables now. If this stays over 5
  minutes, the refresh was cut off; use Refresh Hours.
- "A refresh at ... stopped part way, so the tables may be incomplete": use Refresh Hours.
- "The refresh ... failed before writing: ...": the tables are still the earlier, whole
  ones. The reason says what to fix.
- "The refresh ... failed part way: ... The tables may be incomplete": fix what it names,
  then use Refresh Hours.
- "Hours is being set up by setupReports since ...": wait. If this stays over 5 minutes,
  run `setupReports` again. "Hours is not set up: run setupReports." means what it says.

**Row 3** counts, at the last refresh and over the whole Log whatever the slicers show:

- open shifts, which aren't counted (the Log's `Kiosk: Open shifts` view lists them);
- Log rows with Admin Alerts? set (the `Kiosk: Flagged` view);
- unreviewed Flags rows (the Flags tab's `Flags: Unreviewed` view), or "Run setupSheets
  to add the Flags tab" when the Flags tab is missing or can't be read;
- counted rows left out because their Date can't be read (the monthly report lists them
  under rows to review).

The monthly report gives open and flagged rows month by month.

**Volunteers' names.** A volunteer is a User Token, shown with the Volunteer Name from
their latest counted shift in the whole Log.

- **No name.** Every volunteer whose name there is blank is on one line, `(no name)`, with
  their shifts and hours added together. The Volunteer slicer has one `(no name)` entry.
- **The same name.** When two volunteers' names match, ignoring capitals and extra spaces,
  the one whose first shift came first keeps the plain name. The next gets a number: "Ann
  Lee", then "Ann Lee (2)", then "Ann Lee (3)". Each keeps their own spelling. Someone
  whose name really is "(no name)" shows as "(no name) (2)".
- **Names stay put.** A new volunteer's first shift is the newest, so they never change
  anyone else's name. A name changes only when a volunteer's latest name changes, when an
  older shift is added, edited or removed (an import, say), or when a volunteer with no
  name gets one.

Runs of spaces in names, Role/Type and Activity show as one, and values that differ only in
capitals show in one spelling, the one on the latest shift.

**The Volunteers count** in Hours by month counts the names in the table. So all of a
month's volunteers with no name count as one volunteer that month.

**Hours data.** The tables read a hidden tab, Hours data, which the refresh writes: one row
per counted shift with a month, as plain values, with no User Token. Its columns are A
Date, B Year, C Month, D To date, E Start, F Volunteer, G Shifts, H Hours, I Role/Type, J
Activity and K Shift. Date and To date hold the same day as a real date: the From date
slicer reads Date, and the To date slicer reads To date. Shift is the Shifts table's label.
There is no Weekday column; the weekday is in the Shift label.

Leave Hours data hidden and don't edit it. An edit there shows in the tables only until a
refresh writes the whole table again, which every refresh from the menu, at night or by
`setupReports` does. Its cells L1 to Q1 are the refresh's own record of what it wrote, and
B1 is worked out from them; leave them alone. Neither tab warns before an edit (a warning
would pop up at every slicer click), and `setupReports` clears the Hours tab and builds it
again, so anything typed on it is lost. The sort boxes' choices are the one thing it keeps.

**Where Hours and the monthly report differ.** Both count with the same code, so for a
month, with Hours refreshed since the Log last changed, they give the same hours and
shifts. Names, and sometimes the number of volunteers, differ:

- Hours names a volunteer from the whole Log and the report from the month, so someone
  whose name was spelled differently that month shows under different names. Hours also
  tidies spacing and capitals as above.
- For volunteers with the same name, Hours numbers them: "Ann Lee (2)". The report adds the
  date of each one's first shift instead: "Ann Lee · first shift 2026-03-02", plus the Log
  row when their first shifts share a date.
- Hours puts every volunteer with no name on one `(no name)` line and counts them as one
  volunteer in a month. The report lists and counts each one. So in a month with 3
  volunteers with no name, Hours' Volunteers figure is 2 lower than the report's.

And the refresh reads the Log without the kiosk's lock, so a row the kiosk was writing at
that moment can be read half-written; the next refresh reads it whole. The report reads
under the lock.

**On a phone or tablet.** Use Hours in Sheets on a computer: the Sheets apps for phones and
tablets can't edit pivot tables.

### Monthly report

**Monthly report** in the Kiosk admin menu opens a small window. Choose the month (it
starts on last month, or this month when last month has no rows) and type your initials,
as for the other menu items.

The report is written to a new tab named for the month, such as `Report 2026-11`. Making
a second report for the same month makes a new tab, `Report 2026-11 (2)`. The script
never changes a report tab after writing it, so each one is a record of the Log as it was
when the report was made. Delete old report tabs by hand when you no longer need them.
Report tabs warn before an edit.

Report tabs are styled when they're written: the title, the section headings, each
table's header row, column widths and a blue tab. The styling shows in the PDF too; what
the report says doesn't change. Tabs made before the styling keep their old look, since
the script never changes a report tab after writing it.

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

`setupReports` saves these filter views on the Log. In the Log, open Data > Change view
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
asks to authorize the script again, for the Sheets service it uses to save filter views
and build the Hours tab. Accept.

It makes or repairs the Hours and Hours data tabs, the filter views and the warnings, from
the Log's current columns, and fills Hours. Then it installs the trigger the sort boxes
need (below). It changes only what it made: the Hours and Hours data tabs, the views titled
`Kiosk: `, the warnings it put on the Log and its own sort trigger. It also deletes the old
Monthly Hours tab (below). It never changes a Log cell, a report tab or any other tab.

Each run builds the Hours tab again from scratch: it clears it and makes the slicers, sort
boxes and tables anew. Each sort box keeps the order it held, and its table follows it. A
saved slicer default is cleared, a sort made in the pivot table editor goes back to its
box's order, and anything typed on the tab is lost. Otherwise running it again changes
nothing.

It stops before changing anything when:

- the Log is missing a column the kiosk needs. It gives the kiosk's message; run
  `setupSheets` first;
- a tab named Hours or Hours data isn't the kiosk's (`setupReports` didn't make it).
  Rename or delete that tab, then run it again;
- the kiosk's Hours or Hours data tab has been copied. The copy carries the kiosk's mark,
  and the message names both tabs. Delete the copy, then run it again.

If a refresh is writing Hours and doesn't finish within a minute, it stops with "A refresh
is writing Hours; run setupReports again in a minute." The filter views and warnings are
done by then, and running it again is safe.

**The old Monthly Hours tab.** Once Hours is filled and reads back whole, `setupReports`
deletes the Monthly Hours tab, but only one that carries the warning before edits that
`setupReports` put on it. A tab named Monthly Hours without that warning is left alone, and
the finish message says so; delete it by hand when you no longer need it. If Hours can't be
filled, `setupReports` keeps Monthly Hours and stops with "Hours was not filled (...);
Monthly Hours was kept. Fix that and run setupReports again." The reason in the brackets is
what B1 says.

**The sort boxes' trigger.** A pick in a sort box runs a short job, `runHoursSort`, that
re-sorts the table. A trigger starts it. Once Hours is filled, `setupReports` installs that
trigger for the Google account running `setupReports`. Every pick then runs as that
account, whoever made it. So run `setupReports` signed in as the account that owns the
daily jobs (Settings "Daily jobs installed by").

The finish message says how it went:

- "The sort boxes run as ... (trigger installed)." or "(trigger already installed)." The
  boxes work. Running `setupReports` again keeps one trigger, never two.
- "The sort boxes' trigger couldn't be installed: ..." Hours is set up, but picking a sort
  does nothing. Fix what the message names, then run `setupReports` again.

If picking in a box never re-sorts its table, the trigger may be missing. Run
`setupReports` again, as that account. To check first, open the editor's Triggers page
(the clock icon), signed in as that account. It should list one `runHoursSort` trigger
whose event is On edit.

- **Removing it.** Delete the `runHoursSort` trigger on the Triggers page. The sort boxes
  then do nothing. `removeDailyJobs` doesn't remove it, since it isn't a daily job. The
  next `setupReports` adds it back.
- **Failure emails.** If a sort fails, Google emails a failure notice to the account
  that ran `setupReports`. The table may keep its old order: pick the order again.
- **Two accounts.** If a second account also ran `setupReports`, it has its own trigger,
  and each pick runs twice. That does no harm. To stop it, sign in as that account and
  delete its `runHoursSort` trigger. The Triggers page shows only the signed-in account's
  own triggers.
- **The Executions page** lists a `runHoursSort` run for every edit anywhere in the
  spreadsheet, not only for picks. Those runs see that the edit wasn't in a sort box and
  stop at once. That is normal.

When it finishes, its log in the editor says what it did, with two reminders: run
`setupDailyJobs` once more if the daily jobs were installed before the Hours refresh, and
run `setupReports` again after a Log column moves.

**After inserting, deleting or moving a Log column, run `setupReports` again**, so the
filter views follow the columns. Hours reads the Log by its headers and follows by itself.
Run `setupSheets` again too, for the look's colour rules.

**After pushing a new version that changes Hours, run `setupReports` straight away.**
Until it runs, the tabs keep their old layout: the sort boxes may be missing, and the
Shifts table may show dates as day numbers such as 46339.

To add the reports to a spreadsheet already in use, or to move one from the Monthly Hours
tab to the Hours tab and the new look, do these steps in this order:

1. `pnpm push`. The kiosk page doesn't change, so a versioned web app deployment needs no
   update, and the menu runs the pushed code. Monthly Hours keeps working until step 3,
   and Refresh Hours says "Run setupReports." until then.
2. Run `setupSheets` from the editor. It adds any missing Settings row, such as "Volunteer
   hour value", and applies the look.
3. Run `setupReports` from the editor, and authorize it when asked. If the daily jobs are
   installed, sign in as the account that owns them first. It builds and fills Hours,
   deletes Monthly Hours, and installs the sort boxes' trigger.
4. If the daily jobs are installed, sign in as the account that owns them (Settings "Daily
   jobs installed by") and run `setupDailyJobs` once more, to add the nightly Hours
   refresh. Doing it after step 3 means the first nightly run finds Hours set up.

## Setup

For a short clone-to-deploy checklist, see [CONTRIBUTING.md](CONTRIBUTING.md).

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
7. Once, in the Apps Script editor, run `setupSheets` (creates the Log, Settings, Flags
   and How to tabs, with Settings' What it does column and the header notes), then `setupSampleProfiles` (builds an invented Volunteer Profiles file and
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
Flags tab's Reviewed tickbox, its `Flags: Unreviewed` filter view and the look of the Log,
Flags and Settings tabs. It never changes a cell with text in it and never deletes a row,
except for the staff help it rewrites on every run (below). So running it again changes
nothing, except that it puts its look and its help back.

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
- Then the Flags tab: it creates the tab if there is none and writes any missing header
  after the last one (Reviewed By and Notes are not added; they are staff's). It sets each
  Flags column's format, puts the tickbox on Reviewed from row 2 to the bottom of the tab
  (only that column), freezes row 1, and adds or updates the `Flags: Unreviewed` filter
  view. That view uses the Sheets API advanced service, as `setupReports` does, so the
  first run may ask you to authorize the script again. If the view can't be made,
  `setupSheets` stops with a message saying so; everything before it is done, and the
  kiosk copies flags to the tab without the view.
- Last, the look of the Log, Flags and Settings tabs, on every run:
  - the header row: navy for the columns the kiosk writes, teal for the columns staff fill
    (Role/Type, Activity and Notes on the Log; Reviewed, Reviewed By and Notes on Flags;
    Value on Settings) and teal for any column the kiosk doesn't know; white bold text,
    wrapped, 40 px high;
  - the width of each column it knows (a column it doesn't know keeps its width), and
    Settings' Value column wrapped;
  - banding in white and light blue from row 2. It first removes any other banding on
    these tabs, so banding staff set there is lost at the next run;
  - colour rules: on the Log, an open row pale yellow and an Admin Alerts? cell with text
    pale red; on Flags, a row with Reviewed ticked in grey text. Each rule it makes has
    `N("kiosk look")` in its formula, which changes nothing but lets it find its own rules
    again. It replaces only those, keeps every rule staff made and puts staff's first, so
    where both match a cell, staff's wins;
  - the tab colours: Log navy, Flags yellow, Settings grey.

  The rules name columns by letter, so after moving a Log or Flags column, run
  `setupSheets` again (it must run again then anyway, for the formats). The look uses the
  same Sheets API advanced service as the view. If it can't be applied, `setupSheets`
  stops with "The tabs are set up, but their look could not be applied: ..."; everything
  before it is done.

- The staff help, on every run. All its text is in Logic.js's "Staff help" section (and
  `settingsDescriptions`, after `settingsDefaults`), so a release that runs `setupSheets`
  keeps it current. Staff text never names code.
  - Settings column C, What it does (see Settings), after the missing rows are added, with
    its one warning-only protection. Columns A and B are not written.
  - The Log and Flags header notes, after the Flags tab is set up. A cell gets the
    kiosk's note only when its note is empty or is exactly (`===`, nothing trimmed) one of
    `headerNoteKioskTexts()`: the current notes, or an earlier wording listed in
    `headerNotePastTexts()`. Any other note is staff's and is never written, not even
    back as it was. A cell that is no longer a kiosk header loses a note that is exactly a
    kiosk text, since it describes the wrong column. A deleted note comes back at the
    next run.
  - The How to tab, last: who to ask for help, short walkthroughs for staff (review
    flags, fix a sign-out, add, remove and restore a shift, the monthly report, the flags
    email, changing a setting, the Hours tab), a "Please don't" list, and every Log and
    Flags header note. Its first section, "Problems with the kiosk", is one cell holding a
    formula (in the General format; every other cell is plain text) that reads the
    Settings row "Kiosk contact" live: it shows "...contact: " and the value, trimmed, or
    while the row is blank, missing or unreadable, says to ask whoever looks after the
    kiosk and how to fill the row in. It finds the row as the kiosk does (the first row,
    exact name, case counting) and trims the same characters, so a value of only spaces or
    line breaks reads as blank. Staff edits to the row show at once, with no run.
    It is found by its developer metadata (key `kiosk-guide`), not by name. With no marked
    tab, it is created first in the tab bar; after that it is never moved or renamed, so
    it stays where staff put it. It is cleared and rewritten whole on every run, and has a
    warning-only protection. If it is deleted, the next run makes it again, first in the
    tab bar. With no marked tab, a tab named "How to" in any capitals stops the run
    (rename it); two marked tabs (a duplicated tab carries the mark) stop it too, named.

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

To add the reports to a sheet in use, or to move one from the Monthly Hours tab to the
Hours tab and the new look, follow the steps under Setting up the reports.

The staff help (Settings' What it does column, the header notes and the How to tab) is
written only by `setupSheets`, so:

- a release that changes any help text runs `setupSheets` after the push, as above;
- a release that changes `hoursHowTo()` or `hoursDateNote()` runs `setupSheets` as well as
  `setupReports`: the How to tab copies both lines, and `setupReports` doesn't write that
  tab;
- a change to a header note's wording adds the old text to `headerNotePastTexts()`.
  Otherwise cells on a live sheet still carrying the old text are taken for staff notes
  and never updated. `tests/header-notes-shipped.json` is the record of every note text a
  release has written: add the new texts to it after the release that writes them, and
  never remove one. A test fails while any text in it is unknown to the kiosk.

## Commands

```
pnpm dev         front end alone, with invented volunteers kept in the browser (two
                 Jordan Riveras try the phone step: 0142 and 0187). Any code of 16+
                 letters opens it; Shift+D opens its test tools. The window after the
                 tap is 12 hours. Jennifer Smith and Chris Thompson show the missed
                 check-out notice at their next check-in (reset to see it again).
pnpm test        server logic, setup and kiosk store tests (Node)
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
apps-script/Reports.js      setupReports, the Hours refresh and the Monthly report menu item's server functions
apps-script/Jobs.js         the daily jobs: setupDailyJobs, removeDailyJobs, the weekly flags email, the nightly Hours refresh
apps-script/HoursSort.js    the Hours tab's sort boxes: the on-edit handler that re-sorts a table when a box changes
apps-script/Report.html     the Monthly report window (plain HTML and JavaScript, committed source)
apps-script/Import.js       the Import past hours menu item: preview, write, ledger and flags
apps-script/ImportDialog.html the Import past hours dialog (plain HTML and JavaScript, committed source)
apps-script/Logic.js        the rules, as plain functions the Node tests load
apps-script/Sheets.js       Log, Settings, Flags and Profiles access; setupSheets, setupSampleProfiles
apps-script/SampleData.js   invented Volunteer Profiles rows for development
apps-script/Index.html      the page doGet serves; a build output, not committed
scripts/copy-to-gas.mjs     checks the single-file build and copies it into apps-script/
tests/                      logic tests, and setupSheets run against an in-memory sheet;
                            header-notes-shipped.json records the header notes released
sample-data/                invented volunteer profiles with the real column headers
```
