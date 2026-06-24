import {
  RuleIR,
  CrewScenario,
  Duty,
  DutyType,
  EvaluationResult,
  RulesetEvaluationResult,
  RuleStatus,
  Violation,
} from "./models";
import {
  dutyMinutes,
  isWithinTrailingWindow,
  instantMinutes,
  clockOfDay,
  woclOverlapMinutes,
  maxFdpEasa,
} from "./timeUtils";

// ── Duty-period assembly (shared by FDP + rest interpreters) ─────────────────

// A duty period = the consecutive on-duty block for one calendar day. sign_on is
// the report instant (first STD − reportOffset); sign_off is the release instant
// (last on-blocks + signOff for flying; last end for non-flying standby).
interface DutyPeriod {
  date: string;
  primaryType: DutyType;
  sectors: number;       // FLIGHT segments in the period
  firstStart: number;    // first STD instant (on-blocks-out)
  lastEnd: number;       // last on-blocks instant
  signOn: number;        // report instant
  signOff: number;       // release instant
}

function buildDutyPeriods(
  duties: Duty[],
  reportOffset: number,
  signOffMins: number,
): DutyPeriod[] {
  const byDate = new Map<string, Duty[]>();
  for (const d of duties) {
    if (d.dutyType === "OFF" || d.dutyType === "REST") continue; // not on-duty
    const arr = byDate.get(d.date) ?? [];
    arr.push(d);
    byDate.set(d.date, arr);
  }
  const periods: DutyPeriod[] = [];
  for (const [date, ds] of byDate) {
    const flights = ds.filter((d) => d.dutyType === "FLIGHT");
    const hasFlight = flights.length > 0;
    let firstStart = Infinity;
    let lastEnd = -Infinity;
    for (const d of ds) {
      const s = instantMinutes(d.date, d.startTime);
      let e = instantMinutes(d.date, d.endTime);
      if (e < s) e += 1440; // defensive cross-midnight within a single duty
      if (s < firstStart) firstStart = s;
      if (e > lastEnd) lastEnd = e;
    }
    periods.push({
      date,
      primaryType: hasFlight ? "FLIGHT" : ds[0].dutyType,
      sectors: flights.length,
      firstStart,
      lastEnd,
      signOn: firstStart - reportOffset,
      signOff: lastEnd + (hasFlight ? signOffMins : 0),
    });
  }
  periods.sort((a, b) => a.signOn - b.signOn);
  return periods;
}

// ── FLIGHT_DUTY_PERIOD interpreter ───────────────────────────────────────────
// Actual FDP = report (first STD − offset) → last on-blocks. Release (last STA +
// signOff) is NOT the FDP end — it drives rest, not FDP. Max FDP is a fixed cap
// or the EASA Table-2 value by report-local time + sectors (WOCL-reduced).
function evaluateFdp(ir: RuleIR, scenario: CrewScenario): EvaluationResult {
  const p = ir.fdp!;
  const hardViolations: Violation[] = [];
  const softViolations: Violation[] = [];
  const logicTrace: any[] = [];
  const periods = buildDutyPeriods(scenario.duties, p.reportOffsetMinutes, p.signOffMinutes)
    .filter((dp) => dp.sectors > 0); // FDP applies to flight duty periods

  for (const dp of periods) {
    const fdp = dp.lastEnd - dp.signOn;
    const reportClock = clockOfDay(dp.signOn);
    const maxFdp = p.useEasaTable ? maxFdpEasa(reportClock, dp.sectors) : (p.maxFdpMinutes ?? 0);
    const wocl = woclOverlapMinutes(dp.signOn, dp.lastEnd);
    const ok = fdp <= maxFdp;
    logicTrace.push({
      rule: ir.referenceCode, date: dp.date, sectors: dp.sectors,
      reportClock, fdpMinutes: fdp, maxFdpMinutes: maxFdp, woclMinutes: wocl, pass: ok,
    });
    if (!ok) {
      const v: Violation = {
        rule: ir.referenceCode,
        severity: ir.severity,
        message: `FDP ${Math.round(fdp)}m > max ${maxFdp}m on ${dp.date}` +
          (wocl > 0 ? ` (WOCL ${wocl}m)` : ""),
        allowedMinutes: maxFdp,
        actualMinutes: Math.round(fdp),
      };
      (ir.severity === "HARD" ? hardViolations : softViolations).push(v);
    }
  }
  return {
    legal: hardViolations.length === 0,
    status: deriveStatus(hardViolations, softViolations),
    provenance: { engine: "crew-rules-evaluator@FLIGHT_DUTY_PERIOD" },
    hardViolations, softViolations, logicTrace,
  };
}

