import { ParsedDSL, RuleIR, LogicGraph, LogicNode } from "./models";

// compileRule freezes a ParsedDSL into an executable IR + logic graph.
// Hours → minutes happens here. Override params win over base params.
export function compileRule(input: {
  ruleId: string;
  parsedDsl: ParsedDSL;
  baseParams?: { severity?: "HARD" | "SOFT"; softPenalty?: number };
  overrideParams?: { severity?: "HARD" | "SOFT"; softPenalty?: number };
}): { ir: RuleIR; logicGraph: LogicGraph } {
  const { ruleId, parsedDsl } = input;
  const merged = { ...(input.baseParams ?? {}), ...(input.overrideParams ?? {}) };
  const severity = merged.severity ?? "HARD";
  const softPenalty = severity === "SOFT" ? merged.softPenalty ?? 0 : 0;

  const ir: RuleIR = {
    ruleId,
    referenceCode: parsedDsl.referenceCode,
    severity,
    kind: parsedDsl.kind,
    windows: parsedDsl.windows.map((w) => ({
      allowedMinutes: Math.round(w.hours * 60),
      windowDays: w.days,
    })),
    softPenalty,
  };

  // Logic graph mirrors IR — useful for what-if engines and visualisation.
  const root: LogicNode = {
    op: "AND",
    children: ir.windows.map((w) => ({
      op: "LTE" as const,
      left: { op: "WINDOW_SUM" as const, windowDays: w.windowDays, field: "FLIGHT_MINUTES" as const },
      right: w.allowedMinutes,
    })),
  };

  return { ir, logicGraph: { ruleId, root } };
}
