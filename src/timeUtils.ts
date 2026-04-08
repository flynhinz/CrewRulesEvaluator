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
