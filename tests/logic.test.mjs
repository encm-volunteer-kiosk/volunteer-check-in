// Tests for apps-script/Logic.js, loaded the way Apps Script loads it: one plain script
// run in its own global scope. Objects made inside that scope have its prototypes, so
// results are compared through plain().

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');

const L = {};
vm.runInNewContext(read('apps-script/Logic.js'), L);
const sample = {};
vm.runInNewContext(read('apps-script/SampleData.js'), sample);

const plain = (x) => JSON.parse(JSON.stringify(x));
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const idOf = (token) => sha256(token.trim()).slice(0, 16);

const MIN = 60000;
const HOUR = 60 * MIN;
// 10:00 Central on 2026-11-12 (Central is UTC-6 in November).
const NOW = Date.parse('2026-11-12T16:00:00Z');
const TODAY = '2026-11-12';

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const csv = parseCsv(read('sample-data/volunteer-profiles-sample.csv'));
const HEADER = csv[0];

/** A data row under the real header, with the given cells by normalized header. */
function profileRow(cells) {
  const row = HEADER.map(() => '');
  for (const [name, value] of Object.entries(cells)) {
    const at = HEADER.findIndex((h) => L.normalizeHeader(h) === name);
    assert.ok(at >= 0, 'no header ' + name);
    row[at] = value;
  }
  return row;
}

const person = (first, last, token, phone = '615-555-0150', start = '01/15/2026') =>
  profileRow({
    'volunteer first name': first,
    'volunteer last name': last,
    'onboarding token': token,
    'volunteer phone': phone,
    'start date mm/dd/yyyy': start,
  });

const parse = (rows) => plain(L.parseProfiles(HEADER, rows, sha256));

// ---------------------------------------------------------------------------
// Text

test('normalizeHeader collapses embedded newlines and spaces', () => {
  assert.equal(L.normalizeHeader('Volunteer\nFirst Name'), 'volunteer first name');
  assert.equal(L.normalizeHeader('  Start Date\r\nmm/dd/yyyy '), 'start date mm/dd/yyyy');
  assert.equal(L.normalizeHeader('Onboarding\n  Token'), 'onboarding token');
});

test('normalizeName trims, lower-cases and collapses spaces', () => {
  assert.equal(L.normalizeName('  Maria   ALVAREZ '), 'maria alvarez');
  assert.equal(L.normalizeName(null), '');
});

test('normalizeCode keeps lower-case letters only', () => {
  assert.equal(L.normalizeCode('Purple Otter 42 Lamp-Post!'), 'purpleotterlamppost');
  assert.equal(L.normalizeCode(undefined), '');
});

test('sheetText marks formula-looking text as plain text', () => {
  assert.equal(L.sheetText('=HYPERLINK("x")'), '\'=HYPERLINK("x")');
  assert.equal(L.sheetText(' Maria '), 'Maria');
  assert.equal(L.sheetText('-Ann'), '-Ann');
});

test('utf8Length counts UTF-8 bytes', () => {
  assert.equal(L.utf8Length('abc'), 3);
  assert.equal(L.utf8Length('é'), 2);
  assert.equal(L.utf8Length('€'), 3);
  assert.equal(L.utf8Length('😀'), 4);
});

test('bytesToHex turns signed digest bytes into lowercase hex', () => {
  assert.equal(L.bytesToHex([-1, 0, 15, 16, -128, 127]), 'ff000f10807f');
  const digest = createHash('sha256').update('sample-token-01', 'utf8').digest();
  const signed = Array.from(new Int8Array(digest.buffer, digest.byteOffset, digest.length));
  assert.equal(L.bytesToHex(signed), sha256('sample-token-01'));
});

test('idFromHash keeps the first 16 hex characters', () => {
  assert.equal(L.idFromHash('ABCDEF0123456789ffff'), 'abcdef0123456789');
});

test('phoneLast4 takes the last four digits and drops an extension', () => {
  assert.equal(L.phoneLast4('615-555-0101'), '0101');
  assert.equal(L.phoneLast4('(615) 555-0113'), '0113');
  assert.equal(L.phoneLast4('615-555-0117 x12'), '0117');
  assert.equal(L.phoneLast4('615.555.0118 ext. 4401'), '0118');
  assert.equal(L.phoneLast4('615-555-0119 Ext 7'), '0119');
  assert.equal(L.phoneLast4('615-555-0120#33'), '0120');
  assert.equal(L.phoneLast4('6155550121'), '0121');
  assert.equal(L.phoneLast4('555'), '');
  assert.equal(L.phoneLast4(''), '');
  assert.equal(L.phoneLast4('x1234'), '');
});

