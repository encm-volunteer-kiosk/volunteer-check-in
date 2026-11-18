import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  api,
  callRecord,
  isRefusal,
  localApi,
  refusalMessage,
  toVolunteer,
  usingLocalApi,
  type Refusal,
} from "./api";
import {
  afterArrivalChange,
  arrivalSavedText,
  arrivalToSend,
  movePick,
  openArrivalPick,
  showsArrivalChange,
  type ArrivalPick,
} from "./arrivalChange";
import { BRAND_THANKS_LINE, brandKey } from "./brand";
import {
  brandPageSettings,
  logoUrlOf,
  organizationNameOf,
  pageSwitchesOf,
  wordText,
  type PageSettings,
} from "./words";
import { cardTime, DEFAULT_LONG_SHIFT_HOURS } from "./cardTime";
import {
  appreciationMessages,
  FAIL_NEXT_SAVE_KEY,
  isToday,
  type Milestone,
  type Volunteer,
} from "./data";
import {
  clearStoredList,
  listStateAfterFailure,
  noListExtras,
  readStoredList,
  listRetryMs,
  storeList,
  wakeRefreshDue,
  type ListExtras,
  type ListState,
  type ListStorage,
} from "./listStore";
import {
  afterHoursRequest,
  HOURS_REQUEST_TIMEOUT_MS,
  hoursConfirmText,
  hoursPhoneStepAfter,
  hoursRequestReady,
  settleWithin,
  showsHoursLink,
  type HoursRequestState,
} from "./hoursRequestButton";
import { searchNames } from "./nameSearch";
import { personName } from "./names";
import { searchOpenAfter, type SearchOpenEvent } from "./searchOpen";
import { QuickPicks } from "./QuickPicks.tsx";
import { pickTime, pickedTimeToIso } from "./quickPicks";
import {
  afterPhoneRefusal,
  digitsAskedAtTap,
  digitsMissing,
  digitsToSend,
  nameKey,
} from "./sameName";
import {
  abandonSave,
  autoHomeMs,
  goesHomeWhenListLosesVolunteer,
  inactivityMs,
  msUntil,
  noSaves,
  refusalOutcome,
  resultOf,
  SLOW_LINE_MS,
  slowLineShows,
  startSave,
  takeReply,
  takeWatchdog,
  WATCHDOG_MS,
  type SaveFrom,
  type SaveKind,
  type SaveOwner,
  type SaveRecord,
  type Screen,
  type StatusCode,
} from "./saveFlow";
import {
  afterEnqueue,
  ATTEMPT_MS,
  changeQueue,
  codeMatches,
  dismissFailed,
  dropMark,
  enqueue,
  heldMarkCovered,
  LIST_REFRESH_MS,
  newSave,
  newTapId,
  nextRunDelay,
  overlay,
  qualifies,
  readQueue,
  runOnce,
  runnerGate,
  SAVE_QUEUE_KEY,
  SELECT_REFRESH_MS,
  SERVER_MAX_MS,
  stampNow,
  stillSavingText,
  savingLineShown,
  nextSlowAt,
  storeForegroundMark,
  stuckSaves,
  touch,
  type Change,
  type FailedSave,
  type ListStamp,
  type Mark,
  type QueuedSave,
  type QueueEnv,
  type RunResult,
  type SaveQueue,
} from "./saveQueue";

// What the result screens show. The first name and kind come from the save, not the list.
type Result = SaveOwner & {
  time?: string;
  duration?: number;
  milestone?: Milestone | null;
  message?: string;
  status?: StatusCode;
};
type PhoneStep = "entry" | "missing" | null;
const TZ = "America/Chicago";
const ACCESS_CODE_KEY = brandKey("kiosk-access-code");
// The header clock reads the time this often, so it is never more than this behind the iPad's.
const CLOCK_TICK_MS = 5_000;

const Icon = ({ name, size = 24 }: { name: string; size?: number }) => {
  const paths: Record<string, React.ReactNode> = {
    chevron: <path d="m9 18 6-6-6-6" />,
    search: (
      <>
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-4-4" />
      </>
    ),
    back: (
      <>
        <path d="m15 18-6-6 6-6" />
        <path d="M9 12h10" />
      </>
    ),
    users: (
      <>
        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
      </>
    ),
    user: (
      <>
        <circle cx="12" cy="8" r="4" />
        <path d="M4 21a8 8 0 0 1 16 0" />
      </>
    ),
    clock: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </>
    ),
    check: <path d="m5 12 4 4L19 6" />,
    star: <path d="m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9Z" />,
    alert: (
      <>
        <path d="M12 3 2.5 20h19Z" />
        <path d="M12 9v4M12 17h.01" />
      </>
    ),
  };
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths[name]}
    </svg>
  );
};

/** The "Today is / day / time" block, on its own clock. */
function DateBlock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);
  const day = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    weekday: "long",
    month: "short",
    day: "numeric",
  }).format(now);
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hour: "numeric",
    minute: "2-digit",
  }).format(now);
  return (
    <div className="date">
      <span>Today is</span>
      <strong>{day}</strong>
      <time dateTime={now.toISOString()}>{time}</time>
    </div>
  );
}

// The Settings the page shows with: from the list in use, or the brand's before one arrives.
const PageSettingsContext = createContext<PageSettings>(brandPageSettings);

/** Text written with the default words, in the sheet's words (wordText, words.ts). */
function useWords(): (text: string) => string {
  const words = useContext(PageSettingsContext).words;
  return (text) => wordText(text, words);
}

/**
 * The Logo link's image, else the brand's logo, with the organisation's name as its alt
 * text; the name as a heading when there is no image or the image fails to load.
 */
function BrandLogo({ className }: { className: string }) {
  const settings = useContext(PageSettingsContext);
  const name = organizationNameOf(settings);
  const url = logoUrlOf(settings);
  const [failed, setFailed] = useState<string | null>(null);
  if (!url || failed === url) return <h1 className={className + " logo-name"}>{name}</h1>;
  return <img className={className} src={url} alt={name} onError={() => setFailed(url)} />;
}

function Header() {
  return (
    <header className="header">
      <BrandLogo className="logo" />
      <DateBlock />
    </header>
  );
}

function Button({
  children,
  variant = "primary",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" }) {
  return (
    <button className={`button ${variant}`} {...props}>
      {children}
    </button>
  );
}

function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button className="back-button" onClick={onClick}>
      <Icon name="back" size={20} /> Back
    </button>
  );
}

/**
 * The server's flag: an open row less than "Auto clock-out after hours" since its check-in
 * tap, past midnight too, or one dated today whose check-in time can't be read. So an
 * evening volunteer still reaches check-out after midnight.
 */
function isCheckedIn(volunteer: Volunteer) {
  return Boolean(volunteer.checkedIn);
}

/** The tablet's clock, read again at each minute boundary: one clock for every card. */
function useMinuteNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let timer = 0;
    const arm = () => {
      // A few milliseconds past the boundary, so the new minute has begun when it reads.
      timer = window.setTimeout(
        () => {
          setNow(Date.now());
          arm();
        },
        60_000 - (Date.now() % 60_000) + 50,
      );
    };
    arm();
    return () => clearTimeout(timer);
  }, []);
  return now;
}

// What a card needs to show a check-in time: the shared minute clock, and the sheet's "Long
// shift flag hours", past which a checked-in card turns amber.
type CardClock = { nowMs: number; longShiftHours: number };

function VolunteerCard({
  volunteer,
  clock,
  onClick,
  plain = false,
}: {
  volunteer: Volunteer;
  clock: CardClock;
  onClick: () => void;
  // The hours search: the name alone, with no check-in time or check-out label.
  plain?: boolean;
}) {
  const checkedIn = !plain && isCheckedIn(volunteer);
  const time = checkedIn
    ? cardTime(volunteer.currentCheckIn, clock.nowMs, clock.longShiftHours)
    : null;
  return (
    <button
      className={`volunteer-card${checkedIn ? " is-checked-in" : ""}${time?.late ? " late" : ""}`}
      onClick={onClick}
      aria-label={
        plain
          ? `Request hours for ${personName(volunteer)}`
          : time
            ? `Check out ${personName(volunteer)}, ${time.label}`
            : `Check in ${personName(volunteer)}`
      }
    >
      <span className="volunteer-name">
        <span>{personName(volunteer)}</span>
      </span>
      <span className="card-meta">
        {time ? (
          <>
            <span className="in-time">{time.text}</span>
            <span className="checkout-action">
              Check out <Icon name="chevron" size={18} />
            </span>
          </>
        ) : (
          <Icon name="chevron" size={23} />
        )}
      </span>
    </button>
  );
}

