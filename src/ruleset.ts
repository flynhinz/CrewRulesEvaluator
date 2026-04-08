import { parseRule } from "./parser";
import { compileRule } from "./compiler";
import { RuleIR } from "./models";

// Authoritative CAR-121.811 text. The engine is the only place this lives.
export const CAR_121_811_TEXT = `Maximum flight time:
• 100 hours in any 28 consecutive days
• 900 hours in any 365 consecutive days`;

// Build a default ruleset containing CAR-121.811 as a HARD rule.
export function buildDefaultRuleset(): { rules: RuleIR[] } {
  const { parsedDsl } = parseRule({
    ruleId: "CAR-121.811",
    referenceCode: "CAR-121.811",
    rawText: CAR_121_811_TEXT,
    params: {},
  });
  const { ir } = compileRule({
    ruleId: "CAR-121.811",
    parsedDsl,
    baseParams: { severity: "HARD" },
  });
  return { rules: [ir] };
}
