import type { AvailabilityWindow, WeekdayKey, WorkSchedule } from "./types";

export type BusyRange = {
  startsAt: string;
  endsAt: string;
  source: "booking" | "google";
  title?: string;
};

const WEEKDAY_KEYS: WeekdayKey[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export function buildAvailability(
  schedule: WorkSchedule,
  fromIso: string,
  toIso: string,
  durationMinutes: number,
  busyRanges: BusyRange[]
): AvailabilityWindow[] {
  const result: AvailabilityWindow[] = [];
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  const stepMs = Math.max(5, schedule.slotStepMinutes || 30) * 60 * 1000;
  const durationMs = durationMinutes * 60 * 1000;
  const busy = busyRanges.map((item) => ({ start: Date.parse(item.startsAt), end: Date.parse(item.endsAt) }));

  for (const dateKey of localDateKeys(fromIso, toIso)) {
    const override = schedule.dateOverrides?.[dateKey];
    const windows = override?.closed ? [] : override?.windows ?? schedule.weeklyTemplate[weekdayKey(dateKey)] ?? [];
    for (const window of windows) {
      const windowStart = zonedDate(dateKey, window.start, schedule.timezone).getTime();
      const windowEnd = zonedDate(dateKey, window.end, schedule.timezone).getTime();
      for (let cursor = Math.max(windowStart, roundUpToStep(from, stepMs)); cursor + durationMs <= Math.min(windowEnd, to); cursor += stepMs) {
        const end = cursor + durationMs;
        if (busy.some((range) => cursor < range.end && end > range.start)) continue;
        const startsAt = new Date(cursor).toISOString();
        const endsAt = new Date(end).toISOString();
        result.push({
          id: availabilityId(startsAt, durationMinutes),
          startsAt,
          endsAt,
          durationMinutes,
          source: "work_schedule"
        });
      }
    }
  }
  return result.sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
}

function localDateKeys(fromIso: string, toIso: string): string[] {
  const keys: string[] = [];
  let cursor = zonedMidnight(dateKeyInMoscow(new Date(fromIso))).getTime();
  const end = zonedMidnight(dateKeyInMoscow(new Date(toIso))).getTime();
  for (; cursor <= end; cursor += 24 * 60 * 60 * 1000) {
    keys.push(dateKeyInMoscow(new Date(cursor)));
  }
  return [...new Set(keys)];
}

function weekdayKey(dateKey: string): WeekdayKey {
  const day = zonedMidnight(dateKey).getDay();
  return WEEKDAY_KEYS[day];
}

function zonedDate(dateKey: string, hhmm: string, timezone: string): Date {
  const offset = timezone === "Europe/Moscow" ? "+03:00" : "+03:00";
  return new Date(`${dateKey}T${hhmm}:00${offset}`);
}

function zonedMidnight(dateKey: string): Date {
  return new Date(`${dateKey}T00:00:00+03:00`);
}

function dateKeyInMoscow(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function roundUpToStep(timestamp: number, stepMs: number): number {
  return Math.ceil(timestamp / stepMs) * stepMs;
}

function availabilityId(startsAt: string, durationMinutes: number): string {
  return `avail_${startsAt.replace(/[-:.]/g, "")}_${durationMinutes}`;
}
