/**
 * RFC 7807 Problem Details taxonomy for Utix (#267).
 *
 * This module provides:
 *   1. `PROBLEM_CODES` — the stable machine-readable code registry. Never rename
 *      or remove a code; only add new ones. Consumers switch on codes, not on
 *      English strings.
 *   2. `ProblemDetails` — the RFC 7807-aligned response shape: `type`, `title`,
 *      `status`, `detail`, `instance?`, `correlationId`, `code`, `retryable`,
 *      `hint`, `extensions?`.
 *   3. `toProblemDetails()` — lifts a `HorizonErrorClassification` or a
 *      `RpcErrorClassification` into a `ProblemDetails` envelope.
 *   4. `problemDetailsFromCode()` — creates a `ProblemDetails` from a bare
 *      `ProblemCode`, taking an optional override for the `detail` field.
 *
 * Safe-message invariants
 * ───────────────────────
 * - No function here echoes user-supplied input.
 * - No raw Horizon or RPC error strings are forwarded to consumers.
 * - The `detail` field is always derived from the internal taxonomy, never from
 *   an untrusted source.
 *
 * Stability contract
 * ──────────────────
 * Once a code ships in `PROBLEM_CODES` it is permanent. To evolve meaning,
 * add a new code and document the old one as "superseded by <new-code>".
 */

// ─── RFC 7807 base type ───────────────────────────────────────────────────────

/**
 * A structured error response following RFC 7807 Problem Details for HTTP APIs.
 *
 * Extensions beyond RFC 7807:
 *   `code`      — stable machine-readable identifier (always lowercase_snake)
 *   `retryable` — whether repeating the request is safe
 *   `hint`      — actionable remediation hint aimed at the developer
 *   `correlationId` — passed through from the originating transport layer
 *   `extensions`    — open-ended map for future non-breaking additions
 */
export interface ProblemDetails {
  /** Absolute URI identifying the problem type (RFC 7807 §3.1). */
  type: string;
  /** Short, human-readable summary of the problem. */
  title: string;
  /** HTTP status code. */
  status: number;
  /** Human-readable, specific explanation of *this* occurrence. */
  detail: string;
  /** URI reference to the specific resource that caused the problem. */
  instance?: string;
  /** Stable machine-readable code that consumers switch on. */
  code: ProblemCode;
  /** Whether the caller can safely retry the request. */
  retryable: boolean;
  /** Actionable remediation hint for developers and support staff. */
  hint: string;
  /** Passed through from the originating transport layer. */
  correlationId?: string;
  /** Non-breaking extension fields for future additions. */
  extensions?: Record<string, unknown>;
}

// ─── Stable code registry ─────────────────────────────────────────────────────

/**
 * Internal definition backing each entry in `PROBLEM_CODES`.
 */
export interface ProblemDefinition {
  /** Lowercase snake-case stable identifier. Never rename once shipped. */
  readonly code: ProblemCode;
  /** Absolute URI type reference (RFC 7807 §3.1). */
  readonly type: string;
  /** Short summary line. */
  readonly title: string;
  /** HTTP status code for the wire response. */
  readonly status: number;
  /** Safe default detail string. Never includes user input or raw API errors. */
  readonly detail: string;
  /** Whether repeating the request is safe. */
  readonly retryable: boolean;
  /** Actionable remediation hint for developers. */
  readonly hint: string;
}

/**
 * Base URI for all Utix problem type URIs.
 * Consumers compare the full `type` string; the base is an implementation detail.
 */
const BASE_URI = "https://utix.dev/problems";

function uri(slug: string): string {
  return `${BASE_URI}/${slug}`;
}

// ─── Stable code literal union ────────────────────────────────────────────────

