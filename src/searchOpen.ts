// When the Checked In panel slides aside on the landscape welcome screen (index.css,
// `search-open`). It goes out only on the volunteer's own action in the name box, after the
// tap has committed: a click on the box, or a change to its text. Never on focus alone: the
// box is autofocused at rest and refocused by Clear, and a tap on a box that already has
// focus fires no focus event. Never at touch-down either: iPad Safari checks the tap's target
// again when the finger lifts, and a box that moved by then loses the tap. The panel comes
// back whenever the box loses focus, and is in place whenever the welcome screen opens.

export type SearchOpenEvent = "click" | "typed" | "focus" | "clear" | "blur" | "unmount";

/** Whether the panel is aside after `event`, given whether it was aside before. */
export function searchOpenAfter(open: boolean, event: SearchOpenEvent): boolean {
  switch (event) {
    case "click":
    case "typed":
      return true;
    case "blur":
    case "unmount":
      return false;
    case "focus":
    case "clear":
      return open;
  }
}
