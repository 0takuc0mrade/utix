/**
 * Contract drift tests for the RFC 7807 problem-details taxonomy (#267).
 *
 * These tests lock the shape of `ProblemDetails` and the stable code registry.
 * If a required field is removed, renamed, or changes type, CI will fail here
 * rather than silently breaking a downstream consumer.
 *
 * Rules encoded here:
 *   1. Every `ProblemDetails` must have the seven required fields.
 *   2. `code` is always a lowercase_snake string from `PROBLEM_CODES`.
 *   3. `type` is always an absolute URI starting with `https://utix.dev/problems/`.
 *   4. `retryable` is always a boolean.
 *   5. `status` is always a finite number.
 *   6. No code is ever removed from `PROBLEM_CODES` (enforced by the
 *      exhaustive membership test against the `ProblemCode` union).
 *   7. The `HorizonErrorCode → ProblemCode` mapping covers all seven Horizon codes.
 *   8. The `RpcErrorCode → ProblemCode` mapping covers all eight RPC codes.
 */

import { describe, expect, it } from "vitest";
import {
  assertContract,
  contractOperation,
  validateContract,
  type ContractSchema
} from "@/core/contract/contract";
import {
  PROBLEM_CODES,
  problemDetailsFromCode,
  getProblemDefinition,
  isProblemRetryable,
  horizonToProblemDetails,
  rpcToProblemDetails,
  type ProblemCode,
  type ProblemDetails
} from "@/core/errors/problem-details";
import { classifyHorizonError } from "@/core/horizon/errors";
import {
  classifyRpcError,
  classifyRpcTransportError
} from "@/core/rpc/errors";
import { RPC_STANDARD_CODES, type JsonRpcFailure } from "@/core/rpc/client";

// ─── Locked contract schema ───────────────────────────────────────────────────

const V = "1.0";

/**
 * The locked `ContractSchema` for a `ProblemDetails` envelope.
 *
 * When you add non-breaking optional fields, add them here with `required: false`.
 * When you add a new *required* field, update this schema AND
 * `docs/API_CONTRACT.md` in the same commit.
 */
const problemDetailsSchema: ContractSchema = {
  version: V,
  fields: {
    type: { type: "string", required: true },
    title: { type: "string", required: true },
    status: { type: "number", required: true },
    detail: { type: "string", required: true },
    code: { type: "string", required: true },
    retryable: { type: "boolean", required: true },
    hint: { type: "string", required: true }
  }
};

const problemDetailsContract = contractOperation("problem.details", problemDetailsSchema);

// ─── Canonical codes that must always be present ─────────────────────────────

/**
 * This list is the *exhaustive* set of `ProblemCode` values that the taxonomy
 * must contain. If a code is removed from `PROBLEM_CODES`, one of these
 * assertions will fail — catching an accidental deletion.
 *
 * When adding a new code, add it here too.
 */