test('parseStartDate accepts yyyy-MM-dd and m/d/yyyy only', () => {
  assert.equal(L.parseStartDate('2026-02-15'), '2026-02-15');
  assert.equal(L.parseStartDate('2/5/2026'), '2026-02-05');
  assert.equal(L.parseStartDate(' 02/15/2026 '), '2026-02-15');
  assert.equal(L.parseStartDate(''), '');
  assert.equal(L.parseStartDate('soon'), '');
  assert.equal(L.parseStartDate('2026-02-30'), '');
  assert.equal(L.parseStartDate('13/01/2026'), '');
  assert.equal(L.parseStartDate('2026/02/15'), '');
});

test('isRowToday on a date and on a date-time', () => {
  assert.equal(L.isRowToday('2026-11-12', TODAY), true);
  assert.equal(L.isRowToday(' 2026-11-12 ', TODAY), true);
  assert.equal(L.isRowToday('11/12/2026', TODAY), true);
  assert.equal(L.isRowToday('2026-11-12 9:30 am', TODAY), true);
  assert.equal(L.isRowToday('2026-11-12T09:30:00', TODAY), true);
  assert.equal(L.isRowToday('2026-11-11', TODAY), false);
  assert.equal(L.isRowToday('2026-11-11 23:59', TODAY), false);
  assert.equal(L.isRowToday('', TODAY), false);
  assert.equal(L.isRowToday('2026-11-12', ''), false);
});

test('parseFlagMinutes falls back to 15', () => {
  assert.equal(L.parseFlagMinutes('20'), 20);
  assert.equal(L.parseFlagMinutes('0'), 0);
  assert.equal(L.parseFlagMinutes(''), 15);
  assert.equal(L.parseFlagMinutes('soon'), 15);
  assert.equal(L.parseFlagMinutes('-5'), 15);
});

// ---------------------------------------------------------------------------
// Setup tables

test('logHeaders and settingsDefaults', () => {
  assert.deepEqual(plain(L.logHeaders()), [
    'Shift ID',
    'Volunteer ID',
    'First name',
    'Last name',
    'Date',
    'Tapped in at',
    'Arrived at',
    'Signed out at',
    'Hours',
    'Status',
    'Flag',
    'Staff note',
  ]);
  const defaults = Object.fromEntries(plain(L.settingsDefaults(TODAY)));
  assert.equal(defaults['Kiosk access code'], '');
  assert.equal(defaults['Volunteer Profiles file ID'], '');
  assert.equal(defaults['Volunteer Profiles tab'], 'Volunteer Profiles');
  assert.equal(defaults['Kiosk launch date'], TODAY);
  assert.equal(defaults['Arrival flag minutes'], '15');
  assert.equal(defaults['Profiles problems'], '');
  assert.equal(defaults['Closing time Monday'], '17:00');
  assert.equal(defaults['Closing time Sunday'], '17:00');
  assert.equal(L.settingsDefaults(TODAY).length, 13);
});

// ---------------------------------------------------------------------------
// Volunteer Profiles

test('the sample CSV header has 22 columns with embedded newlines', () => {
  assert.equal(HEADER.length, 22);
  assert.ok(HEADER[0].includes('\n'));
  const { volunteers, problems } = parse(csv.slice(1));
  assert.equal(volunteers.length, 12);
  assert.deepEqual(problems, []);
  const maria = volunteers[0];
  assert.deepEqual(maria, {
    id: idOf('sample-token-01'),
    firstName: 'Maria',
    lastName: 'Alvarez',
    phoneLast4: '0101',
    startDate: '2026-02-15',
    needsPhoneCheck: false,
  });
  // Kate Sullivan and Kate Sullivan-Price are different names.
  assert.ok(volunteers.every((v) => !v.needsPhoneCheck));
});

test('SampleData.js starts with the CSV header and its people', () => {
  const rows = plain(sample.sampleProfileRows_());
  assert.deepEqual(rows[0], HEADER);
  assert.deepEqual(rows.slice(1, csv.length), csv.slice(1));
  assert.ok(rows.every((r) => r.length === 22));
  const { volunteers, problems } = parse(rows.slice(1));
  const alvarez = volunteers.filter((v) => v.lastName === 'Alvarez');
  assert.equal(alvarez.length, 2);
  assert.ok(alvarez.every((v) => v.needsPhoneCheck));
  assert.notEqual(alvarez[0].phoneLast4, alvarez[1].phoneLast4);
  // rows[k] is sheet row k + 1, the header being row 1.
  const anaRow = rows.findIndex((r) => r[0] === 'Ana') + 1;
  assert.deepEqual(
    problems.map((p) => p.text),
    ['row ' + anaRow + ': Ana Ruiz has no onboarding token'],
  );
  const starts = volunteers.map((v) => v.startDate);
  assert.ok(starts.some((d) => d < TODAY));
  assert.ok(starts.some((d) => d > TODAY));
  assert.ok(volunteers.some((v) => v.firstName === 'Ivy' && v.phoneLast4 === '0117'));
});

test('a missing required header throws and names it', () => {
  const header = HEADER.filter((h) => L.normalizeHeader(h) !== 'onboarding token');
  assert.throws(() => L.parseProfiles(header, [], sha256), /"onboarding token"/);
});