// ── REST_PERIOD interpreter ──────────────────────────────────────────────────
// Rest = sign_off(prev duty) → sign_on(next duty). Required = fixed min, or
// max(preceding duty, min) for the EASA "preceding-or-12h" rule.
function evaluateRest(ir: RuleIR, scenario: CrewScenario): EvaluationResult {
  const p = ir.rest!;
  const hardViolations: Violation[] = [];
  const softViolations: Violation[] = [];
  const logicTrace: any[] = [];
  const periods = buildDutyPeriods(scenario.duties, p.reportOffsetMinutes, p.signOffMinutes);

  for (let i = 1; i < periods.length; i++) {
    const prev = periods[i - 1];
    const next = periods[i];
    if (p.beforeDutyType && next.primaryType !== p.beforeDutyType) continue;
    const rest = next.signOn - prev.signOff;
    const precedingDuty = prev.signOff - prev.signOn;
    const required = p.mode === "preceding_or_min"
      ? Math.max(precedingDuty, p.minRestMinutes)
      : p.minRestMinutes;
    const ok = rest >= required;
    logicTrace.push({
      rule: ir.referenceCode, fromDate: prev.date, toDate: next.date,
      restMinutes: Math.round(rest), requiredMinutes: required, pass: ok,
    });
    if (!ok) {
      const v: Violation = {
        rule: ir.referenceCode,
        severity: ir.severity,
        message: `Rest ${Math.round(rest)}m < required ${required}m before ${next.date}`,
        allowedMinutes: required,
        actualMinutes: Math.round(rest),
      };
      (ir.severity === "HARD" ? hardViolations : softViolations).push(v);
    }
  }
  return {
    legal: hardViolations.length === 0,
    status: deriveStatus(hardViolations, softViolations),
    provenance: { engine: "crew-rules-evaluator@REST_PERIOD" },
    hardViolations, softViolations, logicTrace,
  };
}

// ── WEEKLY_REST interpreter ──────────────────────────────────────────────────
// A continuous duty-free period of ≥ minFreeMinutes must exist in the trailing
// windowDays window ending at evaluationDate.
function evaluateWeeklyRest(ir: RuleIR, scenario: CrewScenario): EvaluationResult {
  const p = ir.weeklyRest!;
  const winEnd = instantMinutes(scenario.evaluationDate, "00:00") + 1440; // end of eval day
  const winStart = winEnd - p.windowDays * 1440;
  const periods = buildDutyPeriods(scenario.duties, 0, 0)
    .map((dp) => [Math.max(dp.signOn, winStart), Math.min(dp.signOff, winEnd)] as [number, number])
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);

  // Longest duty-free gap within the window (incl. leading/trailing free time).
  let longest = 0;
  let cursor = winStart;
  for (const [s, e] of periods) {
    longest = Math.max(longest, s - cursor);
    cursor = Math.max(cursor, e);
  }
  longest = Math.max(longest, winEnd - cursor);

  const ok = longest >= p.minFreeMinutes;
  const logicTrace = [{
    rule: ir.referenceCode, windowDays: p.windowDays,
    longestFreeMinutes: Math.round(longest), requiredMinutes: p.minFreeMinutes, pass: ok,
  }];
  const violations: Violation[] = ok ? [] : [{
    rule: ir.referenceCode,
    severity: ir.severity,
    message: `Longest duty-free ${Math.round(longest)}m < ${p.minFreeMinutes}m in ${p.windowDays}d`,
    windowDays: p.windowDays,
    allowedMinutes: p.minFreeMinutes,
    actualMinutes: Math.round(longest),
  }];
  const hardViolations = ir.severity === "HARD" ? violations : [];
  const softViolations = ir.severity === "SOFT" ? violations : [];
  return {
    legal: hardViolations.length === 0,
    status: deriveStatus(hardViolations, softViolations),
    provenance: { engine: "crew-rules-evaluator@WEEKLY_REST" },
    hardViolations, softViolations, logicTrace,
  };
}

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
    case "FLIGHT_DUTY_PERIOD":
      return ir.fdp ? evaluateFdp(ir, scenario)
        : evaluateUnknown({ ...ir, unknownReason: "FDP rule missing fdp params" });
    case "REST_PERIOD":
      return ir.rest ? evaluateRest(ir, scenario)
        : evaluateUnknown({ ...ir, unknownReason: "rest rule missing rest params" });
    case "WEEKLY_REST":
      return ir.weeklyRest ? evaluateWeeklyRest(ir, scenario)
        : evaluateUnknown({ ...ir, unknownReason: "weekly-rest rule missing params" });
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
