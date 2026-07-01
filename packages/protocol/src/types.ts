export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;
export type JsonObject = { [key: string]: JsonValue };
export type JsonArray = JsonValue[];

export type BridgeRequestId = string | number | null;

export interface BridgeRequestMeta {
  traceId?: string;
  source?: string;
  timeoutMs?: number;
  [key: string]: JsonValue | undefined;
}

export interface BridgeSessionRef {
  id: string;
  action?: "create" | "resume";
  metadata?: JsonObject;
}

export interface BridgeRequest {
  jsonrpc: "2.0";
  id?: BridgeRequestId;
  runtime?: string;
  capability?: string;
  session?: BridgeSessionRef;
  method: string;
  params?: JsonValue;
  meta?: BridgeRequestMeta;
}

export interface BridgeError {
  code: number;
  message: string;
  data?: JsonValue;
}

export interface BridgeSuccessResponse {
  jsonrpc: "2.0";
  id: BridgeRequestId;
  result: JsonValue;
}

export interface BridgeErrorResponse {
  jsonrpc: "2.0";
  id: BridgeRequestId;
  error: BridgeError;
}

export type BridgeResponse = BridgeSuccessResponse | BridgeErrorResponse;
