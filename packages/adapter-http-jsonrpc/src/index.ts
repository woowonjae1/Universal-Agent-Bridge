import {
  AdapterError,
  type AdapterHealth,
  type AgentRuntimeAdapter,
  type RuntimeCapabilities,
  type RuntimeMethodDefinition
} from "@uab/adapter-sdk";
import {
  BRIDGE_ERROR_CODES,
  type BridgeResponse,
  type JsonValue
} from "@uab/protocol";

export interface HttpJsonRpcAdapterOptions {
  id: string;
  name?: string;
  baseUrl: string;
  rpcPath?: string;
  methodsPath?: string;
  capabilitiesPath?: string;
  healthPath?: string;
  token?: string;
  timeoutMs?: number;
  defaultCapabilities?: RuntimeCapabilities;
  defaultMethods?: RuntimeMethodDefinition[];
}

interface RuntimeDiscoveryPayload {
  capabilities?: RuntimeCapabilities;
  methods?: RuntimeMethodDefinition[];
}

export function createHttpJsonRpcAdapter(
  options: HttpJsonRpcAdapterOptions
): AgentRuntimeAdapter {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const rpcPath = options.rpcPath ?? "/rpc";
  const methodsPath = options.methodsPath ?? "/methods";
  const capabilitiesPath = options.capabilitiesPath ?? "/capabilities";
  const healthPath = options.healthPath ?? "/health";
  const timeoutMs = options.timeoutMs ?? 15_000;

  return {
    info: {
      id: options.id,
      name: options.name ?? options.id,
      description: `HTTP JSON-RPC adapter for ${baseUrl}`
    },
    async capabilities() {
      const discovery = await fetchOptional<RuntimeDiscoveryPayload | RuntimeCapabilities>(
        buildUrl(baseUrl, capabilitiesPath),
        options.token,
        timeoutMs
      );

      if (isDiscoveryPayload(discovery) && discovery.capabilities) {
        return discovery.capabilities;
      }
      if (isCapabilities(discovery)) return discovery;

      return options.defaultCapabilities ?? {
        system: { read: true }
      };
    },
    async methods() {
      const discovery = await fetchOptional<RuntimeDiscoveryPayload | RuntimeMethodDefinition[]>(
        buildUrl(baseUrl, methodsPath),
        options.token,
        timeoutMs
      );

      if (Array.isArray(discovery)) return discovery;
      if (isDiscoveryPayload(discovery) && Array.isArray(discovery.methods)) {
        return discovery.methods;
      }

      return options.defaultMethods ?? [
        {
          name: "system.ping",
          title: "Ping runtime",
          capability: "system",
          risk: "read",
          paramsExample: {}
        }
      ];
    },
    async health(): Promise<AdapterHealth> {
      const health = await fetchOptional<AdapterHealth>(
        buildUrl(baseUrl, healthPath),
        options.token,
        timeoutMs
      );

      return health ?? {
        status: "degraded",
        details: {
          reason: "Health endpoint did not return a bridge-compatible response."
        }
      };
    },
    async call(request, context) {
      const response = await postJson<BridgeResponse>(
        buildUrl(baseUrl, rpcPath),
        {
          jsonrpc: "2.0",
          id: context.requestId,
          method: request.method,
          params: request.params ?? {},
          meta: {
            ...request.meta,
            traceId: context.traceId,
            source: request.meta?.source ?? "universal-agent-bridge"
          }
        },
        options.token,
        timeoutMs,
        context.signal
      );

      if ("error" in response) {
        throw new AdapterError(response.error.message, {
          code: response.error.code,
          data: response.error.data
        });
      }

      return response.result;
    }
  };
}

async function fetchOptional<T>(
  url: string,
  token: string | undefined,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<T | undefined> {
  try {
    const response = await fetchWithTimeout(url, {
      method: "GET",
      headers: buildHeaders(token)
    }, timeoutMs, signal);

    if (!response.ok) return undefined;
    return await response.json() as T;
  } catch {
    return undefined;
  }
}

async function postJson<T>(
  url: string,
  payload: unknown,
  token: string | undefined,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<T> {
  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: buildHeaders(token),
    body: JSON.stringify(payload)
  }, timeoutMs, signal);

  const data = await response.json().catch(() => undefined) as T | undefined;

  if (!response.ok) {
    throw new AdapterError(`HTTP runtime returned ${response.status}.`, {
      code: BRIDGE_ERROR_CODES.adapterUnavailable,
      data: data === undefined ? undefined : data as JsonValue
    });
  }

  if (data === undefined) {
    throw new AdapterError("HTTP runtime returned an empty response.", {
      code: BRIDGE_ERROR_CODES.adapterUnavailable
    });
  }

  return data;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  upstream?: AbortSignal
): Promise<Response> {
  const { signal, dispose } = createRequestSignal(timeoutMs, upstream);

  try {
    return await fetch(url, {
      ...init,
      signal
    });
  } finally {
    dispose();
  }
}

function createRequestSignal(
  timeoutMs: number,
  upstream?: AbortSignal
): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const onAbort = () => controller.abort(createAbortError(upstream?.reason, "HTTP JSON-RPC request aborted."));
  const timeout = setTimeout(() => {
    controller.abort(createAbortError(undefined, `HTTP JSON-RPC request timed out after ${timeoutMs}ms.`));
  }, timeoutMs);

  if (upstream?.aborted) {
    controller.abort(createAbortError(upstream.reason, "HTTP JSON-RPC request aborted."));
  } else {
    upstream?.addEventListener("abort", onAbort, { once: true });
  }

  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timeout);
      upstream?.removeEventListener("abort", onAbort);
    }
  };
}

function createAbortError(reason: unknown, fallbackMessage: string): Error {
  const message = reason instanceof Error
    ? reason.message
    : typeof reason === "string"
      ? reason
      : fallbackMessage;
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function buildHeaders(token: string | undefined): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {})
  };
}

function buildUrl(baseUrl: string, path: string): string {
  if (/^https?:\/\//.test(path)) return path;
  return `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
}

function isCapabilities(value: unknown): value is RuntimeCapabilities {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isDiscoveryPayload(value: unknown): value is RuntimeDiscoveryPayload {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
