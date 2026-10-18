import { DEFAULT_NETWORK, SOROBAN_RPC_URLS } from "@/core/network/config";
import type { StellarNetwork } from "@/core/network/types";

export interface JsonRpcSuccess<T> {
  jsonrpc: "2.0";
  id: number | string;
  result: T;
}

export interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: number | string | null;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcResponse<T> = JsonRpcSuccess<T> | JsonRpcFailure;

export const RPC_STANDARD_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  MALFORMED_ENVELOPE: -32000
} as const;

let requestId = 0;

/**
 * Validates untrusted JSON-RPC payload and parses it into a typed JsonRpcResponse.
 * Returns a typed JsonRpcFailure if envelope constraints are violated.
 */
export function parseJsonRpcResponse<T>(
  payload: unknown,
  expectedId?: number | string
): JsonRpcResponse<T> {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return {
      jsonrpc: "2.0",
      id: null,
      error: {
        code: RPC_STANDARD_CODES.INVALID_REQUEST,
        message: "Malformed JSON-RPC response: payload must be a non-null object",
        data: payload
      }
    };
  }

  const obj = payload as Record<string, unknown>;

  if (obj.jsonrpc !== "2.0") {
    const rawId = obj.id;
    const safeId = typeof rawId === "number" || typeof rawId === "string" ? rawId : null;
    return {
      jsonrpc: "2.0",
      id: safeId,
      error: {
        code: RPC_STANDARD_CODES.INVALID_REQUEST,
        message: 'Malformed JSON-RPC response: missing or invalid jsonrpc version (must be "2.0")',
        data: payload
      }
    };
  }

  const rawId = obj.id;
  const isIdValid =
    rawId === null || typeof rawId === "string" || typeof rawId === "number";

  if (!isIdValid) {
    return {
      jsonrpc: "2.0",
      id: null,
      error: {
        code: RPC_STANDARD_CODES.INVALID_REQUEST,
        message: "Malformed JSON-RPC response: id must be a string, number, or null",
        data: payload
      }
    };
  }

  if (expectedId !== undefined && rawId !== null && rawId !== expectedId) {
    return {
      jsonrpc: "2.0",
      id: rawId,
      error: {
        code: RPC_STANDARD_CODES.INVALID_REQUEST,
        message: `Malformed JSON-RPC response: id mismatch (expected ${expectedId}, received ${rawId})`,
        data: payload
      }
    };
  }

  const hasResult = "result" in obj;
  const hasError = "error" in obj;

  if (hasResult && hasError) {
    return {
      jsonrpc: "2.0",
      id: rawId,
      error: {
        code: RPC_STANDARD_CODES.INVALID_REQUEST,
        message: "Malformed JSON-RPC response: payload cannot contain both result and error",
        data: payload
      }
    };
  }

  if (!hasResult && !hasError) {
    return {
      jsonrpc: "2.0",
      id: rawId,
      error: {
        code: RPC_STANDARD_CODES.INVALID_REQUEST,
        message: "Malformed JSON-RPC response: payload must contain either result or error",
        data: payload
      }
    };
  }

  if (hasError) {
    const err = obj.error;
    if (
      err === null ||
      typeof err !== "object" ||
      // JSON-RPC 2.0 §5.1: the error code MUST be an integer.
      !Number.isInteger((err as Record<string, unknown>).code) ||
      typeof (err as Record<string, unknown>).message !== "string"
    ) {
      return {
        jsonrpc: "2.0",
        id: rawId,
        error: {
          code: RPC_STANDARD_CODES.INVALID_REQUEST,
          message: "Malformed JSON-RPC response: error field must be an object with integer code and string message",
          data: err
        }
      };
    }

    return {
      jsonrpc: "2.0",
      id: rawId,
      error: {
        code: (err as Record<string, unknown>).code as number,
        message: (err as Record<string, unknown>).message as string,
        data: (err as Record<string, unknown>).data
      }
    };
  }

  if (rawId === null) {
    return {
      jsonrpc: "2.0",
      id: null,
      error: {
        code: RPC_STANDARD_CODES.INVALID_REQUEST,
        message: "Malformed JSON-RPC response: successful response must have a non-null id",
        data: payload
      }
    };
  }

  return {
    jsonrpc: "2.0",
    id: rawId,
    result: obj.result as T
  };
}

/**
 * Public discriminator to safely determine whether an RPC response is a failure or malformed.
 */
export function isRpcFailure<T>(value: JsonRpcResponse<T> | unknown): value is JsonRpcFailure {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return "error" in candidate && candidate.error !== null && typeof candidate.error === "object";
}

/**
 * Minimal JSON-RPC caller for Soroban RPC.
 *
 * Feature slices wrap this with their own typed method helpers rather than
 * calling it directly from components.
 */
export async function sorobanRpc<T>(
  method: string,
  params: unknown = {},
  options: { network?: StellarNetwork; signal?: AbortSignal } = {}
): Promise<JsonRpcResponse<T>> {
  const network = options.network ?? DEFAULT_NETWORK;
  requestId += 1;
  const currentId = requestId;

  let response: Response;
  try {
    response = await fetch(SOROBAN_RPC_URLS[network], {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: currentId, method, params }),
      signal: options.signal
    });
  } catch (err: unknown) {
    return {
      jsonrpc: "2.0",
      id: currentId,
      error: {
        code: RPC_STANDARD_CODES.INTERNAL_ERROR,
        message: err instanceof Error ? err.message : "Network fetch failed",
        data: err
      }
    };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (err: unknown) {
    return {
      jsonrpc: "2.0",
      id: currentId,
      error: {
        code: RPC_STANDARD_CODES.PARSE_ERROR,
        message: `Failed to parse RPC response JSON (HTTP ${response.status})`,
        data: err
      }
    };
  }

  if (!response.ok && !isRpcFailure(body)) {
    return {
      jsonrpc: "2.0",
      id: currentId,
      error: {
        code: response.status,
        message: `Soroban RPC responded with HTTP ${response.status}`,
        data: body
      }
    };
  }

  return parseJsonRpcResponse<T>(body, currentId);
}
