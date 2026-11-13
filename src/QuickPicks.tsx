import { useEffect, useRef, useState } from "react";
import {
  agoText,
  canNudge,
  centralMinutes,
  clockText,
  fromTimeValue,
  nudge,
  pickMinutes,
  quickAnswers,
  quickRange,
  toTimeValue,
} from "./quickPicks";
import "./quickPicks.css";

// A held nudge button steps once at once, then repeats after a pause.
const HOLD_DELAY_MS = 450;
const HOLD_REPEAT_MS = 170;
// Redraw now and then, so "Now" and the hidden answers follow the clock while the picker
// stays open.
const CLOCK_TICK_MS = 15_000;

/**
 * The time picker behind the change-time link: quick answers ("Now", "15 min ago", ...) and
 * 15-minute nudges, docked at the bottom of the screen. Every value it sends through
 * onChange is a quarter hour from minMinutes (rounded up) to now (rounded down), Central,
 * as "HH:mm"; see src/quickPicks.ts.
 */
export function QuickPicks({
  value,
  minMinutes = 0,
  label,
  confirmText,
  saving,
  onChange,
  onConfirm,
  onBack,
}: {
  value: string;
  // The earliest time that can be chosen, in Central minutes since midnight (fractions
  // allowed): 0 for arrival, the stated arrival for check-out.
  minMinutes?: number;
  label: string;
  confirmText: string;
  saving: boolean;
  onChange: (time: string) => void;
  onConfirm: () => void;
  onBack: () => void;
}) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setTick((tick) => tick + 1), CLOCK_TICK_MS);
    return () => window.clearInterval(timer);
  }, []);

  const range = quickRange(minMinutes, centralMinutes());
  const minutes = fromTimeValue(value);
  const answers = quickAnswers(range);

  // A held nudge repeats faster than the parent re-renders, so each step counts from the
  // last value sent, not from the value prop of the render that started the hold.
  const valueRef = useRef(minutes);
  valueRef.current = minutes;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const minRef = useRef(minMinutes);
  minRef.current = minMinutes;

  // The range is read from the clock at the moment of each tap.
  const send = (next: number) => {
    valueRef.current = next;
    onChangeRef.current(toTimeValue(next));
  };
  const pick = (shown: number, ago: number) => {
    const next = pickMinutes(shown, ago, quickRange(minRef.current, centralMinutes()));
    if (next !== null) send(next);
  };
  const step = (delta: number) => {
    const next = nudge(valueRef.current, delta, quickRange(minRef.current, centralMinutes()));
    if (next === null) return false;
    send(next);
    return true;
  };

  return (
    <div className="quick-picks" role="group" aria-label={label}>
      <div className="quick-picks-answers" role="group" aria-label="Quick picks">
        {answers.map((answer) => {
          const chosen = answer.minutes === minutes;
          return (
            <button
              type="button"
              key={answer.label}
              className={`quick-pick${chosen ? " is-selected" : ""}`}
              aria-pressed={chosen}
              disabled={saving}
              onClick={() => pick(answer.minutes, range.latest - answer.minutes)}
            >
              <strong>{answer.label}</strong>
              <small>{clockText(answer.minutes)}</small>
            </button>
          );
        })}
      </div>
      <div className="quick-picks-row">
        <div className="quick-picks-nudges">
          <NudgeButton
            label="15 minutes earlier"
            text="−15"
            disabled={saving || !canNudge(minutes, -15, range)}
            onStep={() => step(-15)}
          />
          <div className="quick-picks-readout">
            <output aria-live="polite">{clockText(minutes)}</output>
            <span>{agoText(minutes, range)}</span>
          </div>
          <NudgeButton
            label="15 minutes later"
            text="+15"
            disabled={saving || !canNudge(minutes, 15, range)}
            onStep={() => step(15)}
          />
        </div>
        <div className="quick-picks-actions">
          <button type="button" className="button secondary" onClick={onBack} disabled={saving}>
            Go back
          </button>
          <button type="button" className="button primary" onClick={onConfirm} disabled={saving}>
            {saving ? (
              <>
                <span className="spinner" /> Saving…
              </>
            ) : (
              confirmText
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Steps once on press and repeats while held. It stops on pointerup, pointerleave and
 * pointercancel, and when a step reaches the end of the range: a button that turns disabled
 * under the finger gets no pointerup in every browser. A keyboard press (a click with no
 * pointer) steps once.
 */
function NudgeButton({
  label,
  text,
  disabled,
  onStep,
}: {
  label: string;
  text: string;
  disabled: boolean;
  onStep: () => boolean;
}) {
  const delay = useRef(0);
  const repeat = useRef(0);
  const onStepRef = useRef(onStep);
  onStepRef.current = onStep;

  const stop = () => {
    window.clearTimeout(delay.current);
    window.clearInterval(repeat.current);
    delay.current = 0;
    repeat.current = 0;
  };
  // Also stop on a pointerup anywhere, and when the button goes away mid-hold.
  useEffect(() => {
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      stop();
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, []);
  useEffect(() => {
    if (disabled) stop();
  }, [disabled]);

  return (
    <button
      type="button"
      className="quick-picks-nudge"
      aria-label={label}
      disabled={disabled}
      onPointerDown={(event) => {
        if (event.button > 0 || disabled) return;
        stop();
        if (!onStepRef.current()) return;
        delay.current = window.setTimeout(() => {
          repeat.current = window.setInterval(() => {
            if (!onStepRef.current()) stop();
          }, HOLD_REPEAT_MS);
        }, HOLD_DELAY_MS);
      }}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      onClick={(event) => {
        if (event.detail === 0) onStepRef.current();
      }}
      onContextMenu={(event) => event.preventDefault()}
    >
      <strong>{text}</strong>
      <small>min</small>
    </button>
  );
}