test('email is not needed', () => {
  const header = HEADER.filter((h) => L.normalizeHeader(h) !== 'email');
  assert.doesNotThrow(() => L.parseProfiles(header, [], sha256));
});

test('a blank token leaves the row out with a problem line', () => {
  const { volunteers, problems } = parse([
    person('Lena', 'Park', 'tok-a'),
    person('Ana', 'Ruiz', '  '),
  ]);
  assert.deepEqual(
    volunteers.map((v) => v.firstName),
    ['Lena'],
  );
  assert.deepEqual(problems, [{ row: 3, text: 'row 3: Ana Ruiz has no onboarding token' }]);
});

test('a row without both names is skipped silently', () => {
  const { volunteers, problems } = parse([
    person('', '', 'tok-a'),
    person('Cher', '', 'tok-b'),
    person('   ', 'Lowe', 'tok-c'),
    profileRow({}),
  ]);
  assert.deepEqual(volunteers, []);
  assert.deepEqual(problems, []);
});

test('rows sharing a token are all left out, each naming the others', () => {
  const { volunteers, problems } = parse([
    person('Lena', 'Park', 'tok-a'),
    person('Omar', 'Haddad', 'tok-dup'),
    person('Ruth', 'Lindqvist', ' tok-dup '),
    person('Dev', 'Patel', 'tok-dup'),
  ]);
  assert.deepEqual(
    volunteers.map((v) => v.firstName),
    ['Lena'],
  );
  assert.deepEqual(
    problems.map((p) => p.text),
    [
      'row 3: Omar Haddad has the same onboarding token as rows 4, 5',
      'row 4: Ruth Lindqvist has the same onboarding token as rows 3, 5',
      'row 5: Dev Patel has the same onboarding token as rows 3, 4',
    ],
  );
  const pair = parse([person('A', 'B', 't1'), person('C', 'D', 't1')]);
  assert.equal(pair.problems[0].text, 'row 2: A B has the same onboarding token as row 3');
});

test('a same-name pair both need a phone check', () => {
  const { volunteers, problems } = parse([
    person('Sam', 'Lee', 'tok-1', '615-555-0131'),
    person('Ruth', 'Okafor', 'tok-2'),
    person(' sam ', 'LEE', 'tok-3', '615-555-0132'),
  ]);
  assert.deepEqual(problems, []);
  assert.deepEqual(
    volunteers.map((v) => [v.firstName, v.id, v.phoneLast4, v.needsPhoneCheck]),
    [
      ['Sam', idOf('tok-1'), '0131', true],
      ['Ruth', idOf('tok-2'), '0150', false],
      ['sam', idOf('tok-3'), '0132', true],
    ],
  );
});

test('a same-name member with no usable phone is listed and gets a problem line', () => {
  const { volunteers, problems } = parse([
    person('Sam', 'Lee', 'tok-1', '615-555-0131'),
    person('Sam', 'Lee', 'tok-2', '555'),
    person('Ruth', 'Okafor', 'tok-3', ''),
  ]);
  assert.equal(volunteers.length, 3);
  assert.equal(volunteers[1].phoneLast4, '');
  assert.equal(volunteers[1].needsPhoneCheck, true);
  // No phone is fine for someone who doesn't share a name.
  assert.deepEqual(problems, [
    { row: 3, text: 'row 3: Sam Lee shares a name and has no usable phone number' },
  ]);
});

test('a same-name pair with the same last four are both refused and reported', () => {
  const { volunteers, problems } = parse([
    person('Sam', 'Lee', 'tok-1', '615-555-0131'),
    person('Ruth', 'Okafor', 'tok-2', '615-555-0131'),
    person('Sam', 'Lee', 'tok-3', '(615) 555-0131 x9'),
  ]);
  assert.equal(volunteers.length, 3);
  const sams = volunteers.filter((v) => v.firstName === 'Sam');
  for (const sam of sams) {
    assert.equal(sam.needsPhoneCheck, true);
    assert.equal(L.checkPhone(sam, '0131'), 'PHONE_MISSING');
    assert.equal(L.checkPhone(sam, null), 'PHONE_MISSING');
  }
  // Ruth shares the digits but not the name, so she is unaffected.
  assert.equal(volunteers[1].phoneLast4, '0131');
  assert.deepEqual(problems, [
    { row: 2, text: 'row 2: Sam Lee shares a name and the last four phone digits with row 4' },
    { row: 4, text: 'row 4: Sam Lee shares a name and the last four phone digits with row 2' },
  ]);
});

