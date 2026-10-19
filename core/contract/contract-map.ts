/**
 * Cross-Service Contract Map for Domain Events and Integration Boundaries (#219).
 *
 * Provides a formal registry and runtime validation mechanism for every domain
 * event, integration boundary, and cross-service payload in Utix.
 *
 * Each contract locks:
 * 1. Producer service & consumer services
 * 2. Required fields, types, and nested value paths
 * 3. Version negotiation and upcast policies
 * 4. Allowed failure behavior, poison-event policies, and DLQ handling
 * 5. Idempotency guarantees and replay protection requirements
 */

import { err, ok, type Result } from "@/core/result/result";
import {
  type ContractErrorCode,
  type ContractSchema,
  type SchemaVersionErrorCode,
  negotiateSchemaVersion,
  validateContract
} from "@/core/contract/contract";

export type AllowedFailureBehavior =
  | "fail_silent"
  | "retry_and_dead_letter"
  | "revert_state"
  | "safe_fallback"
  | "reject_with_code";

export type PoisonEventPolicy = "halt" | "skip" | "quarantine";

export interface VersionRules {
  readonly currentVersion: string;
  readonly supportedVersions: readonly string[];
  readonly deprecatedVersions?: readonly string[];
  readonly upcastPolicy?: "automatic" | "manual" | "reject";
}

export interface FailurePolicy {
  readonly allowedFailureBehavior: AllowedFailureBehavior;
  readonly maxRetries?: number;
  readonly deadLetterQueue?: boolean;
  readonly poisonHandling: PoisonEventPolicy;
  readonly defaultErrorCode: string;
}

export interface IdempotencyPolicy {
  readonly required: boolean;
  readonly keyField?: string;
  readonly ttlMs?: number;
}

export interface EventContractDefinition {
  readonly eventId: string;
  readonly name: string;
  readonly description: string;
  readonly producer: string;
  readonly consumers: readonly string[];
  readonly schema: ContractSchema;
  readonly versionRules: VersionRules;
  readonly failurePolicy: FailurePolicy;
  readonly idempotency: IdempotencyPolicy;
}

/**
 * Single source of truth cross-service contract map.
 */
