// Integration guard against the REAL rules.ir payloads on live demo-prod
// (yzkhjutcjxenodaxvdhg), captured read-only 2026-06-18. These are the exact
// jsonb values of the 8 approved/published archetypes — the messy real shapes
// (two IR schemas + 5 empty), not happy-path fixtures (Law 35). Proves the
// widened engine evaluates what it can and marks the rest 'unknown' — never a
// silent OK.

import { describe, it, expect } from "vitest";
import { normalizeIr, evaluateRuleset, CrewScenario, Duty, RawRule } from "../src";

// Verbatim from `SELECT DISTINCT ON (type) type, reference_code, ir FROM rules
// WHERE status IN ('approved','published')`.
const PROD_RULES: RawRule[] = [
  { ruleId: "p1", referenceCode: "ORO.FTL.235", type: "cumulative-duty",
    ir: { kind: "CUMULATIVE_FLIGHT_TIME", windows: [{ windowDays: 28, allowedMinutes: 6000 }], severity: "HARD", softPenalty: 0, referenceCode: "ORO.FTL.235" } },
  { ruleId: "p2", referenceCode: "CAR-121.811", type: "cumulative-flight-time",
    ir: { id: "CAR-121.811", scope: "CREW_MEMBER", severity: "HARD", constraints: [
      { metric: "crew.flightTimeMinutes", window: { days: 28, type: "rolling" }, operator: "<=", threshold_minutes: 6000 },
      { metric: "crew.flightTimeMinutes", window: { days: 365, type: "rolling" }, operator: "<=", threshold_minutes: 54000 } ] } },
  { ruleId: "p3", referenceCode: "ORO.FTL.210(c)", type: "extension-commander",
    ir: { kind: "CUMULATIVE_FLIGHT_TIME", windows: [{ windowDays: 28, allowedMinutes: 5700 }], severity: "SOFT", softPenalty: 10, referenceCode: "ORO.FTL.210(c)" } },
  { ruleId: "p4", referenceCode: "CAR-121.807", type: "flight_time_limitation", ir: {} },
  { ruleId: "p5", referenceCode: "CAR-OPS-1.1095", type: "flight-duty-period", ir: {} },
  { ruleId: "p6", referenceCode: "FAR-117.21", type: "reserve-rest", ir: {} },
  { ruleId: "p7", referenceCode: "CAR-121.809", type: "rest-requirement", ir: {} },
  { ruleId: "p8", referenceCode: "CASR-48.060", type: "weekly-rest", ir: {} },
];

const evalDate = "2026-04-08";
function addDays(base: string, n: number): string {
  const d = new Date(base + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function flightDuties(count: number, hours: number): Duty[] {
  const endMin = 8 * 60 + Math.round(hours * 60);
  const end = `${String(Math.floor(endMin / 60)).padStart(2, "0")}:${String(endMin % 60).padStart(2, "0")}`;
  return Array.from({ length: count }, (_, i) => ({ date: addDays(evalDate, -i), startTime: "08:00", endTime: end, dutyType: "FLIGHT" as const }));
}

describe("live prod IR — widened engine classification", () => {
  it("normalises 3 interpretable + 5 unknown of the 8 archetypes", () => {
    const kinds = PROD_RULES.map((r) => ({ ref: r.referenceCode, kind: normalizeIr(r).kind }));
    const cft = kinds.filter((k) => k.kind === "CUMULATIVE_FLIGHT_TIME").map((k) => k.ref).sort();
    const unknown = kinds.filter((k) => k.kind === "UNKNOWN").map((k) => k.ref).sort();
    expect(cft).toEqual(["CAR-121.811", "ORO.FTL.210(c)", "ORO.FTL.235"]);
    expect(unknown).toEqual(["CAR-121.807", "CAR-OPS-1.1095", "CASR-48.060", "CAR-121.809", "FAR-117.21"].sort());
  });

  it("evaluateRuleset over real IRs: breaches + amber + 5 unknowns, no silent OK", () => {
    const rules = PROD_RULES.map(normalizeIr);
    const scenario: CrewScenario = { crewId: "SCX0002", duties: flightDuties(28, 5), evaluationDate: evalDate }; // 8400 min/28d
    const r = evaluateRuleset({ rulesetId: "prod-published", rules, scenario });

    // 8400 > 6000 (HARD ORO.FTL.235 & CAR-121.811) → breach; > 5700 (SOFT) → amber.
    expect(r.legal).toBe(false);
    expect(r.unknownCount).toBe(5);
    expect(r.hasUnknown).toBe(true);
    const tally = r.perRule.reduce<Record<string, number>>((a, p) => {
      a[p.result.status] = (a[p.result.status] ?? 0) + 1; return a;
    }, {});
    expect(tally.breach).toBeGreaterThanOrEqual(1);
    expect(tally.amber).toBe(1);
    expect(tally.unknown).toBe(5);
    // The 5 empty-IR rules carry an explicit reason — never an empty pass.
    for (const p of r.perRule) {
      if (p.result.status === "unknown") expect(p.result.provenance.reason).toMatch(/no IR/);
    }
  });
});