function Welcome({
  volunteers,
  listState,
  clock,
  onSelect,
  onSearchOpen,
  focusOnOpen,
  banner,
  onRequestHours,
  hours,
}: {
  volunteers: Volunteer[];
  listState: ListState;
  // The staff banner for saves that didn't land, above the name box.
  banner: ReactNode;
  clock: CardClock;
  onSelect: (v: Volunteer) => void;
  // Whether the name box takes focus on its own when the screen opens. Not when a tap
  // brought the screen up (Go back, Done): focus given during a tap raises the tablet's
  // keyboard, and the Checked In panel would stay in place under it (src/searchOpen.ts).
  focusOnOpen: boolean;
  // Told whether the Checked In panel should be aside, by the rule in src/searchOpen.ts.
  onSearchOpen: (open: boolean) => void;
  // Opens the hours search from the Request my hours link; absent while the link is hidden.
  onRequestHours?: () => void;
  // The hours search: this screen's search with its own words and a Back button home. A tap
  // on a name goes to onSelect, which there opens the hours steps.
  hours?: { onBack: () => void };
}) {
  const w = useWords();
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const welcomeNotes = [
    "We're happy you're here.",
    "Thanks for being here, neighbor.",
    "Your helping hands matter.",
  ];
  const welcomeNote = welcomeNotes[new Date().getDate() % welcomeNotes.length];
  // The screens below test the typed text itself; the search folds it (src/nameSearch.ts).
  // A query of only punctuation finds nobody and shows "No matching volunteer found".
  const normalizedQuery = query.trim().toLowerCase();
  const results = useMemo(() => searchNames(volunteers, query), [query, volunteers]);

  // What this screen last told the app, so each event is applied to the current state.
  const searchOpen = useRef(false);
  const reportSearch = (event: SearchOpenEvent) => {
    searchOpen.current = searchOpenAfter(searchOpen.current, event);
    onSearchOpen(searchOpen.current);
  };
  useEffect(() => () => reportSearch("unmount"), []);

  const updateQuery = (next: string) => {
    setQuery(next);
    window.requestAnimationFrame(() => searchRef.current?.focus({ preventScroll: true }));
  };
  const heading = hours ? (
    "Request my hours"
  ) : (
    <>
      Hey there, <span>neighbor!</span>
    </>
  );
  // Shown twice, one at a time by layout (index.css): in the logo and date row on a landscape
  // tablet, under the name card elsewhere.
  const hoursLink = onRequestHours && (
    <button type="button" className="text-button hours-link" onClick={onRequestHours}>
      Request my hours
    </button>
  );

  return (
    <main className={`welcome name-entry screen-enter${hours ? " hours-search-main" : ""}`}>
      {hours && <BackButton onClick={hours.onBack} />}
      <section className="hero name-entry-hero">
        <div className="spark spark-hero">
          <i />
          <i />
          <i />
        </div>
        <p className="welcome-note">{welcomeNote}</p>
        <h1>{heading}</h1>
        <p>{hours ? "Type your name, then tap it." : "Tap the box below and type your name."}</p>
      </section>

      <section className="name-search-card" aria-label={w("Find your volunteer profile")}>
        {banner}
        <label className="search-field name-search-field">
          <Icon name="search" size={29} />
          <span className="sr-only">Type your first and last name</span>
          <input
            ref={searchRef}
            autoFocus={focusOnOpen && !hours}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              reportSearch("typed");
            }}
            // A click, not focus or touch-down: see src/searchOpen.ts.
            onClick={() => reportSearch("click")}
            onBlur={() => reportSearch("blur")}
            // The tablet's Search key closes the keyboard, so results under it show.
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
            placeholder="Enter your name"
            maxLength={60}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="words"
            spellCheck={false}
            enterKeyHint="search"
          />
          {query && (
            <button
              type="button"
              // Keeps focus in the box, so the keyboard stays up and the panel stays aside.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                updateQuery("");
                reportSearch("clear");
              }}
              aria-label="Clear name"
            >
              Clear
            </button>
          )}
        </label>

        {normalizedQuery && results.length > 0 && (
          <p className="match-prompt">
            <Icon name="user" size={21} />
            Tap your name below
          </p>
        )}

        <div className="name-results" aria-live="polite">
          {listState === "failed" ? (
            <div className="no-name">
              <strong>{w("This kiosk can't reach the volunteer list right now.")}</strong>
              <span className="board-member-message">{w("Please see a board member.")}</span>
            </div>
          ) : (
            <>
              {!normalizedQuery && (
                <div className="type-prompt">
                  <Icon name="user" size={27} />
                  <span>Start typing to find your name.</span>
                </div>
              )}
              {/* Shown instead of the prompt and the greeting above the card on a landscape
                  tablet, where the box sits at the top of the screen (index.css). */}
              {!normalizedQuery && (
                <div className="hero results-greeting">
                  <div className="spark spark-hero">
                    <i />
                    <i />
                    <i />
                  </div>
                  <p className="welcome-note">{welcomeNote}</p>
                  <h1>{heading}</h1>
                  <p>
                    {hours ? "Type your name, then tap it." : "Type your name in the box above."}
                  </p>
                </div>
              )}
              {results.map((volunteer) => (
                <VolunteerCard
                  key={volunteer.id}
                  volunteer={volunteer}
                  clock={clock}
                  plain={Boolean(hours)}
                  onClick={() => onSelect(volunteer)}
                />
              ))}
              {normalizedQuery &&
                results.length === 0 &&
                (listState === "loading" ? (
                  <div className="no-name">
                    <strong>{w("Loading volunteers…")}</strong>
                    <span>This can take a few seconds.</span>
                  </div>
                ) : (
                  <div className="no-name">
                    <strong>{w("No matching volunteer found")}</strong>
                    <span>Double-check the spelling.</span>
                    <span className="board-member-message">
                      {w("If you still don't see your name, please see a board member for help.")}
                    </span>
                  </div>
                ))}
            </>
          )}
        </div>
      </section>

      {hoursLink && <div className="hours-link-under">{hoursLink}</div>}

      {/* The logo and date, here under the name card instead of above it on a landscape tablet. */}
      <div className="welcome-header">
        <BrandLogo className="logo" />
        {hoursLink}
        <DateBlock />
      </div>

      <p className="tagline">Good neighbors change lives.</p>
    </main>
  );
}

function CheckedInSidebar({
  volunteers,
  saving,
  clock,
  onSelect,
}: {
  volunteers: Volunteer[];
  // The saves waiting in the tablet's queue: once one has waited SLOW_SAVE_MS, a line
  // under the title says how many.
  saving: QueuedSave[];
  clock: CardClock;
  onSelect: (v: Volunteer) => void;
}) {
  // Read again when the next queued save turns slow, so the line shows on time.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const at = nextSlowAt(saving, now);
    if (at === null) return;
    // Capped at setTimeout's largest delay: a longer one fires at once, over and over.
    const wait = Math.min(2_147_483_647, Math.max(0, at - Date.now()));
    const id = window.setTimeout(() => setNow(Date.now()), wait);
    return () => window.clearTimeout(id);
  }, [saving, now]);
  // Once shown, the line stays until the queue is empty, so it doesn't blink off when a
  // slow save lands ahead of a newer one.
  const slowNow = savingLineShown(saving, Math.max(now, Date.now()));
  const [held, setHeld] = useState(false);
  if (saving.length === 0 && held) setHeld(false);
  if (saving.length > 0 && slowNow && !held) setHeld(true);
  const showSaving = saving.length > 0 && (held || slowNow);

  // Earliest check-in first. A volunteer whose check-in time can't be read is still
  // checked in, and goes last.
  const arrival = (v: Volunteer) =>
    v.currentCheckIn ? Date.parse(v.currentCheckIn) : Number.POSITIVE_INFINITY;
  const checkedIn = volunteers.filter(isCheckedIn).sort((a, b) => {
    const ta = arrival(a);
    const tb = arrival(b);
    return ta === tb ? 0 : ta < tb ? -1 : 1;
  });

  return (
    <aside className={`checkin-sidebar`}>
      <h2 className="checkin-sidebar-title">Checked In</h2>
      {showSaving && (
        <p className="sidebar-saving" role="status">
          {saving.length === 1
            ? `Saving 1 ${saving[0].kind === "in" ? "check-in" : "check-out"}…`
            : `Saving ${saving.length}…`}
        </p>
      )}
      {checkedIn.length === 0 ? (
        <p className="sidebar-empty">No one checked in yet.</p>
      ) : (
        checkedIn.map((volunteer) => (
          <VolunteerCard
            key={volunteer.id}
            volunteer={volunteer}
            clock={clock}
            onClick={() => {
              onSelect(volunteer);
            }}
          />
        ))
      )}
    </aside>
  );
}

function PhoneDigits({
  digits,
  onChange,
  onSubmit,
}: {
  digits: string;
  onChange: (digits: string) => void;
  onSubmit: () => void;
}) {
  return (
    <label className="phone-digits">
      <span className="sr-only">Last four digits of your phone number</span>
      <input
        autoFocus
        value={digits}
        onChange={(event) => {
          // Digits only. A pasted whole number keeps its last four; typing stops at four.
          // No maxLength: it would cut "(615) 555-0142" to "(615" before this runs.
          const typed = event.target.value.replace(/\D/g, "");
          const pasted = typed.length - digits.length > 1;
          onChange(typed.length > 4 && pasted ? typed.slice(-4) : typed.slice(0, 4));
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") onSubmit();
        }}
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        // Not "off": Safari ignores that and offers to fill in a contact's phone number, which
        // would put the iPad owner's last four digits in the box. A code field gets no
        // contact suggestions, and the number keyboard still comes from inputMode.
        autoComplete="one-time-code"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="done"
        placeholder="0000"
      />
    </label>
  );
}

function Confirmation({
  volunteer,
  checkout,
  phoneStep = null,
  phoneDigits = "",
  digitsAsked,
  anotherIn,
  time,
  picker = false,
  minMinutes = 0,
  saving,
  error,
  onTimeChange,
  onOpenPicker,
  onPhoneDigitsChange,
  onPhoneContinue,
  onConfirm,
  onBack,
  arrivalChange,
}: {
  volunteer: Volunteer;
  checkout: boolean;
  phoneStep?: PhoneStep;
  phoneDigits?: string;
  // The tap asked for the digits (or a phone refusal did since): Check Out or Check In waits
  // for four of them.
  digitsAsked: boolean;
  // A check-out sent without digits was refused because another of the name is checked in.
  anotherIn: boolean;
  // The time picker: arrival on the check-in screen, check-out on the check-out screen.
  time?: string;
  picker?: boolean;
  minMinutes?: number;
  saving: boolean;
  error: string;
  onTimeChange?: (time: string) => void;
  // Given only when the picker may be offered; its link shows after the phone step.
  onOpenPicker?: () => void;
  onPhoneDigitsChange: (digits: string) => void;
  onPhoneContinue: () => void;
  onConfirm: () => void;
  onBack: () => void;
  // Change on the check-out screen's line, and its picker. Absent on the check-in screen.
  arrivalChange?: ArrivalChangeProps;
}) {
  const w = useWords();
  const showTimeKeyboard = Boolean(!phoneStep && picker && time && onTimeChange);
  // Change's own picker: a third picker state, whose Save time calls only the Change.
  const changePicker = !phoneStep && arrivalChange?.pick ? arrivalChange : null;
  const hasKeyboard = showTimeKeyboard || changePicker !== null;

  return (
    <>
      <main className={`center-screen screen-enter${hasKeyboard ? " has-keyboard" : ""}`}>
        {!hasKeyboard && <BackButton onClick={onBack} />}
        <section
          className={`panel confirmation-panel${hasKeyboard ? " with-keyboard" : ""}${phoneStep === "entry" ? " phone-check" : ""}`}
        >
          <div className="spark">
            <i />
            <i />
            <i />
          </div>
          <div className="eyebrow">{checkout ? "Ready to wrap up?" : "Welcome, neighbor"}</div>
          <h1>
            {checkout ? `Heading out, ${volunteer.firstName}?` : `Hi, ${volunteer.firstName}!`}
          </h1>
          <p>
            {phoneStep ? (
              <>
                There&apos;s more than one <strong>{personName(volunteer)}</strong>
                {anotherIn ? ", and another one is checked in right now." : "."}
                {phoneStep === "entry" &&
                  " Please enter the last four digits of your phone number."}
              </>
            ) : checkout && volunteer.currentCheckIn ? (
              <>
                You checked in {isToday(volunteer.currentCheckIn) ? "" : "yesterday "}at{" "}
                <strong>{formatTime(volunteer.currentCheckIn)}</strong>
                {arrivalChange?.offered && !changePicker ? (
                  <>
                    {" · "}
                    <button
                      type="button"
                      className="text-button inline-change"
                      onClick={arrivalChange.onOpen}
                    >
                      Change
                    </button>
                  </>
                ) : (
                  "."
                )}
              </>
            ) : checkout ? (
              "You're checked in."
            ) : (
              "Just making sure we have the right neighbor."
            )}
          </p>
          {arrivalChange?.saved && !phoneStep && !changePicker && (
            <p className="arrival-saved" role="status">
              {arrivalSavedText}
            </p>
          )}
          {phoneStep === "entry" && (
            <PhoneDigits
              digits={phoneDigits}
              onChange={onPhoneDigitsChange}
              onSubmit={onPhoneContinue}
            />
          )}
          {!phoneStep && checkout && !hasKeyboard && volunteer.currentCheckIn && (
            <ShiftThanks checkedInAt={volunteer.currentCheckIn} />
          )}
          {!checkout && !phoneStep && !showTimeKeyboard && (
            <div className="identity">
              <Icon name="user" /> {personName(volunteer)}
            </div>
          )}
          {hasKeyboard && (
            <div className="checkin-details">
              <div className="identity">
                <Icon name="user" /> {personName(volunteer)}
              </div>
              <div className="arrival-time">
                <span>
                  <Icon name="clock" size={21} />
                  {checkout && !changePicker
                    ? "What time did you leave?"
                    : "What time did you arrive?"}
                </span>
                <small>Tap a time below, or use −15 and +15 to adjust it.</small>
              </div>
            </div>
          )}
          {error && <ErrorNotice text={error} />}
          {!hasKeyboard && (
            <div className="button-stack">
              {phoneStep === "entry" && (
                <Button onClick={onPhoneContinue} disabled={phoneDigits.length < 4}>
                  Continue
                </Button>
              )}
              {!phoneStep && (
                <Button
                  onClick={onConfirm}
                  disabled={saving || digitsMissing(digitsAsked, phoneDigits)}
                >
                  {saving ? (
                    <>
                      <span className="spinner" /> Saving…
                    </>
                  ) : checkout ? (
                    "Check Out"
                  ) : (
                    "Check In"
                  )}
                </Button>
              )}
              <Button variant="secondary" onClick={onBack} disabled={saving}>
                {checkout && !phoneStep ? w("Keep Volunteering") : "Go back"}
              </Button>
            </div>
          )}
          {!phoneStep && !hasKeyboard && onOpenPicker && (
            <button type="button" className="text-button" onClick={onOpenPicker} disabled={saving}>
              {checkout
                ? "Forgot to check out earlier? Change your check-out time"
                : "Forgot to check in earlier? Change your arrival time"}
            </button>
          )}
        </section>
      </main>
      {showTimeKeyboard && (
        <QuickPicks
          value={time!}
          minMinutes={minMinutes}
          label={checkout ? "Check-out time picker" : "Arrival time picker"}
          confirmText={checkout ? "Check Out" : "Check In"}
          saving={saving}
          onChange={onTimeChange!}
          onConfirm={onConfirm}
          onBack={onBack}
        />
      )}
      {changePicker && (
        <QuickPicks
          value={changePicker.pick!.time.time}
          minMinutes={0}
          maxMinutes={changePicker.pick!.maxMinutes}
          label="Arrival time picker"
          confirmText="Save time"
          saving={changePicker.saving}
          onChange={changePicker.onTimeChange}
          onConfirm={changePicker.onSave}
          onBack={changePicker.onClose}
        />
      )}
    </>
  );
}

