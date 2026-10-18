import { SettingValue } from "./protocol";

// Re-exported so a consumer working with declarations and values needs only
// this module.
export type { SettingValue };

export type SettingType = "BOOLEAN" | "NUMBER" | "SELECT" | "TEXT";

export interface SettingOption {
  value: string;
  label: string;
}

// The settings a game version declares, mirroring the API's
// GameVersionSettingsItemDTO. The frontend passes its generated DTOs straight
// into these functions, so an incompatible change to the spec breaks that
// assignment at compile time.
export interface SettingDeclaration {
  key: string;
  type: SettingType;
  label?: string;
  description?: string;
  tab?: string;
  ui?: string;
  // CEL expression gating whether this setting may be changed; see
  // specs/expressions/grammar.md. Absent means always editable.
  enabledWhen?: string;
  bool?: { defaultValue: boolean };
  number?: { min: number; max: number; step: number; defaultValue: number };
  select?: {
    multiple: boolean;
    options: SettingOption[];
    defaultValue: string[];
  };
  text?: { defaultValue: string; maxLength?: number };
}

// Setting values are carried in the URL under this prefix, so they cannot
// collide with a page's own query parameters:
// ?s.friendly-fire=true&s.round-time=180
export const SETTING_QUERY_PREFIX = "s.";

// The read side of URLSearchParams, which is all reading settings from a URL
// needs. Next.js' ReadonlyURLSearchParams satisfies it too.
export interface SettingQuerySource {
  getAll(name: string): string[];
}

export function defaultSettingValues(
  declarations: SettingDeclaration[],
): Record<string, SettingValue> {
  const values: Record<string, SettingValue> = {};
  for (const declaration of declarations) {
    values[declaration.key] = defaultSettingValue(declaration);
  }
  return values;
}

function defaultSettingValue(declaration: SettingDeclaration): SettingValue {
  switch (declaration.type) {
    case "BOOLEAN":
      return declaration.bool?.defaultValue ?? false;
    case "NUMBER":
      return declaration.number?.defaultValue ?? 0;
    case "SELECT":
      return declaration.select?.multiple
        ? (declaration.select?.defaultValue ?? [])
        : (declaration.select?.defaultValue?.[0] ?? "");
    case "TEXT":
      return declaration.text?.defaultValue ?? "";
  }
}

// clampNumberSetting keeps a value inside the declared bounds and on a step
// boundary, so neither a slider nor a URL can produce a value the game did not
// declare as reachable.
export function clampNumberSetting(
  declaration: SettingDeclaration,
  value: number,
): number {
  const bounds = declaration.number;
  if (!bounds) return value;

  const steps = Math.round((value - bounds.min) / bounds.step);
  const stepped = bounds.min + steps * bounds.step;
  return Math.min(bounds.max, Math.max(bounds.min, stepped));
}

// settingValuesFromQuery starts from the declared defaults and overrides each
// setting a `s.<key>` query parameter supplies a usable value for. A malformed
// value is reported and left at its default rather than failing the whole URL,
// so one stale parameter in a shared link cannot make a game unstartable.
export function settingValuesFromQuery(
  declarations: SettingDeclaration[],
  query: SettingQuerySource,
): Record<string, SettingValue> {
  const values = defaultSettingValues(declarations);

  for (const declaration of declarations) {
    const raw = query.getAll(SETTING_QUERY_PREFIX + declaration.key);
    if (raw.length === 0) continue;

    const parsed = parseSettingValue(declaration, raw);
    if (parsed === undefined) {
      console.warn(
        `Ignoring the value the URL supplies for setting '${declaration.key}': it is not valid for a ${declaration.type} setting`,
      );
      continue;
    }
    values[declaration.key] = parsed;
  }

  return values;
}

function parseSettingValue(
  declaration: SettingDeclaration,
  raw: string[],
): SettingValue | undefined {
  // A repeated parameter is only meaningful for a multi-select; everywhere else
  // the last occurrence wins, matching how query parameters usually read.
  const last = raw[raw.length - 1];

  switch (declaration.type) {
    case "BOOLEAN":
      return parseBooleanSetting(last);
    case "NUMBER": {
      const value = Number(last.trim());
      if (last.trim() === "" || !Number.isFinite(value)) return undefined;
      return clampNumberSetting(declaration, value);
    }
    case "SELECT":
      return parseSelectSetting(declaration, raw);
    case "TEXT": {
      const maxLength = declaration.text?.maxLength;
      return maxLength === undefined ? last : last.slice(0, maxLength);
    }
  }
}

function parseBooleanSetting(raw: string): boolean | undefined {
  switch (raw.trim().toLowerCase()) {
    case "true":
    case "1":
      return true;
    case "false":
    case "0":
      return false;
    default:
      return undefined;
  }
}

// A select accepts repeated parameters and comma separated lists alike, so both
// ?s.modifiers=fast&s.modifiers=low_gravity and ?s.modifiers=fast,low_gravity
// select the same two options. An option the version does not declare rejects
// the whole value: silently dropping it would start the game with a different
// selection than the link asked for.
function parseSelectSetting(
  declaration: SettingDeclaration,
  raw: string[],
): SettingValue | undefined {
  const selectSetting = declaration.select;
  if (!selectSetting) return undefined;

  const declaredValues = selectSetting.options.map(
    (settingOption) => settingOption.value,
  );
  const requested = raw
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  if (requested.length === 0) return undefined;
  if (requested.some((value) => !declaredValues.includes(value))) {
    return undefined;
  }

  if (!selectSetting.multiple) {
    return requested.length === 1 ? requested[0] : undefined;
  }
  return Array.from(new Set(requested));
}
