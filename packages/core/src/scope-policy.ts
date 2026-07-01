import type { AgentRuntimeAdapter, Principal } from "@uab/adapter-sdk";
import type { BridgeRequest } from "@uab/protocol";

export interface AccessDecision {
  allow: boolean;
  reason?: string;
}

export interface AccessPolicyInput {
  request: BridgeRequest;
  adapter: AgentRuntimeAdapter;
  principal?: Principal;
}

export interface AccessPolicy {
  authorize(input: AccessPolicyInput): AccessDecision | Promise<AccessDecision>;
}

export class AllowAllAccessPolicy implements AccessPolicy {
  authorize(): AccessDecision {
    return { allow: true };
  }
}

export class ScopeAccessPolicy implements AccessPolicy {
  authorize(input: AccessPolicyInput): AccessDecision {
    const { request, principal } = input;

    if (!principal) {
      return {
        allow: false,
        reason: "Principal is required for scoped access."
      };
    }

    if (
      principal.runtimeAllowlist &&
      !principal.runtimeAllowlist.includes(request.runtime)
    ) {
      return {
        allow: false,
        reason: `Principal cannot access runtime '${request.runtime}'.`
      };
    }

    const requiredScope = methodToScope(request.method);
    if (hasScope(principal.scopes, requiredScope)) {
      return { allow: true };
    }

    return {
      allow: false,
      reason: `Missing required scope '${requiredScope}'.`
    };
  }
}

export function methodToScope(method: string): string {
  const [domain = "runtime", action = "call"] = method.split(".");
  const normalizedAction = action.toLowerCase();

  if (domain === "system" && ["restart", "stop", "doctorfix"].includes(normalizedAction)) {
    return `${domain}:admin`;
  }

  const writeActions = new Set([
    "add",
    "attach",
    "backup",
    "create",
    "delete",
    "disable",
    "enable",
    "import",
    "install",
    "mark",
    "publish",
    "reconnect",
    "remove",
    "rename",
    "reschedule",
    "run",
    "set",
    "update",
    "upload"
  ]);

  return `${domain}:${writeActions.has(normalizedAction) ? "write" : "read"}`;
}

export function hasScope(scopes: string[], requiredScope: string): boolean {
  const [domain] = requiredScope.split(":");
  return (
    scopes.includes("*") ||
    scopes.includes(requiredScope) ||
    scopes.includes(`${domain}:*`)
  );
}

