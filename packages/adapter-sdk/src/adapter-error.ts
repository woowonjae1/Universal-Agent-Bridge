import { BRIDGE_ERROR_CODES } from "@uab/protocol";
import type { JsonValue } from "@uab/protocol";

export class AdapterError extends Error {
  readonly code: number;
  readonly data?: JsonValue;

  constructor(
    message: string,
    options: { code?: number; data?: JsonValue } = {}
  ) {
    super(message);
    this.name = "AdapterError";
    this.code = options.code ?? BRIDGE_ERROR_CODES.internalError;
    this.data = options.data;
  }
}

