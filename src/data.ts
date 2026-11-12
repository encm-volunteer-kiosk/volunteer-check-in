export type Volunteer = {
  id: string;
  firstName: string;
  lastName: string;
  phone?: string;
  email?: string;
  active: boolean;
  expectedToday: boolean;
  currentCheckIn: string | null;
  completedShiftCount: number;
  totalVolunteerMinutes: number;
};

export type VolunteerEvent = {
  id: string;
  volunteerId: string;
  eventType: "check_in" | "check_out";
  timestamp: string;
  shiftId: string;
};

export type KioskData = {
  volunteers: Volunteer[];
  events: VolunteerEvent[];
  recognizedMilestones: string[];
  messageIndex: number;
};

export type Milestone = { id: string; title: string; message: string };

const STORAGE_KEY = "encm-volunteer-kiosk-v1";
const TZ = "America/Chicago";

const names = [
  ["Sarah", "Johnson"],
  ["Michael", "Davis"],
  ["Jennifer", "Smith"],
  ["Robert", "Wilson"],
  ["Emily", "Brown"],
  ["Chris", "Thompson"],
  ["Amanda", "Taylor"],
  ["David", "Miller"],
  ["Lisa", "Anderson"],
  ["Jonathan", "Reed"],
  ["Jessica", "Reynolds"],
  ["Jordan", "Rivera"],
  ["Marcus", "Green"],
  ["Patricia", "Moore"],
  ["Angela", "Brooks"],
  ["Kevin", "Parker"],
  ["Monica", "Harris"],
  ["Samuel", "Clark"],
  ["Denise", "Walker"],
  ["Terrence", "Lewis"],
  ["Olivia", "Turner"],
  ["Brian", "Young"],
  ["Nina", "Carter"],
  ["William", "Hall"],
];

const seededStats = [
  [0, 0],
  [4, 870],
  [9, 2820],
  [2, 410],
  [24, 5840],
  [7, 1880],
  [12, 3110],
  [9, 2960],
  [3, 720],
  [1, 190],
  [15, 4920],
  [0, 0],
  [6, 1340],
  [18, 5980],
  [8, 2780],
  [5, 960],
  [11, 2320],
  [25, 6210],
  [4, 780],
  [19, 5740],
  [2, 330],
  [13, 3210],
  [7, 1280],
  [1, 240],
];

function centralDay(iso: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

export function isToday(iso: string) {
  return centralDay(iso) === centralDay(new Date().toISOString());
}

function createSeed(): KioskData {
  const now = Date.now();
  const volunteers = names.map(([firstName, lastName], index) => ({
    id: `vol-${index + 1}`,
    firstName,
    lastName,
    active: true,
    expectedToday: index < 9,
    currentCheckIn: index === 7 ? new Date(now - 82 * 60_000).toISOString() : null,
    completedShiftCount: seededStats[index][0],
    totalVolunteerMinutes: seededStats[index][1],
  }));
  const events: VolunteerEvent[] = [];
  volunteers.forEach((v, i) => {
    const historyCount = v.completedShiftCount;
    const baseMinutes = historyCount ? Math.floor(v.totalVolunteerMinutes / historyCount) : 0;
    let remainingMinutes = historyCount ? v.totalVolunteerMinutes % historyCount : 0;
    for (let h = 0; h < historyCount; h++) {
      const start = new Date(now - (h + 2 + (i % 3)) * 86_400_000);
      start.setHours(14, 0, 0, 0);
      const shiftId = `seed-${v.id}-${h}`;
      const duration = baseMinutes + (remainingMinutes-- > 0 ? 1 : 0);
      events.push(
        {
          id: `${shiftId}-in`,
          volunteerId: v.id,
          eventType: "check_in",
          timestamp: start.toISOString(),
          shiftId,
        },
        {
          id: `${shiftId}-out`,
          volunteerId: v.id,
          eventType: "check_out",
          timestamp: new Date(start.getTime() + duration * 60_000).toISOString(),
          shiftId,
        },
      );
    }
  });
  const active = volunteers[7];
  const activeShift = "active-vol-8";
  events.push({
    id: `${activeShift}-in`,
    volunteerId: active.id,
    eventType: "check_in",
    timestamp: active.currentCheckIn!,
    shiftId: activeShift,
  });
  // An intentionally unfinished old shift: preserved, but never treated as today's active shift.
  const oldIncomplete = new Date(now - 3 * 86_400_000).toISOString();
  events.push({
    id: "incomplete-vol-6",
    volunteerId: "vol-6",
    eventType: "check_in",
    timestamp: oldIncomplete,
    shiftId: "incomplete-old",
  });
  return { volunteers, events, recognizedMilestones: [], messageIndex: 0 };
}

function normalize(data: KioskData): KioskData {
  return {
    ...data,
    volunteers: data.volunteers.map((volunteer) => ({
      ...volunteer,
      currentCheckIn:
        volunteer.currentCheckIn && isToday(volunteer.currentCheckIn)
          ? volunteer.currentCheckIn
          : null,
    })),
  };
}

export const kioskStore = {
  load(): KioskData {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) return normalize(JSON.parse(stored));
      const seed = createSeed();
      localStorage.setItem(STORAGE_KEY, JSON.stringify(seed));
      return seed;
    } catch {
      return createSeed();
    }
  },
  async save(data: KioskData): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 350));
    if (sessionStorage.getItem("encm-fail-next-save") === "true") {
      sessionStorage.removeItem("encm-fail-next-save");
      throw new Error("Simulated save failure");
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  },
  reset() {
    const seed = createSeed();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(seed));
    return seed;
  },
};