/**
 * Change on the check-out screen. offered: the line shows "· Change" (showsArrivalChange).
 * pick: the open picker, or null. saving: the Change is out. saved: "Arrival time saved."
 * shows under the line until the volunteer leaves the screen.
 */
type ArrivalChangeProps = {
  offered: boolean;
  pick: ArrivalPick | null;
  saving: boolean;
  saved: boolean;
  onOpen: () => void;
  onTimeChange: (time: string) => void;
  onSave: () => void;
  onClose: () => void;
};

/**
 * The Request my hours steps after a name in the hours search: the phone step for a name two
 * volunteers share, as at check-in, then the confirm screen. Send only records a request;
 * the answer's line takes the sentence's place. No line names an email address.
 */
function HoursConfirm({
  volunteer,
  phoneStep,
  phoneDigits,
  error,
  state,
  onPhoneDigitsChange,
  onPhoneContinue,
  onSend,
  onBack,
}: {
  volunteer: Volunteer;
  phoneStep: PhoneStep;
  phoneDigits: string;
  error: string;
  state: HoursRequestState;
  onPhoneDigitsChange: (digits: string) => void;
  onPhoneContinue: () => void;
  onSend: () => void;
  onBack: () => void;
}) {
  const w = useWords();
  const sending = state.kind === "sending";
  const done = state.kind === "line" && !state.again;
  return (
    <main className="center-screen screen-enter">
      {!sending && <BackButton onClick={onBack} />}
      <section
        className={`panel confirmation-panel hours-confirm${phoneStep === "entry" ? " phone-check" : ""}`}
      >
        <div className="spark">
          <i />
          <i />
          <i />
        </div>
        <div className="eyebrow">{w("Your volunteer hours")}</div>
        <h1>Hi, {volunteer.firstName}!</h1>
        <p aria-live="polite">
          {phoneStep ? (
            <>
              There&apos;s more than one <strong>{personName(volunteer)}</strong>.
              {phoneStep === "entry" && " Please enter the last four digits of your phone number."}
            </>
          ) : state.kind === "line" ? (
            state.text
          ) : (
            hoursConfirmText
          )}
        </p>
        {phoneStep === "entry" && (
          <PhoneDigits
            digits={phoneDigits}
            onChange={onPhoneDigitsChange}
            onSubmit={onPhoneContinue}
          />
        )}
        {error && <ErrorNotice text={error} />}
        <div className="button-stack">
          {phoneStep === "entry" && (
            <Button onClick={onPhoneContinue} disabled={phoneDigits.length < 4}>
              Continue
            </Button>
          )}
          {!phoneStep && !done && (
            <Button onClick={onSend} disabled={sending}>
              {sending ? (
                <>
                  <span className="spinner" /> Sending…
                </>
              ) : (
                "Send"
              )}
            </Button>
          )}
          {done ? (
            <Button onClick={onBack}>Done</Button>
          ) : (
            <Button variant="secondary" onClick={onBack} disabled={sending}>
              Go back
            </Button>
          )}
        </div>
      </section>
    </main>
  );
}

/**
 * The staff banner on the welcome screen: saves that failed, queued saves tapped more than
 * 10 minutes ago, and a save queue that couldn't be read. A board member clears the failed
 * lines with the kiosk access code, checked on the tablet, so it works offline. "Not saved
 * yet" lines can't be dismissed: they go when their saves land or fail.
 */
function SaveBanner({
  failed,
  stuck,
  unreadable,
  onDismiss,
}: {
  failed: FailedSave[];
  stuck: QueuedSave[];
  unreadable: boolean;
  // True when the typed code is the kiosk's and the lines were cleared.
  onDismiss: (typed: string) => boolean;
}) {
  const w = useWords();
  const [asking, setAsking] = useState(false);
  const [typed, setTyped] = useState("");
  const [wrong, setWrong] = useState(false);
  if (!failed.length && !stuck.length && !unreadable) return null;
  const what = (kind: SaveKind) => (kind === "in" ? "check-in" : "check-out");
  const at = (ms: number) => formatTime(new Date(ms).toISOString());
  const dismissable = failed.length > 0 || unreadable;
  return (
    <div className="save-banner" role="alert">
      {dismissable && <strong>{w("These didn't save. Please tell a board member.")}</strong>}
      <ul>
        {failed.map((f) => (
          <li key={f.key}>
            {f.name}: {what(f.kind)} at {at(f.tapAt)}. {f.reason}
            {f.maybeSaved ? " It may have saved; check the Log." : ""}
          </li>
        ))}
        {unreadable && (
          <li>
            The tablet&apos;s list of unsaved taps couldn&apos;t be read. Please check the Log.
          </li>
        )}
        {stuck.map((s) => (
          <li key={s.key}>
            Not saved yet: {personName(s)}, {what(s.kind)} at {at(s.tapAt)}. The tablet keeps
            trying.
          </li>
        ))}
      </ul>
      {dismissable &&
        (asking ? (
          <form
            className="save-banner-code"
            onSubmit={(event) => {
              event.preventDefault();
              if (onDismiss(typed)) {
                setAsking(false);
                setTyped("");
                setWrong(false);
              } else setWrong(true);
            }}
          >
            <label>
              {w("Board member: kiosk access code")}
              <input
                type="password"
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
                autoComplete="off"
                autoFocus
              />
            </label>
            <button type="submit">Clear</button>
            {wrong && <p>That&apos;s not the kiosk code.</p>}
          </form>
        ) : (
          <button type="button" onClick={() => setAsking(true)}>
            Dismiss
          </button>
        ))}
    </div>
  );
}

function ErrorNotice({ text }: { text: string }) {
  return (
    <div className="error-notice" role="alert">
      <Icon name="alert" size={20} />
      <span>{text}</span>
    </div>
  );
}

function ShiftThanks({ checkedInAt }: { checkedInAt: string }) {
  const w = useWords();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const minutes = Math.max(0, Math.floor((now - new Date(checkedInAt).getTime()) / 60_000));

  return (
    <div className="checkout-thanks">
      <span>
        <Icon name="clock" size={21} />
        Your time so far
      </span>
      <strong>{formatDuration(minutes)}</strong>
      <small>{w("Thank you for volunteering with us.")}</small>
    </div>
  );
}

/**
 * Shown after a check-in when the volunteer's last shift ended without their own Check Out.
 * It never says what time was recorded. The check-in is already saved; Got it leads to the
 * checked-in screen.
 */
function MissedCheckOutNotice({ firstName, onDone }: { firstName: string; onDone: () => void }) {
  return (
    <main className="center-screen screen-enter">
      <section className="panel confirmation-panel" aria-live="polite">
        <div className="spark">
          <i />
          <i />
          <i />
        </div>
        <h1>Welcome back, {firstName}!</h1>
        <p>
          Last time you didn&apos;t check out. Please tap <strong>Check Out</strong> before you
          leave today.
        </p>
        <div className="button-stack">
          <Button onClick={onDone}>Got it</Button>
        </div>
      </section>
    </main>
  );
}

function Success({
  type,
  result,
  onDone,
}: {
  type: "in" | "out";
  result: Result;
  onDone: () => void;
}) {
  return (
    <main className={`success-screen success-${type} screen-enter`}>
      {type === "in" && <SunriseSkyline />}
      <div className="success-content">
        <div className="spark success-spark left">
          <i />
          <i />
          <i />
        </div>
        <div className="spark success-spark right">
          <i />
          <i />
          <i />
        </div>
        <div className="success-icon">
          <Icon name="check" size={54} />
        </div>
        <h1>
          {type === "in"
            ? `${result.firstName}, we're glad you're here!`
            : `You made a difference today, ${result.firstName}!`}
        </h1>
        {type === "in" ? (
          <>
            <p className="success-label">You&apos;re checked in.</p>
            <div className="time-metric">
              <Icon name="clock" size={29} /> {result.time && formatTime(result.time)}
            </div>
            <p className="appreciation">{result.message}</p>
            <p className="reminder">Don&apos;t forget to check out before you leave.</p>
          </>
        ) : (
          <>
            {result.milestone && (
              <div className="milestone">
                <div className="milestone-title">
                  <Icon name="star" size={22} /> {result.milestone.title}
                </div>
                <p>{result.milestone.message}</p>
              </div>
            )}
            <p className="appreciation">{result.message}</p>
            <p className="thanks">{BRAND_THANKS_LINE}</p>
          </>
        )}
        <Button onClick={onDone}>Done</Button>
      </div>
    </main>
  );
}

