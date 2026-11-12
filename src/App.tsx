import { useEffect, useMemo, useRef, useState } from "react";
import {
  appreciationMessages,
  checkIn,
  checkOut,
  isToday,
  kioskStore,
  type KioskData,
  type Milestone,
  type Volunteer,
} from "./data";

type Screen = "welcome" | "confirm" | "checkout" | "success-in" | "success-out";
type Result = { time: string; duration?: number; milestone?: Milestone | null; message: string };
const TZ = "America/Chicago";

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
      <img className="logo" src="/encm-logo.png" alt="East Nashville Care Market" />
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

const keyboardRows = ["QWERTYUIOP", "ASDFGHJKL", "ZXCVBNM"];

function OnScreenKeyboard({
  hasText,
  onKey,
  onBackspace,
  onClear,
}: {
  hasText: boolean;
  onKey: (key: string) => void;
  onBackspace: () => void;
  onClear: () => void;
}) {
  return (
    <div className="app-keyboard" aria-label="On-screen keyboard">
      {keyboardRows.map((row, rowIndex) => (
        <div className="keyboard-row" key={row}>
          {rowIndex === 2 && (
            <button
              type="button"
              className="keyboard-action clear-key"
              onClick={onClear}
              disabled={!hasText}
            >
              Clear
            </button>
          )}
          {[...row].map((letter) => (
            <button
              type="button"
              className="letter-key"
              key={letter}
              onClick={() => onKey(letter)}
              aria-label={`Type ${letter}`}
            >
              {letter}
            </button>
          ))}
          {rowIndex === 2 && (
            <>
              <button
                type="button"
                className="keyboard-action space-key"
                onClick={() => onKey(" ")}
                disabled={!hasText}
              >
                Space
              </button>
              <button
                type="button"
                className="keyboard-action delete-key"
                onClick={onBackspace}
                disabled={!hasText}
                aria-label="Backspace"
              >
                Delete
              </button>
            </>
          )}
        </div>
      ))}
    </div>
  );
}

const minuteOptions = Array.from({ length: 12 }, (_, index) => index * 5);

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

  const updateTime = (hour: number, minute: number, nextPeriod: "AM" | "PM") => {
    const hour24 = (hour % 12) + (nextPeriod === "PM" ? 12 : 0);
    onChange(`${String(hour24).padStart(2, "0")}:${String(minute).padStart(2, "0")}`);
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
  onSelect,
}: {
  volunteers: Volunteer[];
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

  const updateQuery = (next: string | ((current: string) => string)) => {
    setQuery(next);
    window.requestAnimationFrame(() => searchRef.current?.focus());
  };

  return (
    <>
      <main className="welcome name-entry screen-enter">
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
          <p>Use the keyboard below, then tap your name.</p>
        </section>

        <section className="name-search-card" aria-label="Find your volunteer profile">
          <label className="search-field name-search-field">
            <Icon name="search" size={29} />
            <span className="sr-only">Type your first and last name</span>
            <input
              ref={searchRef}
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Enter your name"
              autoComplete="off"
              inputMode="none"
              spellCheck={false}
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
            {!normalizedQuery && (
              <div className="type-prompt">
                <Icon name="user" size={27} />
                <span>Tap the large letters below to find your name.</span>
              </div>
            )}
            {results.map((volunteer) => (
              <VolunteerCard
                key={volunteer.id}
                volunteer={volunteer}
                onClick={() => onSelect(volunteer)}
              />
            ))}
            {normalizedQuery && results.length === 0 && (
              <div className="no-name">
                <strong>No matching volunteer found</strong>
                <span>Double-check the spelling.</span>
                <span className="board-member-message">
                  If you still don&apos;t see your name, please see a board member for help.
                </span>
              </div>
            )}
          </div>
        </section>

        <p className="tagline">Good neighbors change lives.</p>
      </main>
      <OnScreenKeyboard
        hasText={Boolean(query)}
        onKey={(key) =>
          updateQuery((current) => {
            if (key === " " && (!current || current.endsWith(" "))) return current;
            return `${current}${key}`.slice(0, 60);
          })
        }
        onBackspace={() => updateQuery((current) => current.slice(0, -1))}
        onClear={() => updateQuery("")}
      />
    </>
  );
}

