// The part of Apps Script's client-side google.script.run that the kiosk uses. It exists
// only when the page is served by the Apps Script web app.

interface GoogleScriptRunner {
  withSuccessHandler(handler: (result: unknown) => void): GoogleScriptRunner;
  withFailureHandler(handler: (error: Error) => void): GoogleScriptRunner;
  apiCheckAccess(code: string): void;
  apiListVolunteers(code: string): void;
  apiCheckIn(
    code: string,
    id: string,
    arrivalIso: string | null,
    phoneLast4: string | null,
    tap?: object,
  ): void;
  apiCheckOut(
    code: string,
    id: string,
    phoneLast4: string | null,
    checkOutIso: string | null,
    tap?: object,
  ): void;
  apiRequestHours(code: string, id: string, digits: string | null): void;
  apiChangeArrival(
    code: string,
    id: string,
    digits: string | null,
    shiftId: string,
    fromIso: string,
    arrivalIso: string,
  ): void;
}

declare const google: { script?: { run: GoogleScriptRunner } } | undefined;