export type ProblemCode =
  // Validation
  | "validation_error"
  | "invalid_address"
  | "invalid_amount"
  | "invalid_asset_code"
  | "missing_required_field"
  // Stellar account
  | "account_not_found"
  | "account_unfunded"
  | "account_merge_ineligible"
  // Stellar asset / trustline
  | "asset_not_found"
  | "trustline_missing"
  | "trustline_limit_exceeded"
  | "trustline_no_issuer"
  // Stellar transaction
  | "transaction_not_found"
  | "transaction_malformed"
  | "transaction_failed"
  | "sequence_mismatch"
  | "insufficient_fee"
  | "precondition_failed"
  // Soroban / smart-contract
  | "soroban_simulation_failed"
  | "soroban_invocation_failed"
  | "soroban_resource_limit_exceeded"
  | "soroban_contract_not_found"
  | "xdr_decode_error"
  | "xdr_encode_error"
  // Horizon transport
  | "horizon_not_found"
  | "horizon_rate_limited"
  | "horizon_bad_request"
  | "horizon_server_error"
  | "horizon_network_unavailable"
  | "horizon_timeout"
  | "horizon_unknown"
  // Soroban RPC transport
  | "rpc_parse_error"
  | "rpc_invalid_request"
  | "rpc_method_not_found"
  | "rpc_invalid_params"
  | "rpc_server_error"
  | "rpc_network_unavailable"
  | "rpc_timeout"
  | "rpc_unknown"
  // Internal / unclassified
  | "internal_error";

// ─── PROBLEM_CODES registry ───────────────────────────────────────────────────

/**
 * Stable taxonomy of every problem code Utix may surface.
 *
 * Rules (strictly enforced by contract drift tests):
 *   1. Keys and `code` values are identical and must match `ProblemCode`.
 *   2. No code is ever removed; add a new one to supersede an old one.
 *   3. Codes are lowercase_snake; do NOT use UPPER_SNAKE here (the UPPER_SNAKE
 *      codes in `error-codes.ts` are an older, internal-only taxonomy).
 */
