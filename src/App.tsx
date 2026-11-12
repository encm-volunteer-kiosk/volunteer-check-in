import { useEffect, useMemo, useRef, useState } from "react";
import { api, isRefusal, localApi, toVolunteer, usingLocalApi, type Refusal } from "./api";
import logo from "./assets/encm-logo.png";
import { appreciationMessages, isToday, type Milestone, type Volunteer } from "./data";

type Screen = "welcome" | "confirm" | "checkout" | "success-in" | "success-out";
type Result = { time: string; duration?: number; milestone?: Milestone | null; message: string };
type ListState = "loading" | "ready" | "failed";
type PhoneStep = "entry" | "missing" | null;
const TZ = "America/Chicago";
const ACCESS_CODE_KEY = "encm-kiosk-access-code";
const LIST_REFRESH_MS = 5 * 60_000;
const LIST_RETRY_MS = 30_000;

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

function Header() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
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
    <header className="header">
      <img className="logo" src={logo} alt="East Nashville Care Market" />
      <div className="date">
        <span>Today is</span>
        <strong>{day}</strong>
        <time dateTime={now.toISOString()}>{time}</time>
      </div>
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

function VolunteerCard({ volunteer, onClick }: { volunteer: Volunteer; onClick: () => void }) {
  const checkedIn = Boolean(volunteer.currentCheckIn && isToday(volunteer.currentCheckIn));
  return (
    <button
      className={`volunteer-card${checkedIn ? " is-checked-in" : ""}`}
      onClick={onClick}
      aria-label={
        checkedIn
          ? `Check out ${volunteer.firstName} ${volunteer.lastName}`
          : `Check in ${volunteer.firstName} ${volunteer.lastName}`
      }
    >
      <span className="volunteer-name">
        <span>
          {volunteer.firstName} {volunteer.lastName}
        </span>
      </span>
      <span className="card-meta">
        {checkedIn ? (
          <span className="checkout-action">
            Check out <Icon name="chevron" size={18} />
          </span>
        ) : (
          <Icon name="chevron" size={23} />
        )}
      </span>
    </button>
  );
}

const minuteOptions = [0, 15, 30, 45];

