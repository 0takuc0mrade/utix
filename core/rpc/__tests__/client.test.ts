import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createCaptureSink,
  resetTelemetrySink,
  setTelemetrySink
} from "@/core/telemetry/telemetry";
import {
  sorobanRpc,
  parseJsonRpcResponse,
  isRpcFailure,
  RPC_STANDARD_CODES,
  type JsonRpcSuccess,
  type JsonRpcFailure
} from "@/core/rpc/client";
import {
  generateMalformedRpcFixture,
  MALFORMED_RPC_PAYLOADS,
  verifyFixture
} from "@/core/testing/sorobanRpcFixtures";

describe("core/rpc/client", () => {
  describe("parseJsonRpcResponse", () => {
    it("parses a valid JSON-RPC success response", () => {
      const payload = {
        jsonrpc: "2.0",
        id: 42,
        result: { status: "success", count: 10 }
      };

      const parsed = parseJsonRpcResponse<{ status: string; count: number }>(payload, 42);

      expect(isRpcFailure(parsed)).toBe(false);
      expect((parsed as JsonRpcSuccess<{ status: string; count: number }>).result).toEqual({
        status: "success",
        count: 10
      });
      expect(parsed.id).toBe(42);
    });

    it("parses a valid JSON-RPC error response", () => {
      const payload = {
        jsonrpc: "2.0",
        id: 42,
        error: { code: -32601, message: "Method not found" }
      };

      const parsed = parseJsonRpcResponse(payload, 42);

      expect(isRpcFailure(parsed)).toBe(true);
      const failure = parsed as JsonRpcFailure;
      expect(failure.error.code).toBe(-32601);
      expect(failure.error.message).toBe("Method not found");
    });

    it("handles non-object payloads (string, number, array, null)", () => {
      const stringResult = parseJsonRpcResponse("unexpected string");
      expect(isRpcFailure(stringResult)).toBe(true);
      expect((stringResult as JsonRpcFailure).error.code).toBe(RPC_STANDARD_CODES.INVALID_REQUEST);

      const arrayResult = parseJsonRpcResponse([1, 2, 3]);
      expect(isRpcFailure(arrayResult)).toBe(true);

      const nullResult = parseJsonRpcResponse(null);
      expect(isRpcFailure(nullResult)).toBe(true);

      const numResult = parseJsonRpcResponse(12345);
      expect(isRpcFailure(numResult)).toBe(true);
    });

    it("handles missing or invalid jsonrpc version", () => {
      const missingVersion = parseJsonRpcResponse({ id: 1, result: {} });
      expect(isRpcFailure(missingVersion)).toBe(true);
      expect((missingVersion as JsonRpcFailure).error.message).toContain('jsonrpc version');

      const wrongVersion = parseJsonRpcResponse({ jsonrpc: "1.0", id: 1, result: {} });
      expect(isRpcFailure(wrongVersion)).toBe(true);
    });

    it("handles invalid id types (e.g. boolean, object)", () => {
      const boolId = parseJsonRpcResponse({ jsonrpc: "2.0", id: true, result: {} });
      expect(isRpcFailure(boolId)).toBe(true);
      expect((boolId as JsonRpcFailure).error.message).toContain("id must be a string, number, or null");
    });

    it("handles payload containing both result and error", () => {
      const dualPayload = {
        jsonrpc: "2.0",
        id: 1,
        result: { status: "ok" },
        error: { code: -32603, message: "Conflict" }
      };

      const parsed = parseJsonRpcResponse(dualPayload, 1);
      expect(isRpcFailure(parsed)).toBe(true);
      expect((parsed as JsonRpcFailure).error.message).toContain("cannot contain both result and error");
    });

    it("handles payload containing neither result nor error", () => {
      const emptyPayload = {
        jsonrpc: "2.0",
        id: 1
      };

      const parsed = parseJsonRpcResponse(emptyPayload, 1);
      expect(isRpcFailure(parsed)).toBe(true);
      expect((parsed as JsonRpcFailure).error.message).toContain("must contain either result or error");
    });

    it("handles success response with null id as malformed", () => {
      const nullIdSuccess = {
        jsonrpc: "2.0",
        id: null,
        result: { ok: true }
      };

      const parsed = parseJsonRpcResponse(nullIdSuccess);
      expect(isRpcFailure(parsed)).toBe(true);
      expect((parsed as JsonRpcFailure).error.message).toContain("must have a non-null id");
    });

    it("handles error payload with invalid error structure", () => {
      const stringError = {
        jsonrpc: "2.0",
        id: 1,
        error: "just a string error"
      };

      const parsed = parseJsonRpcResponse(stringError, 1);
      expect(isRpcFailure(parsed)).toBe(true);
      expect((parsed as JsonRpcFailure).error.message).toContain("error field must be an object");
    });
  });

  describe("isRpcFailure discriminator", () => {
    it("identifies error responses correctly", () => {
      const errResponse: JsonRpcFailure = {
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32600, message: "Invalid request" }
      };
      expect(isRpcFailure(errResponse)).toBe(true);
    });

    it("identifies success responses correctly", () => {
      const okResponse: JsonRpcSuccess<{ value: number }> = {
        jsonrpc: "2.0",
        id: 1,
        result: { value: 100 }
      };
      expect(isRpcFailure(okResponse)).toBe(false);
    });

    it("returns false for non-object or invalid inputs", () => {
      expect(isRpcFailure(null)).toBe(false);
      expect(isRpcFailure(undefined)).toBe(false);
      expect(isRpcFailure("string")).toBe(false);
      expect(isRpcFailure(123)).toBe(false);
    });
  });

  describe("sorobanRpc network integration with malformed envelopes", () => {
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
      vi.restoreAllMocks();
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
      resetTelemetrySink();
    });

    it("uses the caller correlation id for the RPC request and success telemetry", async () => {
      const correlationId = "worker-job-123";
      const telemetry = createCaptureSink();
      setTelemetrySink(telemetry);
      globalThis.fetch = vi.fn().mockImplementation(async (_url, init) => {
        const body = JSON.parse(init?.body as string);
        return {
          ok: true,
          status: 200,
          json: async () => ({ jsonrpc: "2.0", id: body.id, result: { status: "healthy" } })
        } as unknown as Response;
      });

      const response = await sorobanRpc<{ status: string }>(
        "getHealth",
        {},
        { correlationId }
      );

      expect(JSON.parse(vi.mocked(globalThis.fetch).mock.calls[0][1]?.body as string).id)
        .toBe(correlationId);
      expect(response.id).toBe(correlationId);
      expect(isRpcFailure(response)).toBe(false);
      expect(telemetry.events).toMatchObject([{
        op: "soroban.rpc",
        result: "success",
        correlationId,
        payload: { method: "getHealth" }
      }]);
    });

    it("emits transport failures with the same caller correlation id", async () => {
      const correlationId = "worker-job-retry";
      const telemetry = createCaptureSink();
      setTelemetrySink(telemetry);
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("Connection refused"));

      const response = await sorobanRpc("getHealth", {}, { correlationId });

      expect(isRpcFailure(response)).toBe(true);
      expect(telemetry.events).toMatchObject([{
        op: "soroban.rpc",
        result: "failure",
        correlationId,
        errorCode: String(RPC_STANDARD_CODES.INTERNAL_ERROR)
      }]);
    });

    it("safely handles malformed non-object JSON response without throwing", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => "primitive response"
      } as unknown as Response);

      const response = await sorobanRpc("simulateTransaction");
      expect(isRpcFailure(response)).toBe(true);
      expect((response as JsonRpcFailure).error.code).toBe(RPC_STANDARD_CODES.INVALID_REQUEST);
    });

    it("safely handles dual result and error envelope without throwing", async () => {
      globalThis.fetch = vi.fn().mockImplementation(async (_url, init) => {
        const body = JSON.parse(init?.body as string);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            jsonrpc: "2.0",
            id: body.id,
            result: { value: 1 },
            error: { code: -32000, message: "Ambiguous response" }
          })
        } as unknown as Response;
      });

      const response = await sorobanRpc("simulateTransaction");
      expect(isRpcFailure(response)).toBe(true);
      expect((response as JsonRpcFailure).error.message).toContain("cannot contain both result and error");
    });

    it("safely handles response id mismatch without throwing", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          jsonrpc: "2.0",
          id: 99999,
          result: { value: 1 }
        })
      } as unknown as Response);

      const response = await sorobanRpc("simulateTransaction");
      expect(isRpcFailure(response)).toBe(true);
      expect((response as JsonRpcFailure).error.message).toContain("id mismatch");
    });

    it("safely handles HTML/502 JSON parse failure without throwing unhandled UI errors", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
        json: async () => {
          throw new SyntaxError("Unexpected token < in JSON at position 0");
        }
      } as unknown as Response);

      const response = await sorobanRpc("simulateTransaction");
      expect(isRpcFailure(response)).toBe(true);
      expect((response as JsonRpcFailure).error.code).toBe(RPC_STANDARD_CODES.PARSE_ERROR);
    });

    it("safely handles network fetch exceptions", async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("Connection refused"));

      const response = await sorobanRpc("simulateTransaction");
      expect(isRpcFailure(response)).toBe(true);
      expect((response as JsonRpcFailure).error.message).toContain("Connection refused");
    });
  });

  describe("malformed RPC fixtures and verifyFixture validation", () => {
    it("all malformed fixture presets are rejected by verifyFixture", () => {
      const keys = Object.keys(MALFORMED_RPC_PAYLOADS) as (keyof typeof MALFORMED_RPC_PAYLOADS)[];
      expect(keys.length).toBeGreaterThanOrEqual(8);

      for (const key of keys) {
        const fixture = generateMalformedRpcFixture(key);
        const result = verifyFixture(fixture);
        expect(result.valid).toBe(false);
      }
    });
  });
});
