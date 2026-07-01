import type { JsonValue } from "./types.js";

export const BRIDGE_ERROR_CODES = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  runtimeNotFound: -32001,
  permissionDenied: -32003,
  adapterUnavailable: -32004,
  timeout: -32005
} as const;

export type BridgeErrorCode =
  (typeof BRIDGE_ERROR_CODES)[keyof typeof BRIDGE_ERROR_CODES];

export class BridgeProtocolError extends Error {
  readonly code: BridgeErrorCode | number;
  readonly data?: JsonValue;

  constructor(code: BridgeErrorCode | number, message: string, data?: JsonValue) {
    super(message);
    this.name = "BridgeProtocolError";
    this.code = code;
    this.data = data;
  }
}