test('in a same-name trio where two share a last four, the third still passes', () => {
  const { volunteers, problems } = parse([
    person('Sam', 'Lee', 'tok-1', '615-555-0131'),
    person('Sam', 'Lee', 'tok-2', '615-555-0132'),
    person('sam', 'lee', 'tok-3', '615-555-0131'),
  ]);
  assert.equal(volunteers.length, 3);
  assert.equal(L.checkPhone(volunteers[0], '0131'), 'PHONE_MISSING');
  assert.equal(L.checkPhone(volunteers[2], '0131'), 'PHONE_MISSING');
  assert.equal(L.checkPhone(volunteers[1], '0132'), null);
  assert.equal(L.checkPhone(volunteers[1], '0131'), 'PHONE_WRONG');
  assert.deepEqual(
    problems.map((p) => p.text),
    [
      'row 2: Sam Lee shares a name and the last four phone digits with row 4',
      'row 4: sam lee shares a name and the last four phone digits with row 2',
    ],
  );
  const four = parse([
    person('Sam', 'Lee', 'tok-1', '615-555-0131'),
    person('Sam', 'Lee', 'tok-2', '615-555-0131'),
    person('Sam', 'Lee', 'tok-3', '615-555-0131'),
  ]);
  assert.equal(
    four.problems[0].text,
    'row 2: Sam Lee shares a name and the last four phone digits with rows 3, 4',
  );
});

test('a duplicate token does not count toward a same-name group', () => {
  const { volunteers } = parse([
    person('Sam', 'Lee', 'tok-1'),
    person('Sam', 'Lee', 'tok-dup'),
    person('Ann', 'Ito', 'tok-dup'),
  ]);
  assert.equal(volunteers.length, 1);
  assert.equal(volunteers[0].needsPhoneCheck, false);
});

test('start dates are read in either form', () => {
  const { volunteers } = parse([
    person('A', 'One', 't1', '', '2026-03-04'),
    person('B', 'Two', 't2', '', '3/4/2026'),
    person('C', 'Three', 't3', '', ''),
    person('D', 'Four', 't4', '', 'TBD'),
  ]);
  assert.deepEqual(
    volunteers.map((v) => v.startDate),
    ['2026-03-04', '2026-03-04', '', ''],
  );
});

test('findVolunteer', () => {
  const list = [{ id: 'abc' }, { id: 'def' }];
  assert.deepEqual(plain(L.findVolunteer(list, 'def')), { id: 'def' });
  assert.equal(L.findVolunteer(list, 'zzz'), null);
  assert.equal(L.findVolunteer(list, null), null);
});

// ---------------------------------------------------------------------------
// Access, phone and arrival

test('checkAccessCode needs a 16-letter Settings code and a match', () => {
  const code = 'purple otter lamp post';
  assert.equal(L.checkAccessCode('PURPLEOTTERLAMPPOST', code), null);
  assert.equal(L.checkAccessCode('purple otter lamp post', code), null);
  assert.equal(L.checkAccessCode('purple otter lamp', code), 'ACCESS');
  assert.equal(L.checkAccessCode('', code), 'ACCESS');
  assert.equal(L.checkAccessCode(null, code), 'ACCESS');
  // Fifteen letters counts as not set, even when the code matches.
  assert.equal(L.checkAccessCode('abcdefghijklmno', 'abcdefghijklmno'), 'ACCESS');
  assert.equal(L.checkAccessCode('abcdefghijklmnop', 'abcdefghijklmnop'), null);
  assert.equal(L.checkAccessCode('', ''), 'ACCESS');
  assert.equal(L.minCodeLetters(), 16);
});

test('checkPhone', () => {
  const plainOne = { needsPhoneCheck: false, phoneLast4: '' };
  const twin = { needsPhoneCheck: true, phoneLast4: '0131' };
  const noPhone = { needsPhoneCheck: true, phoneLast4: '' };
  assert.equal(L.checkPhone(plainOne, null), null);
  assert.equal(L.checkPhone(plainOne, '9999'), null);
  assert.equal(L.checkPhone(twin, null), 'PHONE_NEEDED');
  assert.equal(L.checkPhone(twin, ''), 'PHONE_NEEDED');
  assert.equal(L.checkPhone(twin, '0132'), 'PHONE_WRONG');
  assert.equal(L.checkPhone(twin, '0131'), null);
  assert.equal(L.checkPhone(noPhone, '0131'), 'PHONE_MISSING');
  assert.equal(L.checkPhone(noPhone, null), 'PHONE_MISSING');
});

test('validateArrival clamps up to 5 minutes ahead and refuses more', () => {
  assert.deepEqual(plain(L.validateArrival(NOW, NOW - HOUR, TODAY, TODAY)), {
    arrivedMs: NOW - HOUR,
  });
  assert.deepEqual(plain(L.validateArrival(NOW, NOW + 3 * MIN, TODAY, TODAY)), { arrivedMs: NOW });
  assert.deepEqual(plain(L.validateArrival(NOW, NOW + 5 * MIN, TODAY, TODAY)), { arrivedMs: NOW });
  assert.equal(L.validateArrival(NOW, NOW + 6 * MIN, TODAY, TODAY), 'ARRIVAL_FUTURE');
  assert.equal(L.arrivalGraceMinutes(), 5);
});