export const PROBLEM_CODES = {
  // ── Validation (400) ──────────────────────────────────────────────────────
  validation_error: {
    code: "validation_error",
    type: uri("validation-error"),
    title: "Validation Error",
    status: 400,
    detail: "One or more input values did not pass validation.",
    retryable: false,
    hint: "Check the field descriptions and correct the offending values before retrying."
  },
  invalid_address: {
    code: "invalid_address",
    type: uri("invalid-address"),
    title: "Invalid Stellar Address",
    status: 400,
    detail: "The supplied Stellar address is not a valid public key.",
    retryable: false,
    hint: "A Stellar public key starts with 'G' and is exactly 56 Base32 characters. Verify the address and try again."
  },
  invalid_amount: {
    code: "invalid_amount",
    type: uri("invalid-amount"),
    title: "Invalid Amount",
    status: 400,
    detail: "The amount is not a valid Stellar quantity.",
    retryable: false,
    hint: "Amounts must be positive, use at most 7 decimal places, and fit within Stellar's 64-bit fixed-point range (≤ 922,337,203,685.4775807)."
  },
  invalid_asset_code: {
    code: "invalid_asset_code",
    type: uri("invalid-asset-code"),
    title: "Invalid Asset Code",
    status: 400,
    detail: "The asset code does not conform to the Stellar asset format.",
    retryable: false,
    hint: "Asset codes are 1–12 alphanumeric characters. Native XLM has no code. Check spelling and try again."
  },
  missing_required_field: {
    code: "missing_required_field",
    type: uri("missing-required-field"),
    title: "Missing Required Field",
    status: 400,
    detail: "A required input field was not provided.",
    retryable: false,
    hint: "Check the API or tool documentation for the list of required fields and supply all of them."
  },

  // ── Stellar account (404 / 400) ───────────────────────────────────────────
  account_not_found: {
    code: "account_not_found",
    type: uri("account-not-found"),
    title: "Stellar Account Not Found",
    status: 404,
    detail: "No account exists at this address on the selected network.",
    retryable: false,
    hint: "Verify the address and the active network (mainnet vs testnet). A new address must be funded before Horizon can locate it."
  },
  account_unfunded: {
    code: "account_unfunded",
    type: uri("account-unfunded"),
    title: "Account Not Funded",
    status: 400,
    detail: "The account has not received its minimum XLM reserve and has never been activated.",
    retryable: false,
    hint: "Fund the account with at least the base reserve (currently 1 XLM) to activate it. Use the Testnet Faucet for testnet addresses."
  },
  account_merge_ineligible: {
    code: "account_merge_ineligible",
    type: uri("account-merge-ineligible"),
    title: "Account Merge Ineligible",
    status: 400,
    detail: "The account cannot be merged because it still holds sub-entries or open trustlines.",
    retryable: false,
    hint: "Remove all offers, trustlines, and data entries from the account before attempting a merge."
  },

  // ── Stellar asset / trustline (404 / 400) ────────────────────────────────
  asset_not_found: {
    code: "asset_not_found",
    type: uri("asset-not-found"),
    title: "Asset Not Found",
    status: 404,
    detail: "The requested asset does not exist on the selected network.",
    retryable: false,
    hint: "Verify the asset code and issuer address. Ensure you are on the correct network."
  },
  trustline_missing: {
    code: "trustline_missing",
    type: uri("trustline-missing"),
    title: "Trustline Missing",
    status: 400,
    detail: "The account does not have a trustline for the requested asset.",
    retryable: false,
    hint: "The receiving account must establish a trustline for the asset before it can hold a balance. Have the account send a Change Trust operation first."
  },
  trustline_limit_exceeded: {
    code: "trustline_limit_exceeded",
    type: uri("trustline-limit-exceeded"),
    title: "Trustline Limit Exceeded",
    status: 400,
    detail: "The operation would exceed the trustline's configured limit.",
    retryable: false,
    hint: "Increase the trustline limit via a Change Trust operation, or reduce the amount being transferred."
  },
  trustline_no_issuer: {
    code: "trustline_no_issuer",
    type: uri("trustline-no-issuer"),
    title: "Trustline Issuer Not Found",
    status: 404,
    detail: "The asset issuer account does not exist on the selected network.",
    retryable: false,
    hint: "Verify the issuer address. The asset may not be available on the active network."
  },

  // ── Stellar transaction (400 / 404) ───────────────────────────────────────
  transaction_not_found: {
    code: "transaction_not_found",
    type: uri("transaction-not-found"),
    title: "Transaction Not Found",
    status: 404,
    detail: "No transaction with that hash was found on the selected network.",
    retryable: false,
    hint: "Verify the transaction hash and the active network. Transactions can take several seconds to appear after submission."
  },
  transaction_malformed: {
    code: "transaction_malformed",
    type: uri("transaction-malformed"),
    title: "Transaction Malformed",
    status: 400,
    detail: "The transaction envelope could not be decoded or is structurally invalid.",
    retryable: false,
    hint: "Ensure the transaction is encoded as a valid base64 XDR envelope. Use the XDR Inspector to diagnose encoding issues."
  },
  transaction_failed: {
    code: "transaction_failed",
    type: uri("transaction-failed"),
    title: "Transaction Failed",
    status: 400,
    detail: "The transaction was submitted but rejected by the Stellar network.",
    retryable: false,
    hint: "Inspect the result codes to identify which operation failed. Use the Result Code Explainer for a plain-language breakdown."
  },
  sequence_mismatch: {
    code: "sequence_mismatch",
    type: uri("sequence-mismatch"),
    title: "Sequence Number Mismatch",
    status: 400,
    detail: "The transaction sequence number does not match the account's current sequence.",
    retryable: true,
    hint: "Fetch the account's current sequence number and rebuild the transaction. This often occurs when multiple transactions are submitted in quick succession."
  },
  insufficient_fee: {
    code: "insufficient_fee",
    type: uri("insufficient-fee"),
    title: "Insufficient Fee",
    status: 400,
    detail: "The base fee offered is below the network minimum.",
    retryable: false,
    hint: "Increase the transaction fee to meet the current network minimum. Check the Fee Stats tool for current surge pricing."
  },
  precondition_failed: {
    code: "precondition_failed",
    type: uri("precondition-failed"),
    title: "Precondition Failed",
    status: 400,
    detail: "The transaction's time bounds or ledger sequence preconditions were not met.",
    retryable: false,
    hint: "Check the transaction's minTime/maxTime and min/maxLedger against the current ledger. Use the Preconditions Explainer for details."
  },

  // ── Soroban / smart-contract ──────────────────────────────────────────────
  soroban_simulation_failed: {
    code: "soroban_simulation_failed",
    type: uri("soroban-simulation-failed"),
    title: "Soroban Simulation Failed",
    status: 400,
    detail: "The Soroban transaction simulation did not succeed.",
    retryable: false,
    hint: "Review the simulation error code. Common causes: contract not found, host function trap, insufficient footprint. Use the Simulation Explainer for diagnostics."
  },
  soroban_invocation_failed: {
    code: "soroban_invocation_failed",
    type: uri("soroban-invocation-failed"),
    title: "Soroban Contract Invocation Failed",
    status: 400,
    detail: "The Soroban contract invocation was rejected or trapped.",
    retryable: false,
    hint: "Check the contract error code and diagnostics events. The contract may have enforced a precondition or the arguments may be invalid."
  },
  soroban_resource_limit_exceeded: {
    code: "soroban_resource_limit_exceeded",
    type: uri("soroban-resource-limit-exceeded"),
    title: "Soroban Resource Limit Exceeded",
    status: 400,
    detail: "The transaction exceeded its Soroban resource budget.",
    retryable: false,
    hint: "Increase the resource fee and footprint via simulation, or reduce the work performed by the contract invocation. Check the Fee Estimator tool."
  },
  soroban_contract_not_found: {
    code: "soroban_contract_not_found",
    type: uri("soroban-contract-not-found"),
    title: "Soroban Contract Not Found",
    status: 404,
    detail: "No Soroban contract exists at the given contract ID on the selected network.",
    retryable: false,
    hint: "Verify the contract ID and the active network. Contracts are network-specific and must be deployed before they can be invoked."
  },
  xdr_decode_error: {
    code: "xdr_decode_error",
    type: uri("xdr-decode-error"),
    title: "XDR Decode Error",
    status: 400,
    detail: "The input could not be decoded as valid Stellar XDR.",
    retryable: false,
    hint: "Verify that the input is valid base64-encoded XDR. Use the XDR Inspector to pinpoint the malformed section."
  },
  xdr_encode_error: {
    code: "xdr_encode_error",
    type: uri("xdr-encode-error"),
    title: "XDR Encode Error",
    status: 500,
    detail: "A value could not be encoded to XDR.",
    retryable: false,
    hint: "Check that all values are within the valid range for their XDR type. File a bug report with the reproduction case."
  },

  // ── Horizon transport (mapped from HorizonErrorCode) ─────────────────────
  horizon_not_found: {
    code: "horizon_not_found",
    type: uri("horizon-not-found"),
    title: "Horizon: Resource Not Found",
    status: 404,
    detail: "The requested resource was not found on Horizon.",
    retryable: false,
    hint: "Verify the identifier (address, hash, ledger number) and the active network."
  },
  horizon_rate_limited: {
    code: "horizon_rate_limited",
    type: uri("horizon-rate-limited"),
    title: "Horizon: Rate Limited",
    status: 429,
    detail: "Horizon is temporarily rate-limiting requests from this client.",
    retryable: true,
    hint: "Wait a moment before retrying. Consider caching results to reduce request frequency."
  },
  horizon_bad_request: {
    code: "horizon_bad_request",
    type: uri("horizon-bad-request"),
    title: "Horizon: Bad Request",
    status: 400,
    detail: "Horizon rejected the request because the supplied value was invalid.",
    retryable: false,
    hint: "Check the parameter format against the Horizon documentation and try again."
  },
  horizon_server_error: {
    code: "horizon_server_error",
    type: uri("horizon-server-error"),
    title: "Horizon: Server Error",
    status: 503,
    detail: "Horizon is temporarily unavailable.",
    retryable: true,
    hint: "Check the Horizon Health tool or https://stellarbeat.io for network status. Try again shortly."
  },
  horizon_network_unavailable: {
    code: "horizon_network_unavailable",
    type: uri("horizon-network-unavailable"),
    title: "Horizon: Network Unavailable",
    status: 503,
    detail: "The connection to Horizon could not be established.",
    retryable: true,
    hint: "Check your internet connection and try again. If the problem persists, verify the Horizon URL in settings."
  },
  horizon_timeout: {
    code: "horizon_timeout",
    type: uri("horizon-timeout"),
    title: "Horizon: Request Timeout",
    status: 504,
    detail: "Horizon did not respond within the allowed time.",
    retryable: true,
    hint: "Try again. If timeouts are frequent, check the Horizon Health tool for elevated response times."
  },
  horizon_unknown: {
    code: "horizon_unknown",
    type: uri("horizon-unknown"),
    title: "Horizon: Unknown Error",
    status: 500,
    detail: "An unclassified error was returned by Horizon.",
    retryable: false,
    hint: "Try again. If the error persists, record the correlation ID and report it."
  },

  // ── Soroban RPC transport ─────────────────────────────────────────────────
  rpc_parse_error: {
    code: "rpc_parse_error",
    type: uri("rpc-parse-error"),
    title: "RPC: Parse Error",
    status: 400,
    detail: "The Soroban RPC endpoint could not parse the request.",
    retryable: false,
    hint: "Ensure the JSON-RPC request is well-formed and the method parameters match the expected schema."
  },
  rpc_invalid_request: {
    code: "rpc_invalid_request",
    type: uri("rpc-invalid-request"),
    title: "RPC: Invalid Request",
    status: 400,
    detail: "The Soroban RPC request was structurally invalid.",
    retryable: false,
    hint: "Check the JSON-RPC envelope: jsonrpc, id, method and params must all be present and correctly typed."
  },
  rpc_method_not_found: {
    code: "rpc_method_not_found",
    type: uri("rpc-method-not-found"),
    title: "RPC: Method Not Found",
    status: 404,
    detail: "The requested Soroban RPC method does not exist on this node.",
    retryable: false,
    hint: "Verify the method name against the Soroban RPC specification. The node may be running an older protocol version."
  },
  rpc_invalid_params: {
    code: "rpc_invalid_params",
    type: uri("rpc-invalid-params"),
    title: "RPC: Invalid Parameters",
    status: 400,
    detail: "The parameters supplied to the Soroban RPC method are invalid.",
    retryable: false,
    hint: "Check the parameter names and value types against the Soroban RPC documentation."
  },
  rpc_server_error: {
    code: "rpc_server_error",
    type: uri("rpc-server-error"),
    title: "RPC: Server Error",
    status: 503,
    detail: "The Soroban RPC node returned an internal error.",
    retryable: true,
    hint: "Try again. If the error persists, check node status or switch to a different RPC endpoint."
  },
  rpc_network_unavailable: {
    code: "rpc_network_unavailable",
    type: uri("rpc-network-unavailable"),
    title: "RPC: Network Unavailable",
    status: 503,
    detail: "The connection to the Soroban RPC node could not be established.",
    retryable: true,
    hint: "Check your internet connection and the configured RPC URL."
  },
  rpc_timeout: {
    code: "rpc_timeout",
    type: uri("rpc-timeout"),
    title: "RPC: Request Timeout",
    status: 504,
    detail: "The Soroban RPC node did not respond within the allowed time.",
    retryable: true,
    hint: "Try again. Soroban operations involving large footprints can take longer; consider increasing the client timeout."
  },
  rpc_unknown: {
    code: "rpc_unknown",
    type: uri("rpc-unknown"),
    title: "RPC: Unknown Error",
    status: 500,
    detail: "An unclassified error was returned by the Soroban RPC node.",
    retryable: false,
    hint: "Try again. If the error persists, record the correlation ID and report it."
  },

  // ── Internal / unclassified ───────────────────────────────────────────────
  internal_error: {
    code: "internal_error",
    type: uri("internal-error"),
    title: "Internal Error",
    status: 500,
    detail: "An unexpected internal error occurred.",
    retryable: true,
    hint: "Try again. If the problem persists, contact support with the correlation ID."
  }
} as const satisfies Record<ProblemCode, ProblemDefinition>;

