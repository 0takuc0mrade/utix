/**
 * Soroban RPC failure taxonomy.
 *
 * Maps JSON-RPC error codes (from `core/rpc/client.ts`) and transport failures
 * to stable `ProblemCode` values. Every feature that calls Soroban RPC should
 * map its transport errors through `classifyRpcError` so error handling stays
 * consistent across slices.
 *
 * Safe-message invariants
 * ───────────────────────
 * - `safeMessage` is always derived from the internal taxonomy; raw RPC error
 *   messages are never forwarded to the caller.
 * - `rawCode` and `rawMessage` are carried internally for diagnostics but must
 *   not be rendered in user-facing UI.
 */

import { RPC_STANDARD_CODES, type JsonRpcFailure } from "@/core/rpc/client";
import type { ProblemCode } from "@/core/errors/problem-details";

export type RpcErrorCode =
  | "rpc_parse_error"
  | "rpc_invalid_request"
  | "rpc_method_not_found"
  | "rpc_invalid_params"
  | "rpc_server_error"
  | "rpc_network_unavailable"
  | "rpc_timeout"
  | "rpc_unknown";

export interface RpcErrorClassification {
  /** Stable Utix error code (matches ProblemCode). */
  code: RpcErrorCode;
  /** The ProblemCode this maps to (always identical to `code` for RPC errors). */
  problemCode: ProblemCode;
  /** Whether the caller can safely retry. */
  retryable: boolean;
  /** Safe, pre-sanitised message; never echoes raw RPC error text. */
  safeMessage: string;
  /** Correlation ID for tracing. */
  correlationId: string;
  /**
   * Internal diagnostics only — never render in user-facing UI.
   * Carries the original JSON-RPC error code for logging.
   */
  rawCode?: number;
}

const safeMessages: Record<RpcErrorCode, string> = {
  rpc_parse_error:
    "The Soroban RPC request could not be parsed. Check the request format and try again.",
  rpc_invalid_request:
    "The Soroban RPC request was invalid. Check the JSON-RPC envelope and try again.",
  rpc_method_not_found:
    "The requested Soroban RPC method does not exist on this node.",
  rpc_invalid_params:
    "The parameters supplied to the Soroban RPC method are invalid.",
  rpc_server_error:
    "The Soroban RPC node returned an internal error. Try again shortly.",
  rpc_network_unavailable:
    "The connection to the Soroban RPC node could not be established. Check your connection.",
  rpc_timeout:
    "The Soroban RPC node did not respond in time. Try again.",
  rpc_unknown:
    "An unexpected error was returned by the Soroban RPC node. Try again or contact support."
};

const retryable: Record<RpcErrorCode, boolean> = {
  rpc_parse_error: false,
  rpc_invalid_request: false,
  rpc_method_not_found: false,
  rpc_invalid_params: false,
  rpc_server_error: true,
  rpc_network_unavailable: true,
  rpc_timeout: true,
  rpc_unknown: false
};

function correlationId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `rpc-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Classifies a raw JSON-RPC error code (from `RPC_STANDARD_CODES` or an HTTP
 * status) into a stable `RpcErrorClassification`.
 */
function classifyRpcCode(code: number): RpcErrorCode {
  switch (code) {
    case RPC_STANDARD_CODES.PARSE_ERROR:
      return "rpc_parse_error";
    case RPC_STANDARD_CODES.INVALID_REQUEST:
    case RPC_STANDARD_CODES.MALFORMED_ENVELOPE:
      return "rpc_invalid_request";
    case RPC_STANDARD_CODES.METHOD_NOT_FOUND:
      return "rpc_method_not_found";
    case RPC_STANDARD_CODES.INVALID_PARAMS:
      return "rpc_invalid_params";
    case RPC_STANDARD_CODES.INTERNAL_ERROR:
      return "rpc_server_error";
    default:
      // HTTP 429 → rate-limit → treat as server-side and retryable
      if (code === 429) return "rpc_server_error";
      // HTTP 5xx range
      if (code >= 500 && code < 600) return "rpc_server_error";
      return "rpc_unknown";
  }
}

/**
 * Classifies a `JsonRpcFailure` into a stable `RpcErrorClassification`.
 *
 * The raw error message in the `JsonRpcFailure` is intentionally dropped;
 * callers receive only the safe taxonomy message.
 */
export function classifyRpcError(failure: JsonRpcFailure): RpcErrorClassification {
  const rpcCode = classifyRpcCode(failure.error.code);
  return {
    code: rpcCode,
    problemCode: rpcCode as ProblemCode,
    retryable: retryable[rpcCode],
    safeMessage: safeMessages[rpcCode],
    correlationId: correlationId(),
    rawCode: failure.error.code
  };
}

/**
 * Classifies a transport-level failure (network error, abort, timeout) into a
 * stable `RpcErrorClassification`.
 *
 * Pass the raw `Error` object; only the error type is inspected, never the
 * message text, which may contain user data or internal paths.
 */
export function classifyRpcTransportError(error: unknown): RpcErrorClassification {
  let rpcCode: RpcErrorCode = "rpc_unknown";

  if (error instanceof Error) {
    const name = error.name.toLowerCase();
    const message = error.message.toLowerCase();

    if (name === "aborterror" || message.includes("abort")) {
      rpcCode = "rpc_timeout";
    } else if (
      name === "typeerror" ||
      message.includes("fetch") ||
      message.includes("network") ||
      message.includes("failed to fetch")
    ) {
      rpcCode = "rpc_network_unavailable";
    } else if (message.includes("timeout") || message.includes("timed out")) {
      rpcCode = "rpc_timeout";
    }
  }

  return {
    code: rpcCode,
    problemCode: rpcCode as ProblemCode,
    retryable: retryable[rpcCode],
    safeMessage: safeMessages[rpcCode],
    correlationId: correlationId()
  };
}