// The check-in screen's neighborhood, across the bottom of the screen in a 1024 x 170 box:
// each building's left edge, width, height, and whether it has a pitched roof. The middle is
// left open for the sun.
const SUNRISE_BUILDINGS: [number, number, number, boolean][] = [
  [14, 70, 64, false],
  [96, 46, 92, false],
  [150, 82, 52, false],
  [244, 54, 110, true],
  [310, 66, 76, false],
  [388, 40, 58, false],
  [596, 44, 64, false],
  [650, 72, 98, false],
  [734, 52, 120, true],
  [798, 80, 60, false],
  [890, 48, 86, false],
  [948, 64, 54, false],
];
const SUNRISE_GROUND = 158;

/** The building outlines and their windows: x, y, and the order a window lights in. */
const SUNRISE = (() => {
  const outlines: string[] = [];
  const windows: [number, number, number][] = [];
  for (const [x, w, h, roof] of SUNRISE_BUILDINGS) {
    const top = SUNRISE_GROUND - h;
    outlines.push(
      roof
        ? `M${x} ${SUNRISE_GROUND}V${top + 16}l${w / 2} -16l${w / 2} 16V${SUNRISE_GROUND}z`
        : `M${x} ${SUNRISE_GROUND}V${top}h${w}V${SUNRISE_GROUND}z`,
    );
    const cols = Math.max(2, Math.floor((w - 10) / 16));
    const rows = Math.max(1, Math.floor((h - (roof ? 30 : 16)) / 22));
    const gap = (w - cols * 9) / (cols + 1);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        // A few windows stay dark, so the rows don't look like a grid.
        if ((r * 3 + c * 5 + x) % 4 === 0) continue;
        windows.push([
          Math.round((x + gap + c * (9 + gap)) * 10) / 10,
          top + (roof ? 26 : 12) + r * 22,
          Math.round((x / 1024) * 24 + r),
        ]);
      }
    }
  }
  return { outlines, windows };
})();

/**
 * The check-in screen's celebration: the saving screen's neighborhood across the bottom, the
 * sun rising behind it and the windows lighting left to right. It plays once and stays lit;
 * without motion it shows lit at once.
 */
function SunriseSkyline() {
  return (
    <svg
      className="sunrise-skyline"
      viewBox="0 0 1024 170"
      preserveAspectRatio="xMidYMax meet"
      aria-hidden="true"
    >
      <defs>
        <clipPath id="sunrise-above-ground">
          <rect x="0" y="0" width="1024" height={SUNRISE_GROUND} />
        </clipPath>
      </defs>
      {/* Clipped at the ground line, so the sun comes up from behind it. */}
      <g clipPath="url(#sunrise-above-ground)">
        <circle className="glow" cx="512" cy="150" r="70" />
        <circle className="sun" cx="512" cy="150" r="44" />
      </g>
      <g className="buildings">
        {SUNRISE.outlines.map((d) => (
          <path key={d} d={d} />
        ))}
      </g>
      {SUNRISE.windows.map(([x, y, n]) => (
        <rect
          key={`${x},${y}`}
          className="window"
          x={x}
          y={y}
          width={9}
          height={11}
          style={{ animationDelay: `${0.9 + n * 0.045}s` }}
        />
      ))}
      <path className="ground" d={`M0 ${SUNRISE_GROUND}h1024`} />
    </svg>
  );
}

// The neighborhood's windows, lit one after another while a save runs: x, y, width, height,
// and the step of the 4 s loop at which each one comes on.
const SKYLINE_WINDOWS: [number, number, number, number, number][] = [
  [30, 114, 7, 8, 0],
  [41, 114, 7, 8, 5],
  [30, 128, 7, 8, 9],
  [41, 128, 7, 8, 3],
  [74, 80, 8, 9, 2],
  [88, 80, 8, 9, 7],
  [102, 80, 8, 9, 11],
  [74, 98, 8, 9, 6],
  [88, 98, 8, 9, 1],
  [102, 98, 8, 9, 10],
  [74, 116, 8, 9, 4],
  [102, 116, 8, 9, 8],
  [135, 98, 7, 8, 5],
  [146, 98, 7, 8, 2],
  [135, 114, 7, 8, 9],
  [146, 114, 7, 8, 6],
  [173, 120, 10, 9, 3],
  [205, 124, 8, 10, 8],
];

/**
 * The saving screen's picture: a line drawing of the neighborhood, the sun crossing the sky
 * and windows lighting up one by one. It loops for as long as the save takes, so a slow save
 * never shows anything stuck; the success screen that follows is its finish.
 */
function SavingSkyline() {
  return (
    <svg className="saving-skyline" viewBox="0 0 240 180" aria-hidden="true">
      {/* Drawn first, so the buildings pass in front of it; its path stays above the ground. */}
      <circle className="sun" cx="120" cy="62" r="18" />
      <g className="buildings">
        <rect x="22" y="104" width="34" height="46" />
        <path d="M66 150V70h18V52l8-14 8 14v18h18v80z" />
        <rect x="128" y="88" width="30" height="62" />
        <rect x="166" y="110" width="24" height="40" />
        <path d="M196 150v-30l14-12 14 12v30z" />
      </g>
      {SKYLINE_WINDOWS.map(([x, y, width, height, step]) => (
        <rect
          key={`${x},${y}`}
          className="window"
          x={x}
          y={y}
          width={width}
          height={height}
          style={{ animationDelay: `${step * 0.32}s` }}
        />
      ))}
      <path className="ground" d="M8 150h224" />
      <path className="street" d="M40 172h160" />
    </svg>
  );
}

/**
 * Shown for the whole of a check-in or check-out call. It has no way back: only the call's
 * reply or its watchdog leaves it.
 */
function SavingScreen({ save }: { save: SaveRecord }) {
  const [slow, setSlow] = useState(() => slowLineShows(Date.now() - save.startedAt));
  useEffect(() => {
    if (slow) return;
    const timer = window.setTimeout(
      () => setSlow(true),
      msUntil(SLOW_LINE_MS, Date.now() - save.startedAt),
    );
    return () => clearTimeout(timer);
  }, [slow, save.startedAt]);

  return (
    <main className="center-screen screen-enter">
      <section className="panel confirmation-panel saving-panel" aria-live="polite">
        <SavingSkyline />
        <h1>
          {save.kind === "in" ? "Checking you in" : "Checking you out"}, {save.firstName}…
        </h1>
        {slow && <p className="slow-line">Still saving. Please don&apos;t tap again.</p>}
      </section>
    </main>
  );
}

/**
 * The server says the volunteer is already checked in, or not checked in. Not checked in is
 * never called checked out: it also covers a shift that aged out, which staff fix.
 */
function StatusScreen({ result, onDone }: { result: Result; onDone: () => void }) {
  const w = useWords();
  const already = result.status === "ALREADY_IN";
  return (
    <main className="center-screen screen-enter">
      <section className="panel confirmation-panel" aria-live="polite">
        <h1>
          {result.firstName}, {already ? "you're already checked in." : "you're not checked in."}
        </h1>
        <p>
          {already
            ? "Don't forget to check out before you leave."
            : w("If you just checked out, you're all set. If not, please see a board member.")}
        </p>
        <div className="button-stack">
          <Button onClick={onDone}>Done</Button>
        </div>
      </section>
    </main>
  );
}

/** A save given up by its watchdog. The server may still finish it; the list will show it. */
function Unconfirmed({ firstName, onDone }: { firstName: string; onDone: () => void }) {
  const w = useWords();
  return (
    <main className="center-screen screen-enter">
      <section className="panel confirmation-panel" aria-live="polite">
        <h1>This is taking too long, {firstName}.</h1>
        <p>{w("Please try again in a minute, or see a board member.")}</p>
        <div className="button-stack">
          <Button onClick={onDone}>Done</Button>
        </div>
      </section>
    </main>
  );
}

function Setup({
  saving,
  error,
  onSave,
}: {
  saving: boolean;
  error: string;
  onSave: (code: string) => void;
}) {
  const w = useWords();
  const [code, setCode] = useState("");
  const codeRef = useRef<HTMLInputElement>(null);
  const save = () => {
    if (!saving && code.trim()) onSave(code.trim());
  };

  return (
    <main className="welcome name-entry screen-enter">
      <section className="hero name-entry-hero">
        <h1>Set up this kiosk</h1>
        <p>{w("Board member: tap the box below, type the kiosk access code, then tap Save.")}</p>
      </section>

      <section className="name-search-card" aria-label="Kiosk access code">
        <label className="search-field name-search-field">
          <span className="sr-only">Kiosk access code</span>
          <input
            ref={codeRef}
            autoFocus
            value={code}
            onChange={(event) => setCode(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") save();
            }}
            type="password"
            placeholder="Kiosk access code"
            maxLength={200}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            enterKeyHint="done"
          />
          {code && (
            <button
              type="button"
              onClick={() => {
                setCode("");
                codeRef.current?.focus();
              }}
              aria-label="Clear code"
            >
              Clear
            </button>
          )}
        </label>
        {error && <ErrorNotice text={error} />}
        <div className="button-stack">
          <Button onClick={save} disabled={saving || !code.trim()}>
            {saving ? (
              <>
                <span className="spinner" /> Saving…
              </>
            ) : (
              "Save"
            )}
          </Button>
        </div>
      </section>
    </main>
  );
}

function DevTools({ onReset }: { onReset: () => void }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if (e.shiftKey && e.key.toLowerCase() === "d") setOpen((v) => !v);
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);
  if (!open) return null;
  return (
    <aside className="dev-tools">
      <strong>Prototype tools</strong>
      <button onClick={onReset}>Reset mock data</button>
      <button
        onClick={() => {
          sessionStorage.setItem(FAIL_NEXT_SAVE_KEY, "true");
          setOpen(false);
        }}
      >
        Fail next save
      </button>
      <small>Shift + D to close</small>
    </aside>
  );
}

function formatTime(iso: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

function centralTimeValue(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "00";
  return `${part("hour")}:${part("minute")}`;
}

function minutesOfDay(value: string) {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function floorQuarter(minutes: number) {
  return minutes - (minutes % 15);
}

/** The latest quarter hour at or before now, Central, as HH:MM. */
function latestQuarterHour() {
  const quarter = floorQuarter(minutesOfDay(centralTimeValue()));
  return `${String(Math.floor(quarter / 60)).padStart(2, "0")}:${String(quarter % 60).padStart(2, "0")}`;
}

/** Central minutes since midnight of an instant, seconds and milliseconds as a fraction. */
function centralMinutesOf(ms: number) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((item) => item.type === type)?.value ?? 0);
  return part("hour") * 60 + part("minute") + (part("second") + (ms % 1000) / 1000) / 60;
}

