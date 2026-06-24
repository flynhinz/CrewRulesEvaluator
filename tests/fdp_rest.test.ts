import { describe, it, expect } from "vitest";
import { normalizeIr, evaluateRule, CrewScenario, Duty, RuleIR } from "../src";
import { maxFdpEasa, woclOverlapMinutes, instantMinutes } from "../src/timeUtils";

const evalDate = "2026-04-30";
function scn(duties: Duty[], date = evalDate): CrewScenario {
  return { crewId: "C", duties, evaluationDate: date };
}
function flight(date: string, start: string, end: string): Duty {
  return { date, startTime: start, endTime: end, dutyType: "FLIGHT" };
}

describe("EASA Table-2 helper", () => {
  it("day report (08:00) 1-2 sectors → 13h; night/WOCL (03:00) → 11h", () => {
    expect(maxFdpEasa(8 * 60, 2)).toBe(780);
    expect(maxFdpEasa(3 * 60, 1)).toBe(660);
  });
  it("subtracts 30m/sector beyond 2, floor 9h", () => {
    expect(maxFdpEasa(8 * 60, 4)).toBe(780 - 60);
    expect(maxFdpEasa(8 * 60, 20)).toBe(540);
  });
  it("WOCL overlap counts 02:00–05:59 minutes", () => {
    const s = instantMinutes("2026-04-08", "01:00");
    const e = instantMinutes("2026-04-08", "04:00");
    expect(woclOverlapMinutes(s, e)).toBe(120); // 02:00–04:00
  });
});

describe("FLIGHT_DUTY_PERIOD interpreter", () => {
  const fixed12h = normalizeIr({
    ruleId: "fdp", referenceCode: "CAR-OPS-1.1095", type: "flight-duty-period",
    ir: { id: "x", severity: "HARD", constraints: [{ metric: "crew.fdpMinutes", window: { days: 1 }, operator: "<=", threshold_minutes: 720 }] },
  });
  it("normalises crew.fdpMinutes → FLIGHT_DUTY_PERIOD fixed cap", () => {
    expect(fixed12h.kind).toBe("FLIGHT_DUTY_PERIOD");
    expect(fixed12h.fdp?.maxFdpMinutes).toBe(720);
  });
  it("ok when FDP within cap (report = STD−60)", () => {
    // start 06:00 → report 05:00; end 17:00 → FDP = 12:00 = 720 ≤ 720
    const r = evaluateRule({ ruleId: "fdp", ir: fixed12h, scenario: scn([flight("2026-04-08", "06:00", "17:00")]) });
    expect(r.status).toBe("ok");
  });
  it("breach when FDP exceeds cap", () => {
    // start 06:00 → report 05:00; end 18:00 → FDP = 13:00 = 780 > 720
    const r = evaluateRule({ ruleId: "fdp", ir: fixed12h, scenario: scn([flight("2026-04-08", "06:00", "18:00")]) });
    expect(r.status).toBe("breach");
    expect(r.hardViolations[0].actualMinutes).toBe(780);
  });
  it("EASA-table FDP: night report tightens the cap to breach", () => {
    const easa: RuleIR = normalizeIr({
      ruleId: "easa", referenceCode: "ORO.FTL.205", type: "flight-duty-period",
      ir: { kind: "FLIGHT_DUTY_PERIOD", severity: "HARD", fdp: { useEasaTable: true } },
    });
    expect(easa.fdp?.useEasaTable).toBe(true);
    // report 05:00 (cap 12:00=720); start 06:00 end 18:00 → FDP 13:00 > 720 → breach
    const r = evaluateRule({ ruleId: "easa", ir: easa, scenario: scn([flight("2026-04-08", "06:00", "18:00")]) });
    expect(r.status).toBe("breach");
  });
});

