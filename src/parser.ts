import { ParsedDSL } from "./models";

// parseRule extracts authoritative intent from rule text. It does NOT
// normalise units and does NOT evaluate. Compiler owns canonicalisation.
export function parseRule(input: {
  ruleId: string;
  referenceCode: string;
  rawText: string;
  params: any;
}): { parsedDsl: ParsedDSL } {
  const { ruleId, referenceCode, rawText } = input;

  // Match clauses like "100 hours in any 28 consecutive days".
  const clauseRegex =
    /(\d+(?:\.\d+)?)\s*hours?\s+in\s+any\s+(\d+)\s+consecutive\s+days?/gi;

  const windows: Array<{ hours: number; days: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = clauseRegex.exec(rawText)) !== null) {
    windows.push({ hours: parseFloat(m[1]), days: parseInt(m[2], 10) });
  }

  if (windows.length === 0) {
    throw new Error(`parseRule: no recognisable clauses in ${referenceCode}`);
  }

  return {
    parsedDsl: {
      ruleId,
      referenceCode,
      kind: "CUMULATIVE_FLIGHT_TIME",
      windows,
      raw: rawText,
    },
  };
}