function Confirmation({
  volunteer,
  checkout,
  duplicateName,
  arrivalTime,
  saving,
  error,
  onArrivalTimeChange,
  onConfirm,
  onBack,
}: {
  volunteer: Volunteer;
  checkout: boolean;
  duplicateName?: boolean;
  arrivalTime?: string;
  saving: boolean;
  error: string;
  onArrivalTimeChange?: (time: string) => void;
  onConfirm: () => void;
  onBack: () => void;
}) {
  const showTimeKeyboard = Boolean(
    !checkout && !duplicateName && arrivalTime && onArrivalTimeChange,
  );

  return (
    <>
      <main className={`center-screen screen-enter${showTimeKeyboard ? " has-keyboard" : ""}`}>
        {!showTimeKeyboard && <BackButton onClick={onBack} />}
        <section className={`panel confirmation-panel${showTimeKeyboard ? " with-keyboard" : ""}`}>
          <div className="spark">
            <i />
            <i />
            <i />
          </div>
          <div className="eyebrow">
            {duplicateName
              ? "A little help needed"
              : checkout
                ? "Ready to wrap up?"
                : "Welcome, neighbor"}
          </div>
          <h1>
            {duplicateName
              ? "Let's get a coordinator"
              : checkout
                ? `Heading out, ${volunteer.firstName}?`
                : `Hi, ${volunteer.firstName}!`}
          </h1>
          <p>
            {duplicateName ? (
              <>
                We found more than one volunteer named{" "}
                <strong>
                  {volunteer.firstName} {volunteer.lastName}
                </strong>
                . A volunteer coordinator can help choose the right record.
              </>
            ) : checkout ? (
              <>
                You checked in today at <strong>{formatTime(volunteer.currentCheckIn!)}</strong>.
              </>
            ) : (
              "Just making sure we have the right neighbor."
            )}
          </p>
          {checkout && volunteer.currentCheckIn && (
            <ShiftThanks checkedInAt={volunteer.currentCheckIn} />
          )}
          {!checkout && !duplicateName && (
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
                <small>Use the keyboard below to adjust your arrival time.</small>
              </div>
            </div>
          )}
          {error && <ErrorNotice text={error} />}
          {!showTimeKeyboard && (
            <div className="button-stack">
              {!duplicateName && (
                <Button onClick={onConfirm} disabled={saving}>
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
                {duplicateName ? "Go back" : checkout ? "Keep Volunteering" : "Go back"}
              </Button>
            </div>
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

export default function App() {
  const [data, setData] = useState<KioskData>(() => kioskStore.load());
  const [screen, setScreen] = useState<Screen>("welcome");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [arrivalTime, setArrivalTime] = useState(() => centralTimeValue());
  const inactivityRef = useRef<number | null>(null);
  const selected = data.volunteers.find((v) => v.id === selectedId) ?? null;

  const goHome = () => {
    setScreen("welcome");
    setSelectedId(null);
    setError("");
    setResult(null);
    setArrivalTime(centralTimeValue());
  };
  const select = (volunteer: Volunteer) => {
    setSelectedId(volunteer.id);
    setError("");
    setArrivalTime(centralTimeValue());
    setScreen(
      volunteer.currentCheckIn && isToday(volunteer.currentCheckIn) ? "checkout" : "confirm",
    );
  };

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

  async function handleConfirm() {
    if (!selected || saving) return;
    setError("");
    const timestamp = centralTimeToIso(arrivalTime);
    if (new Date(timestamp).getTime() > Date.now() + 60_000) {
      setError("Your arrival time cannot be in the future. Please choose an earlier time.");
      return;
    }
    setSaving(true);
    try {
      const next = checkIn(data, selected.id, timestamp);
      const message = appreciationMessages[data.messageIndex % appreciationMessages.length];
      next.messageIndex = data.messageIndex + 1;
      await kioskStore.save(next);
      setData(next);
      setResult({ time: timestamp, message });
      setScreen("success-in");
    } catch {
      setError(
        "We couldn't save your check-in. Please try again or ask a volunteer coordinator for help.",
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleCheckout() {
    if (!selected || saving) return;
    setSaving(true);
    setError("");
    try {
      const timestamp = new Date().toISOString();
      const completed = checkOut(data, selected.id, timestamp);
      const message = appreciationMessages[data.messageIndex % appreciationMessages.length];
      completed.data.messageIndex = data.messageIndex + 1;
      await kioskStore.save(completed.data);
      setData(completed.data);
      setResult({
        time: timestamp,
        duration: completed.duration,
        milestone: completed.earned,
        message,
      });
      setScreen("success-out");
    } catch {
      setError(
        "We couldn't save your check-out. Please try again or ask a volunteer coordinator for help.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={`app-shell screen-${screen}`}>
      {screen === "welcome" && (
        <>
          <Header />
          <Welcome
            volunteers={data.volunteers.filter((volunteer) => volunteer.active)}
            onSelect={select}
          />
        </>
      )}
      {screen === "confirm" && selected && (
        <Confirmation
          volunteer={selected}
          checkout={false}
          arrivalTime={arrivalTime}
          duplicateName={
            data.volunteers.filter(
              (v) =>
                v.active &&
                v.firstName.toLowerCase() === selected.firstName.toLowerCase() &&
                v.lastName.toLowerCase() === selected.lastName.toLowerCase(),
            ).length > 1
          }
          saving={saving}
          error={error}
          onArrivalTimeChange={setArrivalTime}
          onConfirm={handleConfirm}
          onBack={goHome}
        />
      )}
      {screen === "checkout" && selected && (
        <Confirmation
          volunteer={selected}
          checkout
          saving={saving}
          error={error}
          onConfirm={handleCheckout}
          onBack={goHome}
        />
      )}
      {screen === "success-in" && selected && result && (
        <Success type="in" volunteer={selected} result={result} onDone={goHome} />
      )}
      {screen === "success-out" && selected && result && (
        <Success type="out" volunteer={selected} result={result} onDone={goHome} />
      )}
      <DevTools
        onReset={() => {
          setData(kioskStore.reset());
          goHome();
        }}
      />
    </div>
  );
}