test('validateArrival refuses another day', () => {
  assert.equal(L.validateArrival(NOW, NOW - 12 * HOUR, '2026-11-11', TODAY), 'ARRIVAL_OTHER_DAY');
  assert.equal(L.validateArrival(NOW, NaN, '', TODAY), 'ARRIVAL_OTHER_DAY');
  // Just before midnight, a fast clock's arrival is past midnight but is taken as now.
  assert.deepEqual(plain(L.validateArrival(NOW, NOW + 2 * MIN, '2026-11-13', TODAY)), {
    arrivedMs: NOW,
  });
  // Far in the future is refused as future first.
  assert.equal(L.validateArrival(NOW, NOW + 24 * HOUR, '2026-11-13', TODAY), 'ARRIVAL_FUTURE');
});

test('arrivalFlag compares and prints the same rounded minutes', () => {
  assert.equal(L.arrivalFlag(NOW, NOW - 15 * MIN, 15), '');
  assert.equal(L.arrivalFlag(NOW, NOW - 16 * MIN, 15), 'arrival differs by 16 min');
  assert.equal(L.arrivalFlag(NOW, NOW - 15.4 * MIN, 15), '');
  assert.equal(L.arrivalFlag(NOW, NOW - 15.6 * MIN, 15), 'arrival differs by 16 min');
  assert.equal(L.arrivalFlag(NOW, NOW + 20 * MIN, 15), 'arrival differs by 20 min');
  assert.equal(L.arrivalFlag(NOW, NOW - 16 * MIN, 30), '');
  assert.equal(L.arrivalFlag(NOW, NaN, 15), '');
});

// ---------------------------------------------------------------------------
// Hours and milestones

test('hoursBetween rounds to 2 decimals and is never negative', () => {
  assert.equal(L.hoursBetween(NOW, NOW + 90 * MIN), 1.5);
  assert.equal(L.hoursBetween(NOW, NOW + 100 * MIN), 1.67);
  assert.equal(L.hoursBetween(NOW, NOW - HOUR), 0);
  assert.equal(L.hoursBetween(NaN, NOW), 0);
});

test('minutesFromHours', () => {
  assert.equal(L.minutesFromHours(1.67), 100);
  assert.equal(L.minutesFromHours('2.5'), 150);
  assert.equal(L.minutesFromHours(''), 0);
  assert.equal(L.minutesFromHours(NaN), 0);
  assert.equal(L.minutesFromHours('junk'), 0);
  assert.equal(L.minutesFromHours(-1), 0);
});

test('milestones table', () => {
  const table = plain(L.milestones());
  assert.deepEqual(
    table.map((m) => m.id),
    ['shift-1', 'shift-10', 'shift-25', 'hours-50', 'hours-100'],
  );
  assert.equal(table[0].title, 'First completed shift');
  assert.equal(table[4].message, '100 hours logged here, making East Nashville stronger.');
});

const LAUNCH = '2026-11-01';
const crossed = (shifts, minutes, add, start = '2026-11-05', launch = LAUNCH) => {
  const m = L.milestoneCrossed(shifts, minutes, add, start, launch);
  return m && m.id;
};

test('each milestone fires at its threshold', () => {
  assert.equal(crossed(0, 0, 60), 'shift-1');
  assert.equal(crossed(1, 60, 60), null);
  assert.equal(crossed(8, 480, 60), null);
  assert.equal(crossed(9, 540, 60), 'shift-10');
  assert.equal(crossed(10, 600, 60), null);
  assert.equal(crossed(24, 1440, 60), 'shift-25');
  assert.equal(crossed(30, 49 * 60, 59), null);
  assert.equal(crossed(30, 49 * 60, 60), 'hours-50');
  assert.equal(crossed(30, 50 * 60, 60), null);
  assert.equal(crossed(60, 99 * 60 + 30, 30), 'hours-100');
  const m = plain(L.milestoneCrossed(9, 540, 60, '', LAUNCH));
  assert.deepEqual(m, {
    id: 'shift-10',
    title: '10 shifts',
    message: '10 shifts checked in here. Thank you for showing up for your neighbors!',
  });
});

test('a double crossing gives the first in order', () => {
  assert.equal(crossed(9, 49 * 60, 120), 'shift-10');
  assert.equal(crossed(24, 99 * 60, 120), 'shift-25');
  assert.equal(crossed(30, 49 * 60, 52 * 60), 'hours-50');
});

