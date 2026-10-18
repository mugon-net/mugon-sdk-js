import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { SettingValue } from "./protocol";
import {
  compileSettingExpressions,
  isSettingEnabled,
  areSettingsValid,
  parseSettingExpression,
  tryParseSettingExpression,
} from "./expression";
import type { SettingDeclaration } from "./settings";

// The corpus is shared with the backend's cel-go implementation; running the
// same cases on both sides is what keeps the two from drifting.
// See specs/expressions/grammar.md.
const corpus = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../../../specs/expressions/cases.json", import.meta.url),
    ),
    "utf8",
  ),
) as {
  environments: Record<string, Record<string, string>>;
  values: Record<string, Record<string, SettingValue>>;
  evaluate: {
    name: string;
    environment?: string;
    source: string;
    expect?: boolean;
    error?: boolean;
  }[];
};

describe("corpus parity with the backend", () => {
  it("declares cases", () => {
    expect(corpus.evaluate.length).toBeGreaterThan(0);
  });

  for (const testCase of corpus.evaluate) {
    it(testCase.name, () => {
      const values = corpus.values[testCase.environment ?? "default"];
      expect(values).toBeDefined();

      const expression = parseSettingExpression(testCase.source);

      if (testCase.error) {
        expect(() => expression.evaluate(values)).toThrow();
        return;
      }
      expect(expression.evaluate(values)).toBe(testCase.expect);
    });
  }
});

describe("parseSettingExpression", () => {
  it("throws on a syntax error", () => {
    expect(() => parseSettingExpression(`settings["map"] ==`)).toThrow();
  });

  it("throws when the result is not a boolean", () => {
    const expression = parseSettingExpression(`settings["round-time"]`);
    expect(() => expression.evaluate({ "round-time": 120 })).toThrow(
      /expected a boolean/,
    );
  });

  it("is reusable across different values", () => {
    const expression = parseSettingExpression(`settings["round-time"] > 60`);
    expect(expression.evaluate({ "round-time": 120 })).toBe(true);
    expect(expression.evaluate({ "round-time": 30 })).toBe(false);
  });

  it("exposes its source", () => {
    expect(parseSettingExpression(`settings["bots"]`).source).toBe(
      `settings["bots"]`,
    );
  });
});

describe("tryParseSettingExpression", () => {
  it("returns null for absent and blank sources", () => {
    expect(tryParseSettingExpression(undefined)).toBeNull();
    expect(tryParseSettingExpression("   ")).toBeNull();
  });

  it("returns null rather than throwing on a malformed source", () => {
    expect(tryParseSettingExpression(`settings[`)).toBeNull();
  });
});

const declarations: SettingDeclaration[] = [
  { key: "bots", type: "BOOLEAN", bool: { defaultValue: true } },
  {
    key: "bot-count",
    type: "NUMBER",
    number: { min: 1, max: 8, step: 1, defaultValue: 4 },
    enabledWhen: `settings["bots"]`,
  },
  {
    key: "modifiers",
    type: "SELECT",
    select: {
      multiple: true,
      options: [{ value: "fast", label: "Fast" }],
      defaultValue: [],
    },
  },
];

describe("compileSettingExpressions", () => {
  it("gates a setting on another setting's value", () => {
    const compiled = compileSettingExpressions(declarations);

    expect(isSettingEnabled(compiled, "bot-count", { bots: true })).toBe(true);
    expect(isSettingEnabled(compiled, "bot-count", { bots: false })).toBe(
      false,
    );
  });

  it("treats a setting with no expression as always editable", () => {
    const compiled = compileSettingExpressions(declarations);
    expect(isSettingEnabled(compiled, "bots", { bots: false })).toBe(true);
    expect(isSettingEnabled(compiled, "unknown", {})).toBe(true);
  });

  it("gates validity on the version expression", () => {
    const compiled = compileSettingExpressions(
      declarations,
      `size(settings["modifiers"]) > 0`,
    );

    expect(areSettingsValid(compiled, { modifiers: [] })).toBe(false);
    expect(areSettingsValid(compiled, { modifiers: ["fast"] })).toBe(true);
  });

  it("treats a version with no expression as always valid", () => {
    expect(areSettingsValid(compileSettingExpressions(declarations), {})).toBe(
      true,
    );
  });

  // A published expression is validated, so a runtime failure means a bug on
  // our side; blocking play on that would be worse than allowing it.
  it("fails open when evaluation throws", () => {
    const compiled = compileSettingExpressions(
      declarations,
      `settings["missing"]`,
    );
    expect(areSettingsValid(compiled, {})).toBe(true);
  });

  it("fails open for a setting whose expression throws", () => {
    const compiled = compileSettingExpressions([
      { key: "a", type: "BOOLEAN", enabledWhen: `settings["missing"]` },
    ]);
    expect(isSettingEnabled(compiled, "a", {})).toBe(true);
  });
});
