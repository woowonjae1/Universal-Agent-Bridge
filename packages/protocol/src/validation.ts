import type { BridgeRequest, BridgeRequestId, JsonValue } from "./types.js";

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function isBridgeRequestId(value: unknown): value is BridgeRequestId {
  return value === null || typeof value === "string" || typeof value === "number";
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return Number.isFinite(value) || typeof value !== "number";
  }

  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }

  if (isJsonObject(value)) {
    return Object.values(value).every(
      (entry) => entry === undefined || isJsonValue(entry)
    );
  }

  return false;
}

export function isBridgeRequest(value: unknown): value is BridgeRequest {
  if (!isJsonObject(value)) return false;
  if (value.jsonrpc !== "2.0") return false;
  if (value.id !== undefined && !isBridgeRequestId(value.id)) return false;
  if (typeof value.runtime !== "string" || value.runtime.trim() === "") return false;
  if (typeof value.method !== "string" || value.method.trim() === "") return false;
  if (value.params !== undefined && !isJsonValue(value.params)) return false;
  if (value.meta !== undefined && !isJsonObject(value.meta)) return false;
  return true;
}

export function extractRequestId(value: unknown): BridgeRequestId {
  if (!isJsonObject(value)) return null;
  return isBridgeRequestId(value.id) ? value.id : null;
}