export const CROSS_SERVICE_CONTRACT_MAP: Readonly<Record<string, EventContractDefinition>> = {
  "telemetry.event": {
    eventId: "telemetry.event",
    name: "Telemetry Metric Record",
    description: "Structured operational performance and telemetry record emitted by core/telemetry.",
    producer: "core/telemetry",
    consumers: ["core/audit", "core/health", "logging_subsystem"],
    schema: {
      version: "1.0",
      fields: {
        op: { type: "string", required: true },
        actorType: { type: "string", required: true },
        result: { type: "string", required: true },
        latencyMs: { type: "number", required: true },
        correlationId: { type: "string", required: true },
        timestamp: { type: "string", required: true }
      }
    },
    versionRules: {
      currentVersion: "1.0",
      supportedVersions: ["1.0"],
      deprecatedVersions: [],
      upcastPolicy: "automatic"
    },
    failurePolicy: {
      allowedFailureBehavior: "fail_silent",
      poisonHandling: "skip",
      defaultErrorCode: "telemetry_drop_unhandled"
    },
    idempotency: {
      required: false
    }
  },

  "horizon.error": {
    eventId: "horizon.error",
    name: "Classified Horizon Error",
    description: "Standardized Stellar Horizon transport and HTTP error classification payload.",
    producer: "core/horizon",
    consumers: ["features/*/hooks", "features/*/components", "core/ui"],
    schema: {
      version: "1.0",
      fields: {
        code: { type: "string", required: true },
        detail: { type: "object", required: true }
      }
    },
    versionRules: {
      currentVersion: "1.0",
      supportedVersions: ["1.0"],
      deprecatedVersions: [],
      upcastPolicy: "manual"
    },
    failurePolicy: {
      allowedFailureBehavior: "safe_fallback",
      poisonHandling: "quarantine",
      defaultErrorCode: "request_failed"
    },
    idempotency: {
      required: false
    }
  },

  "worker.job": {
    eventId: "worker.job",
    name: "Background Worker Job",
    description: "Asynchronous task payload queued for background execution with retry and DLQ.",
    producer: "features/*",
    consumers: ["core/workers", "core/audit"],
    schema: {
      version: "1.0",
      fields: {
        id: { type: "string", required: true },
        operation: { type: "string", required: true },
        status: { type: "string", required: true },
        attempts: { type: "number", required: true },
        enqueuedAt: { type: "string", required: true },
        correlationId: { type: "string", required: true }
      }
    },
    versionRules: {
      currentVersion: "1.0",
      supportedVersions: ["1.0"],
      deprecatedVersions: [],
      upcastPolicy: "automatic"
    },
    failurePolicy: {
      allowedFailureBehavior: "retry_and_dead_letter",
      maxRetries: 3,
      deadLetterQueue: true,
      poisonHandling: "quarantine",
      defaultErrorCode: "worker_job_failed"
    },
    idempotency: {
      required: true,
      keyField: "id",
      ttlMs: 86_400_000
    }
  },

  "export.envelope": {
    eventId: "export.envelope",
    name: "Data Export Envelope",
    description: "Privacy-audited, scoped, schema-versioned data export container.",
    producer: "core/export",
    consumers: ["browser_download", "core/audit"],
    schema: {
      version: "1.0",
      fields: {
        schemaVersion: { type: "string", required: true },
        scope: { type: "string", required: true },
        generatedAt: { type: "string", required: true },
        expiresAt: { type: "string", required: true },
        generator: { type: "string", required: true },
        correlationId: { type: "string", required: true },
        recordCount: { type: "number", required: true },
        page: { type: "number", required: true },
        totalRecords: { type: "number", required: true },
        records: { type: "array", required: true }
      }
    },
    versionRules: {
      currentVersion: "1.0",
      supportedVersions: ["1.0"],
      deprecatedVersions: [],
      upcastPolicy: "reject"
    },
    failurePolicy: {
      allowedFailureBehavior: "reject_with_code",
      poisonHandling: "halt",
      defaultErrorCode: "export_denied"
    },
    idempotency: {
      required: true,
      keyField: "correlationId",
      ttlMs: 3_600_000
    }
  },

  "lifecycle.state": {
    eventId: "lifecycle.state",
    name: "Lifecycle State Transition",
    description: "State machine transition payload for domain records (tickets, jobs, envelopes).",
    producer: "core/lifecycle",
    consumers: ["core/ui", "core/notifications", "core/reconciliation"],
    schema: {
      version: "1.0",
      fields: {
        id: { type: "string", required: true },
        kind: { type: "string", required: true },
        state: { type: "string", required: true },
        updatedAt: { type: "string", required: true }
      }
    },
    versionRules: {
      currentVersion: "1.0",
      supportedVersions: ["1.0"],
      deprecatedVersions: [],
      upcastPolicy: "automatic"
    },
    failurePolicy: {
      allowedFailureBehavior: "revert_state",
      poisonHandling: "halt",
      defaultErrorCode: "invalid_transition"
    },
    idempotency: {
      required: true,
      keyField: "id",
      ttlMs: 86_400_000
    }
  },

  "idempotency.record": {
    eventId: "idempotency.record",
    name: "Idempotency Record Replay",
    description: "Persisted outcome and request hash for idempotent high-risk write operations.",
    producer: "core/idempotency",
    consumers: ["core/workers", "core/operations", "core/export"],
    schema: {
      version: "1.0",
      fields: {
        key: { type: "string", required: true },
        operation: { type: "string", required: true },
        requestHash: { type: "string", required: true },
        status: { type: "string", required: true },
        createdAt: { type: "string", required: true },
        expiresAt: { type: "string", required: true },
        replays: { type: "number", required: true }
      }
    },
    versionRules: {
      currentVersion: "1.0",
      supportedVersions: ["1.0"],
      deprecatedVersions: [],
      upcastPolicy: "automatic"
    },
    failurePolicy: {
      allowedFailureBehavior: "reject_with_code",
      poisonHandling: "halt",
      defaultErrorCode: "idempotency_key_conflict"
    },
    idempotency: {
      required: true,
      keyField: "key",
      ttlMs: 86_400_000
    }
  },

  "reconciliation.report": {
    eventId: "reconciliation.report",
    name: "Reconciliation Invariant Report",
    description: "Dry-run report analyzing stored domain records against derived state.",
    producer: "core/reconciliation",
    consumers: ["core/health", "maintainer_dashboard"],
    schema: {
      version: "1.0",
      fields: {
        timestamp: { type: "string", required: true },
        dryRun: { type: "boolean", required: true },
        checkedCount: { type: "number", required: true },
        driftCount: { type: "number", required: true },
        drifts: { type: "array", required: true }
      }
    },
    versionRules: {
      currentVersion: "1.0",
      supportedVersions: ["1.0"],
      deprecatedVersions: [],
      upcastPolicy: "automatic"
    },
    failurePolicy: {
      allowedFailureBehavior: "safe_fallback",
      poisonHandling: "quarantine",
      defaultErrorCode: "reconciliation_failed"
    },
    idempotency: {
      required: false
    }
  },

  "webhook.delivery": {
    eventId: "webhook.delivery",
    name: "Webhook Signed Delivery",
    description: "Signed HMAC event delivery with replay window and timestamp verification.",
    producer: "core/webhooks",
    consumers: ["external_subscribers", "core/audit"],
    schema: {
      version: "1.0",
      fields: {
        id: { type: "string", required: true },
        timestamp: { type: "number", required: true },
        event: { type: "string", required: true },
        data: { type: "object", required: true },
        signature: { type: "object", required: true }
      }
    },
    versionRules: {
      currentVersion: "1.0",
      supportedVersions: ["1.0"],
      deprecatedVersions: [],
      upcastPolicy: "reject"
    },
    failurePolicy: {
      allowedFailureBehavior: "retry_and_dead_letter",
      maxRetries: 5,
      deadLetterQueue: true,
      poisonHandling: "quarantine",
      defaultErrorCode: "webhook_delivery_failed"
    },
    idempotency: {
      required: true,
      keyField: "id",
      ttlMs: 300_000
    }
  },

  "replay.event": {
    eventId: "replay.event",
    name: "Event Log Replay Entry",
    description: "Append-only versioned event log entry used to project read models deterministically.",
    producer: "core/replay",
    consumers: ["core/replay/projections", "core/reconciliation"],
    schema: {
      version: "1.0",
      fields: {
        id: { type: "string", required: true },
        sequence: { type: "number", required: true },
        type: { type: "string", required: true },
        version: { type: "number", required: true },
        occurredAt: { type: "string", required: true }
      }
    },
    versionRules: {
      currentVersion: "1.0",
      supportedVersions: ["1.0"],
      deprecatedVersions: [],
      upcastPolicy: "automatic"
    },
    failurePolicy: {
      allowedFailureBehavior: "safe_fallback",
      poisonHandling: "halt",
      defaultErrorCode: "replay_poison_event"
    },
    idempotency: {
      required: true,
      keyField: "id"
    }
  },

  "ownership.transfer": {
    eventId: "ownership.transfer",
    name: "Ownership Transfer Intent",
    description: "Pending two-step ownership handover with expiry and self-transfer guard.",
    producer: "core/ownership",
    consumers: ["core/notifications", "core/audit", "core/lifecycle"],
    schema: {
      version: "1.0",
      fields: {
        id: { type: "string", required: true },
        resourceId: { type: "string", required: true },
        currentOwner: { type: "string", required: true },
        proposedOwner: { type: "string", required: true },
        status: { type: "string", required: true },
        expiresAt: { type: "number", required: true }
      }
    },
    versionRules: {
      currentVersion: "1.0",
      supportedVersions: ["1.0"],
      deprecatedVersions: [],
      upcastPolicy: "automatic"
    },
    failurePolicy: {
      allowedFailureBehavior: "reject_with_code",
      poisonHandling: "halt",
      defaultErrorCode: "ownership_transfer_invalid"
    },
    idempotency: {
      required: true,
      keyField: "id",
      ttlMs: 86_400_000
    }
  }
};