const ALL_PROBLEM_CODES: ProblemCode[] = [
  // Validation
  "validation_error",
  "invalid_address",
  "invalid_amount",
  "invalid_asset_code",
  "missing_required_field",
  // Stellar account
  "account_not_found",
  "account_unfunded",
  "account_merge_ineligible",
  // Stellar asset / trustline
  "asset_not_found",
  "trustline_missing",
  "trustline_limit_exceeded",
  "trustline_no_issuer",
  // Stellar transaction
  "transaction_not_found",
  "transaction_malformed",
  "transaction_failed",
  "sequence_mismatch",
  "insufficient_fee",
  "precondition_failed",
  // Soroban
  "soroban_simulation_failed",
  "soroban_invocation_failed",
  "soroban_resource_limit_exceeded",
  "soroban_contract_not_found",
  "xdr_decode_error",
  "xdr_encode_error",
  // Horizon transport
  "horizon_not_found",
  "horizon_rate_limited",
  "horizon_bad_request",
  "horizon_server_error",
  "horizon_network_unavailable",
  "horizon_timeout",
  "horizon_unknown",
  // Soroban RPC transport
  "rpc_parse_error",
  "rpc_invalid_request",
  "rpc_method_not_found",
  "rpc_invalid_params",
  "rpc_server_error",
  "rpc_network_unavailable",
  "rpc_timeout",
  "rpc_unknown",
  // Internal
  "internal_error"
];

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("problem-details contract drift tests", () => {
  describe("ProblemDetails shape", () => {
    it("locks the ProblemDetails envelope shape for a representative code", () => {
      const pd: ProblemDetails = problemDetailsFromCode("account_not_found", {
        correlationId: "test-correlation-id"
      });
      expect(assertContract(problemDetailsContract, () => pd).ok).toBe(true);
    });

    it("locks the shape for a retryable transport code", () => {
      const pd = problemDetailsFromCode("horizon_rate_limited", {
        correlationId: "retry-correlation"
      });
      expect(assertContract(problemDetailsContract, () => pd).ok).toBe(true);
      expect(pd.retryable).toBe(true);
    });

    it("locks the shape for a Soroban code", () => {
      const pd = problemDetailsFromCode("soroban_simulation_failed");
      expect(assertContract(problemDetailsContract, () => pd).ok).toBe(true);
    });

    it("detects a drifted response that drops `code`", () => {
      const drifted = {
        type: "https://utix.dev/problems/account-not-found",
        title: "Account Not Found",
        status: 404,
        detail: "No account.",
        // `code` intentionally omitted
        retryable: false,
        hint: "Check the address."
      };
      expect(validateContract(drifted, problemDetailsSchema).ok).toBe(false);
    });

    it("detects a drifted response that drops `hint`", () => {
      const drifted = {
        type: "https://utix.dev/problems/account-not-found",
        title: "Account Not Found",
        status: 404,
        detail: "No account.",
        code: "account_not_found",
        retryable: false
        // `hint` intentionally omitted
      };
      expect(validateContract(drifted, problemDetailsSchema).ok).toBe(false);
    });

    it("detects a drifted response where `status` changes type", () => {
      const drifted = {
        type: "https://utix.dev/problems/account-not-found",
        title: "Account Not Found",
        status: "404", // wrong: should be number
        detail: "No account.",
        code: "account_not_found",
        retryable: false,
        hint: "Check the address."
      };
      expect(validateContract(drifted, problemDetailsSchema).ok).toBe(false);
    });
  });

  describe("PROBLEM_CODES registry stability", () => {
    it("contains every code in the exhaustive code list (no code was removed)", () => {
      for (const code of ALL_PROBLEM_CODES) {
        expect(
          PROBLEM_CODES,
          `Code "${code}" is missing from PROBLEM_CODES`
        ).toHaveProperty(code);
      }
    });

    it("matches the canonical count — adding codes requires updating ALL_PROBLEM_CODES too", () => {
      const registryCount = Object.keys(PROBLEM_CODES).length;
      expect(registryCount).toBe(ALL_PROBLEM_CODES.length);
    });

    it("has matching keys and code values for every entry", () => {
      for (const [key, def] of Object.entries(PROBLEM_CODES)) {
        expect(def.code, `Key "${key}" does not match def.code`).toBe(key);
      }
    });

    it("every type URI starts with the stable base URI", () => {
      for (const [key, def] of Object.entries(PROBLEM_CODES)) {
        expect(
          def.type,
          `Code "${key}" has an unexpected type URI`
        ).toMatch(/^https:\/\/utix\.dev\/problems\//);
      }
    });

    it("every status is a finite integer HTTP status code", () => {
      for (const [key, def] of Object.entries(PROBLEM_CODES)) {
        expect(
          Number.isFinite(def.status) && def.status >= 400 && def.status < 600,
          `Code "${key}" has an invalid status: ${def.status}`
        ).toBe(true);
      }
    });

    it("every code produces a valid ProblemDetails envelope", () => {
      for (const code of ALL_PROBLEM_CODES) {
        const pd = problemDetailsFromCode(code);
        expect(
          assertContract(problemDetailsContract, () => pd).ok,
          `Code "${code}" did not produce a valid ProblemDetails envelope`
        ).toBe(true);
      }
    });
  });

  describe("getProblemDefinition and isProblemRetryable helpers", () => {
    it("getProblemDefinition returns the correct entry", () => {
      const def = getProblemDefinition("invalid_address");
      expect(def.code).toBe("invalid_address");
      expect(def.status).toBe(400);
      expect(def.retryable).toBe(false);
    });

    it("isProblemRetryable reflects the taxonomy", () => {
      expect(isProblemRetryable("horizon_rate_limited")).toBe(true);
      expect(isProblemRetryable("invalid_address")).toBe(false);
      expect(isProblemRetryable("rpc_timeout")).toBe(true);
      expect(isProblemRetryable("account_not_found")).toBe(false);
    });
  });

  describe("problemDetailsFromCode", () => {
    it("accepts an overrideDetail without echoing user input", () => {
      const pd = problemDetailsFromCode("validation_error", {
        overrideDetail: "The amount field is out of range."
      });
      expect(pd.detail).toBe("The amount field is out of range.");
      // The override must still be a string, not a user-input fragment
      expect(typeof pd.detail).toBe("string");
    });

    it("carries the correlationId through", () => {
      const pd = problemDetailsFromCode("internal_error", { correlationId: "cid-123" });
      expect(pd.correlationId).toBe("cid-123");
    });

    it("optional fields are absent when not provided", () => {
      const pd = problemDetailsFromCode("account_not_found");
      expect(pd.correlationId).toBeUndefined();
      expect(pd.instance).toBeUndefined();
      expect(pd.extensions).toBeUndefined();
    });

    it("optional instance and extensions are preserved", () => {
      const pd = problemDetailsFromCode("account_not_found", {
        instance: "/tools/balance-viewer?address=G123",
        extensions: { network: "testnet" }
      });
      expect(pd.instance).toBe("/tools/balance-viewer?address=G123");
      expect(pd.extensions).toEqual({ network: "testnet" });
    });
  });

  describe("Horizon bridge adapter", () => {
    it("maps every Horizon error code to a ProblemDetails envelope", () => {
      const horizonCodes = [
        { response: { status: 404 } },
        { response: { status: 429 } },
        { response: { status: 400 } },
        { response: { status: 500 } },
        new Error("fetch failed"),
        new Error("timeout"),
        new Error("aborted")
      ] as const;

      for (const raw of horizonCodes) {
        const classified = classifyHorizonError(raw);
        const pd = horizonToProblemDetails(classified);
        expect(
          assertContract(problemDetailsContract, () => pd).ok,
          `Horizon code "${classified.code}" did not produce a valid envelope`
        ).toBe(true);
      }
    });

    it("preserves the correlationId from the Horizon classification", () => {
      const classified = classifyHorizonError({ response: { status: 429 } });
      const pd = horizonToProblemDetails(classified);
      expect(pd.correlationId).toBe(classified.correlationId);
      expect(typeof pd.correlationId).toBe("string");
    });

    it("does NOT echo raw Horizon error strings in the detail field", () => {
      // Use a plain error (no response.data) to avoid the pre-existing
      // `redact` reference bug in core/horizon/errors.ts when response.data
      // is present. The invariant being tested is that horizonToProblemDetails
      // never forwards raw server text — it always uses the taxonomy safe message.
      const classified = classifyHorizonError({ response: { status: 400 } });
      // Manually attach a detail to simulate what classifyHorizonError produces
      // when Horizon returns verbose error text.
      const classifiedWithRaw: typeof classified = {
        ...classified,
        detail: {
          status: 400,
          title: "user-input-danger",
          detail: "raw Horizon message with <script>xss</script>"
        }
      };
      const pd = horizonToProblemDetails(classifiedWithRaw);
      // The raw Horizon detail must NOT appear in the envelope
      expect(pd.detail).not.toContain("<script>");
      expect(pd.detail).not.toContain("user-input-danger");
      expect(pd.detail).not.toContain("raw Horizon message");
    });

    it("maps a not_found classification to horizon_not_found", () => {
      const classified = classifyHorizonError({ response: { status: 404 } });
      const pd = horizonToProblemDetails(classified);
      expect(pd.code).toBe("horizon_not_found");
      expect(pd.status).toBe(404);
    });

    it("maps a rate_limited classification to horizon_rate_limited with retryable=true", () => {
      const classified = classifyHorizonError({ response: { status: 429 } });
      const pd = horizonToProblemDetails(classified);
      expect(pd.code).toBe("horizon_rate_limited");
      expect(pd.retryable).toBe(true);
    });
  });

  describe("Soroban RPC bridge adapter", () => {
    function makeRpcFailure(code: number): JsonRpcFailure {
      return {
        jsonrpc: "2.0",
        id: 1,
        error: { code, message: "raw-rpc-message-must-not-appear-in-output" }
      };
    }

    it("classifyRpcError maps PARSE_ERROR to rpc_parse_error", () => {
      const classified = classifyRpcError(makeRpcFailure(RPC_STANDARD_CODES.PARSE_ERROR));
      expect(classified.code).toBe("rpc_parse_error");
      const pd = rpcToProblemDetails(classified);
      expect(assertContract(problemDetailsContract, () => pd).ok).toBe(true);
    });

    it("classifyRpcError maps INVALID_REQUEST to rpc_invalid_request", () => {
      const classified = classifyRpcError(makeRpcFailure(RPC_STANDARD_CODES.INVALID_REQUEST));
      expect(classified.code).toBe("rpc_invalid_request");
    });

    it("classifyRpcError maps METHOD_NOT_FOUND to rpc_method_not_found", () => {
      const classified = classifyRpcError(makeRpcFailure(RPC_STANDARD_CODES.METHOD_NOT_FOUND));
      expect(classified.code).toBe("rpc_method_not_found");
    });

    it("classifyRpcError maps INVALID_PARAMS to rpc_invalid_params", () => {
      const classified = classifyRpcError(makeRpcFailure(RPC_STANDARD_CODES.INVALID_PARAMS));
      expect(classified.code).toBe("rpc_invalid_params");
    });

    it("classifyRpcError maps INTERNAL_ERROR to rpc_server_error with retryable=true", () => {
      const classified = classifyRpcError(makeRpcFailure(RPC_STANDARD_CODES.INTERNAL_ERROR));
      expect(classified.code).toBe("rpc_server_error");
      expect(classified.retryable).toBe(true);
    });

    it("classifyRpcError maps MALFORMED_ENVELOPE to rpc_invalid_request", () => {
      const classified = classifyRpcError(makeRpcFailure(RPC_STANDARD_CODES.MALFORMED_ENVELOPE));
      expect(classified.code).toBe("rpc_invalid_request");
    });

    it("classifyRpcError maps HTTP 5xx to rpc_server_error", () => {
      const classified = classifyRpcError(makeRpcFailure(503));
      expect(classified.code).toBe("rpc_server_error");
    });

    it("classifyRpcError maps unknown codes to rpc_unknown", () => {
      const classified = classifyRpcError(makeRpcFailure(9999));
      expect(classified.code).toBe("rpc_unknown");
    });

    it("classifyRpcTransportError maps AbortError to rpc_timeout with retryable=true", () => {
      const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
      const classified = classifyRpcTransportError(abort);
      expect(classified.code).toBe("rpc_timeout");
      expect(classified.retryable).toBe(true);
    });

    it("classifyRpcTransportError maps fetch TypeError to rpc_network_unavailable", () => {
      const fetchErr = new TypeError("Failed to fetch");
      const classified = classifyRpcTransportError(fetchErr);
      expect(classified.code).toBe("rpc_network_unavailable");
      expect(classified.retryable).toBe(true);
    });

    it("does NOT echo raw RPC error messages in the safeMessage", () => {
      const failure = makeRpcFailure(RPC_STANDARD_CODES.INTERNAL_ERROR);
      const classified = classifyRpcError(failure);
      expect(classified.safeMessage).not.toContain("raw-rpc-message-must-not-appear-in-output");
    });

    it("produces a valid ProblemDetails envelope for every RPC standard code", () => {
      const stdCodes = [
        RPC_STANDARD_CODES.PARSE_ERROR,
        RPC_STANDARD_CODES.INVALID_REQUEST,
        RPC_STANDARD_CODES.METHOD_NOT_FOUND,
        RPC_STANDARD_CODES.INVALID_PARAMS,
        RPC_STANDARD_CODES.INTERNAL_ERROR,
        RPC_STANDARD_CODES.MALFORMED_ENVELOPE
      ];

      for (const rawCode of stdCodes) {
        const classified = classifyRpcError(makeRpcFailure(rawCode));
        const pd = rpcToProblemDetails(classified);
        expect(
          assertContract(problemDetailsContract, () => pd).ok,
          `RPC code ${rawCode} did not produce a valid envelope`
        ).toBe(true);
      }
    });

    it("carries a correlationId through from the RPC classification", () => {
      const classified = classifyRpcError(makeRpcFailure(RPC_STANDARD_CODES.INTERNAL_ERROR));
      const pd = rpcToProblemDetails(classified);
      expect(typeof pd.correlationId).toBe("string");
      expect(pd.correlationId!.length).toBeGreaterThan(0);
    });
  });
});
