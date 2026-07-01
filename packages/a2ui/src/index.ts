import { isJsonObject, isJsonValue, type JsonObject, type JsonValue } from "@uab/protocol";

export const A2UI_EVENT_NAME = "a2ui.envelope";

export const A2UI_ENVELOPE_TYPES = [
  "createSurface",
  "updateComponents",
  "updateDataModel",
  "deleteSurface",
  "actionResponse",
  "callFunction"
] as const;

export type A2uiEnvelopeType = (typeof A2UI_ENVELOPE_TYPES)[number];

export const A2UI_COMPONENT_TYPES = [
  "surface",
  "card",
  "heading",
  "text",
  "button",
  "input",
  "form",
  "list",
  "table",
  "stat",
  "row",
  "column",
  "divider"
] as const;

export type A2uiComponentType = (typeof A2UI_COMPONENT_TYPES)[number];

export interface A2uiComponent {
  id?: string;
  type: A2uiComponentType;
  title?: string;
  text?: string;
  label?: string;
  name?: string;
  value?: JsonValue;
  placeholder?: string;
  variant?: "primary" | "secondary" | "danger" | "ghost";
  columns?: string[];
  rows?: JsonObject[];
  items?: JsonValue[];
  children?: A2uiComponent[];
  action?: A2uiAction;
  props?: JsonObject;
}

export interface A2uiAction {
  type: "submit" | "callFunction" | "rpc" | "link";
  name?: string;
  label?: string;
  params?: JsonObject;
}

export interface A2uiEnvelope {
  version: "1.0" | "0.9.1" | string;
  type: A2uiEnvelopeType;
  surfaceId: string;
  components?: A2uiComponent[];
  dataModel?: JsonObject;
  actions?: A2uiAction[];
  payload?: JsonValue;
  meta?: JsonObject;
}

export interface A2uiSanitizeOptions {
  maxDepth?: number;
  maxComponents?: number;
  maxTextLength?: number;
}

interface SanitizeState extends Required<A2uiSanitizeOptions> {
  componentCount: number;
}

const DEFAULT_OPTIONS: Required<A2uiSanitizeOptions> = {
  maxDepth: 6,
  maxComponents: 80,
  maxTextLength: 4_000
};

const ENVELOPE_TYPES = new Set<string>(A2UI_ENVELOPE_TYPES);
const COMPONENT_TYPES = new Set<string>(A2UI_COMPONENT_TYPES);
const ACTION_TYPES = new Set<string>(["submit", "callFunction", "rpc", "link"]);
const VARIANTS = new Set<string>(["primary", "secondary", "danger", "ghost"]);

export function isA2uiEnvelope(value: unknown): value is A2uiEnvelope {
  if (!isJsonObject(value)) return false;
  if (typeof value.version !== "string" || value.version.trim() === "") return false;
  if (typeof value.type !== "string" || !ENVELOPE_TYPES.has(value.type)) return false;
  if (typeof value.surfaceId !== "string" || value.surfaceId.trim() === "") return false;
  return true;
}

export function sanitizeA2uiEnvelope(
  value: unknown,
  options: A2uiSanitizeOptions = {}
): A2uiEnvelope | undefined {
  if (!isA2uiEnvelope(value)) return undefined;

  const state: SanitizeState = {
    ...DEFAULT_OPTIONS,
    ...options,
    componentCount: 0
  };
  const input = value as A2uiEnvelope & Record<string, unknown>;
  const envelope: A2uiEnvelope = {
    version: clampText(input.version, state.maxTextLength),
    type: input.type as A2uiEnvelopeType,
    surfaceId: clampText(input.surfaceId, 160)
  };

  if (Array.isArray(input.components)) {
    envelope.components = input.components
      .map((component) => sanitizeComponent(component, 0, state))
      .filter((component): component is A2uiComponent => Boolean(component));
  }

  if (isJsonObject(input.dataModel)) {
    envelope.dataModel = sanitizeJsonObject(input.dataModel, state.maxDepth, state.maxTextLength);
  }

  if (Array.isArray(input.actions)) {
    envelope.actions = input.actions
      .slice(0, state.maxComponents)
      .map((action) => sanitizeAction(action, state))
      .filter((action): action is A2uiAction => Boolean(action));
  }

  if (input.payload !== undefined && isJsonValue(input.payload)) {
    envelope.payload = sanitizeJsonValue(input.payload, state.maxDepth, state.maxTextLength);
  }

  if (isJsonObject(input.meta)) {
    envelope.meta = sanitizeJsonObject(input.meta, state.maxDepth, state.maxTextLength);
  }

  return envelope;
}

export function extractA2uiEnvelope(
  value: unknown,
  options?: A2uiSanitizeOptions
): A2uiEnvelope | undefined {
  const direct = sanitizeA2uiEnvelope(value, options);
  if (direct) return direct;

  if (!isJsonObject(value)) return undefined;

  const a2ui = sanitizeA2uiEnvelope(value.a2ui, options);
  if (a2ui) return a2ui;

  const ui = sanitizeA2uiEnvelope(value.ui, options);
  if (ui) return ui;

  return undefined;
}

