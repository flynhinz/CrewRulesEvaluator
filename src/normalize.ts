// Normalises the heterogeneous `rules.ir` payloads found in the live DB into a
// single canonical RuleIR the evaluator can dispatch on. Anything we cannot
// interpret becomes kind:"UNKNOWN" with a reason — never a silent pass.
//
// Two real IR shapes exist in prod today:
//   (a) "windows" shape  : { kind:"CUMULATIVE_FLIGHT_TIME", windows:[{windowDays,allowedMinutes}], severity, softPenalty }
//   (b) "constraints" shape: { severity, constraints:[{ metric, window:{days,type}, operator, threshold_minutes }] }
// 5 of 8 approved/published archetypes have empty IR ({}) → UNKNOWN.

import { RuleIR } from "./models";

// A raw rule row as loaded from the `rules` table.
export type RawRule = {
  ruleId: string;
  referenceCode: string;
  type?: string | null;        // rules.type (e.g. "flight-duty-period")
  severity?: string | null;    // rules.severity / ir.severity
  ir?: unknown;                 // rules.ir (jsonb) — any of the shapes above, or {}
};

function asSeverity(s: unknown, fallback: "HARD" | "SOFT" = "HARD"): "HARD" | "SOFT" {
  return String(s ?? "").toUpperCase() === "SOFT" ? "SOFT" : fallback;
}

function unknown(raw: RawRule, reason: string): RuleIR {
  return {
    ruleId: raw.ruleId,
    referenceCode: raw.referenceCode,
    severity: asSeverity(raw.severity),
    kind: "UNKNOWN",
    windows: [],
    softPenalty: 0,
    unknownReason: reason,
  };
}

// The only metric we can currently evaluate as a cumulative window sum.
const FLIGHT_TIME_METRIC = "crew.flightTimeMinutes";

/**
 * Normalise one raw rule's IR into a canonical RuleIR. Pure; no I/O.
 * Unhandled shapes/metrics/empty IR → kind:"UNKNOWN" (+ reason).
 */
export function normalizeIr(raw: RawRule): RuleIR {
  const ir = raw.ir;
  if (!ir || typeof ir !== "object") {
    return unknown(raw, `no IR for type '${raw.type ?? "?"}'`);
  }
  const obj = ir as Record<string, any>;
  // Empty object IR (the 5/8 approved/published archetypes with `ir: {}`).
  if (Object.keys(obj).length === 0) {
    return unknown(raw, `no IR for type '${raw.type ?? "?"}'`);
  }
  const severity = asSeverity(obj.severity ?? raw.severity);

  // (a) windows shape — already canonical.
  if (obj.kind === "CUMULATIVE_FLIGHT_TIME" && Array.isArray(obj.windows) && obj.windows.length > 0) {
    const windows = obj.windows
      .filter((w: any) => Number.isFinite(w?.windowDays) && Number.isFinite(w?.allowedMinutes))
      .map((w: any) => ({ windowDays: Number(w.windowDays), allowedMinutes: Number(w.allowedMinutes) }));
    if (windows.length === 0) return unknown(raw, "windows present but malformed");
    return {
      ruleId: raw.ruleId,
      referenceCode: raw.referenceCode,
      severity,
      kind: "CUMULATIVE_FLIGHT_TIME",
      windows,
      softPenalty: Number(obj.softPenalty ?? 0),
    };
  }

  // (b) constraints shape — map the flight-time cumulative constraints to windows.
  if (Array.isArray(obj.constraints) && obj.constraints.length > 0) {
    const ftWindows = obj.constraints
      .filter(
        (c: any) =>
          c?.metric === FLIGHT_TIME_METRIC &&
          (c?.operator ?? "<=") === "<=" &&
          Number.isFinite(c?.threshold_minutes) &&
          Number.isFinite(c?.window?.days),
      )
      .map((c: any) => ({ windowDays: Number(c.window.days), allowedMinutes: Number(c.threshold_minutes) }));
    if (ftWindows.length > 0) {
      return {
        ruleId: raw.ruleId,
        referenceCode: raw.referenceCode,
        severity,
        kind: "CUMULATIVE_FLIGHT_TIME",
        windows: ftWindows,
        softPenalty: Number(obj.softPenalty ?? 0),
      };
    }
    // Constraints exist but use metrics we don't interpret (duty/rest/etc.).
    const metrics = Array.from(new Set(obj.constraints.map((c: any) => String(c?.metric ?? "?"))));
    return unknown(raw, `no interpreter for constraint metric(s): ${metrics.join(", ")}`);
  }

  return unknown(raw, `unrecognised IR shape for type '${raw.type ?? "?"}'`);
}