/**
 * The earliest check-out time the server could accept for this entry, in milliseconds: the
 * stated arrival of its open shift. For an entry in a same-name group the digits may
 * pick any member, so it is the earliest arrival among the group's checked-in members; the
 * server checks the real one. null when no member is checked in, and null when a
 * checked-in member's check-in time can't be read: the server then checks no lower bound,
 * so the page offers no picker and the server's clock gives the check-out time.
 */
function checkOutLowerBound(volunteer: Volunteer, volunteers: Volunteer[]) {
  const group = volunteer.needsPhoneCheck
    ? volunteers.filter((v) => v.id === volunteer.id || nameKey(v) === nameKey(volunteer))
    : [volunteer];
  const checkedIn = group.filter(isCheckedIn);
  if (checkedIn.some((v) => !v.currentCheckIn)) return null;
  const arrivals = checkedIn.map((v) => Date.parse(v.currentCheckIn!));
  return arrivals.length ? Math.min(...arrivals) : null;
}

function formatDuration(minutes: number) {
  if (minutes < 1) return "Less than a minute";
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (!hours) return `${remainingMinutes} minute${remainingMinutes === 1 ? "" : "s"}`;
  if (!remainingMinutes) return `${hours} hour${hours === 1 ? "" : "s"}`;
  return `${hours} hour${hours === 1 ? "" : "s"} ${remainingMinutes} minute${
    remainingMinutes === 1 ? "" : "s"
  }`;
}

// Blurs the focused input so the tablet's keyboard closes and can't cover the screen's
// buttons or the arrival-time picker.
function closeTabletKeyboard() {
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
}

function readStoredCode(): string | null {
  try {
    return localStorage.getItem(ACCESS_CODE_KEY) || null;
  } catch {
    return null;
  }
}

function storeCode(code: string | null) {
  // If storage is blocked, the code lives only in memory and is asked again after a reload.
  try {
    if (code) localStorage.setItem(ACCESS_CODE_KEY, code);
    else localStorage.removeItem(ACCESS_CODE_KEY);
  } catch {}
}