export function createA2uiAgUiCustomValue(envelope: A2uiEnvelope): JsonObject {
  return JSON.parse(JSON.stringify(envelope)) as JsonObject;
}

function sanitizeComponent(
  value: unknown,
  depth: number,
  state: SanitizeState
): A2uiComponent | undefined {
  if (depth > state.maxDepth || state.componentCount >= state.maxComponents) return undefined;
  if (!isJsonObject(value) || typeof value.type !== "string" || !COMPONENT_TYPES.has(value.type)) {
    return undefined;
  }

  state.componentCount += 1;
  const input = value as Record<string, unknown>;
  const component: A2uiComponent = {
    type: input.type as A2uiComponentType
  };

  component.id = sanitizeOptionalString(input.id, 160, state);
  component.title = sanitizeOptionalString(input.title, state.maxTextLength, state);
  component.text = sanitizeOptionalString(input.text, state.maxTextLength, state);
  component.label = sanitizeOptionalString(input.label, state.maxTextLength, state);
  component.name = sanitizeOptionalString(input.name, 160, state);
  component.placeholder = sanitizeOptionalString(input.placeholder, state.maxTextLength, state);

  if (typeof input.variant === "string" && VARIANTS.has(input.variant)) {
    component.variant = input.variant as A2uiComponent["variant"];
  }

  if (input.value !== undefined && isJsonValue(input.value)) {
    component.value = sanitizeJsonValue(input.value, state.maxDepth - depth, state.maxTextLength);
  }

  if (Array.isArray(input.columns)) {
    component.columns = input.columns
      .filter((entry): entry is string => typeof entry === "string")
      .slice(0, 24)
      .map((entry) => clampText(entry, 120));
  }

  if (Array.isArray(input.rows)) {
    component.rows = input.rows
      .filter(isJsonObject)
      .slice(0, 100)
      .map((row) => sanitizeJsonObject(row, 3, state.maxTextLength));
  }

  if (Array.isArray(input.items)) {
    component.items = input.items
      .filter(isJsonValue)
      .slice(0, 100)
      .map((entry) => sanitizeJsonValue(entry, 3, state.maxTextLength));
  }

  if (Array.isArray(input.children)) {
    component.children = input.children
      .map((child) => sanitizeComponent(child, depth + 1, state))
      .filter((child): child is A2uiComponent => Boolean(child));
  }

  const action = sanitizeAction(input.action, state);
  if (action) {
    component.action = action;
  }

  if (isJsonObject(input.props)) {
    component.props = sanitizeJsonObject(input.props, 3, state.maxTextLength);
  }

  return component;
}

function sanitizeAction(value: unknown, state: SanitizeState): A2uiAction | undefined {
  if (!isJsonObject(value) || typeof value.type !== "string" || !ACTION_TYPES.has(value.type)) {
    return undefined;
  }

  const input = value as Record<string, unknown>;
  const action: A2uiAction = {
    type: input.type as A2uiAction["type"]
  };

  action.name = sanitizeOptionalString(input.name, 160, state);
  action.label = sanitizeOptionalString(input.label, state.maxTextLength, state);

  if (isJsonObject(input.params)) {
    action.params = sanitizeJsonObject(input.params, 3, state.maxTextLength);
  }

  return action;
}

function sanitizeOptionalString(
  value: unknown,
  maxLength: number,
  state: SanitizeState
): string | undefined {
  if (typeof value === "string") {
    return clampText(value, Math.min(maxLength, state.maxTextLength));
  }
  return undefined;
}

function sanitizeJsonObject(
  value: Record<string, unknown>,
  depth: number,
  maxTextLength: number
): JsonObject {
  if (depth <= 0) return {};

  const output: JsonObject = {};
  for (const [key, entry] of Object.entries(value)) {
    if (shouldDropKey(key) || entry === undefined || !isJsonValue(entry)) continue;
    output[clampText(key, 120)] = sanitizeJsonValue(entry, depth - 1, maxTextLength);
  }
  return output;
}

function sanitizeJsonValue(value: JsonValue, depth: number, maxTextLength: number): JsonValue {
  if (typeof value === "string") return clampText(value, maxTextLength);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) {
    if (depth <= 0) return [];
    return value.slice(0, 100).map((entry) => sanitizeJsonValue(entry, depth - 1, maxTextLength));
  }
  return sanitizeJsonObject(value, depth, maxTextLength);
}

function shouldDropKey(key: string): boolean {
  const lower = key.toLowerCase();
  return lower === "__proto__" ||
    lower === "constructor" ||
    lower === "prototype" ||
    lower.startsWith("on") ||
    lower.includes("script") ||
    lower.includes("html");
}

function clampText(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}
