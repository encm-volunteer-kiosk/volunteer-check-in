// A person's name as the tablet shows and saves it: the first and last name with a space
// between, or the first name alone when the last is blank (a list with one column for the
// whole name gives a one-word name a blank last name), so no name ends in a space. Every
// place the page joins the two names joins them here.
//
// Plain TypeScript only: the tests import this file in Node.

export function personName(person: { firstName: string; lastName: string }): string {
  return person.lastName ? `${person.firstName} ${person.lastName}` : person.firstName;
}