/**
 * Retrieves a contract definition by its unique eventId.
 */
export function getContractDefinition(eventId: string): EventContractDefinition | undefined {
  return CROSS_SERVICE_CONTRACT_MAP[eventId];
}

/**
 * Lists all registered event and integration boundary contracts.
 */
export function listAllContracts(): readonly EventContractDefinition[] {
  return Object.values(CROSS_SERVICE_CONTRACT_MAP);
}

/**
 * Finds all contracts where the given service acts as producer.
 */
export function getContractsByProducer(producer: string): readonly EventContractDefinition[] {
  return listAllContracts().filter(
    (contract) => contract.producer === producer || (contract.producer === "features/*" && producer.startsWith("features/"))
  );
}

/**
 * Finds all contracts where the given service acts as consumer.
 */
export function getContractsByConsumer(consumer: string): readonly EventContractDefinition[] {
  return listAllContracts().filter((contract) =>
    contract.consumers.some((c) => c === consumer || (c === "features/*/hooks" && consumer.startsWith("features/")))
  );
}

/**
 * Validates an event payload against its locked contract and version rules.
 */
export function validateEventContractPayload(
  eventId: string,
  payload: unknown,
  options?: { requestedVersion?: string }
): Result<true, ContractErrorCode | SchemaVersionErrorCode> {
  const contract = getContractDefinition(eventId);
  if (!contract) {
    return err("contract_drift");
  }

  // Negotiate version if requested or required
  const requestedVersion = options?.requestedVersion ?? contract.versionRules.currentVersion;
  const versionNegotiation = negotiateSchemaVersion({
    requested: requestedVersion,
    current: contract.versionRules.currentVersion,
    deprecated: contract.versionRules.deprecatedVersions
  });

  if (versionNegotiation.code !== undefined && versionNegotiation.code !== "schema_deprecated") {
    return err(versionNegotiation.code);
  }

  // Validate fields against schema
  return validateContract(payload, contract.schema);
}