function TimeKeyboard({
  value,
  saving,
  onChange,
  onConfirm,
  onBack,
}: {
  value: string;
  saving: boolean;
  onChange: (time: string) => void;
  onConfirm: () => void;
  onBack: () => void;
}) {
  const [hourValue, minuteValue] = value.split(":").map(Number);
  const hour12 = hourValue % 12 || 12;
  const period = hourValue >= 12 ? "PM" : "AM";

  // Minutes since midnight, Central. Nothing later than now can be chosen.
  const nowMinutes = minutesOfDay(centralTimeValue());
  const toMinutes = (hour: number, minute: number, nextPeriod: "AM" | "PM") =>
    ((hour % 12) + (nextPeriod === "PM" ? 12 : 0)) * 60 + minute;
  const isLater = (hour: number, minute: number, nextPeriod: "AM" | "PM") =>
    toMinutes(hour, minute, nextPeriod) > nowMinutes;

  const updateTime = (hour: number, minute: number, nextPeriod: "AM" | "PM") => {
    // A new hour or period keeps the chosen minutes unless that is later than now; then it
    // takes the latest quarter hour that isn't.
    const start = toMinutes(hour, 0, nextPeriod);
    const total = Math.min(start + minute, Math.max(start, nowMinutes - (nowMinutes % 15)));
    onChange(
      `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`,
    );
  };

  return (
    <div className="app-keyboard time-keyboard" aria-label="Arrival time keyboard">
      <div className="keyboard-row" aria-label="Choose an hour">
        {Array.from({ length: 12 }, (_, index) => index + 1).map((hour) => (
          <button
            type="button"
            className={`time-key${hour === hour12 ? " is-selected" : ""}`}
            key={hour}
            onClick={() => updateTime(hour, minuteValue, period)}
            disabled={isLater(hour, 0, period)}
            aria-label={`${hour} o'clock`}
            aria-pressed={hour === hour12}
          >
            {hour}
          </button>
        ))}
      </div>
      <div className="keyboard-row" aria-label="Choose minutes">
        {minuteOptions.map((minute) => (
          <button
            type="button"
            className={`time-key${minute === minuteValue ? " is-selected" : ""}`}
            key={minute}
            onClick={() => updateTime(hour12, minute, period)}
            disabled={isLater(hour12, minute, period)}
            aria-label={`${minute} minutes past the hour`}
            aria-pressed={minute === minuteValue}
          >
            :{String(minute).padStart(2, "0")}
          </button>
        ))}
      </div>
      <div className="keyboard-row time-action-row">
        {(["AM", "PM"] as const).map((option) => (
          <button
            type="button"
            className={`keyboard-action period-key${option === period ? " is-selected" : ""}`}
            key={option}
            onClick={() => updateTime(hour12, minuteValue, option)}
            disabled={isLater(hour12, 0, option)}
            aria-pressed={option === period}
          >
            {option}
          </button>
        ))}
        <div className="button-stack keyboard-button-stack">
          <Button variant="secondary" onClick={onBack} disabled={saving}>
            Go back
          </Button>
          <Button onClick={onConfirm} disabled={saving}>
            {saving ? (
              <>
                <span className="spinner" /> Saving…
              </>
            ) : (
              "Check In"
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}

function Welcome({
  volunteers,
  listState,
  onSelect,
}: {
  volunteers: Volunteer[];
  listState: ListState;
  onSelect: (v: Volunteer) => void;
}) {
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const welcomeNotes = [
    "We're happy you're here.",
    "Thanks for being here, neighbor.",
    "Your helping hands matter.",
  ];
  const welcomeNote = welcomeNotes[new Date().getDate() % welcomeNotes.length];
  const normalizedQuery = query.trim().toLowerCase();
  const results = useMemo(() => {
    if (!normalizedQuery) return [];
    return volunteers
      .filter((volunteer) =>
        `${volunteer.firstName} ${volunteer.lastName}`.toLowerCase().includes(normalizedQuery),
      )
      .sort((a, b) => {
        const aName = `${a.firstName} ${a.lastName}`.toLowerCase();
        const bName = `${b.firstName} ${b.lastName}`.toLowerCase();
        const score = (name: string) =>
          name.startsWith(normalizedQuery)
            ? 0
            : name.split(" ").some((part) => part.startsWith(normalizedQuery))
              ? 1
              : 2;
        return (
          score(aName) - score(bName) ||
          `${a.firstName} ${a.lastName}`.localeCompare(`${b.firstName} ${b.lastName}`)
        );
      })
      .slice(0, 3);
  }, [normalizedQuery, volunteers]);

  const cardRef = useRef<HTMLElement>(null);
  // Set once the name box gets focus: room below the card, so the page can scroll the box
  // and its results above the tablet keyboard. Never unset, so a tap on a result can't
  // shift the layout under the finger.
  const [typing, setTyping] = useState(false);

  const updateQuery = (next: string) => {
    setQuery(next);
    window.requestAnimationFrame(() => searchRef.current?.focus({ preventScroll: true }));
  };

  return (
    <main className={`welcome name-entry screen-enter${typing ? " is-typing" : ""}`}>
      <section className="hero name-entry-hero">
        <div className="spark spark-hero">
          <i />
          <i />
          <i />
        </div>
        <p className="welcome-note">{welcomeNote}</p>
        <h1>
          Hey there, <span>neighbor!</span>
        </h1>
        <p>Tap the box below and type your name.</p>
      </section>

      <section className="name-search-card" aria-label="Find your volunteer profile" ref={cardRef}>
        <label className="search-field name-search-field">
          <Icon name="search" size={29} />
          <span className="sr-only">Type your first and last name</span>
          <input
            ref={searchRef}
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onFocus={() => setTyping(true)}
            placeholder="Enter your name"
            maxLength={60}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="words"
            spellCheck={false}
            enterKeyHint="search"
          />
          {query && (
            <button type="button" onClick={() => updateQuery("")} aria-label="Clear name">
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
              <strong>This kiosk can&apos;t reach the volunteer list right now.</strong>
              <span className="board-member-message">Please see a board member.</span>
            </div>
          ) : (
            <>
              {!normalizedQuery && (
                <div className="type-prompt">
                  <Icon name="user" size={27} />
                  <span>Start typing to find your name.</span>
                </div>
              )}
              {results.map((volunteer) => (
                <VolunteerCard
                  key={volunteer.id}
                  volunteer={volunteer}
                  onClick={() => onSelect(volunteer)}
                />
              ))}
              {normalizedQuery &&
                results.length === 0 &&
                (listState === "loading" ? (
                  <div className="no-name">
                    <strong>Loading volunteers…</strong>
                  </div>
                ) : (
                  <div className="no-name">
                    <strong>No matching volunteer found</strong>
                    <span>Double-check the spelling.</span>
                    <span className="board-member-message">
                      If you still don&apos;t see your name, please see a board member for help.
                    </span>
                  </div>
                ))}
            </>
          )}
        </div>
      </section>

      <p className="tagline">Good neighbors change lives.</p>
    </main>
  );
}

function CheckedInDrawer({ volunteers, onSelect }: {
  volunteers: Volunteer[];
  onSelect: (v: Volunteer) => void;
}) {
  const [open, setOpen] = useState(false);
  const checkedIn = volunteers.filter(v => Boolean(v.currentCheckIn && isToday(v.currentCheckIn)));

  return (
    <>
      <button className={`drawer-tab${open ? " is-open" : ""}`} onClick={() => setOpen(!open)}>
        {"Checked in: " + checkedIn.length}
      </button>
      <aside className={`checkin-drawer${open ? " is-open" : ""}`}>
        {checkedIn.map((volunteer) => (
          <VolunteerCard
            key={volunteer.id}
            volunteer={volunteer}
            onClick={() => {
              onSelect(volunteer);
              setOpen(false);
            }}
          />
        ))}
      </aside>
    </>
  )
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
        autoComplete="off"
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
  arrivalTime,
  arrivalPicker = false,
  saving,
  error,
  onArrivalTimeChange,
  onOpenArrivalPicker,
  onPhoneDigitsChange,
  onPhoneContinue,
  onConfirm,
  onBack,
}: {
  volunteer: Volunteer;
  checkout: boolean;
  phoneStep?: PhoneStep;
  phoneDigits?: string;
  arrivalTime?: string;
  arrivalPicker?: boolean;
  saving: boolean;
  error: string;
  onArrivalTimeChange?: (time: string) => void;
  onOpenArrivalPicker?: () => void;
  onPhoneDigitsChange: (digits: string) => void;
  onPhoneContinue: () => void;
  onConfirm: () => void;
  onBack: () => void;
}) {
  const showTimeKeyboard = Boolean(
    !checkout && !phoneStep && arrivalPicker && arrivalTime && onArrivalTimeChange,
  );
  const hasKeyboard = showTimeKeyboard;
  const digitsMissing = Boolean(volunteer.needsPhoneCheck) && phoneDigits.length !== 4;

  return (
    <>
      <main className={`center-screen screen-enter${hasKeyboard ? " has-keyboard" : ""}`}>
        {!hasKeyboard && <BackButton onClick={onBack} />}
        <section className={`panel confirmation-panel${hasKeyboard ? " with-keyboard" : ""}`}>
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
                There&apos;s more than one{" "}
                <strong>
                  {volunteer.firstName} {volunteer.lastName}
                </strong>
                .
                {phoneStep === "entry" &&
                  " Please enter the last four digits of your phone number."}
              </>
            ) : checkout ? (
              <>
                You checked in today at <strong>{formatTime(volunteer.currentCheckIn!)}</strong>.
              </>
            ) : (
              "Just making sure we have the right neighbor."
            )}
          </p>
          {phoneStep === "entry" && (
            <PhoneDigits
              digits={phoneDigits}
              onChange={onPhoneDigitsChange}
              onSubmit={onPhoneContinue}
            />
          )}
          {!phoneStep && checkout && volunteer.currentCheckIn && (
            <ShiftThanks checkedInAt={volunteer.currentCheckIn} />
          )}
          {!checkout && !phoneStep && !showTimeKeyboard && (
            <div className="identity">
              <Icon name="user" /> {volunteer.firstName} {volunteer.lastName}
            </div>
          )}
          {showTimeKeyboard && (
            <div className="checkin-details">
              <div className="identity">
                <Icon name="user" /> {volunteer.firstName} {volunteer.lastName}
              </div>
              <div className="arrival-time">
                <span>
                  <Icon name="clock" size={21} />
                  What time did you arrive?
                </span>
                <output aria-live="polite">{formatTimeValue(arrivalTime!)}</output>
                <small>Tap to adjust your arrival time.</small>
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
                <Button onClick={onConfirm} disabled={saving || digitsMissing}>
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
                {checkout && !phoneStep ? "Keep Volunteering" : "Go back"}
              </Button>
            </div>
          )}
          {!checkout && !phoneStep && !showTimeKeyboard && onOpenArrivalPicker && (
            <button
              type="button"
              className="text-button"
              onClick={onOpenArrivalPicker}
              disabled={saving}
            >
              Forgot to check in earlier? Change your arrival time
            </button>
          )}
        </section>
      </main>
      {showTimeKeyboard && (
        <TimeKeyboard
          value={arrivalTime!}
          saving={saving}
          onChange={onArrivalTimeChange!}
          onConfirm={onConfirm}
          onBack={onBack}
        />
      )}
    </>
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
        Your time today
      </span>
      <strong>{formatDuration(minutes)}</strong>
      <small>Thank you for volunteering with us.</small>
    </div>
  );
}