// ─── Public helpers ───────────────────────────────────────────────────────────

/**
 * Look up the full `ProblemDefinition` for a stable code.
 */
export function getProblemDefinition(code: ProblemCode): ProblemDefinition {
  return PROBLEM_CODES[code];
}

/**
 * Whether a problem code indicates the operation is safe to retry.
 */
export function isProblemRetryable(code: ProblemCode): boolean {
  return PROBLEM_CODES[code].retryable;
}

/**
 * Creates a `ProblemDetails` envelope from a `ProblemCode`.
 *
 * The `detail` field defaults to the safe message in the taxonomy; pass
 * `overrideDetail` only with a pre-sanitised, non-user-input string.
 */
export function problemDetailsFromCode(
  code: ProblemCode,
  options: {
    overrideDetail?: string;
    correlationId?: string;
    instance?: string;
    extensions?: Record<string, unknown>;
  } = {}
): ProblemDetails {
  const def = PROBLEM_CODES[code];
  return {
    type: def.type,
    title: def.title,
    status: def.status,
    detail: options.overrideDetail ?? def.detail,
    instance: options.instance,
    code: def.code,
    retryable: def.retryable,
    hint: def.hint,
    correlationId: options.correlationId,
    extensions: options.extensions
  };
}

// ─── Bridge adapters ──────────────────────────────────────────────────────────