test('first completed shift depends on the start date and launch date', () => {
  assert.equal(crossed(0, 0, 60, '2026-10-31'), null);
  assert.equal(crossed(0, 0, 60, '2026-11-01'), 'shift-1');
  assert.equal(crossed(0, 0, 60, '2026-11-02'), 'shift-1');
  assert.equal(crossed(0, 0, 60, '11/2/2026'), 'shift-1');
  assert.equal(crossed(0, 0, 60, '11/2/2026', '11/1/2026'), 'shift-1');
  assert.equal(crossed(0, 0, 60, ''), null);
  assert.equal(crossed(0, 0, 60, 'TBD'), null);
  assert.equal(crossed(0, 0, 60, '2026-11-02', ''), null);
  // Skipping the first shift doesn't stop an hours milestone on the same check-out.
  assert.equal(crossed(0, 0, 50 * 60, '2026-10-01'), 'hours-50');
});

// ---------------------------------------------------------------------------
// Log rows and the check-in and check-out decisions

const ID = 'aaaaaaaaaaaaaaaa';
const OTHER = 'bbbbbbbbbbbbbbbb';
const entry = (row, fields) => ({
  row,
  id: ID,
  dateText: TODAY,
  tappedMs: NOW - 2 * HOUR,
  arrivedMs: NOW - 2 * HOUR,
  hours: NaN,
  status: 'open',
  ...fields,
});

test('findOpenShiftToday ignores other IDs, other days and closed rows', () => {
  const entries = [
    entry(2, { dateText: '2026-11-11' }),
    entry(3, { status: 'closed', hours: 1 }),
    entry(4, { id: OTHER }),
  ];
  assert.equal(L.findOpenShiftToday(entries, ID, TODAY), null);
  entries.push(entry(5, { status: ' Open ' }));
  assert.equal(L.findOpenShiftToday(entries, ID, TODAY).row, 5);
  entries.push(entry(6, { arrivedMs: NOW - HOUR }));
  assert.equal(L.findOpenShiftToday(entries, ID, TODAY).row, 6);
});

test('closedTotals counts closed rows and their minutes', () => {
  const entries = [
    entry(2, { status: 'closed', hours: 1.5, dateText: '2026-10-01' }),
    entry(3, { status: 'Closed', hours: 2.25 }),
    entry(4, { status: 'closed', hours: NaN }),
    entry(5, { status: 'open' }),
    entry(6, { status: 'auto-closed', hours: 3 }),
    entry(7, { status: 'closed', hours: 4, id: OTHER }),
  ];
  assert.deepEqual(plain(L.closedTotals(entries, ID)), { shifts: 3, minutes: 225 });
});

test('volunteerSummaries gives only today\'s open arrival and no private fields', () => {
  const volunteers = [
    {
      id: ID,
      firstName: 'Sam',
      lastName: 'Lee',
      phoneLast4: '0131',
      startDate: '2026-01-15',
      needsPhoneCheck: true,
    },
    {
      id: OTHER,
      firstName: 'Ruth',
      lastName: 'Okafor',
      phoneLast4: '0150',
      startDate: '',
      needsPhoneCheck: false,
    },
  ];
  const entries = [
    entry(2, { id: OTHER, dateText: '2026-11-11' }),
    entry(3, { arrivedMs: NaN, tappedMs: NOW - HOUR }),
  ];
  assert.deepEqual(plain(L.volunteerSummaries(volunteers, entries, TODAY)), [
    {
      id: ID,
      firstName: 'Sam',
      lastName: 'Lee',
      openShiftArrival: new Date(NOW - HOUR).toISOString(),
      needsPhoneCheck: true,
    },
    { id: OTHER, firstName: 'Ruth', lastName: 'Okafor', openShiftArrival: null, needsPhoneCheck: false },
  ]);
});

const VOL = {
  id: ID,
  firstName: 'Sam',
  lastName: 'Lee',
  phoneLast4: '0131',
  startDate: '2026-11-05',
  needsPhoneCheck: false,
};
const TWIN = { ...VOL, needsPhoneCheck: true };
const checkIn = (fields) =>
  plain(
    L.decideCheckIn({
      volunteers: [VOL],
      id: ID,
      digits: null,
      entries: [],
      todayDate: TODAY,
      nowMs: NOW,
      arrivedMs: NOW - 20 * MIN,
      arrivedDate: TODAY,
      flagMinutes: 15,
      ...fields,
    }),
  );

test('decideCheckIn accepts and flags', () => {
  assert.deepEqual(checkIn({}), {
    volunteer: VOL,
    arrivedMs: NOW - 20 * MIN,
    flag: 'arrival differs by 20 min',
  });
  assert.deepEqual(checkIn({ arrivedMs: NOW - 5 * MIN }), {
    volunteer: VOL,
    arrivedMs: NOW - 5 * MIN,
    flag: '',
  });
  assert.deepEqual(checkIn({ arrivedMs: NOW + 3 * MIN }), { volunteer: VOL, arrivedMs: NOW, flag: '' });
  assert.deepEqual(checkIn({ volunteers: [TWIN], digits: '0131' }).flag, 'arrival differs by 20 min');
  // Yesterday's open row is left for the auto-close and doesn't block today.
  assert.deepEqual(checkIn({ entries: [entry(2, { dateText: '2026-11-11' })] }).flag, 'arrival differs by 20 min');
});

