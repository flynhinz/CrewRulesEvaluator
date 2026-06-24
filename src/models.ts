// Core domain models shared across parser, compiler, and evaluator.
// Kept intentionally narrow: the engine never knows about UI concerns.

export type DutyType = "OFF" | "FLIGHT" | "STANDBY" | "REST";

export type Duty = {
  date: string;       // ISO "YYYY-MM-DD"
  startTime: string;  // "HH:MM" 24h
  endTime: string;    // "HH:MM" 24h (same calendar day; overnight not modelled in V1)
  dutyType: DutyType;
};

export type CrewScenario = {
  crewId: string;
  duties: Duty[];
  evaluationDate: string; // ISO date used as the right edge of rolling windows
};

// ----- Rule representation -----

export type ParsedDSL = {
  ruleId: string;
  referenceCode: string;
  kind: "CUMULATIVE_FLIGHT_TIME";
  // Each window is a literal hours-over-days clause as parsed from text.
  windows: Array<{ hours: number; days: number }>;
  raw: string;
};

// Archetypes the engine can actually interpret. "UNKNOWN" is a first-class
// terminal kind: a rule whose IR we could not normalise (empty IR, or a
// metric/shape no interpreter handles yet). It is NEVER silently treated as
// legal — it yields status "unknown" with provenance (Law 35: no false-green).
export type RuleKind =
  | "CUMULATIVE_FLIGHT_TIME"
  | "FLIGHT_DUTY_PERIOD"
  | "REST_PERIOD"
  | "WEEKLY_REST"
  | "UNKNOWN";

// FDP interpreter params. Either a fixed cap (maxFdpMinutes) OR the EASA
// ORO.FTL.205 Table 2 (useEasaTable) by report-local time + sector count.
export type FdpParams = {
  maxFdpMinutes: number | null;
  useEasaTable: boolean;
  reportOffsetMinutes: number; // report = first STD − this (default 60)
  signOffMinutes: number;      // release = last on-blocks + this (default 15)
};

// Rest interpreter params. Rest = sign_off(prev duty) → sign_on(next duty).
export type RestParams = {
  minRestMinutes: number;
  // "preceding_or_min": rest ≥ max(preceding duty, minRestMinutes) (ORO.FTL.235).
  mode: "fixed" | "preceding_or_min";
  // When set, only checked before duties of this type (e.g. STANDBY = reserve rest).
  beforeDutyType: DutyType | null;
  reportOffsetMinutes: number;
  signOffMinutes: number;
};

// Weekly/cumulative rest: a continuous duty-free period of ≥ minFreeMinutes
// must exist within any trailing windowDays window.
export type WeeklyRestParams = {
  windowDays: number;
  minFreeMinutes: number;
};

export type RuleIR = {
  ruleId: string;
  referenceCode: string;
  severity: "HARD" | "SOFT";
  kind: RuleKind;
  // Canonicalised: minutes + days. Frozen at compile time.
  windows: Array<{ allowedMinutes: number; windowDays: number }>;
  // Soft rules carry a penalty score; HARD rules use 0.
  softPenalty: number;
  // Set per-kind by normalizeIr. Only the field matching `kind` is read.
  fdp?: FdpParams;
  rest?: RestParams;
  weeklyRest?: WeeklyRestParams;
  // Set when kind === "UNKNOWN": why the rule could not be interpreted.
  unknownReason?: string;
};

export type LogicNode =
  | { op: "WINDOW_SUM"; windowDays: number; field: "FLIGHT_MINUTES" }
  | { op: "LTE"; left: LogicNode; right: number }
  | { op: "AND"; children: LogicNode[] };

export type LogicGraph = {
  ruleId: string;
  root: LogicNode;
};

// ----- Evaluation results -----

export type Violation = {
  rule: string;
  severity: "HARD" | "SOFT";
  message: string;
  windowDays?: number;
  allowedMinutes?: number;
  actualMinutes?: number;
};

// Per-rule outcome status (the canonical extension consumed by the Ops UI).
// Mapping: hard violation → "breach", soft violation → "amber",
// evaluated clean → "ok", could-not-evaluate → "unknown".
export type RuleStatus = "ok" | "amber" | "breach" | "unknown";

// Where a verdict came from — surfaced on expand so an operator can see that
// an "unknown" is an honest gap, not a pass.
export type RuleProvenance = {
  engine: string;                 // e.g. "crew-rules-evaluator@<kind>"
  ruleset_version?: string | null;
  override_applied?: boolean;
  reason?: string;                // populated for "unknown"
};

export type EvaluationResult = {
  legal: boolean;
  status: RuleStatus;
  provenance: RuleProvenance;
  hardViolations: Violation[];
  softViolations: Violation[];
  logicTrace: any[];
};

export type RulesetEvaluationResult = {
  legal: boolean;
  totalSoftPenalty: number;
  perRule: Array<{ ruleId: string; result: EvaluationResult }>;
  hardViolations: Violation[];
  softViolations: Violation[];
  // Un-evaluable rules MUST be visible — a caller cannot read `legal` as
  // "all clear" while rules went un-evaluated. Surface the gap explicitly.
  hasUnknown: boolean;
  unknownCount: number;
};
