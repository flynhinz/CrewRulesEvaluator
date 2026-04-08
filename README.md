# CrewRulesEvaluator

Deterministic rules engine for airline crew legality.

## Pipeline
`parseRule` → `compileRule` → `evaluateRule` / `evaluateRuleset`

- Parser extracts intent from authoritative text.
- Compiler canonicalises (hours→minutes) and freezes IR.
- Evaluator computes window sums and produces violations + trace.

## V1 Rule
CAR-121.811 — 100h/28d and 900h/365d cumulative flight time (HARD).

## Running tests
```
pnpm i
pnpm vitest
```