function Success({
  type,
  volunteer,
  result,
  onDone,
}: {
  type: "in" | "out";
  volunteer: Volunteer;
  result: Result;
  onDone: () => void;
}) {
  return (
    <main className={`success-screen success-${type} screen-enter`}>
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
            ? `${volunteer.firstName}, we're glad you're here!`
            : `You made a difference today, ${volunteer.firstName}!`}
        </h1>
        {type === "in" ? (
          <>
            <p className="success-label">You&apos;re checked in.</p>
            <div className="time-metric">
              <Icon name="clock" size={29} /> {formatTime(result.time)}
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
            <p className="thanks">Thanks for showing up for your East Nashville neighbors.</p>
          </>
        )}
        <Button onClick={onDone}>Done</Button>
      </div>
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
  const [code, setCode] = useState("");
  const codeRef = useRef<HTMLInputElement>(null);
  const save = () => {
    if (!saving && code.trim()) onSave(code.trim());
  };

  return (
    <main className="welcome name-entry screen-enter">
      <section className="hero name-entry-hero">
        <h1>Set up this kiosk</h1>
        <p>Board member: tap the box below, type the kiosk access code, then tap Save.</p>
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
          sessionStorage.setItem("encm-fail-next-save", "true");
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

/** The latest quarter hour at or before now, Central, as HH:MM. */
function latestQuarterHour() {
  const now = minutesOfDay(centralTimeValue());
  const quarter = now - (now % 15);
  return `${String(Math.floor(quarter / 60)).padStart(2, "0")}:${String(quarter % 60).padStart(2, "0")}`;
}

function formatTimeValue(value: string) {
  const [hour, minute] = value.split(":").map(Number);
  return `${hour % 12 || 12}:${String(minute).padStart(2, "0")} ${hour >= 12 ? "PM" : "AM"}`;
}

function centralTimeToIso(time: string) {
  const [hour, minute] = time.split(":").map(Number);
  const dateParts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const datePart = (type: Intl.DateTimeFormatPartTypes) =>
    Number(dateParts.find((item) => item.type === type)?.value);
  const desiredUtc = Date.UTC(
    datePart("year"),
    datePart("month") - 1,
    datePart("day"),
    hour,
    minute,
  );
  const zonedParts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const offsetAt = (timestamp: number) => {
    const parts = zonedParts.formatToParts(new Date(timestamp));
    const value = (type: Intl.DateTimeFormatPartTypes) =>
      Number(parts.find((item) => item.type === type)?.value);
    return (
      Date.UTC(
        value("year"),
        value("month") - 1,
        value("day"),
        value("hour"),
        value("minute"),
        value("second"),
      ) -
      Math.floor(timestamp / 1000) * 1000
    );
  };
  let timestamp = desiredUtc - offsetAt(desiredUtc);
  timestamp = desiredUtc - offsetAt(timestamp);
  return new Date(timestamp).toISOString();
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

export default function App() {
  const [code, setCode] = useState<string | null>(readStoredCode);
  const codeRef = useRef(code);
  const [setupError, setSetupError] = useState("");
  const [volunteers, setVolunteers] = useState<Volunteer[]>([]);
  const [listState, setListState] = useState<ListState>("loading");
  const listRequested = useRef(0);
  const listApplied = useRef(0);
  const [messageIndex, setMessageIndex] = useState(0);
  const [screen, setScreen] = useState<Screen>("welcome");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [arrivalTime, setArrivalTime] = useState(() => centralTimeValue());
  // Check-in sends no time, so the server uses its own clock, unless the volunteer opens
  // the arrival-time picker.
  const [arrivalPicker, setArrivalPicker] = useState(false);
  const [phoneStep, setPhoneStep] = useState<PhoneStep>(null);
  const [phoneDigits, setPhoneDigits] = useState("");
  const inactivityRef = useRef<number | null>(null);
  const selected = volunteers.find((v) => v.id === selectedId) ?? null;

  const goHome = () => {
    setScreen("welcome");
    setSelectedId(null);
    setError("");
    setResult(null);
    setArrivalTime(centralTimeValue());
    setArrivalPicker(false);
    setPhoneStep(null);
    setPhoneDigits("");
  };
  const select = (volunteer: Volunteer) => {
    closeTabletKeyboard();
    setSelectedId(volunteer.id);
    setError("");
    setArrivalTime(centralTimeValue());
    setArrivalPicker(false);
    setPhoneStep(volunteer.needsPhoneCheck ? "entry" : null);
    setPhoneDigits("");
    setScreen(
      volunteer.currentCheckIn && isToday(volunteer.currentCheckIn) ? "checkout" : "confirm",
    );
  };

  const applyCode = (next: string | null) => {
    codeRef.current = next;
    storeCode(next);
    setCode(next);
    setVolunteers([]);
    setListState("loading");
  };
  // The server refused the stored code: back to the setup screen.
  const lockKiosk = (message: string) => {
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
    const failed = () => setListState((state) => (state === "ready" ? state : "failed"));
    api.listVolunteers(requestCode).then(
      (reply) => {
        if (!isCurrent()) return;
        listApplied.current = seq;
        if (isRefusal(reply)) {
          if (reply.refusal === "ACCESS") lockKiosk(reply.message);
          else failed();
          return;
        }
        setVolunteers(reply.map(toVolunteer));
        setListState("ready");
      },
      () => {
        if (isCurrent()) failed();
      },
    );
  }

  useEffect(() => {
    if (!code) return;
    refreshList();
    const timer = window.setInterval(refreshList, LIST_REFRESH_MS);
    return () => clearInterval(timer);
  }, [code]);

  useEffect(() => {
    if (!code || listState !== "failed") return;
    const timer = window.setInterval(refreshList, LIST_RETRY_MS);
    return () => clearInterval(timer);
  }, [code, listState]);

  useEffect(() => {
    if (selectedId && listState === "ready" && !selected) goHome();
  }, [volunteers]);

  useEffect(() => {
    if (screen === "welcome") return;
    const resetTimer = () => {
      if (inactivityRef.current) clearTimeout(inactivityRef.current);
      inactivityRef.current = window.setTimeout(goHome, 90_000);
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
    if (screen !== "success-in" && screen !== "success-out") return;
    const timer = window.setTimeout(goHome, screen === "success-in" ? 5000 : 7000);
    return () => clearTimeout(timer);
  }, [screen]);

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

  function showRefusal(reply: Refusal) {
    if (reply.refusal === "ACCESS") {
      lockKiosk(reply.message);
      return;
    }
    if (reply.refusal === "PHONE_WRONG" || reply.refusal === "PHONE_NEEDED") {
      setPhoneDigits("");
      setPhoneStep("entry");
    } else if (reply.refusal === "PHONE_MISSING") {
      setPhoneDigits("");
      setPhoneStep("missing");
    }
    setError(reply.message);
  }

  // In a same-name group the server picks the member by the digits, so the volunteer it
  // acted on can be another entry than the one tapped. Screens after a success use that one.
  function selectActedOn(id: string) {
    if (volunteers.some((v) => v.id === id)) setSelectedId(id);
  }

  // A same-name volunteer's call always carries exactly four digits.
  const digitsMissing = () => Boolean(selected?.needsPhoneCheck) && phoneDigits.length !== 4;

  async function handleConfirm() {
    if (!selected || saving || !code) return;
    if (digitsMissing()) {
      setPhoneStep("entry");
      return;
    }
    setError("");
    const timestamp = arrivalPicker ? centralTimeToIso(arrivalTime) : null;
    if (timestamp && new Date(timestamp).getTime() > Date.now() + 60_000) {
      setError("Your arrival time cannot be in the future. Please choose an earlier time.");
      return;
    }
    setSaving(true);
    try {
      const reply = await api.checkIn(
        code,
        selected.id,
        timestamp,
        selected.needsPhoneCheck ? phoneDigits : null,
      );
      if (isRefusal(reply)) {
        showRefusal(reply);
        return;
      }
      selectActedOn(reply.id);
      setResult({ time: reply.arrivedAt, message: nextMessage() });
      setScreen("success-in");
    } catch {
      setError(
        "We couldn't save your check-in. Please try again or ask a volunteer coordinator for help.",
      );
    } finally {
      setSaving(false);
      refreshList();
    }
  }

  async function handleCheckout() {
    if (!selected || saving || !code) return;
    if (digitsMissing()) {
      setPhoneStep("entry");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const reply = await api.checkOut(
        code,
        selected.id,
        selected.needsPhoneCheck ? phoneDigits : null,
      );
      if (isRefusal(reply)) {
        showRefusal(reply);
        return;
      }
      selectActedOn(reply.id);
      setResult({
        time: reply.signedOutAt,
        duration: reply.minutes,
        milestone: reply.milestone,
        message: nextMessage(),
      });
      setScreen("success-out");
    } catch {
      setError(
        "We couldn't save your check-out. Please try again or ask a volunteer coordinator for help.",
      );
    } finally {
      setSaving(false);
      refreshList();
    }
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

  return (
    <div className={`app-shell screen-${code ? screen : "welcome"}`}>
      {!code && (
        <>
          <Header />
          <Setup saving={saving} error={setupError} onSave={handleSaveCode} />
        </>
      )}
      {code && screen === "welcome" && (
        <>
          <Header />
          <Welcome volunteers={volunteers} listState={listState} onSelect={select} />
          <CheckedInDrawer volunteers={volunteers} onSelect={select} />
        </>
      )}
      {code && screen === "confirm" && selected && (
        <Confirmation
          volunteer={selected}
          checkout={false}
          arrivalTime={arrivalTime}
          arrivalPicker={arrivalPicker}
          onOpenArrivalPicker={() => {
            setError("");
            setArrivalTime(latestQuarterHour());
            setArrivalPicker(true);
          }}
          {...phoneProps}
          saving={saving}
          error={error}
          onArrivalTimeChange={setArrivalTime}
          onConfirm={handleConfirm}
          onBack={goHome}
        />
      )}
      {code && screen === "checkout" && selected && (
        <Confirmation
          volunteer={selected}
          checkout
          {...phoneProps}
          saving={saving}
          error={error}
          onConfirm={handleCheckout}
          onBack={goHome}
        />
      )}
      {code && screen === "success-in" && selected && result && (
        <Success type="in" volunteer={selected} result={result} onDone={goHome} />
      )}
      {code && screen === "success-out" && selected && result && (
        <Success type="out" volunteer={selected} result={result} onDone={goHome} />
      )}
      {usingLocalApi && (
        <DevTools
          onReset={() => {
            localApi.reset();
            goHome();
            refreshList();
          }}
        />
      )}
    </div>
  );
}
