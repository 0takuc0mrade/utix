import { describe, expect, it } from "vitest";
import {
  CROSS_SERVICE_CONTRACT_MAP,
  getContractDefinition,
  getContractsByConsumer,
  getContractsByProducer,
  listAllContracts,
  validateEventContractPayload,
  verifyCrossServiceContractMap
} from "@/core/contract/contract-map";

describe("Cross-Service Contract Map (#219)", () => {
  it("verifies the integrity and completeness of all registered contracts", () => {
    const verification = verifyCrossServiceContractMap();
    expect(verification.ok).toBe(true);
    if (!verification.ok) return;

    expect(verification.value.valid).toBe(true);
    expect(verification.value.totalContracts).toBeGreaterThanOrEqual(10);
    expect(verification.value.producersCount).toBeGreaterThanOrEqual(5);
    expect(verification.value.consumersCount).toBeGreaterThanOrEqual(5);
  });

  it("retrieves contract definition by eventId", () => {
    const telemetryContract = getContractDefinition("telemetry.event");
    expect(telemetryContract).toBeDefined();
    expect(telemetryContract?.producer).toBe("core/telemetry");
    expect(telemetryContract?.versionRules.currentVersion).toBe("1.0");
    expect(telemetryContract?.failurePolicy.allowedFailureBehavior).toBe("fail_silent");

    const nonExistent = getContractDefinition("non.existent.event");
    expect(nonExistent).toBeUndefined();
  });

  it("filters contracts by producer and consumer", () => {
    const telemetryContracts = getContractsByProducer("core/telemetry");
    expect(telemetryContracts.some((c) => c.eventId === "telemetry.event")).toBe(true);

    const auditConsumers = getContractsByConsumer("core/audit");
    expect(auditConsumers.length).toBeGreaterThanOrEqual(2);
    expect(auditConsumers.some((c) => c.eventId === "telemetry.event" || c.eventId === "export.envelope")).toBe(true);
  });

  describe("Payload Validation against Contract Schemas", () => {
    it("validates compliant telemetry.event payload", () => {
      const validPayload = {
        op: "horizon.request",
        actorType: "client",
        result: "success",
        latencyMs: 125,
        correlationId: "corr-12345",
        timestamp: "2026-10-19T10:00:00.000Z"
      };

      const result = validateEventContractPayload("telemetry.event", validPayload);
      expect(result.ok).toBe(true);
    });

    it("rejects telemetry.event payload with missing required field", () => {
      const invalidPayload = {
        op: "horizon.request",
        result: "success",
        // missing actorType, latencyMs, correlationId, timestamp
      };

      const result = validateEventContractPayload("telemetry.event", invalidPayload);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("missing_required_field");
    });

    it("rejects telemetry.event payload with wrong field type", () => {
      const wrongTypePayload = {
        op: "horizon.request",
        actorType: "client",
        result: "success",
        latencyMs: "125ms", // should be number
        correlationId: "corr-12345",
        timestamp: "2026-10-19T10:00:00.000Z"
      };

      const result = validateEventContractPayload("telemetry.event", wrongTypePayload);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("wrong_type");
    });

    it("validates compliant worker.job payload with retry and idempotency policies", () => {
      const jobContract = getContractDefinition("worker.job");
      expect(jobContract?.idempotency.required).toBe(true);
      expect(jobContract?.failurePolicy.allowedFailureBehavior).toBe("retry_and_dead_letter");
      expect(jobContract?.failurePolicy.deadLetterQueue).toBe(true);

      const validJob = {
        id: "job-991",
        operation: "maintenance.cleanup",
        status: "queued",
        attempts: 0,
        enqueuedAt: "2026-10-19T10:00:00.000Z",
        correlationId: "corr-991"
      };

      const result = validateEventContractPayload("worker.job", validJob);
      expect(result.ok).toBe(true);
    });

    it("validates compliant export.envelope payload", () => {
      const validEnvelope = {
        schemaVersion: "1.0",
        scope: "own",
        generatedAt: "2026-10-19T10:00:00.000Z",
        expiresAt: "2026-10-20T10:00:00.000Z",
        generator: "utix-export@1",
        correlationId: "corr-exp-1",
        recordCount: 1,
        page: 1,
        totalRecords: 1,
        records: [{ op: "wallet.detect", result: "success" }]
      };

      const result = validateEventContractPayload("export.envelope", validEnvelope);
      expect(result.ok).toBe(true);
    });

    it("rejects unknown event contracts with contract_drift", () => {
      const result = validateEventContractPayload("unknown.event", {});
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("contract_drift");
    });

    it("handles version negotiation and rejects future unsupported versions", () => {
      const validPayload = {
        op: "horizon.request",
        actorType: "client",
        result: "success",
        latencyMs: 125,
        correlationId: "corr-12345",
        timestamp: "2026-10-19T10:00:00.000Z"
      };

      const result = validateEventContractPayload("telemetry.event", validPayload, {
        requestedVersion: "99.0" // future version
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("schema_future");
    });
  });

  describe("Failure Behavior and Policy Consistency", () => {
    it("ensures every contract declares a defined failure behavior and default error code", () => {
      for (const contract of listAllContracts()) {
        expect(["fail_silent", "retry_and_dead_letter", "revert_state", "safe_fallback", "reject_with_code"]).toContain(
          contract.failurePolicy.allowedFailureBehavior
        );
        expect(contract.failurePolicy.defaultErrorCode).toBeTruthy();
        expect(["halt", "skip", "quarantine"]).toContain(contract.failurePolicy.poisonHandling);
      }
    });

    it("ensures high-risk write operations enforce idempotency", () => {
      const writeEvents = ["worker.job", "export.envelope", "idempotency.record", "ownership.transfer", "webhook.delivery"];
      for (const eventId of writeEvents) {
        const contract = getContractDefinition(eventId);
        expect(contract?.idempotency.required).toBe(true);
        expect(contract?.idempotency.keyField).toBeDefined();
      }
    });
  });
});
