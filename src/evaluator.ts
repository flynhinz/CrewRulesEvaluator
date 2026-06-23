import {
  RuleIR,
  CrewScenario,
  EvaluationResult,
  RulesetEvaluationResult,
  RuleStatus,
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

function deriveStatus(hard: Violation[], soft: Violation[]): RuleStatus {
  if (hard.length > 0) return "breach";
  if (soft.length > 0) return "amber";
  return "ok";
}

// Interpreter for the CUMULATIVE_FLIGHT_TIME archetype (CAR-121.811 et al.).
function evaluateCumulativeFlightTime(ir: RuleIR, scenario: CrewScenario): EvaluationResult {
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
    status: deriveStatus(hardViolations, softViolations),
    provenance: { engine: "crew-rules-evaluator@CUMULATIVE_FLIGHT_TIME" },
    hardViolations,
    softViolations,
    logicTrace,
  };
}

// A rule we cannot interpret. Law 35: this is NOT legal-by-omission — it is an
// explicit "unknown" carrying its reason, so the UI can flag the gap.
function evaluateUnknown(ir: RuleIR): EvaluationResult {
  const reason = ir.unknownReason ?? "no interpreter for this rule";
  return {
    legal: true, // no HARD breach could be computed — but status below is the truth
    status: "unknown",
    provenance: { engine: "crew-rules-evaluator@UNKNOWN", reason },
    hardViolations: [],
    softViolations: [],
    logicTrace: [{ rule: ir.referenceCode, unknown: true, reason }],
  };
}

export function evaluateRule(input: {
  ruleId: string;
  ir: RuleIR;
  scenario: CrewScenario;
}): EvaluationResult {
  const { ir, scenario } = input;
  switch (ir.kind) {
    case "CUMULATIVE_FLIGHT_TIME":
      return evaluateCumulativeFlightTime(ir, scenario);
    case "UNKNOWN":
      return evaluateUnknown(ir);
    default: {
      // Exhaustiveness guard: a new RuleKind without an interpreter must NOT
      // fall through to a silent pass — treat it as unknown.
      const k: string = (ir as RuleIR).kind;
      return evaluateUnknown({ ...ir, unknownReason: `no interpreter for kind '${k}'` });
    }
  }
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
  let unknownCount = 0;

  for (const ir of input.rules) {
    const result = evaluateRule({ ruleId: ir.ruleId, ir, scenario: input.scenario });
    perRule.push({ ruleId: ir.ruleId, result });
    hardViolations.push(...result.hardViolations);
    softViolations.push(...result.softViolations);
    if (result.softViolations.length > 0) totalSoftPenalty += ir.softPenalty;
    if (result.status === "unknown") unknownCount += 1;
  }

  return {
    legal: hardViolations.length === 0,
    totalSoftPenalty,
    perRule,
    hardViolations,
    softViolations,
    hasUnknown: unknownCount > 0,
    unknownCount,
  };
}