// localStorage, or null where reaching it throws (storage blocked).
function listStorage(): ListStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export default function App() {
  const [code, setCode] = useState<string | null>(readStoredCode);
  const codeRef = useRef(code);
  // The code reads back from storage: it came from storage when the page started, or it read
  // back equal right after Save stored it (applyCode). Where storage is blocked it doesn't,
  // and every tap waits for the server: the queue couldn't be stored either.
  const codeStored = useRef(code !== null);
  const [setupError, setSetupError] = useState("");
  // A list kept from before the reload shows at once; the refresh below replaces it.
  const [keptList] = useState(() => readStoredList(listStorage(), code, Date.now()));
  const [volunteers, setVolunteers] = useState<Volunteer[]>(() => keptList?.volunteers ?? []);
  // The sheet's "Long shift flag hours" from the same list reply, set with the volunteers.
  const [longShiftHours, setLongShiftHours] = useState(
    () => keptList?.longShiftHours ?? DEFAULT_LONG_SHIFT_HOURS,
  );
  // The page's Settings from the list in use: the kept list's, then each fresh list's; the
  // brand's while there is none. wordsRef is their words for text made outside a render.
  const [pageSettings, setPageSettings] = useState<PageSettings>(
    () => keptList?.pageSettings ?? brandPageSettings,
  );
  const wordsRef = useRef(pageSettings.words);
  wordsRef.current = pageSettings.words;
  const worded = (text: string) => wordText(text, wordsRef.current);
  // Tablet arrival and check-out changes Off hide the screens' time changes; the server
  // refuses them too.
  const { arrivalChanges: arrivalsChangeable, checkOutChanges: checkOutsChangeable } =
    pageSwitchesOf(pageSettings);
  // The list's hoursRequests. The kept list doesn't hold it, so after a reload the Request my
  // hours link stays hidden until a fresh list arrives (a request can't go offline anyway).
  const [hoursRequests, setHoursRequests] = useState(false);
  const nowMs = useMinuteNow();
  const cardClock = useMemo(() => ({ nowMs, longShiftHours }), [nowMs, longShiftHours]);
  const [listState, setListState] = useState<ListState>(keptList ? "stored" : "loading");
  // When the server list on screen arrived, or null when there is none to keep.
  const listSavedAt = useRef<number | null>(keptList?.savedAt ?? null);
  const listRequested = useRef(0);
  const listApplied = useRef(0);
  // What the list in use carries beside its volunteers: milestone texts, the tablet clock's
  // offset from the server's, and the stamp of its request (saveQueue.ts).
  const listExtras = useRef<ListExtras>(keptList ?? noListExtras);
  const [listStamp, setListStamp] = useState<ListStamp | null>(keptList?.listStamp ?? null);
  // The save queue in localStorage, shared by every kiosk tab. The copy here is for
  // rendering: every change goes through changeQueue, which reads and writes storage.
  const queueEnv = useMemo<QueueEnv>(
    () => ({
      locks: typeof navigator !== "undefined" && navigator.locks ? navigator.locks : null,
      storage: listStorage(),
      newEpoch: newTapId,
      now: () => Date.now(),
    }),
    [],
  );
  const [queue, setQueueState] = useState<SaveQueue>(() => readQueue(listStorage(), newTapId));
  const queueRef = useRef(queue);
  // The page's first queue change, which list requests wait for, so their stamp reads the
  // stored queue.
  const queueStarted = useRef<Promise<unknown>>(Promise.resolve());
  // Marks of this page's foreground saves that couldn't be stored, held here for the overlay
  // until a list asked for after them is in use.
  const [heldMarks, setHeldMarksState] = useState<Mark[]>([]);
  const heldMarksRef = useRef<Mark[]>([]);
  // This page is running a queue attempt (it holds, or is asking for, the runner lock).
  const runnerActive = useRef(false);
  const runnerTimer = useRef<number | null>(null);
  // An instant tap is being stored; a second tap meanwhile is ignored.
  const instantBusy = useRef(false);
  // The list the screens show: the server's, with this tablet's saves and marks over it.
  const shown = useMemo(
    () => overlay(volunteers, queue, listStamp, heldMarks),
    [volunteers, queue, listStamp, heldMarks],
  );
  const [messageIndex, setMessageIndex] = useState(0);
  // The volunteer is using the welcome screen's name box: on a landscape tablet the Checked
  // In panel slides aside and the name card centers (index.css, src/searchOpen.ts).
  const [searchOpen, setSearchOpen] = useState(false);
  // Whether the welcome screen's name box focuses itself when the screen opens: on load and
  // when a timer goes home, not when a tap does (see Welcome's focusOnOpen).
  const [focusNameBox, setFocusNameBox] = useState(true);
  const [screen, setScreen] = useState<Screen>("welcome");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // The setup screen's code check only. A check-in or check-out is a save, below.
  const [saving, setSaving] = useState(false);
  // The pending check-in or check-out, if any: in state for the screens, and in a ref so a
  // reply or the watchdog reads the current one, not the one of the render that started it.
  const [save, setSave] = useState<SaveRecord | null>(null);
  const saveFlow = useRef(noSaves);
  const [error, setError] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  // A picked time keeps the Central day it was picked on, so a tap after midnight sends it
  // on that day.
  const [arrivalTime, setArrivalTime] = useState(() => pickTime(centralTimeValue()));
  // Check-in sends no time, so the server uses its own clock, unless the volunteer opens
  // the arrival-time picker.
  const [arrivalPicker, setArrivalPicker] = useState(false);
  // Check-out likewise sends no time unless the volunteer opens the check-out picker.
  const [checkOutTime, setCheckOutTime] = useState(() => pickTime(centralTimeValue()));
  const [checkOutPicker, setCheckOutPicker] = useState(false);
  // Change on the check-out screen: its open picker, whether the Change is out, and whether
  // "Arrival time saved." shows. changeSeq numbers the Changes: an answer moves the screen
  // only while its number is the current one, so leaving the screen drops it.
  const [arrivalPick, setArrivalPick] = useState<ArrivalPick | null>(null);
  const [changeSaving, setChangeSaving] = useState(false);
  const [arrivalSaved, setArrivalSaved] = useState(false);
  const changeSeq = useRef(0);
  const dropArrivalChange = () => {
    changeSeq.current += 1;
    setArrivalPick(null);
    setChangeSaving(false);
    setArrivalSaved(false);
  };
  const [phoneStep, setPhoneStep] = useState<PhoneStep>(null);
  const [phoneDigits, setPhoneDigits] = useState("");
  // Whether the digits are asked for, fixed at the tap (a list refresh on the open screen
  // doesn't change it); a phone refusal sets it.
  const [digitsAsked, setDigitsAsked] = useState(false);
  // A check-out sent without digits was refused because another of the name is checked in.
  const [anotherIn, setAnotherIn] = useState(false);
  // The Request my hours path: the volunteer tapped in the hours search (the confirm screen
  // keeps this copy), and the confirm screen's state. hoursRequestSeq numbers the requests: a
  // reply is shown only while its number is the current one, so leaving the screen drops it.
  const [hoursFor, setHoursFor] = useState<Volunteer | null>(null);
  const [hoursRequest, setHoursRequest] = useState<HoursRequestState>(hoursRequestReady);
  const hoursRequestSeq = useRef(0);
  const dropHoursRequest = () => {
    hoursRequestSeq.current += 1;
    setHoursRequest(hoursRequestReady);
  };
  const inactivityRef = useRef<number | null>(null);
  const selected = shown.find((v) => v.id === selectedId) ?? null;
  const checkOutFloorMs = selected ? checkOutLowerBound(selected, shown) : null;
  const checkOutMinMinutes = checkOutFloorMs === null ? null : centralMinutesOf(checkOutFloorMs);
  // The check-out picker is offered only when the lower bound is today and at least one
  // quarter hour lies between it and now. The picker offers times of today only, so an
  // arrival on an earlier date (an evening shift checked out after midnight) gets no picker
  // and Check Out uses the server's clock. The date test must come first: yesterday's
  // arrival can have fewer minutes since midnight than now.
  const checkOutPickable =
    checkOutFloorMs !== null &&
    checkOutMinMinutes !== null &&
    isToday(new Date(checkOutFloorMs).toISOString()) &&
    Math.ceil(checkOutMinMinutes / 15) * 15 <= floorQuarter(minutesOfDay(centralTimeValue()));

  const goHome = (byTap = false) => {
    setFocusNameBox(!byTap);
    setScreen("welcome");
    setSelectedId(null);
    setError("");
    setResult(null);
    setArrivalTime(pickTime(centralTimeValue()));
    setArrivalPicker(false);
    setCheckOutTime(pickTime(centralTimeValue()));
    setCheckOutPicker(false);
    dropArrivalChange();
    setPhoneStep(null);
    setPhoneDigits("");
    setDigitsAsked(false);
    setAnotherIn(false);
    setHoursFor(null);
    dropHoursRequest();
  };
  // Home from a button the volunteer tapped.
  const tapHome = () => goHome(true);
  const select = (volunteer: Volunteer) => {
    closeTabletKeyboard();
    setSelectedId(volunteer.id);
    setError("");
    setArrivalTime(pickTime(centralTimeValue()));
    setArrivalPicker(false);
    setCheckOutTime(pickTime(centralTimeValue()));
    setCheckOutPicker(false);
    dropArrivalChange();
    const asked = digitsAskedAtTap(isCheckedIn(volunteer), volunteer, shown);
    setDigitsAsked(asked);
    setAnotherIn(false);
    setPhoneStep(asked ? "entry" : null);
    setPhoneDigits("");
    setScreen(isCheckedIn(volunteer) ? "checkout" : "confirm");
    // A list more than a minute old is refreshed while the volunteer reads the screen, so an
    // instant result is decided on a newer one when it lands first. Nothing waits for it.
    const arrived = listSavedAt.current;
    if (arrived === null || Date.now() - arrived > SELECT_REFRESH_MS) refreshList();
  };

  const applyCode = (next: string | null) => {
    codeRef.current = next;
    storeCode(next);
    codeStored.current = next !== null && readStoredCode() === next;
    clearStoredList(listStorage());
    listSavedAt.current = null;
    listExtras.current = noListExtras;
    setListStamp(null);
    setCode(next);
    setVolunteers([]);
    setHoursRequests(false);
    setListState("loading");
  };
  const setSaveFlow = (next: typeof noSaves) => {
    saveFlow.current = next;
    setSave(next.pending);
  };
  // The server refused the stored code: back to the setup screen. A pending save is given
  // up, so its reply can't change the screen.
  const lockKiosk = (message: string) => {
    setSaveFlow(abandonSave(saveFlow.current));
    applyCode(null);
    setSetupError(message);
    goHome();
  };

  // Responses can arrive out of order; only one newer than the last applied is used.
  function refreshList() {
    const requestCode = codeRef.current;
    if (!requestCode) return;
    const seq = ++listRequested.current;
    const isCurrent = () => seq > listApplied.current && codeRef.current === requestCode;
    const failed = () => setListState(listStateAfterFailure);
    void queueStarted.current.then(() => {
      // The stamp: what the stored queue held when the list was asked for.
      const stamp = stampNow(listStorage(), newTapId, Date.now());
      api.listVolunteers(requestCode).then(
        (reply) => {
          if (!isCurrent()) return;
          // A refusal applies nothing, so an older call's list still out can land after it.
          if (isRefusal(reply)) {
            if (reply.refusal === "ACCESS" || reply.refusal === "ZONE_NOT_SET") {
              lockKiosk(reply.message);
            } else failed();
            return;
          }
          listApplied.current = seq;
          const receivedAt = Date.now();
          listSavedAt.current = receivedAt;
          listExtras.current = {
            milestones: reply.milestones,
            clockOffsetMs: reply.serverNow === null ? null : reply.serverNow - receivedAt,
            listStamp: stamp,
            pageSettings: reply.pageSettings,
          };
          setPageSettings(reply.pageSettings ?? brandPageSettings);
          setListStamp(stamp);
          setHeldMarks(heldMarksRef.current.filter((m) => !heldMarkCovered(m, stamp)));
          setVolunteers(reply.volunteers.map(toVolunteer));
          setLongShiftHours(reply.longShiftHours);
          setHoursRequests(reply.hoursRequests);
          setListState("ready");
        },
        () => {
          if (isCurrent()) failed();
        },
      );
    });
  }

  // A queue from storage or a change: rendered, and when its last save has left, the list
  // is refreshed so the volunteers' saved state shows from the server.
  function setQueue(next: SaveQueue) {
    const emptied = queueRef.current.saves.length > 0 && next.saves.length === 0;
    queueRef.current = next;
    setQueueState(next);
    if (emptied) refreshList();
  }

  async function changeSaves(change: Change) {
    const result = await changeQueue(queueEnv, change);
    setQueue(result.queue);
    return result;
  }

  function setHeldMarks(next: Mark[]) {
    heldMarksRef.current = next;
    setHeldMarksState(next);
  }

  // A foreground save's mark: stored in the queue, or held here when it can't be (and then
  // the kept list is removed, so a reload can't trust a list from before the save). False
  // when the mark before a send was refused because the volunteer has a queued save.
  async function foregroundMark(mark: Omit<Mark, "seq">, beforeSend = false) {
    const result = await storeForegroundMark(queueEnv, mark, listStorage(), beforeSend);
    setQueue(result.queue);
    if (result.refused === "queued") return false;
    const others = heldMarksRef.current.filter((m) => m.key !== mark.key);
    setHeldMarks(result.stored ? others : [...others, { ...mark, seq: 0 }]);
    return true;
  }

  // A foreground save the server refused wrote nothing: its mark goes.
  async function dropForegroundMark(key: string) {
    await changeSaves(dropMark(key));
    setHeldMarks(heldMarksRef.current.filter((m) => m.key !== key));
  }

  function armRunner(ms: number) {
    if (runnerTimer.current !== null) clearTimeout(runnerTimer.current);
    runnerTimer.current = window.setTimeout(
      () => {
        runnerTimer.current = null;
        void kickRunner();
      },
      Math.max(0, ms),
    );
  }

  // One attempt at the queue's head, when this page is visible, has a code and no
  // foreground save is pending; then the next run is timed from what it found.
  async function kickRunner() {
    if (runnerActive.current) return;
    const gate = runnerGate({
      hasCode: Boolean(codeRef.current),
      visible: document.visibilityState === "visible",
      foregroundPending: saveFlow.current.pending !== null,
      queued: queueRef.current.saves.length,
    });
    if (gate !== "run") {
      if (gate !== null) armRunner(gate);
      return;
    }
    runnerActive.current = true;
    let ran: RunResult = { status: "busy" };
    try {
      ran = await runOnce(queueEnv, {
        online: () => navigator.onLine,
        send: (save, tap) => {
          const sendCode = codeRef.current ?? "";
          return save.kind === "in"
            ? api.checkIn(sendCode, save.volunteerId, null, null, tap)
            : api.checkOut(sendCode, save.volunteerId, null, null, tap);
        },
        wait: (ms) => new Promise((resolve) => window.setTimeout(resolve, ms)),
        onQueue: setQueue,
      });
    } catch {
    } finally {
      runnerActive.current = false;
    }
    const next = nextRunDelay(ran, {
      now: Date.now(),
      online: navigator.onLine,
      hasLocks: queueEnv.locks !== null,
      queued: queueRef.current.saves.length,
    });
    if (next === "lock") lockKiosk(refusalMessage("ACCESS"));
    else if (next !== null) armRunner(next);
  }

  // The first queue change creates the stored queue, and its epoch, before the first list
  // request reads its stamp.
  useEffect(() => {
    queueStarted.current = changeSaves(touch);
  }, []);

  // Coming back online asks for the list at once: a reply is what lets taps be instant again.
  useEffect(() => {
    if (!code) return;
    refreshList();
    const timer = window.setInterval(refreshList, LIST_REFRESH_MS);
    window.addEventListener("online", refreshList);
    return () => {
      clearInterval(timer);
      window.removeEventListener("online", refreshList);
    };
  }, [code]);

  useEffect(() => {
    const every = listRetryMs(listState);
    if (!code || every === null) return;
    const timer = window.setInterval(refreshList, every);
    return () => clearInterval(timer);
  }, [code, listState]);

  // Timers stop while the iPad sleeps or the page is hidden, so the list can be minutes old when
  // it comes back into view. Refresh it then, but not during a save and not more than once every
  // 30 s.
  useEffect(() => {
    if (!code) return;
    let lastWake: number | null = null;
    const onWake = () => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (!wakeRefreshDue(now, lastWake, saveFlow.current.pending !== null)) return;
      lastWake = now;
      refreshList();
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) onWake();
    };
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [code]);

  // The runner runs when the page opens with a code, comes back into view, comes back
  // online, and when another tab changes the queue. Each re-reads the queue from storage.
  useEffect(() => {
    if (!code) return;
    const kick = () => void kickRunner();
    const reread = () => setQueue(readQueue(listStorage(), newTapId));
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      reread();
      kick();
    };
    const onPageShow = (event: PageTransitionEvent) => {
      reread();
      if (event.persisted) kick();
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key !== SAVE_QUEUE_KEY && event.key !== null) return;
      reread();
      kick();
    };
    void queueStarted.current.then(kick);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("online", kick);
    window.addEventListener("storage", onStorage);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("online", kick);
      window.removeEventListener("storage", onStorage);
      if (runnerTimer.current !== null) clearTimeout(runnerTimer.current);
    };
  }, [code]);

  // Keeps the server list on the tablet when it arrives, with what it carries beside the
  // volunteers. The kept list is the server's: this tablet's saves are in the queue.
  useEffect(() => {
    const savedAt = listSavedAt.current;
    if (codeRef.current && savedAt !== null)
      storeList(
        listStorage(),
        codeRef.current,
        savedAt,
        volunteers,
        longShiftHours,
        listExtras.current,
      );
  }, [volunteers, longShiftHours]);

  // Runs again when the screen changes, so a save that ends back on confirm or checkout for
  // a volunteer who left the list meanwhile goes home instead of showing a blank screen.
  useEffect(() => {
    if (goesHomeWhenListLosesVolunteer(screen, listState, selectedId, selected !== null)) goHome();
  }, [shown, screen]);

  useEffect(() => {
    const ms = inactivityMs(screen);
    if (ms === null) return;
    const resetTimer = () => {
      if (inactivityRef.current) clearTimeout(inactivityRef.current);
      inactivityRef.current = window.setTimeout(() => goHome(), ms);
    };
    const events = ["pointerdown", "keydown", "input"];
    events.forEach((name) => window.addEventListener(name, resetTimer));
    resetTimer();
    return () => {
      if (inactivityRef.current) clearTimeout(inactivityRef.current);
      events.forEach((name) => window.removeEventListener(name, resetTimer));
    };
  }, [screen]);

  useEffect(() => {
    const ms = autoHomeMs(screen);
    if (ms === null) return;
    const timer = window.setTimeout(() => goHome(), ms);
    return () => clearTimeout(timer);
  }, [screen]);

  // The watchdog: a save still pending 45 s after it started is given up. The list refreshes
  // so the volunteer's real state shows, and the page says it couldn't confirm.
  useEffect(() => {
    if (!save) return;
    const { seq, startedAt } = save;
    const timer = window.setTimeout(
      () => {
        const taken = takeWatchdog(saveFlow.current, seq);
        if (!taken.save) return;
        setSaveFlow(taken.flow);
        setError("");
        setResult(resultOf(taken.save, {}));
        setScreen("unconfirmed");
        refreshList();
        void kickRunner();
      },
      msUntil(WATCHDOG_MS, Date.now() - startedAt),
    );
    return () => clearTimeout(timer);
  }, [save?.seq]);

  async function handleSaveCode(candidate: string) {
    if (saving) return;
    setSaving(true);
    setSetupError("");
    try {
      const reply = await api.checkAccess(candidate);
      if (isRefusal(reply)) setSetupError(reply.message);
      else applyCode(candidate);
    } catch {
      setSetupError("We couldn't check the code. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  function nextMessage() {
    setMessageIndex((index) => index + 1);
    return appreciationMessages[messageIndex % appreciationMessages.length];
  }

  // A refusal of the save: the status screen when the volunteer's state differs from the
  // screen's, else back to the screen the save came from with the server's reason.
  function showRefusal(reply: Refusal, save: SaveRecord) {
    const outcome = refusalOutcome(reply.refusal);
    if (outcome === "lock") {
      lockKiosk(reply.message);
      return;
    }
    if (outcome === "status") {
      setResult(resultOf(save, { status: reply.refusal as StatusCode }));
      setScreen("status");
      return;
    }
    setScreen(save.from);
    // A check-out sent without digits and refused with PHONE_NEEDED: the prompt says another
    // of the name is checked in, in place of the server's message.
    const phone = afterPhoneRefusal(outcome, digitsAsked, save.kind === "out");
    if (phone) {
      setPhoneDigits("");
      setPhoneStep(outcome === "phone-missing" ? "missing" : "entry");
      setDigitsAsked(phone.asked);
      setAnotherIn(phone.anotherIn);
    }
    setError(!phone || phone.showMessage ? reply.message : "");
  }

  /** Shows the save screen for a check-in or check-out of the selected volunteer. */
  function beginSave(kind: SaveKind, volunteer: Volunteer, from: SaveFrom) {
    closeTabletKeyboard();
    const started = startSave(saveFlow.current, {
      kind,
      volunteerId: volunteer.id,
      firstName: volunteer.firstName,
      from,
      startedAt: Date.now(),
    });
    setSaveFlow(started.flow);
    setScreen("saving");
    return started.record.seq;
  }

  /**
   * The save a reply belongs to, when it is still the pending one; the record clears. null
   * for a late reply. The caller refreshes the list after every reply, current or late, and
   * does nothing else for a late one. The refresh goes after the volunteer is marked, or the
   * mark would drop it as out of date.
   */
  function endSave(seq: number) {
    const taken = takeReply(saveFlow.current, seq);
    if (taken.save) setSaveFlow(taken.flow);
    return taken.save;
  }

  /**
   * An instant check-in or check-out: the result shows at the tap and the save waits in the
   * queue. False when the tap goes the waiting way instead. A volunteer with a queued save
   * gets the still-saving line and no save at all, since a save sent now would reach the
   * server before the queued one.
   */
  async function tryInstant(kind: SaveKind, entry: Volunteer): Promise<boolean> {
    const now = Date.now();
    const savingLine = (q: SaveQueue) =>
      stillSavingText(
        q,
        entry.id,
        {
          online: navigator.onLine,
          now,
          runnerHeld: runnerActive.current,
        },
        wordsRef.current,
      );
    const still = savingLine(queueRef.current);
    if (still) {
      setError(still);
      return true;
    }
    const extras = listExtras.current;
    const ctx = {
      hasCode: Boolean(codeRef.current),
      codeStored: codeStored.current,
      foregroundPending: saveFlow.current.pending !== null,
      online: navigator.onLine,
      calls: callRecord(),
      listState,
      now,
      listStamp,
      clockOffsetMs: extras.clockOffsetMs,
      queue: queueRef.current,
      heldMarks: heldMarksRef.current,
      arrivalPicker,
      checkOutPicker,
    };
    if (!qualifies(kind, entry, ctx)) return false;
    const save = newSave(kind, entry, now);
    const milestoneId = "milestoneId" in save.shown ? save.shown.milestoneId : null;
    const milestone =
      milestoneId === null ? null : (extras.milestones.find((m) => m.id === milestoneId) ?? null);
    // A step naming a milestone the list has no text for: the server's answer shows it.
    if (milestoneId !== null && !milestone) return false;
    const stored = await changeSaves(enqueue(save, listStamp, () => Date.now()));
    const path = afterEnqueue(stored);
    if (path === "still-saving") setError(savingLine(stored.queue) ?? "");
    if (path !== "instant") return path === "still-saving";
    closeTabletKeyboard();
    if (kind === "in") {
      setResult({
        firstName: entry.firstName,
        kind,
        time: save.arrival ?? undefined,
        message: nextMessage(),
      });
      setScreen(entry.missedSignOut ? "notice" : "success-in");
    } else {
      setResult({ firstName: entry.firstName, kind, milestone, message: nextMessage() });
      setScreen("success-out");
    }
    void kickRunner();
    return true;
  }

  // Runs tryInstant once at a time; true when the tap was handled there.
  async function instantTap(kind: SaveKind, entry: Volunteer): Promise<boolean> {
    if (instantBusy.current) return true;
    instantBusy.current = true;
    try {
      return await tryInstant(kind, entry);
    } finally {
      instantBusy.current = false;
    }
  }

  /**
   * Before a foreground save is sent its mark is stored as unknown, open until the server
   * can no longer write; the reply replaces it with what the server did, or removes it for a
   * refusal, which wrote nothing. A reply that never comes leaves the unknown mark, so the
   * volunteer's next tap waits for a list asked for after the server stopped. null, with
   * nothing to send, when the stored queue holds a save for the volunteer.
   */
  async function markBeforeSend(volunteerId: string) {
    const key = newTapId();
    const startedAt = Date.now();
    const marked = await foregroundMark(
      {
        key,
        volunteerId,
        at: startedAt,
        listAfter: startedAt + SERVER_MAX_MS,
        state: "unknown",
        arrival: null,
      },
      true,
    );
    return marked ? key : null;
  }

  // Another tab queued a save for the volunteer after this page last read the queue: the
  // foreground save isn't sent, and the volunteer gets the still-saving line, as a tap
  // with a queued save does.
  function endWithStillSaving(seq: number, volunteerId: string) {
    const ended = endSave(seq);
    if (ended) {
      setScreen(ended.from);
      setError(
        stillSavingText(
          queueRef.current,
          volunteerId,
          {
            online: navigator.onLine,
            now: Date.now(),
            runnerHeld: runnerActive.current,
          },
          wordsRef.current,
        ) ?? "",
      );
    }
    void kickRunner();
  }

  async function handleConfirm() {
    if (!selected || saveFlow.current.pending || !code) return;
    if (digitsMissing(digitsAsked, phoneDigits)) {
      setPhoneStep("entry");
      return;
    }
    setError("");
    if (await instantTap("in", selected)) return;
    const timestamp = arrivalPicker ? pickedTimeToIso(arrivalTime) : null;
    if (timestamp && new Date(timestamp).getTime() > Date.now() + 60_000) {
      setError("Your arrival time cannot be in the future. Please choose an earlier time.");
      return;
    }
    const seq = beginSave("in", selected, "confirm");
    const markKey = await markBeforeSend(selected.id);
    if (markKey === null) {
      endWithStillSaving(seq, selected.id);
      return;
    }
    let reply: Awaited<ReturnType<typeof api.checkIn>> | null = null;
    try {
      reply = await api.checkIn(
        code,
        selected.id,
        timestamp,
        digitsToSend(digitsAsked, phoneDigits),
      );
    } catch {}
    // The server is done with the call, whether or not the reply is still current.
    if (reply && isRefusal(reply)) await dropForegroundMark(markKey);
    else if (reply) {
      await foregroundMark({
        key: markKey,
        volunteerId: reply.id,
        at: Date.now(),
        listAfter: 0,
        state: "in",
        arrival: reply.arrivedAt,
      });
    }
    const ended = endSave(seq);
    try {
      if (!ended) return;
      if (!reply) {
        setScreen(ended.from);
        setError(
          worded(
            "We couldn't save your check-in. Please try again or ask a volunteer coordinator for help.",
          ),
        );
      } else if (isRefusal(reply)) {
        showRefusal(reply, ended);
      } else {
        // In a same-name group the server picks the member by the digits, so the entry it
        // acted on can be another one than the entry tapped; that is the one marked above.
        // A list asked for before the save is out of date and is dropped.
        listApplied.current = listRequested.current;
        setResult(resultOf(ended, { time: reply.arrivedAt ?? undefined, message: nextMessage() }));
        setScreen(reply.missedSignOut ? "notice" : "success-in");
      }
    } finally {
      refreshList();
      void kickRunner();
    }
  }

  async function handleCheckout() {
    if (!selected || saveFlow.current.pending || !code) return;
    if (digitsMissing(digitsAsked, phoneDigits)) {
      setPhoneStep("entry");
      return;
    }
    setError("");
    if (await instantTap("out", selected)) return;
    // The page's own checks use the server's messages. The server checks again against its
    // clock and the shift it acts on.
    const timestamp = checkOutPicker ? pickedTimeToIso(checkOutTime) : null;
    if (timestamp) {
      const chosen = Date.parse(timestamp);
      if (chosen > Date.now() + 60_000) {
        setError(refusalMessage("CHECKOUT_FUTURE"));
        return;
      }
      if (checkOutFloorMs !== null && chosen < checkOutFloorMs) {
        setError(refusalMessage("CHECKOUT_BEFORE_ARRIVAL"));
        return;
      }
    }
    const seq = beginSave("out", selected, "checkout");
    const markKey = await markBeforeSend(selected.id);
    if (markKey === null) {
      endWithStillSaving(seq, selected.id);
      return;
    }
    let reply: Awaited<ReturnType<typeof api.checkOut>> | null = null;
    try {
      reply = await api.checkOut(
        code,
        selected.id,
        digitsToSend(digitsAsked, phoneDigits),
        timestamp,
      );
    } catch {}
    if (reply && isRefusal(reply)) await dropForegroundMark(markKey);
    else if (reply) {
      await foregroundMark({
        key: markKey,
        volunteerId: reply.id,
        at: Date.now(),
        listAfter: 0,
        state: "out",
        arrival: null,
      });
    }
    const ended = endSave(seq);
    try {
      if (!ended) return;
      if (!reply) {
        setScreen(ended.from);
        setError(
          worded(
            "We couldn't save your check-out. Please try again or ask a volunteer coordinator for help.",
          ),
        );
      } else if (isRefusal(reply)) {
        showRefusal(reply, ended);
      } else {
        listApplied.current = listRequested.current;
        setResult(
          resultOf(ended, {
            time: reply.signedOutAt ?? undefined,
            duration: reply.minutes ?? undefined,
            milestone: reply.milestone,
            message: nextMessage(),
          }),
        );
        setScreen("success-out");
      }
    } finally {
      refreshList();
      void kickRunner();
    }
  }

  /**
   * Save time on Change's picker: the Change alone, never a check-out. Untouched, the picker
   * closes and nothing is sent. The Change waits for the server: before the call its own
   * unknown mark is stored (refused, with the still-saving line, when the queue holds a save
   * for the volunteer); the server's answer, however late, makes that mark the new arrival
   * or drops it, and only a current answer moves the screen. No answer leaves the mark, so
   * the volunteer's next tap waits for the server.
   */
  async function saveArrivalChange() {
    const pick = arrivalPick;
    if (!pick || !selected || !code || changeSaving || saveFlow.current.pending) return;
    const arrivalIso = arrivalToSend(pick);
    setError("");
    if (arrivalIso === null) {
      setArrivalPick(null);
      return;
    }
    const seq = ++changeSeq.current;
    const current = () => seq === changeSeq.current;
    const volunteerId = selected.id;
    const firstName = selected.firstName;
    setChangeSaving(true);
    const markKey = await markBeforeSend(volunteerId);
    if (markKey === null) {
      if (!current()) return;
      setChangeSaving(false);
      setError(
        stillSavingText(
          queueRef.current,
          volunteerId,
          {
            online: navigator.onLine,
            now: Date.now(),
            runnerHeld: runnerActive.current,
          },
          wordsRef.current,
        ) ?? "",
      );
      return;
    }
    const answered = api
      .changeArrival(
        code,
        volunteerId,
        digitsToSend(digitsAsked, phoneDigits),
        pick.shiftId,
        pick.fromIso,
        arrivalIso,
      )
      .then(async (reply) => {
        // The server is done with the call, whether or not the answer is still current.
        if (isRefusal(reply)) await dropForegroundMark(markKey);
        else {
          await foregroundMark({
            key: markKey,
            volunteerId: reply.id,
            at: Date.now(),
            listAfter: 0,
            state: "in",
            arrival: reply.arrivedAt,
          });
          refreshList();
        }
        return reply;
      });
    const reply = await settleWithin(answered, ATTEMPT_MS);
    if (!current()) return;
    setChangeSaving(false);
    const next = afterArrivalChange(reply);
    if (next.kind === "saved") {
      setArrivalPick(null);
      setArrivalSaved(true);
    } else if (next.kind === "lock") {
      lockKiosk(next.message);
    } else if (next.kind === "not-in") {
      setResult({ firstName, kind: "out", status: "NOT_IN" });
      setScreen("status");
    } else if (next.kind === "phone") {
      // As a check-out's phone refusal: the digit step, with the picker closed.
      const phone = afterPhoneRefusal(refusalOutcome(next.refusal.refusal), digitsAsked, true)!;
      setArrivalPick(null);
      setPhoneDigits("");
      setPhoneStep(next.refusal.refusal === "PHONE_MISSING" ? "missing" : "entry");
      setDigitsAsked(phone.asked);
      setAnotherIn(phone.anotherIn);
      setError(phone.showMessage ? next.refusal.message : "");
    } else {
      setError(next.text);
    }
  }

  // The Request my hours link opens the hours search: the welcome screen's search with no
  // Checked In panel, whose names lead only to the hours steps.
  const openHours = () => {
    closeTabletKeyboard();
    goHome(true);
    setScreen("hours");
  };

  // A name in the hours search: the phone step when the name is shared (the check-in rule),
  // then the confirm screen. It checks no one in or out.
  const chooseForHours = (volunteer: Volunteer) => {
    closeTabletKeyboard();
    const asked = digitsAskedAtTap(false, volunteer, shown);
    setHoursFor(volunteer);
    setDigitsAsked(asked);
    setAnotherIn(false);
    setPhoneStep(asked ? "entry" : null);
    setPhoneDigits("");
    setError("");
    dropHoursRequest();
    setScreen("hours-confirm");
  };

  // Send on the confirm screen: records a request, its own call outside the save queue. A
  // phone refusal brings the phone step back with its message.
  async function requestHours() {
    if (!hoursFor || !code || hoursRequest.kind === "sending") return;
    if (digitsMissing(digitsAsked, phoneDigits)) {
      setPhoneStep("entry");
      return;
    }
    const seq = ++hoursRequestSeq.current;
    const firstName = hoursFor.firstName;
    setError("");
    setHoursRequest({ kind: "sending" });
    const reply = await settleWithin(
      api.requestHours(code, hoursFor.id, digitsToSend(digitsAsked, phoneDigits)),
      HOURS_REQUEST_TIMEOUT_MS,
    );
    if (seq !== hoursRequestSeq.current) return;
    if (hoursPhoneStepAfter(reply)) {
      setHoursRequest(hoursRequestReady);
      setPhoneDigits("");
      setDigitsAsked(true);
      setPhoneStep("entry");
      setError((reply as Refusal).message);
      return;
    }
    const next = afterHoursRequest(reply, firstName, wordsRef.current);
    if ("lock" in next) lockKiosk(next.lock);
    else setHoursRequest(next);
  }

  // The kiosk code typed into the banner clears its failed lines in every tab.
  function dismissBanner(typed: string) {
    if (!codeMatches(typed, codeRef.current)) return false;
    void changeSaves(dismissFailed());
    return true;
  }

  const phoneProps = {
    phoneStep,
    phoneDigits,
    onPhoneDigitsChange: setPhoneDigits,
    onPhoneContinue: () => {
      if (phoneDigits.length !== 4) return;
      closeTabletKeyboard();
      setError("");
      setPhoneStep(null);
    },
  };

  // The hours search keeps the welcome screen's layout, with its own fixed landscape place.
  const shellScreen = screen === "hours" ? "welcome hours-search" : screen;

  const shell = (
    <div
      className={`app-shell screen-${code ? shellScreen : "welcome"}${code ? "" : " setup"}${searchOpen && screen === "welcome" ? " search-open" : ""}`}
    >
      {!code && (
        <>
          <Header />
          <Setup saving={saving} error={setupError} onSave={handleSaveCode} />
        </>
      )}
      {code && screen === "welcome" && (
        <>
          <Header />
          <Welcome
            volunteers={shown}
            listState={listState}
            clock={cardClock}
            onSelect={select}
            onSearchOpen={setSearchOpen}
            focusOnOpen={focusNameBox}
            onRequestHours={showsHoursLink(hoursRequests) ? openHours : undefined}
            banner={
              <SaveBanner
                failed={queue.failed}
                stuck={stuckSaves(queue, nowMs)}
                unreadable={queue.unreadable}
                onDismiss={dismissBanner}
              />
            }
          />
          <CheckedInSidebar
            volunteers={shown}
            saving={queue.saves}
            clock={cardClock}
            onSelect={select}
          />
        </>
      )}
      {code && screen === "hours" && (
        <>
          <Header />
          <Welcome
            key="hours"
            volunteers={shown}
            listState={listState}
            clock={cardClock}
            onSelect={chooseForHours}
            onSearchOpen={() => {}}
            focusOnOpen={false}
            banner={null}
            hours={{ onBack: tapHome }}
          />
        </>
      )}
      {code && screen === "hours-confirm" && hoursFor && (
        <HoursConfirm
          volunteer={hoursFor}
          phoneStep={phoneStep}
          phoneDigits={phoneDigits}
          error={error}
          state={hoursRequest}
          onPhoneDigitsChange={setPhoneDigits}
          onPhoneContinue={phoneProps.onPhoneContinue}
          onSend={requestHours}
          onBack={tapHome}
        />
      )}
      {code && screen === "confirm" && selected && (
        <Confirmation
          volunteer={selected}
          checkout={false}
          time={arrivalTime.time}
          picker={arrivalPicker}
          onOpenPicker={
            arrivalsChangeable
              ? () => {
                  setError("");
                  setArrivalTime(pickTime(latestQuarterHour()));
                  setArrivalPicker(true);
                }
              : undefined
          }
          {...phoneProps}
          digitsAsked={digitsAsked}
          anotherIn={anotherIn}
          saving={save !== null}
          error={error}
          onTimeChange={(time) => setArrivalTime(pickTime(time))}
          onConfirm={handleConfirm}
          onBack={tapHome}
        />
      )}
      {code && screen === "checkout" && selected && (
        <Confirmation
          volunteer={selected}
          checkout
          time={checkOutTime.time}
          picker={checkOutPicker}
          minMinutes={checkOutMinMinutes ?? 0}
          onOpenPicker={
            checkOutPickable && checkOutsChangeable
              ? () => {
                  setError("");
                  setCheckOutTime(pickTime(latestQuarterHour()));
                  setCheckOutPicker(true);
                }
              : undefined
          }
          {...phoneProps}
          digitsAsked={digitsAsked}
          anotherIn={anotherIn}
          saving={save !== null}
          error={error}
          onTimeChange={(time) => setCheckOutTime(pickTime(time))}
          onConfirm={handleCheckout}
          onBack={tapHome}
          arrivalChange={{
            offered:
              arrivalsChangeable &&
              showsArrivalChange({
                entry: selected,
                phoneStep,
                picker: checkOutPicker || arrivalPick !== null,
                saving: save !== null || changeSaving,
                digitsAsked,
                digits: phoneDigits,
                queue,
                nowMs: Date.now(),
              }),
            pick: arrivalPick,
            saving: changeSaving,
            saved: arrivalSaved,
            onOpen: () => {
              setError("");
              setArrivalSaved(false);
              setArrivalPick(openArrivalPick(selected, Date.now()));
            },
            onTimeChange: (time) =>
              setArrivalPick((pick) => (pick ? movePick(pick, time, Date.now()) : pick)),
            onSave: saveArrivalChange,
            onClose: () => {
              setError("");
              setArrivalPick(null);
            },
          }}
        />
      )}
      {code && screen === "saving" && save && <SavingScreen key={save.seq} save={save} />}
      {code && screen === "notice" && result && (
        <MissedCheckOutNotice firstName={result.firstName} onDone={() => setScreen("success-in")} />
      )}
      {code && screen === "success-in" && result && (
        <Success type="in" result={result} onDone={tapHome} />
      )}
      {code && screen === "success-out" && result && (
        <Success type="out" result={result} onDone={tapHome} />
      )}
      {code && screen === "status" && result && <StatusScreen result={result} onDone={tapHome} />}
      {code && screen === "unconfirmed" && result && (
        <Unconfirmed firstName={result.firstName} onDone={tapHome} />
      )}
      {usingLocalApi && (
        <DevTools
          onReset={() => {
            localApi.reset();
            setSaveFlow(abandonSave(saveFlow.current));
            goHome();
            refreshList();
          }}
        />
      )}
    </div>
  );
  return <PageSettingsContext.Provider value={pageSettings}>{shell}</PageSettingsContext.Provider>;
}
