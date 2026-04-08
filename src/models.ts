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

export type RuleIR = {
  ruleId: string;
  referenceCode: string;
  severity: "HARD" | "SOFT";
  kind: "CUMULATIVE_FLIGHT_TIME";
  // Canonicalised: minutes + days. Frozen at compile time.
  windows: Array<{ allowedMinutes: number; windowDays: number }>;
  // Soft rules carry a penalty score; HARD rules use 0.
  softPenalty: number;
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

export type EvaluationResult = {
  legal: boolean;
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
};
