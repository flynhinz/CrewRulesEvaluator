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
const FDP_METRIC = "crew.fdpMinutes";
const REST_METRIC = "crew.restMinutes";
const RESERVE_REST_METRIC = "crew.restMinutesBeforeReserve";
const DUTY_FREE_METRIC = "crew.dutyFreeMinutes";

const DEFAULT_REPORT_OFFSET = 60; // report = first STD − 60m
const DEFAULT_SIGN_OFF = 15;      // release = last on-blocks + 15m

function base(raw: RawRule, severity: "HARD" | "SOFT", obj: Record<string, any>) {
  return {
    ruleId: raw.ruleId,
    referenceCode: raw.referenceCode,
    severity,
    softPenalty: Number(obj.softPenalty ?? 0),
    windows: [] as Array<{ allowedMinutes: number; windowDays: number }>,
  };
}
function num(v: any, fallback: number): number {
  return Number.isFinite(v) ? Number(v) : fallback;
}

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

  // (a2) explicit FLIGHT_DUTY_PERIOD kind — EASA Table-2 or fixed cap.
  if (obj.kind === "FLIGHT_DUTY_PERIOD") {
    const f = (obj.fdp ?? {}) as Record<string, any>;
    return {
      ...base(raw, severity, obj),
      kind: "FLIGHT_DUTY_PERIOD",
      fdp: {
        maxFdpMinutes: Number.isFinite(f.maxFdpMinutes) ? Number(f.maxFdpMinutes) : null,
        useEasaTable: Boolean(f.useEasaTable),
        reportOffsetMinutes: num(f.reportOffsetMinutes, DEFAULT_REPORT_OFFSET),
        signOffMinutes: num(f.signOffMinutes, DEFAULT_SIGN_OFF),
      },
    };
  }

  // (b) constraints shape — dispatch by metric.
  if (Array.isArray(obj.constraints) && obj.constraints.length > 0) {
    const cs: any[] = obj.constraints;
    const find = (metric: string) =>
      cs.find((c) => c?.metric === metric && Number.isFinite(c?.threshold_minutes));

    // b1: cumulative flight time → windows.
    const ftWindows = cs
      .filter(
        (c: any) =>
          c?.metric === FLIGHT_TIME_METRIC &&
          (c?.operator ?? "<=") === "<=" &&
          Number.isFinite(c?.threshold_minutes) &&
          Number.isFinite(c?.window?.days),
      )
      .map((c: any) => ({ windowDays: Number(c.window.days), allowedMinutes: Number(c.threshold_minutes) }));
    if (ftWindows.length > 0) {
      return { ...base(raw, severity, obj), kind: "CUMULATIVE_FLIGHT_TIME", windows: ftWindows };
    }

    // b2: max FDP (fixed cap).
    const fdpC = find(FDP_METRIC);
    if (fdpC) {
      return {
        ...base(raw, severity, obj),
        kind: "FLIGHT_DUTY_PERIOD",
        fdp: {
          maxFdpMinutes: Number(fdpC.threshold_minutes),
          useEasaTable: false,
          reportOffsetMinutes: num(obj.reportOffsetMinutes, DEFAULT_REPORT_OFFSET),
          signOffMinutes: num(obj.signOffMinutes, DEFAULT_SIGN_OFF),
        },
      };
    }

    // b3: reserve rest (rest required before a standby/reserve duty).
    const reserveC = find(RESERVE_REST_METRIC);
    if (reserveC) {
      return {
        ...base(raw, severity, obj),
        kind: "REST_PERIOD",
        rest: {
          minRestMinutes: Number(reserveC.threshold_minutes),
          mode: "fixed",
          beforeDutyType: "STANDBY",
          reportOffsetMinutes: num(obj.reportOffsetMinutes, DEFAULT_REPORT_OFFSET),
          signOffMinutes: num(obj.signOffMinutes, DEFAULT_SIGN_OFF),
        },
      };
    }

    // b4: minimum rest between duties.
    const restC = find(REST_METRIC);
    if (restC) {
      return {
        ...base(raw, severity, obj),
        kind: "REST_PERIOD",
        rest: {
          minRestMinutes: Number(restC.threshold_minutes),
          mode: obj.restMode === "preceding_or_min" ? "preceding_or_min" : "fixed",
          beforeDutyType: null,
          reportOffsetMinutes: num(obj.reportOffsetMinutes, DEFAULT_REPORT_OFFSET),
          signOffMinutes: num(obj.signOffMinutes, DEFAULT_SIGN_OFF),
        },
      };
    }

    // b5: weekly / cumulative duty-free rest.
    const wkC = find(DUTY_FREE_METRIC);
    if (wkC && Number.isFinite(wkC?.window?.days)) {
      return {
        ...base(raw, severity, obj),
        kind: "WEEKLY_REST",
        weeklyRest: {
          windowDays: Number(wkC.window.days),
          minFreeMinutes: Number(wkC.threshold_minutes),
        },
      };
    }

    // Constraints exist but use metrics we don't interpret (e.g. single-pilot scope).
    const metrics = Array.from(new Set(cs.map((c: any) => String(c?.metric ?? "?"))));
    return unknown(raw, `no interpreter for constraint metric(s): ${metrics.join(", ")}`);
  }

  return unknown(raw, `unrecognised IR shape for type '${raw.type ?? "?"}'`);
}
