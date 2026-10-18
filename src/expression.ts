import { Environment } from "@marcbachmann/cel-js";
import type { SettingValue } from "./protocol";
import type { SettingDeclaration } from "./settings";

// Setting expressions are a restricted subset of CEL. The backend validates
// every expression when a version is published, so this module only ever
// evaluates expressions that are already known to be well formed — the one
// exception being `mugon dev`, which reads them straight from mugon.toml.
//
// specs/expressions/grammar.md is the source of truth, and
// specs/expressions/cases.json pins this implementation against the backend's.

// The single variable in scope, matching the backend's declaration.
export const SETTINGS_VARIABLE = "settings";

// Structural limits, because expressions are authored by game developers who
// are not fully trusted. The subset has no comprehensions, so a legitimate
// expression is orders of magnitude smaller than these.
const EXPRESSION_LIMITS = {
  maxAstNodes: 500,
  maxDepth: 32,
  maxListElements: 0,
  maxMapEntries: 0,
  maxCallArguments: 4,
} as const;

const environment = new Environment({
  limits: EXPRESSION_LIMITS,
}).registerVariable(SETTINGS_VARIABLE, "map");

// A parsed expression, ready to evaluate against setting values.
export interface SettingExpression {
  readonly source: string;
  evaluate(values: Record<string, SettingValue>): boolean;
}

export class SettingExpressionError extends Error {
  constructor(
    readonly source: string,
    cause: unknown,
  ) {
    super(
      `Failed to parse setting expression '${source}': ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "SettingExpressionError";
  }
}

// parseSettingExpression prepares an expression once so it can be evaluated
// repeatedly as the initiator changes settings. It throws only when the source
// does not parse, which for a published version cannot happen.
export function parseSettingExpression(source: string): SettingExpression {
  let parsed: (context?: Record<string, unknown>) => unknown;
  try {
    parsed = environment.parse(source);
  } catch (cause) {
    throw new SettingExpressionError(source, cause);
  }

  return {
    source,
    evaluate(values) {
      const result = parsed({ [SETTINGS_VARIABLE]: values });
      if (typeof result !== "boolean") {
        throw new SettingExpressionError(
          source,
          `expected a boolean, got ${typeof result}`,
        );
      }
      return result;
    },
  };
}

// tryParseSettingExpression is the non-throwing form, for callers that would
// rather degrade than fail. A null result means the expression is unusable and
// should be treated as absent.
export function tryParseSettingExpression(
  source: string | undefined,
): SettingExpression | null {
  if (source === undefined || source.trim() === "") return null;
  try {
    return parseSettingExpression(source);
  } catch (error) {
    console.error(error);
    return null;
  }
}

// evaluateSettingExpression resolves an expression, failing open: a null
// expression, or one that errors at runtime, yields fallback. Everything is
// validated at publish time, so a runtime error means a bug on our side, and
// blocking play on that is worse than the alternative.
export function evaluateSettingExpression(
  expression: SettingExpression | null,
  values: Record<string, SettingValue>,
  fallback: boolean,
): boolean {
  if (expression === null) return fallback;
  try {
    return expression.evaluate(values);
  } catch (error) {
    console.error(error);
    return fallback;
  }
}

// CompiledSettingExpressions holds every expression of one game version.
export interface CompiledSettingExpressions {
  enabledWhenBySettingKey: Record<string, SettingExpression | null>;
  settingsValidWhen: SettingExpression | null;
}

// compileSettingExpressions parses a version's expressions once. Call it when
// the version changes, not on every value edit.
export function compileSettingExpressions(
  declarations: SettingDeclaration[],
  settingsValidWhen?: string,
): CompiledSettingExpressions {
  const enabledWhenBySettingKey: Record<string, SettingExpression | null> = {};
  for (const declaration of declarations) {
    if (declaration.enabledWhen) {
      enabledWhenBySettingKey[declaration.key] = tryParseSettingExpression(
        declaration.enabledWhen,
      );
    }
  }
  return {
    enabledWhenBySettingKey,
    settingsValidWhen: tryParseSettingExpression(settingsValidWhen),
  };
}

// isSettingEnabled reports whether the initiator may change one setting. A
// setting with no expression is always editable.
export function isSettingEnabled(
  compiled: CompiledSettingExpressions,
  settingKey: string,
  values: Record<string, SettingValue>,
): boolean {
  return evaluateSettingExpression(
    compiled.enabledWhenBySettingKey[settingKey] ?? null,
    values,
    true,
  );
}

// areSettingsValid reports whether the game may start. A version with no
// expression is always ready.
export function areSettingsValid(
  compiled: CompiledSettingExpressions,
  values: Record<string, SettingValue>,
): boolean {
  return evaluateSettingExpression(compiled.settingsValidWhen, values, true);
}