import type { HorizonErrorClassification, HorizonErrorCode } from "@/core/horizon/errors";
import type { RpcErrorClassification } from "@/core/rpc/errors";

/** Maps the existing HorizonErrorCode to the new ProblemCode taxonomy. */
const HORIZON_CODE_MAP: Record<HorizonErrorCode, ProblemCode> = {
  not_found: "horizon_not_found",
  rate_limited: "horizon_rate_limited",
  bad_request: "horizon_bad_request",
  server_error: "horizon_server_error",
  network_unavailable: "horizon_network_unavailable",
  timeout: "horizon_timeout",
  unknown: "horizon_unknown"
};

/**
 * Converts a `HorizonErrorClassification` (from `classifyHorizonError`) into a
 * `ProblemDetails` envelope.
 *
 * The `detail` field is taken from the taxonomy's safe message, not from the
 * raw Horizon response, so no server-supplied text is forwarded to the caller.
 */
export function horizonToProblemDetails(
  classified: HorizonErrorClassification,
  options: { instance?: string; extensions?: Record<string, unknown> } = {}
): ProblemDetails {
  const code = HORIZON_CODE_MAP[classified.code];
  return problemDetailsFromCode(code, {
    correlationId: classified.correlationId,
    instance: options.instance,
    extensions: options.extensions
  });
}

/**
 * Converts a `RpcErrorClassification` (from `classifyRpcError`) into a
 * `ProblemDetails` envelope.
 */
export function rpcToProblemDetails(
  classified: RpcErrorClassification,
  options: { instance?: string; extensions?: Record<string, unknown> } = {}
): ProblemDetails {
  return problemDetailsFromCode(classified.problemCode, {
    correlationId: classified.correlationId,
    instance: options.instance,
    extensions: options.extensions
  });
}