test('decideCheckIn refuses in order', () => {
  const open = [entry(2, {})];
  const late = { arrivedMs: NOW + HOUR };
  assert.deepEqual(checkIn({ id: 'zzzzzzzzzzzzzzzz', entries: open, ...late }), {
    refusal: 'NOT_FOUND',
  });
  assert.deepEqual(checkIn({ volunteers: [{ ...TWIN, phoneLast4: '' }], entries: open }), {
    refusal: 'PHONE_MISSING',
  });
  assert.deepEqual(checkIn({ volunteers: [TWIN], entries: open }), { refusal: 'PHONE_NEEDED' });
  assert.deepEqual(checkIn({ volunteers: [TWIN], digits: '9999', entries: open }), {
    refusal: 'PHONE_WRONG',
  });
  assert.deepEqual(checkIn({ volunteers: [TWIN], digits: '0131', entries: open, ...late }), {
    refusal: 'ALREADY_IN',
  });
  assert.deepEqual(checkIn(late), { refusal: 'ARRIVAL_FUTURE' });
  assert.deepEqual(checkIn({ arrivedMs: NOW - 12 * HOUR, arrivedDate: '2026-11-11' }), {
    refusal: 'ARRIVAL_OTHER_DAY',
  });
});

const checkOut = (fields) =>
  plain(
    L.decideCheckOut({
      volunteers: [VOL],
      id: ID,
      digits: null,
      entries: [entry(9, {})],
      todayDate: TODAY,
      nowMs: NOW,
      launchDate: LAUNCH,
      ...fields,
    }),
  );

test('decideCheckOut closes today\'s open row and picks the milestone', () => {
  const first = checkOut({});
  assert.deepEqual(first, {
    volunteer: VOL,
    row: 9,
    hours: 2,
    minutes: 120,
    milestone: {
      id: 'shift-1',
      title: 'First completed shift',
      message: 'Your first day making a difference. Welcome to the neighborhood!',
    },
  });
  const history = Array.from({ length: 9 }, (_, i) =>
    entry(20 + i, { status: 'closed', hours: 3, dateText: '2026-10-0' + (i + 1) }),
  );
  const tenth = checkOut({ entries: [...history, entry(9, {})] });
  assert.equal(tenth.milestone.id, 'shift-10');
  const second = checkOut({ entries: [history[0], entry(9, {})] });
  assert.equal(second.milestone, null);
});

test('decideCheckOut refuses in order', () => {
  assert.deepEqual(checkOut({ id: 'zzzzzzzzzzzzzzzz' }), { refusal: 'NOT_FOUND' });
  assert.deepEqual(checkOut({ volunteers: [TWIN] }), { refusal: 'PHONE_NEEDED' });
  assert.deepEqual(checkOut({ volunteers: [TWIN], digits: '0000' }), { refusal: 'PHONE_WRONG' });
  assert.deepEqual(checkOut({ volunteers: [TWIN], digits: '0131' }).row, 9);
  assert.deepEqual(checkOut({ entries: [] }), { refusal: 'NOT_IN' });
  assert.deepEqual(checkOut({ entries: [entry(9, { dateText: '2026-11-11' })] }), {
    refusal: 'NOT_IN',
  });
  assert.deepEqual(checkOut({ entries: [entry(9, { status: 'closed', hours: 1 })] }), {
    refusal: 'NOT_IN',
  });
});

// A same-name group as parseProfiles lists it: two Sam Lees told apart by their last
// four, a third whose phone is unusable, and Ruth, who shares only the digits.
const group = () =>
  parse([
    person('Sam', 'Lee', 'tok-1', '615-555-0131'),
    person('Ruth', 'Okafor', 'tok-2', '615-555-0132'),
    person(' sam ', 'LEE', 'tok-3', '615-555-0132'),
    person('Sam', 'Lee', 'tok-4', ''),
  ]).volunteers;

test('resolveVolunteer acts on the tapped volunteer when the digits are theirs', () => {
  const list = group();
  assert.equal(L.resolveVolunteer(list, idOf('tok-1'), '0131').volunteer.id, idOf('tok-1'));
  assert.equal(L.resolveVolunteer(list, idOf('tok-3'), '0132').volunteer.id, idOf('tok-3'));
  // No phone check outside a group: any digits, or none, pass.
  assert.equal(L.resolveVolunteer(list, idOf('tok-2'), null).volunteer.id, idOf('tok-2'));
  assert.equal(L.resolveVolunteer(list, idOf('tok-2'), '0131').volunteer.id, idOf('tok-2'));
  assert.deepEqual(plain(L.resolveVolunteer(list, 'zzzzzzzzzzzzzzzz', '0131')), {
    refusal: 'NOT_FOUND',
  });
  assert.deepEqual(plain(L.resolveVolunteer(list, idOf('tok-1'), '')), {
    refusal: 'PHONE_NEEDED',
  });
});

