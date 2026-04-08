import { describe, it, expect } from "vitest";
import { buildDefaultRuleset, evaluateRuleset, CrewScenario, Duty } from "../src";

function dutyDay(date: string, hours: number): Duty {
  // Build a FLIGHT duty starting at 08:00 lasting `hours`.
  const startMin = 8 * 60;
  const endMin = startMin + Math.round(hours * 60);
  const hh = String(Math.floor(endMin / 60)).padStart(2, "0");
  const mm = String(endMin % 60).padStart(2, "0");
  return { date, startTime: "08:00", endTime: `${hh}:${mm}`, dutyType: "FLIGHT" };
}

function addDays(base: string, n: number): string {
  const d = new Date(base + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

describe("CAR-121.811", () => {
  const { rules } = buildDefaultRuleset();
  const evalDate = "2026-04-08";

  it("legal scenario stays under 100h/28d", () => {
    const duties: Duty[] = [];
    for (let i = 0; i < 28; i++) duties.push(dutyDay(addDays(evalDate, -i), 3));
    const scenario: CrewScenario = { crewId: "C1", duties, evaluationDate: evalDate };
    const r = evaluateRuleset({ rulesetId: "default", rules, scenario });
    expect(r.legal).toBe(true);
    expect(r.hardViolations).toHaveLength(0);
  });

  it("detects 28-day cumulative violation", () => {
    const duties: Duty[] = [];
    for (let i = 0; i < 28; i++) duties.push(dutyDay(addDays(evalDate, -i), 5));
    const scenario: CrewScenario = { crewId: "C2", duties, evaluationDate: evalDate };
    const r = evaluateRuleset({ rulesetId: "default", rules, scenario });
    expect(r.legal).toBe(false);
    const v = r.hardViolations.find((v) => v.windowDays === 28);
    expect(v).toBeTruthy();
    expect(v!.actualMinutes).toBe(28 * 5 * 60);
    expect(v!.allowedMinutes).toBe(100 * 60);
  });

  it("ignores duties outside the trailing window", () => {
    const duties: Duty[] = [];
    for (let i = 30; i < 40; i++) duties.push(dutyDay(addDays(evalDate, -i), 10));
    const scenario: CrewScenario = { crewId: "C3", duties, evaluationDate: evalDate };
    const r = evaluateRuleset({ rulesetId: "default", rules, scenario });
    expect(r.legal).toBe(true);
  });

  it("detects 365-day cumulative violation", () => {
    const duties: Duty[] = [];
    for (let i = 0; i < 200; i++) duties.push(dutyDay(addDays(evalDate, -i * 2), 5));
    const scenario: CrewScenario = { crewId: "C4", duties, evaluationDate: evalDate };
    const r = evaluateRuleset({ rulesetId: "default", rules, scenario });
    const v = r.hardViolations.find((v) => v.windowDays === 365);
    expect(v).toBeTruthy();
  });
});
