// Pure date/time helpers. No I/O. All times treated as wall-clock minutes
// within a single calendar day; cross-midnight duties are out of V1 scope.

export function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) throw new Error(`Bad time: ${hhmm}`);
  return h * 60 + m;
}

export function dutyMinutes(startTime: string, endTime: string): number {
  const s = hhmmToMinutes(startTime);
  const e = hhmmToMinutes(endTime);
  // Negative or zero spans are treated as zero — the UI must validate input.
  return Math.max(0, e - s);
}

export function parseISODate(d: string): Date {
  // Anchor at UTC noon to dodge DST/local-tz drift in day-diff math.
  const [y, m, day] = d.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, day, 12, 0, 0));
}

export function diffDays(a: string, b: string): number {
  const ms = parseISODate(a).getTime() - parseISODate(b).getTime();
  return Math.round(ms / (1000 * 60 * 60 * 24));
}

export function isWithinTrailingWindow(
  dutyDate: string,
  evaluationDate: string,
  windowDays: number
): boolean {
  const delta = diffDays(evaluationDate, dutyDate);
  // Inclusive of evaluationDate, exclusive of windowDays-ago boundary.
  return delta >= 0 && delta < windowDays;
}

// ── FDP / rest helpers (cross-midnight aware) ────────────────────────────────

// Absolute wall-clock minute for a (date, HH:MM). Local times are treated as a
// single uniform clock (no tz) so subtraction across midnight just works.
export function instantMinutes(date: string, hhmm: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return Math.floor(Date.UTC(y, m - 1, d, 0, 0, 0) / 60000) + hhmmToMinutes(hhmm);
}

// Clock-of-day minutes (0..1439) for an absolute instant.
export function clockOfDay(instant: number): number {
  return ((instant % 1440) + 1440) % 1440;
}

// WOCL = Window of Circadian Low, 02:00–05:59 local (EASA). Returns the minutes
// of [startInstant, endInstant) that fall inside WOCL on any day it spans.
export const WOCL_START = 2 * 60;   // 02:00
export const WOCL_END = 6 * 60;     // 06:00 (exclusive)
export function woclOverlapMinutes(startInstant: number, endInstant: number): number {
  if (endInstant <= startInstant) return 0;
  let overlap = 0;
  const firstDay = Math.floor(startInstant / 1440);
  const lastDay = Math.floor((endInstant - 1) / 1440);
  for (let day = firstDay; day <= lastDay; day++) {
    const wStart = day * 1440 + WOCL_START;
    const wEnd = day * 1440 + WOCL_END;
    overlap += Math.max(0, Math.min(endInstant, wEnd) - Math.max(startInstant, wStart));
  }
  return overlap;
}

// EASA ORO.FTL.205 Table 2 (acclimatised) — max FDP for 1–2 sectors by start-of-
// FDP local time, minus 30 min per sector beyond 2 (floor 9h). The night/WOCL
// bands (1700–0459) carry the reduced 11h cap; 0500–0559 ramps back up.
const FDP_BANDS: Array<{ from: number; to: number; max: number }> = [
  { from: 360, to: 809, max: 780 },  // 06:00–13:29 → 13:00
  { from: 810, to: 829, max: 765 },  // 13:30–13:59 → 12:45
  { from: 830, to: 859, max: 750 },  // 14:00–14:29 → 12:30
  { from: 860, to: 889, max: 735 },  // 14:30–14:59 → 12:15
  { from: 890, to: 919, max: 720 },  // 15:00–15:29 → 12:00
  { from: 920, to: 949, max: 705 },  // 15:30–15:59 → 11:45
  { from: 950, to: 979, max: 690 },  // 16:00–16:29 → 11:30
  { from: 980, to: 1009, max: 675 }, // 16:30–16:59 → 11:15
  { from: 300, to: 314, max: 720 },  // 05:00–05:14 → 12:00 (post-WOCL ramp)
  { from: 315, to: 329, max: 735 },  // 05:15–05:29 → 12:15
  { from: 330, to: 344, max: 750 },  // 05:30–05:44 → 12:30
  { from: 345, to: 359, max: 765 },  // 05:45–05:59 → 12:45
];
// Everything else (17:00–04:59, incl. the 02:00–04:59 WOCL core) → 11:00.
const FDP_NIGHT_MAX = 660;

export function maxFdpEasa(reportClockMin: number, sectors: number): number {
  const c = ((reportClockMin % 1440) + 1440) % 1440;
  let base = FDP_NIGHT_MAX;
  for (const b of FDP_BANDS) {
    if (c >= b.from && c <= b.to) { base = b.max; break; }
  }
  const extraSectors = Math.max(0, sectors - 2);
  return Math.max(540, base - 30 * extraSectors); // floor 9:00
}
