import { describe, it, expect } from "vitest";
import { evaluateRule, RuleIR, CrewScenario } from "../src";

// Regression: Run Evaluation crashed at `for (const w of ir.windows)` when an
// IR arrived with windows absent / empty / non-array. The guard must make the
// evaluator degrade to a legal, empty result instead of throwing.

const scenario: CrewScenario = {
  crewId: "C1",
  duties: [],
  evaluationDate: "2026-04-08",
};

function irWith(windows: unknown): RuleIR {
  return {
    ruleId: "r1",
    referenceCode: "TEST-1",
    severity: "HARD",
    kind: "CUMULATIVE_FLIGHT_TIME",
    // deliberately bypass the type to simulate a malformed IR at runtime
    windows: windows as RuleIR["windows"],
    softPenalty: 0,
  };
}

describe("evaluateRule windows guard", () => {
  it.each([
    ["undefined", undefined],
    ["null", null],
    ["empty array", []],
    ["non-array object", { 0: "x" }],
    ["string", "not-an-array"],
  ])("does not throw and returns a legal result when windows is %s", (_label, windows) => {
    expect(() =>
      evaluateRule({ ruleId: "r1", ir: irWith(windows), scenario }),
    ).not.toThrow();
    const r = evaluateRule({ ruleId: "r1", ir: irWith(windows), scenario });
    expect(r.legal).toBe(true);
    expect(r.hardViolations).toHaveLength(0);
    expect(r.softViolations).toHaveLength(0);
    expect(r.logicTrace).toHaveLength(0);
  });
});