describe("REST_PERIOD interpreter", () => {
  const rest10h = normalizeIr({
    ruleId: "rest", referenceCode: "CAR-121.809", type: "rest-requirement",
    ir: { severity: "HARD", constraints: [{ metric: "crew.restMinutes", window: { days: 1 }, operator: ">=", threshold_minutes: 600 }] },
  });
  it("normalises crew.restMinutes → REST_PERIOD", () => {
    expect(rest10h.kind).toBe("REST_PERIOD");
    expect(rest10h.rest?.minRestMinutes).toBe(600);
  });
  it("breach: late duty → early next-day duty leaves < 10h rest", () => {
    // d1 end 23:00 → signOff 23:15; d2 start 06:00 → signOn 05:00 → rest 5:45 < 10h
    const r = evaluateRule({ ruleId: "rest", ir: rest10h, scenario: scn([
      flight("2026-04-08", "13:00", "23:00"), flight("2026-04-09", "06:00", "12:00"),
    ]) });
    expect(r.status).toBe("breach");
  });
  it("ok: adequate overnight rest", () => {
    // d1 end 17:00 → signOff 17:15; d2 start 08:00 → signOn 07:00 → rest 13:45 ≥ 10h
    const r = evaluateRule({ ruleId: "rest", ir: rest10h, scenario: scn([
      flight("2026-04-08", "08:00", "17:00"), flight("2026-04-09", "08:00", "16:00"),
    ]) });
    expect(r.status).toBe("ok");
  });
  it("reserve rest maps to beforeDutyType STANDBY", () => {
    const reserve = normalizeIr({
      ruleId: "rr", referenceCode: "FAR-117.21", type: "reserve-rest",
      ir: { severity: "HARD", constraints: [{ metric: "crew.restMinutesBeforeReserve", window: { days: 1 }, operator: ">=", threshold_minutes: 600 }] },
    });
    expect(reserve.rest?.beforeDutyType).toBe("STANDBY");
  });
});

describe("WEEKLY_REST interpreter", () => {
  const weekly36h = normalizeIr({
    ruleId: "wk", referenceCode: "CASR-48.060", type: "weekly-rest",
    ir: { severity: "HARD", constraints: [{ metric: "crew.dutyFreeMinutes", window: { days: 7 }, operator: ">=", threshold_minutes: 2160 }] },
  });
  it("normalises crew.dutyFreeMinutes → WEEKLY_REST", () => {
    expect(weekly36h.kind).toBe("WEEKLY_REST");
    expect(weekly36h.weeklyRest).toEqual({ windowDays: 7, minFreeMinutes: 2160 });
  });
  it("breach: duty every day, no 36h continuous gap", () => {
    const duties: Duty[] = [];
    for (let d = 24; d <= 30; d++) duties.push(flight(`2026-04-${d}`, "08:00", "20:00"));
    const r = evaluateRule({ ruleId: "wk", ir: weekly36h, scenario: scn(duties) });
    expect(r.status).toBe("breach");
  });
  it("ok: a cluster of OFF days yields a >36h gap", () => {
    // duty only on the 24th and 30th → big free gap in between
    const r = evaluateRule({ ruleId: "wk", ir: weekly36h, scenario: scn([
      flight("2026-04-24", "08:00", "16:00"), flight("2026-04-30", "08:00", "16:00"),
    ]) });
    expect(r.status).toBe("ok");
  });
});

describe("single-pilot CFT stays UNKNOWN (engine can't model the scope)", () => {
  it("crew.singlePilotFlightTimeMinutes → unknown", () => {
    const ir = normalizeIr({
      ruleId: "sp", referenceCode: "CAR-121.807", type: "flight_time_limitation",
      ir: { id: "x", scope: "SINGLE_PILOT", severity: "HARD", constraints: [{ metric: "crew.singlePilotFlightTimeMinutes", window: { days: 1 }, operator: "<=", threshold_minutes: 480 }] },
    });
    expect(ir.kind).toBe("UNKNOWN");
  });
});