test('resolveVolunteer: the wrong same-name entry with the right digits acts on the right person', () => {
  const list = group();
  assert.equal(L.resolveVolunteer(list, idOf('tok-1'), '0132').volunteer.id, idOf('tok-3'));
  assert.equal(L.resolveVolunteer(list, idOf('tok-3'), '0131').volunteer.id, idOf('tok-1'));
  // Ruth has 0132 too, but she isn't in the group.
  assert.notEqual(L.resolveVolunteer(list, idOf('tok-1'), '0132').volunteer.id, idOf('tok-2'));
});

test('resolveVolunteer: digits matching nobody in the group are PHONE_WRONG', () => {
  const list = group();
  assert.deepEqual(plain(L.resolveVolunteer(list, idOf('tok-1'), '9999')), {
    refusal: 'PHONE_WRONG',
  });
  // Ruth's digits don't reach across names: she isn't a Sam Lee.
  const withoutThird = list.filter((v) => v.id !== idOf('tok-3'));
  assert.deepEqual(plain(L.resolveVolunteer(withoutThird, idOf('tok-1'), '0132')), {
    refusal: 'PHONE_WRONG',
  });
});

test('resolveVolunteer: a member without usable digits is PHONE_MISSING and never matched', () => {
  const list = group();
  for (const digits of ['0131', '0132', '9999', null]) {
    assert.deepEqual(plain(L.resolveVolunteer(list, idOf('tok-4'), digits)), {
      refusal: 'PHONE_MISSING',
    });
  }
  // Two members sharing a last four are both blanked: their digits match nobody.
  const shared = parse([
    person('Sam', 'Lee', 'tok-1', '615-555-0131'),
    person('Sam', 'Lee', 'tok-2', '615-555-0135'),
    person('Sam', 'Lee', 'tok-3', '615-555-0135'),
  ]).volunteers;
  assert.deepEqual(plain(L.resolveVolunteer(shared, idOf('tok-1'), '0135')), {
    refusal: 'PHONE_WRONG',
  });
  assert.deepEqual(plain(L.resolveVolunteer(shared, idOf('tok-2'), '0135')), {
    refusal: 'PHONE_MISSING',
  });
  assert.equal(L.resolveVolunteer(shared, idOf('tok-2'), '0131').refusal, 'PHONE_MISSING');
});

test('check-in and check-out act on the member the digits pick', () => {
  const list = group();
  const tapped = idOf('tok-1');
  const right = idOf('tok-3');
  const inDecision = checkIn({ volunteers: list, id: tapped, digits: '0132' });
  assert.equal(inDecision.volunteer.id, right);
  // The right member's open row is what counts for ALREADY_IN and NOT_IN.
  const openRight = [entry(2, { id: right })];
  assert.deepEqual(checkIn({ volunteers: list, id: tapped, digits: '0132', entries: openRight }), {
    refusal: 'ALREADY_IN',
  });
  assert.equal(checkIn({ volunteers: list, id: tapped, digits: '0131', entries: openRight }).volunteer.id, tapped);
  const outDecision = checkOut({ volunteers: list, id: tapped, digits: '0132', entries: openRight });
  assert.equal(outDecision.volunteer.id, right);
  assert.equal(outDecision.row, 2);
  assert.deepEqual(checkOut({ volunteers: list, id: right, digits: '0131', entries: openRight }), {
    refusal: 'NOT_IN',
  });
});

// ---------------------------------------------------------------------------
// Refusals

test('refusal gives each code its exact message', () => {
  const expected = {
    ACCESS: 'This kiosk needs to be set up. Please ask a board member.',
    NOT_FOUND: "We couldn't find your profile. Please see a board member.",
    ALREADY_IN: "You're already checked in today.",
    NOT_IN: "You're not checked in today.",
    ARRIVAL_FUTURE: "Your arrival time can't be in the future. Please choose an earlier time.",
    ARRIVAL_OTHER_DAY: 'Please choose a time from today.',
    PHONE_NEEDED: 'Please enter the last four digits of your phone number.',
    PHONE_WRONG: "Those digits don't match our records. Please try again or see a board member.",
    PHONE_MISSING: 'We need to confirm who you are. Please see a board member.',
    BUSY: 'The kiosk is busy. Please try again.',
  };
  for (const [code, message] of Object.entries(expected)) {
    assert.deepEqual(plain(L.refusal(code)), { ok: false, refusal: code, message });
  }
  assert.deepEqual(Object.keys(plain(L.refusalMessages())).sort(), Object.keys(expected).sort());
  assert.throws(() => L.refusal('NOPE'), /Unknown refusal code/);
});

test('constants', () => {
  assert.equal(L.kioskTimeZone(), 'America/Chicago');
  assert.equal(L.profilesCacheSeconds(), 300);
  assert.equal(L.defaultFlagMinutes(), 15);
});
