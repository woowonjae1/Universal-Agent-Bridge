import { BRIDGE_ERROR_CODES } from "./errors.js";
import type {
  BridgeError,
  BridgeRequest,
  BridgeRequestId,
  BridgeResponse,
  JsonValue
} from "./types.js";

export function createSuccessResponse(
  request: Pick<BridgeRequest, "id">,
  result: JsonValue
): BridgeResponse {
  return {
    jsonrpc: "2.0",
    id: request.id ?? null,
    result
  };
}

export function createErrorResponse(input: {
  id?: BridgeRequestId;
  code?: number;
  message: string;
  data?: JsonValue;
}): BridgeResponse {
  const error: BridgeError = {
    code: input.code ?? BRIDGE_ERROR_CODES.internalError,
    message: input.message
  };

  if (input.data !== undefined) {
    error.data = input.data;
  }

  return {
    jsonrpc: "2.0",
    id: input.id ?? null,
    error
  };
}

export function isErrorResponse(response: BridgeResponse): boolean {
  return "error" in response;
}

export function isSuccessResponse(response: BridgeResponse): boolean {
  return "result" in response;
}