/**
 * Verifies consistency and completeness of the entire Cross-Service Contract Map.
 * Used in automated test suites and CI verification gates.
 */
export function verifyCrossServiceContractMap(): Result<
  {
    totalContracts: number;
    producersCount: number;
    consumersCount: number;
    valid: boolean;
  },
  string
> {
  const contracts = listAllContracts();
  if (contracts.length === 0) {
    return err("No contracts registered in cross-service contract map");
  }

  const producers = new Set<string>();
  const consumers = new Set<string>();

  for (const contract of contracts) {
    if (!contract.eventId || !contract.name || !contract.producer) {
      return err(`Invalid contract metadata for ${contract.eventId || "unnamed"}`);
    }

    if (!contract.consumers || contract.consumers.length === 0) {
      return err(`Contract ${contract.eventId} must declare at least one consumer`);
    }

    if (!contract.schema || !contract.schema.fields || Object.keys(contract.schema.fields).length === 0) {
      return err(`Contract ${contract.eventId} must declare non-empty schema fields`);
    }

    if (!contract.versionRules || !contract.versionRules.currentVersion) {
      return err(`Contract ${contract.eventId} missing version rules`);
    }

    if (!contract.failurePolicy || !contract.failurePolicy.allowedFailureBehavior) {
      return err(`Contract ${contract.eventId} missing failure policy`);
    }

    producers.add(contract.producer);
    for (const c of contract.consumers) {
      consumers.add(c);
    }
  }

  return ok({
    totalContracts: contracts.length,
    producersCount: producers.size,
    consumersCount: consumers.size,
    valid: true
  });
}
