import { describe, it, expect } from "vitest";
import { normalizeIr, evaluateRuleset, CrewScenario, Duty, RuleIR } from "../src";

const evalDate = "2026-04-08";

function addDays(base: string, n: number): string {
  const d = new Date(base + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
// `count` FLIGHT duties of `hours` each, ending at evalDate.
function flightDuties(count: number, hours: number): Duty[] {
  const startMin = 8 * 60;
  const endMin = startMin + Math.round(hours * 60);
  const hh = String(Math.floor(endMin / 60)).padStart(2, "0");
  const mm = String(endMin % 60).padStart(2, "0");
  const out: Duty[] = [];
  for (let i = 0; i < count; i++) {
    out.push({ date: addDays(evalDate, -i), startTime: "08:00", endTime: `${hh}:${mm}`, dutyType: "FLIGHT" });
  }
  return out;
}
function run(rules: RuleIR[], duties: Duty[]) {
  const scenario: CrewScenario = { crewId: "C1", duties, evaluationDate: evalDate };
  return evaluateRuleset({ rulesetId: "test", rules, scenario });
}

describe("normalizeIr — heterogeneous live IR shapes", () => {
  it("(a) windows shape → CUMULATIVE_FLIGHT_TIME", () => {
    const ir = normalizeIr({
      ruleId: "r1", referenceCode: "ORO.FTL.235", type: "cumulative-duty",
      ir: { kind: "CUMULATIVE_FLIGHT_TIME", windows: [{ windowDays: 28, allowedMinutes: 6000 }], severity: "HARD", softPenalty: 0 },
    });
    expect(ir.kind).toBe("CUMULATIVE_FLIGHT_TIME");
    expect(ir.windows).toEqual([{ windowDays: 28, allowedMinutes: 6000 }]);
  });

  it("(b) constraints shape (CAR-121.811 prod) → mapped to windows", () => {
    const ir = normalizeIr({
      ruleId: "r2", referenceCode: "CAR-121.811", type: "cumulative-flight-time", severity: "HARD",
      ir: { id: "CAR-121.811", scope: "CREW_MEMBER", severity: "HARD", constraints: [
        { metric: "crew.flightTimeMinutes", window: { days: 28, type: "rolling" }, operator: "<=", threshold_minutes: 6000 },
        { metric: "crew.flightTimeMinutes", window: { days: 365, type: "rolling" }, operator: "<=", threshold_minutes: 54000 },
      ] },
    });
    expect(ir.kind).toBe("CUMULATIVE_FLIGHT_TIME");
    expect(ir.windows).toEqual([
      { windowDays: 28, allowedMinutes: 6000 },
      { windowDays: 365, allowedMinutes: 54000 },
    ]);
  });

  it("empty IR {} → UNKNOWN with reason (5/8 archetypes)", () => {
    const ir = normalizeIr({ ruleId: "r3", referenceCode: "CAR-OPS-1.1095", type: "flight-duty-period", ir: {} });
    expect(ir.kind).toBe("UNKNOWN");
    expect(ir.unknownReason).toMatch(/no IR/);
  });

  it("constraints with an uninterpreted metric → UNKNOWN", () => {
    const ir = normalizeIr({
      ruleId: "r4", referenceCode: "X", type: "duty-limit",
      ir: { constraints: [{ metric: "crew.dutyMinutes", window: { days: 7 }, operator: "<=", threshold_minutes: 3000 }] },
    });
    expect(ir.kind).toBe("UNKNOWN");
    expect(ir.unknownReason).toMatch(/crew\.dutyMinutes/);
  });
});

describe("evaluateRuleset — status across ok / amber / breach / unknown", () => {
  const hard6000 = normalizeIr({ ruleId: "h", referenceCode: "CAR-121.811", type: "cumulative-flight-time",
    ir: { kind: "CUMULATIVE_FLIGHT_TIME", windows: [{ windowDays: 28, allowedMinutes: 6000 }], severity: "HARD", softPenalty: 0 } });
  const soft5700 = normalizeIr({ ruleId: "s", referenceCode: "ORO.FTL.210(c)", type: "extension-commander",
    ir: { kind: "CUMULATIVE_FLIGHT_TIME", windows: [{ windowDays: 28, allowedMinutes: 5700 }], severity: "SOFT", softPenalty: 10 } });
  const unknownRule = normalizeIr({ ruleId: "u", referenceCode: "CAR-OPS-1.1095", type: "flight-duty-period", ir: {} });

  it("ok: under limit", () => {
    const r = run([hard6000], flightDuties(28, 3)); // 5040 < 6000
    expect(r.perRule[0].result.status).toBe("ok");
    expect(r.legal).toBe(true);
    expect(r.hasUnknown).toBe(false);
  });

  it("breach: HARD over limit", () => {
    const r = run([hard6000], flightDuties(28, 5)); // 8400 > 6000
    expect(r.perRule[0].result.status).toBe("breach");
    expect(r.legal).toBe(false);
  });

  it("amber: SOFT over limit (legal stays true)", () => {
    const r = run([soft5700], flightDuties(28, 3.5)); // 5880 > 5700, soft
    expect(r.perRule[0].result.status).toBe("amber");
    expect(r.legal).toBe(true);
    expect(r.totalSoftPenalty).toBe(10);
  });

  it("unknown: un-evaluable rule is NOT a silent pass (Law 35)", () => {
    const r = run([unknownRule], flightDuties(28, 3));
    expect(r.perRule[0].result.status).toBe("unknown");
    expect(r.perRule[0].result.provenance.reason).toMatch(/no IR/);
    // legal has no hard breach, but the gap MUST be visible:
    expect(r.hasUnknown).toBe(true);
    expect(r.unknownCount).toBe(1);
  });

  it("mixed set surfaces every status and the unknown gap together", () => {
    const r = run([hard6000, soft5700, unknownRule], flightDuties(28, 3.5)); // 5880
    const statuses = r.perRule.map((p) => p.result.status).sort();
    expect(statuses).toEqual(["amber", "ok", "unknown"]); // hard6000 ok@5880, soft5700 amber, unknown
    expect(r.hasUnknown).toBe(true);
  });
});

describe("customer override changes the limit → flips the outcome", () => {
  it("tightening allowedMinutes via an override turns ok into breach", () => {
    const duties = flightDuties(28, 3); // 5040 minutes / 28d
    const base = normalizeIr({ ruleId: "base", referenceCode: "EBA-X", type: "cumulative-flight-time",
      ir: { kind: "CUMULATIVE_FLIGHT_TIME", windows: [{ windowDays: 28, allowedMinutes: 6000 }], severity: "HARD", softPenalty: 0 } });
    // Override merged upstream (customer_rule_overrides.override_params) → tighter cap.
    const overridden: RuleIR = { ...base, windows: [{ windowDays: 28, allowedMinutes: 4000 }] };

    expect(run([base], duties).perRule[0].result.status).toBe("ok");        // 5040 <= 6000
    const r = run([overridden], duties);
    expect(r.perRule[0].result.status).toBe("breach");                        // 5040 > 4000
    expect(r.legal).toBe(false);
  });
});
