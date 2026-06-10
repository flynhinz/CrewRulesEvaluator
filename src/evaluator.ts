import {
  RuleIR,
  CrewScenario,
  EvaluationResult,
  RulesetEvaluationResult,
  Violation,
} from "./models";
import { dutyMinutes, isWithinTrailingWindow } from "./timeUtils";

// Sums FLIGHT-duty minutes whose date falls inside the trailing window
// ending at scenario.evaluationDate.
function sumFlightMinutesInWindow(scenario: CrewScenario, windowDays: number): number {
  let total = 0;
  for (const d of scenario.duties) {
    if (d.dutyType !== "FLIGHT") continue;
    if (!isWithinTrailingWindow(d.date, scenario.evaluationDate, windowDays)) continue;
    total += dutyMinutes(d.startTime, d.endTime);
  }
  return total;
}

export function evaluateRule(input: {
  ruleId: string;
  ir: RuleIR;
  scenario: CrewScenario;
}): EvaluationResult {
  const { ir, scenario } = input;
  const hardViolations: Violation[] = [];
  const softViolations: Violation[] = [];
  const logicTrace: any[] = [];

  // Defensive: a malformed/partial IR (e.g. parsed from text that produced no
  // window clauses) may arrive with `windows` absent, null, or non-array.
  // Treat any of those as "no windows" so Run Evaluation degrades to a legal
  // result instead of throwing on the for-of below.
  const windows = Array.isArray(ir.windows) ? ir.windows : [];

  for (const w of windows) {
    const actual = sumFlightMinutesInWindow(scenario, w.windowDays);
    const ok = actual <= w.allowedMinutes;
    logicTrace.push({
      rule: ir.referenceCode,
      windowDays: w.windowDays,
      allowedMinutes: w.allowedMinutes,
      actualMinutes: actual,
      pass: ok,
    });
    if (!ok) {
      const v: Violation = {
        rule: ir.referenceCode,
        severity: ir.severity,
        message: `Exceeded cumulative flight time`,
        windowDays: w.windowDays,
        allowedMinutes: w.allowedMinutes,
        actualMinutes: actual,
      };
      (ir.severity === "HARD" ? hardViolations : softViolations).push(v);
    }
  }

  return {
    legal: hardViolations.length === 0,
    hardViolations,
    softViolations,
    logicTrace,
  };
}

export function evaluateRuleset(input: {
  rulesetId: string;
  rules: RuleIR[];
  scenario: CrewScenario;
}): RulesetEvaluationResult {
  const perRule: RulesetEvaluationResult["perRule"] = [];
  const hardViolations: Violation[] = [];
  const softViolations: Violation[] = [];
  let totalSoftPenalty = 0;

  for (const ir of input.rules) {
    const result = evaluateRule({ ruleId: ir.ruleId, ir, scenario: input.scenario });
    perRule.push({ ruleId: ir.ruleId, result });
    hardViolations.push(...result.hardViolations);
    softViolations.push(...result.softViolations);
    if (result.softViolations.length > 0) totalSoftPenalty += ir.softPenalty;
  }

  return {
    legal: hardViolations.length === 0,
    totalSoftPenalty,
    perRule,
    hardViolations,
    softViolations,
  };
}