export function checkIn(data: KioskData, volunteerId: string, timestamp: string): KioskData {
  const volunteer = data.volunteers.find((v) => v.id === volunteerId);
  if (!volunteer || (volunteer.currentCheckIn && isToday(volunteer.currentCheckIn))) {
    throw new Error("Volunteer is already checked in");
  }
  const shiftId = crypto.randomUUID();
  return {
    ...data,
    volunteers: data.volunteers.map((v) =>
      v.id === volunteerId ? { ...v, currentCheckIn: timestamp } : v,
    ),
    events: [
      ...data.events,
      { id: crypto.randomUUID(), volunteerId, eventType: "check_in", timestamp, shiftId },
    ],
  };
}

export function checkOut(data: KioskData, volunteerId: string, timestamp: string) {
  const volunteer = data.volunteers.find((v) => v.id === volunteerId);
  if (!volunteer?.currentCheckIn || !isToday(volunteer.currentCheckIn))
    throw new Error("No active shift");
  const openEvent = [...data.events]
    .reverse()
    .find(
      (event) =>
        event.volunteerId === volunteerId &&
        event.eventType === "check_in" &&
        event.timestamp === volunteer.currentCheckIn,
    );
  if (
    !openEvent ||
    data.events.some(
      (event) => event.shiftId === openEvent.shiftId && event.eventType === "check_out",
    )
  ) {
    throw new Error("Shift is already complete");
  }
  const duration = Math.max(
    1,
    Math.round(
      (new Date(timestamp).getTime() - new Date(volunteer.currentCheckIn).getTime()) / 60_000,
    ),
  );
  const before = {
    shifts: volunteer.completedShiftCount,
    minutes: volunteer.totalVolunteerMinutes,
  };
  const after = { shifts: before.shifts + 1, minutes: before.minutes + duration };
  const candidates: Milestone[] = [
    {
      id: "shift-1",
      title: "First completed shift",
      message: "Your first day making a difference. Welcome to the neighborhood!",
    },
    {
      id: "shift-10",
      title: "10 shifts",
      message: "10 times showing up for your neighbors. Thank you!",
    },
    {
      id: "shift-25",
      title: "25 shifts",
      message: "25 shifts of showing up for East Nashville. That's something special.",
    },
    { id: "hours-50", title: "50 hours", message: "50 hours of care, kindness, and community." },
    {
      id: "hours-100",
      title: "100 hours",
      message: "100 hours of making East Nashville stronger.",
    },
  ];
  const earned =
    candidates.find((m) => {
      const key = `${volunteerId}:${m.id}`;
      if (data.recognizedMilestones.includes(key)) return false;
      if (m.id.startsWith("shift-")) {
        const threshold = Number(m.id.split("-")[1]);
        return before.shifts < threshold && after.shifts >= threshold;
      }
      const threshold = Number(m.id.split("-")[1]) * 60;
      return before.minutes < threshold && after.minutes >= threshold;
    }) ?? null;
  return {
    data: {
      ...data,
      volunteers: data.volunteers.map((v) =>
        v.id === volunteerId
          ? {
              ...v,
              currentCheckIn: null,
              completedShiftCount: after.shifts,
              totalVolunteerMinutes: after.minutes,
            }
          : v,
      ),
      events: [
        ...data.events,
        {
          id: crypto.randomUUID(),
          volunteerId,
          eventType: "check_out" as const,
          timestamp,
          shiftId: openEvent.shiftId,
        },
      ],
      recognizedMilestones: earned
        ? [...data.recognizedMilestones, `${volunteerId}:${earned.id}`]
        : data.recognizedMilestones,
    },
    duration,
    earned,
  };
}

export const appreciationMessages = [
  "Good neighbors show up. Thanks for being one.",
  "Your time helps make this community stronger.",
  "Every helping hand matters.",
  "East Nashville is better because neighbors care.",
  "Small acts of kindness make a big difference.",
  "Thanks for being part of what makes this neighborhood special.",
  "Neighbors helping neighbors. That's what it's all about.",
];
