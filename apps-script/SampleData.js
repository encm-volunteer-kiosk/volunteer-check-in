/**
 * Invented Volunteer Profiles rows for the development project. Every value is made up.
 *
 * The first row is the real Profiles header (22 columns, newlines inside headers kept).
 * The people come from sample-data/volunteer-profiles-sample.csv, plus rows that exercise
 * the kiosk's rules: a second Maria Alvarez with a different phone and token, Ana Ruiz
 * with no onboarding token, a row with no name, start dates after the CSV's, and a phone
 * with an extension.
 */
function sampleProfileRows_() {
  return [
    ["Volunteer\nFirst Name", "Volunteer\nLast Name", "SMS\nOK?", "Volunteer\nPhone", "Act", "Onboard\nStatus", "EC\nName", "EC\nPhone", "EC Relationship", "Coordinator's Notes", "Start Date\nmm/dd/yyyy", "DOB\nmm/dd/yyyy", "Email", "Street Address", "City", "State", "ZIP", "Record Last Updated\n(timestamp)", "Onboarding\nToken", "Magic Token\nTimestamp", "Magic Token", "System Admin Notes"],
    ["Maria", "Alvarez", "Yes", "615-555-0101", "FALSE", "Full", "Sample Contact", "615-555-0201", "Friend", "", "02/15/2026", "01/02/1990", "maria.alvarez@example.org", "101 Example St", "Nashville", "TN", "37206", "", "sample-token-01", "", "", ""],
    ["James", "Okafor", "No", "615-555-0102", "FALSE", "Full", "Sample Contact", "615-555-0202", "Friend", "", "03/15/2026", "01/03/1990", "james.okafor@example.org", "102 Example St", "Nashville", "TN", "37206", "", "sample-token-02", "", "", ""],
    ["Maria", "Chen", "Yes", "615-555-0103", "FALSE", "Full", "Sample Contact", "615-555-0203", "Friend", "", "04/15/2026", "01/04/1990", "maria.chen@example.org", "103 Example St", "Nashville", "TN", "37206", "", "sample-token-03", "", "", ""],
    ["Dev", "Patel", "No", "615-555-0104", "FALSE", "Full", "Sample Contact", "615-555-0204", "Friend", "", "05/15/2026", "01/05/1990", "dev.patel@example.org", "104 Example St", "Nashville", "TN", "37206", "", "sample-token-04", "", "", ""],
    ["Grace", "Holloway", "Yes", "615-555-0105", "FALSE", "Full", "Sample Contact", "615-555-0205", "Friend", "", "06/15/2026", "01/06/1990", "grace.holloway@example.org", "105 Example St", "Nashville", "TN", "37206", "", "sample-token-05", "", "", ""],
    ["Sam", "Nguyen", "No", "615-555-0106", "FALSE", "Full", "Sample Contact", "615-555-0206", "Friend", "", "07/15/2026", "01/07/1990", "sam.nguyen@example.org", "106 Example St", "Nashville", "TN", "37206", "", "sample-token-06", "", "", ""],
    ["Tasha", "Brooks", "Yes", "615-555-0107", "FALSE", "Full", "Sample Contact", "615-555-0207", "Friend", "", "08/15/2026", "01/08/1990", "tasha.brooks@example.org", "107 Example St", "Nashville", "TN", "37206", "", "sample-token-07", "", "", ""],
    ["Luis", "Ortega", "No", "615-555-0108", "FALSE", "Full", "Sample Contact", "615-555-0208", "Friend", "", "09/15/2026", "01/09/1990", "luis.ortega@example.org", "108 Example St", "Nashville", "TN", "37206", "", "sample-token-08", "", "", ""],
    ["Ruth", "Lindqvist", "Yes", "615-555-0109", "FALSE", "Full", "Sample Contact", "615-555-0209", "Friend", "", "01/15/2026", "01/01/1990", "ruth.lindqvist@example.org", "109 Example St", "Nashville", "TN", "37206", "", "sample-token-09", "", "", ""],
    ["Omar", "Haddad", "No", "615-555-0110", "FALSE", "Full", "Sample Contact", "615-555-0210", "Friend", "", "02/15/2026", "01/02/1990", "omar.haddad@example.org", "110 Example St", "Nashville", "TN", "37206", "", "sample-token-10", "", "", ""],
    ["Kate", "Sullivan", "Yes", "615-555-0111", "FALSE", "Full", "Sample Contact", "615-555-0211", "Friend", "", "03/15/2026", "01/03/1990", "kate.sullivan@example.org", "111 Example St", "Nashville", "TN", "37206", "", "sample-token-11", "", "", ""],
    ["Kate", "Sullivan-Price", "No", "615-555-0112", "FALSE", "Full", "Sample Contact", "615-555-0212", "Friend", "", "04/15/2026", "01/04/1990", "kate.sullivan-price@example.org", "112 Example St", "Nashville", "TN", "37206", "", "sample-token-12", "", "", ""],
    ["Maria", "Alvarez", "Yes", "(615) 555-0113", "FALSE", "Full", "Sample Contact", "615-555-0153", "Friend", "", "11/16/2026", "01/01/1990", "maria.alvarez13@example.org", "113 Example St", "Nashville", "TN", "37206", "", "sample-token-13", "", "", ""],
    ["Ana", "Ruiz", "Yes", "615-555-0114", "FALSE", "Full", "Sample Contact", "615-555-0154", "Friend", "", "10/01/2026", "01/01/1990", "ana.ruiz14@example.org", "114 Example St", "Nashville", "TN", "37206", "", "", "", "", ""],
    ["", "", "Yes", "615-555-0115", "FALSE", "Full", "Sample Contact", "615-555-0155", "Friend", "", "10/01/2026", "01/01/1990", "unnamed.volunteer15@example.org", "115 Example St", "Nashville", "TN", "37206", "", "sample-token-15", "", "", ""],
    ["Noah", "Feld", "Yes", "615-555-0116", "FALSE", "Full", "Sample Contact", "615-555-0156", "Friend", "", "11/20/2026", "01/01/1990", "noah.feld16@example.org", "116 Example St", "Nashville", "TN", "37206", "", "sample-token-16", "", "", ""],
    ["Ivy", "Moreno", "Yes", "615-555-0117 x12", "FALSE", "Full", "Sample Contact", "615-555-0157", "Friend", "", "12/01/2026", "01/01/1990", "ivy.moreno17@example.org", "117 Example St", "Nashville", "TN", "37206", "", "sample-token-17", "", "", ""],
  ];
}
