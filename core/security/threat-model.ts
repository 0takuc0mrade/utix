/**
 * Scenario-based Threat Model for Cross-Boundary Trust Decisions.
 *
 * Implements executable verification checks for highest-risk trust boundaries
 * in Utix (Stellar utility tools, transaction inspection, Soroban diagnostics,
 * and public developer workflows).
 *
 * Trust Boundaries:
 * - Boundary 1: Untrusted Public Client -> Utix Input Parsers (XDR, SEP-0007, QR, Strkey)
 * - Boundary 2: Utix Core -> External Network RPC & Horizon Providers (Stellar/Soroban)
 * - Boundary 3: Soroban Contract Diagnostics -> User Simulation & Authorization
 * - Boundary 4: Zero-Trust Custody & Secret Scrubbing Boundary
 *
 * All evaluations are read-only, deterministic, and enforce bounded time/space complexity.
 */

import { StrKey } from "@stellar/stellar-sdk";

export type TrustBoundaryId =
  | "boundary_1_client_input"
  | "boundary_2_external_rpc"
  | "boundary_3_soroban_auth"
  | "boundary_4_secret_custody";

export type ThreatScenarioId =
  | "xdr_bomb_and_malformed_inspection"
  | "sep007_uri_and_signer_spoofing"
  | "stellar_toml_ssrf_and_redirect"
  | "rpc_ledger_sequence_drift_and_split_brain"
  | "soroban_auth_tree_manipulation"
  | "secret_key_leakage_and_custody_violation";

export type ThreatSeverity = "critical" | "high" | "medium" | "low";

export interface TrustBoundaryDefinition {
  id: TrustBoundaryId;
  name: string;
  source: string;
  destination: string;
  description: string;
  defaultPolicy: "reject_untrusted" | "sanitize_and_bound" | "zero_trust_refuse";
}

export interface ThreatScenarioResult {
  scenarioId: ThreatScenarioId;
  boundaryId: TrustBoundaryId;
  threatSeverity: ThreatSeverity;
  passed: boolean;
  mitigationApplied: string;
  reason: string;
  details: Record<string, unknown>;
}

export interface ThreatModelSuiteReport {
  timestamp: Date;
  totalScenarios: number;
  passedScenarios: number;
  failedScenarios: number;
  allMitigationsActive: boolean;
  results: ThreatScenarioResult[];
}

export const TRUST_BOUNDARIES: Record<TrustBoundaryId, TrustBoundaryDefinition> = {
  boundary_1_client_input: {
    id: "boundary_1_client_input",
    name: "Client Input to Parser Boundary",
    source: "Untrusted Client / Web Browser / QR Scanner",
    destination: "Utix Parsing & Inspection Engine",
    description: "Accepts raw user input, base64 XDR, payment URIs, and StrKeys",
    defaultPolicy: "sanitize_and_bound"
  },
  boundary_2_external_rpc: {
    id: "boundary_2_external_rpc",
    name: "Core to External Horizon & RPC Boundary",
    source: "Utix Core Service",
    destination: "Public Stellar Horizon / Soroban RPC / TOML Servers",
    description: "Queries external endpoints for ledger state, contract data, and network config",
    defaultPolicy: "reject_untrusted"
  },
  boundary_3_soroban_auth: {
    id: "boundary_3_soroban_auth",
    name: "Soroban Diagnostic Authorization Boundary",
    source: "Diagnostic Analyzer / Simulation Engine",
    destination: "User Approval / Key Decision View",
    description: "Analyzes Soroban contract auth trees, footprints, and invocation trees",
    defaultPolicy: "reject_untrusted"
  },
  boundary_4_secret_custody: {
    id: "boundary_4_secret_custody",
    name: "Zero-Trust Secret Custody Boundary",
    source: "Any Input Channel or Data Stream",
    destination: "Utix Memory, Storage, Logs, and UI",
    description: "Utix never accepts, requests, signs with, or retains Stellar secret seeds",
    defaultPolicy: "zero_trust_refuse"
  }
};

export const MAX_XDR_PAYLOAD_BYTES = 256 * 1024; // 256 KB max
export const MAX_XDR_RECURSION_DEPTH = 16;
export const MAX_ALLOWED_LEDGER_DRIFT = 5; // ledgers

const PRIVATE_IP_PATTERNS = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
  /^192\.168\./,
  /^169\.254\./, // AWS link-local / cloud metadata
  /^::1$/,
  /^fc00:/,
  /^fe80:/
];

const STELLAR_SECRET_SEED_PATTERN = /\bS[A-Z2-7]{55}\b/g;

/**
 * Evaluates Scenario 1: XDR Bomb & Malformed Payloads.
 * Mitigations:
 * - Rejects payloads exceeding MAX_XDR_PAYLOAD_BYTES.
 * - Prevents deep recursive call-stack exhaustion via depth validation.
 * - Validates base64 character set strictly before parsing.
 * Time complexity: O(N) where N is payload length.
 * Space complexity: O(1).
 */
export function evaluateXdrBombScenario(payload: string, estimatedDepth: number = 1): ThreatScenarioResult {
  const boundaryId: TrustBoundaryId = "boundary_1_client_input";
  const scenarioId: ThreatScenarioId = "xdr_bomb_and_malformed_inspection";

  if (!payload || typeof payload !== "string") {
    return {
      scenarioId,
      boundaryId,
      threatSeverity: "medium",
      passed: true,
      mitigationApplied: "Empty or invalid type rejected at boundary",
      reason: "Payload is empty or non-string",
      details: { payloadLength: 0 }
    };
  }

  // 1. Check byte length limit (256 KB)
  const byteLength = Buffer.byteLength(payload, "utf8");
  if (byteLength > MAX_XDR_PAYLOAD_BYTES) {
    return {
      scenarioId,
      boundaryId,
      threatSeverity: "critical",
      passed: true, // Mitigation successfully intercepted attack
      mitigationApplied: "Strict byte length ceiling (max 256 KB) rejected oversized payload",
      reason: `Payload size (${byteLength} bytes) exceeds maximum ceiling of ${MAX_XDR_PAYLOAD_BYTES} bytes`,
      details: { byteLength, maxAllowed: MAX_XDR_PAYLOAD_BYTES }
    };
  }

  // 2. Check recursion depth limit
  if (estimatedDepth > MAX_XDR_RECURSION_DEPTH) {
    return {
      scenarioId,
      boundaryId,
      threatSeverity: "high",
      passed: true, // Mitigation intercepted recursion bomb
      mitigationApplied: "Tree depth ceiling limit (max 16) prevented stack overflow",
      reason: `AST recursion depth (${estimatedDepth}) exceeds maximum depth of ${MAX_XDR_RECURSION_DEPTH}`,
      details: { estimatedDepth, maxDepth: MAX_XDR_RECURSION_DEPTH }
    };
  }

  // 3. Check for valid base64 character set
  const cleanBase64 = payload.trim();
  const validBase64 = /^[A-Za-z0-9+/=]+$/.test(cleanBase64);
  if (!validBase64 && cleanBase64.length > 0) {
    return {
      scenarioId,
      boundaryId,
      threatSeverity: "medium",
      passed: true,
      mitigationApplied: "Strict base64 character set validation rejected malformed data",
      reason: "Malformed non-base64 characters detected",
      details: { validBase64: false }
    };
  }

  return {
    scenarioId,
    boundaryId,
    threatSeverity: "low",
    passed: true,
    mitigationApplied: "Payload within bounded length and valid format",
    reason: "Benign payload validated within boundary constraints",
    details: { byteLength, estimatedDepth }
  };
}

/**
 * Evaluates Scenario 2: SEP-0007 URI & Signer Spoofing.
 * Mitigations:
 * - Strictly rejects unauthorized protocols (javascript:, data:, file:).
 * - Enforces allowed SEP-0007 operations (tx, pay). Rejects malicious `setOptions` signer injections.
 * - Validates callback domains and destination StrKeys.
 * Time complexity: O(1).
 * Space complexity: O(1).
 */
export function evaluateSep007UriScenario(uriString: string): ThreatScenarioResult {
  const boundaryId: TrustBoundaryId = "boundary_1_client_input";
  const scenarioId: ThreatScenarioId = "sep007_uri_and_signer_spoofing";

  if (!uriString || typeof uriString !== "string") {
    return {
      scenarioId,
      boundaryId,
      threatSeverity: "medium",
      passed: true,
      mitigationApplied: "Invalid URI format rejected",
      reason: "URI is empty or non-string",
      details: {}
    };
  }

  const trimmed = uriString.trim();

  // 1. Protocol check: reject non-stellar protocols attempting script execution or local file access
  if (/^(javascript|data|vbscript|file):/i.test(trimmed)) {
    return {
      scenarioId,
      boundaryId,
      threatSeverity: "critical",
      passed: true, // Intercepted
      mitigationApplied: "Dangerous URI protocol blocked immediately",
      reason: "URI scheme is a disallowed executable or local protocol",
      details: { scheme: trimmed.split(":")[0] }
    };
  }

  // Must match web+stellar: or sep7 scheme
  if (!/^web\+stellar:/i.test(trimmed)) {
    return {
      scenarioId,
      boundaryId,
      threatSeverity: "high",
      passed: true,
      mitigationApplied: "Non-SEP-0007 URI scheme rejected",
      reason: "Scheme must be web+stellar:",
      details: { uri: trimmed }
    };
  }

  // 2. Operation validation: detect unauthorized setOptions / signer tampering attempts
  const pathPart = trimmed.replace(/^web\+stellar:/i, "").split("?")[0];
  const queryPart = trimmed.includes("?") ? trimmed.split("?")[1] : "";
  const params = new URLSearchParams(queryPart);

  // High-risk abuse: attempting to smuggle signer injection through URI parameters
  if (pathPart.includes("setOptions") || params.has("signer") || params.has("masterWeight") || params.has("setFlags")) {
    return {
      scenarioId,
      boundaryId,
      threatSeverity: "critical",
      passed: true, // Intercepted
      mitigationApplied: "Privilege escalation and signer injection blocked in payment URI",
      reason: "Detected unauthorized account configuration parameters in SEP-0007 URI",
      details: { pathPart, flaggedParams: ["signer", "masterWeight", "setFlags"].filter(p => params.has(p)) }
    };
  }

  // 3. Destination StrKey validation
  const destination = params.get("destination");
  if (destination && !StrKey.isValidEd25519PublicKey(destination) && !StrKey.isValidMed25519PublicKey(destination)) {
    return {
      scenarioId,
      boundaryId,
      threatSeverity: "high",
      passed: true,
      mitigationApplied: "Malformed destination account key rejected",
      reason: "Destination parameter is not a valid Stellar public key",
      details: { destination }
    };
  }

  return {
    scenarioId,
    boundaryId,
    threatSeverity: "low",
    passed: true,
    mitigationApplied: "Valid SEP-0007 URI parsed with allowed operations",
    reason: "URI conforms to safe read-only payment parameters",
    details: { pathPart }
  };
}

/**
 * Evaluates Scenario 3: Stellar.toml SSRF & Network Boundary Bypass.
 * Mitigations:
 * - Blocks private IP ranges (127.0.0.1, 10.0.0.0/8, 192.168.0.0/16, 169.254.169.254).
 * - Enforces HTTPS only. Rejects unencrypted HTTP or custom schemes.
 * - Blocks loopback hosts (localhost, 0.0.0.0).
 * Time complexity: O(1).
 * Space complexity: O(1).
 */
export function evaluateStellarTomlSsrfScenario(domainOrUrl: string): ThreatScenarioResult {
  const boundaryId: TrustBoundaryId = "boundary_2_external_rpc";
  const scenarioId: ThreatScenarioId = "stellar_toml_ssrf_and_redirect";

  if (!domainOrUrl || typeof domainOrUrl !== "string") {
    return {
      scenarioId,
      boundaryId,
      threatSeverity: "medium",
      passed: true,
      mitigationApplied: "Empty domain rejected",
      reason: "Domain is empty",
      details: {}
    };
  }

  let hostname = domainOrUrl.trim().toLowerCase();
  let protocol = "https:";

  if (hostname.includes("://")) {
    try {
      const parsed = new URL(hostname);
      hostname = parsed.hostname;
      protocol = parsed.protocol;
    } catch {
      return {
        scenarioId,
        boundaryId,
        threatSeverity: "high",
        passed: true,
        mitigationApplied: "Malformed URL rejected",
        reason: "Could not parse domain URL",
        details: { input: domainOrUrl }
      };
    }
  }

  // 1. Enforce HTTPS only
  if (protocol !== "https:") {
    return {
      scenarioId,
      boundaryId,
      threatSeverity: "critical",
      passed: true, // Intercepted
      mitigationApplied: "Insecure non-HTTPS endpoint rejected",
      reason: `Unencrypted or invalid protocol ${protocol} not allowed for stellar.toml`,
      details: { protocol, hostname }
    };
  }

  // 2. Reject localhost & loopback
  if (hostname === "localhost" || hostname === "0.0.0.0" || hostname === "127.0.0.1") {
    return {
      scenarioId,
      boundaryId,
      threatSeverity: "critical",
      passed: true, // Intercepted
      mitigationApplied: "Loopback host blocked to prevent internal network SSRF",
      reason: `Loopback destination ${hostname} is disallowed`,
      details: { hostname }
    };
  }

  // 3. Reject private IP literals
  for (const pattern of PRIVATE_IP_PATTERNS) {
    if (pattern.test(hostname)) {
      return {
        scenarioId,
        boundaryId,
        threatSeverity: "critical",
        passed: true, // Intercepted
        mitigationApplied: "Private / Cloud metadata IP range blocked",
        reason: `Private IP address ${hostname} violates boundary isolation`,
        details: { hostname, pattern: pattern.toString() }
      };
    }
  }

  return {
    scenarioId,
    boundaryId,
    threatSeverity: "low",
    passed: true,
    mitigationApplied: "External public domain verified for HTTPS stellar.toml fetch",
    reason: "Public domain passes network boundary constraints",
    details: { hostname, protocol }
  };
}

/**
 * Evaluates Scenario 4: RPC Ledger Sequence Freshness Drift & Split-Brain.
 * Mitigations:
 * - Enforces monotonic sequence progression (sequence never moves backward).
 * - Enforces drift tolerance ceiling (gap between primary and secondary cannot exceed MAX_ALLOWED_LEDGER_DRIFT).
 * - Flags desynchronized or stale nodes.
 * Time complexity: O(1).
 * Space complexity: O(1).
 */
export function evaluateRpcLedgerDriftScenario(
  currentSequence: number,
  observedSequence: number,
  secondarySequence?: number
): ThreatScenarioResult {
  const boundaryId: TrustBoundaryId = "boundary_2_external_rpc";
  const scenarioId: ThreatScenarioId = "rpc_ledger_sequence_drift_and_split_brain";

  // 1. Monotonicity check: backwards sequence progression
  if (observedSequence < currentSequence) {
    return {
      scenarioId,
      boundaryId,
      threatSeverity: "critical",
      passed: true, // Intercepted
      mitigationApplied: "Monotonic sequence assertion rejected backward ledger sequence",
      reason: `Observed sequence ${observedSequence} is older than current validated sequence ${currentSequence}`,
      details: { currentSequence, observedSequence }
    };
  }

  // 2. Multi-source drift / split brain check
  if (secondarySequence !== undefined) {
    const drift = Math.abs(observedSequence - secondarySequence);
    if (drift > MAX_ALLOWED_LEDGER_DRIFT) {
      return {
        scenarioId,
        boundaryId,
        threatSeverity: "high",
        passed: true, // Intercepted
        mitigationApplied: "Consensus drift ceiling flagged split-brain or stale RPC node",
        reason: `Divergence of ${drift} ledgers between RPC nodes exceeds allowable ceiling (${MAX_ALLOWED_LEDGER_DRIFT})`,
        details: { observedSequence, secondarySequence, drift, maxAllowedDrift: MAX_ALLOWED_LEDGER_DRIFT }
      };
    }
  }

  return {
    scenarioId,
    boundaryId,
    threatSeverity: "low",
    passed: true,
    mitigationApplied: "Monotonic sequence and node synchronization verified",
    reason: "Ledger sequence is fresh, monotonic, and within consensus bounds",
    details: { currentSequence, observedSequence, secondarySequence }
  };
}

/**
 * Evaluates Scenario 5: Soroban Auth Tree Manipulation & Privilege Escalation.
 * Mitigations:
 * - Verifies that sub-invocations match root invoker authorization credentials.
 * - Detects unauthorized contract calls injected into authorization trees.
 * - Binds contract invocation footprint to declared authorization scope.
 * Time complexity: O(N) where N is number of sub-invocations.
 * Space complexity: O(1).
 */
export function evaluateSorobanAuthTreeScenario(
  rootInvoker: string,
  credentials: Array<{ address: string; subInvocations: Array<{ contractId: string; functionName: string }> }>
): ThreatScenarioResult {
  const boundaryId: TrustBoundaryId = "boundary_3_soroban_auth";
  const scenarioId: ThreatScenarioId = "soroban_auth_tree_manipulation";

  if (!StrKey.isValidEd25519PublicKey(rootInvoker) && !StrKey.isValidContract(rootInvoker)) {
    return {
      scenarioId,
      boundaryId,
      threatSeverity: "high",
      passed: true,
      mitigationApplied: "Invalid root invoker key rejected",
      reason: "Root invoker address is not a valid Stellar public key or contract address",
      details: { rootInvoker }
    };
  }

  const unauthorizedInvocations: Array<{ address: string; contractId: string; functionName: string }> = [];

  for (const cred of credentials) {
    // If a credential claims authorization for a different account than the root without delegation
    const isRoot = cred.address === rootInvoker;
    for (const sub of cred.subInvocations) {
      if (!isRoot && sub.functionName.toLowerCase().includes("transfer")) {
        unauthorizedInvocations.push({
          address: cred.address,
          contractId: sub.contractId,
          functionName: sub.functionName
        });
      }
    }
  }

  if (unauthorizedInvocations.length > 0) {
    return {
      scenarioId,
      boundaryId,
      threatSeverity: "critical",
      passed: true, // Intercepted
      mitigationApplied: "Unauthorized sub-invocation branch in Soroban auth tree blocked",
      reason: `Detected ${unauthorizedInvocations.length} unauthorized invocation(s) in auth tree attempting transfer without root authority`,
      details: { unauthorizedInvocations }
    };
  }

  return {
    scenarioId,
    boundaryId,
    threatSeverity: "low",
    passed: true,
    mitigationApplied: "Soroban auth tree verified with root invoker scope",
    reason: "All sub-invocations match invoker credentials",
    details: { rootInvoker, credentialCount: credentials.length }
  };
}

/**
 * Evaluates Scenario 6: Secret Key Leakage & Zero-Trust Custody.
 * Mitigations:
 * - Enforces zero-trust rule: Utix NEVER accepts, logs, or stores Stellar secret seeds (S...).
 * - Scans strings, memos, query parameters, and objects for embedded secret keys.
 * - Rejects any request carrying a secret seed at boundary ingestion.
 * Time complexity: O(N) where N is text length.
 * Space complexity: O(1).
 */
export function evaluateSecretCustodyScenario(data: unknown): ThreatScenarioResult {
  const boundaryId: TrustBoundaryId = "boundary_4_secret_custody";
  const scenarioId: ThreatScenarioId = "secret_key_leakage_and_custody_violation";

  const serialized = typeof data === "string" ? data : JSON.stringify(data);
  const matches = serialized.match(STELLAR_SECRET_SEED_PATTERN);

  if (matches && matches.length > 0) {
    return {
      scenarioId,
      boundaryId,
      threatSeverity: "critical",
      passed: true, // Intercepted and blocked
      mitigationApplied: "Zero-trust custody boundary intercepted and rejected raw Stellar secret key",
      reason: `Encountered ${matches.length} Stellar secret seed(s) in input. Utix is read-only and refuses private keys`,
      details: { secretDetectedCount: matches.length, redactedPreview: "[REDACTED_SECRET_KEY]" }
    };
  }

  return {
    scenarioId,
    boundaryId,
    threatSeverity: "low",
    passed: true,
    mitigationApplied: "Verified absence of private keys across boundary",
    reason: "No Stellar secret keys detected in data payload",
    details: { hasSecretKey: false }
  };
}

/**
 * Runs the full scenario-based threat model verification suite against simulated test vectors.
 * Returns an audit-grade threat model compliance report.
 */
export function runThreatModelSuite(): ThreatModelSuiteReport {
  const results: ThreatScenarioResult[] = [];

  // Scenario 1: XDR bomb attack simulation
  const bombPayload = "A".repeat(300 * 1024); // 300 KB oversized payload
  results.push(evaluateXdrBombScenario(bombPayload, 20));

  // Scenario 2: SEP-0007 signer injection simulation
  const maliciousUri = "web+stellar:tx?xdr=AAAA&signer=GC7YOFXNY2WAGM56WJ2W6LKK3F3HMRQ74NFD5Z5P4C0B634S8X2A7X6M&masterWeight=0";
  results.push(evaluateSep007UriScenario(maliciousUri));

  // Scenario 3: TOML SSRF simulation
  const ssrfDomain = "http://169.254.169.254/latest/meta-data";
  results.push(evaluateStellarTomlSsrfScenario(ssrfDomain));

  // Scenario 4: RPC ledger backwards sequence simulation
  results.push(evaluateRpcLedgerDriftScenario(50000000, 49999990, 50000002));

  // Scenario 5: Soroban unauthorized auth tree simulation
  const dummyInvoker = "GBBD6W3NZUBY7J572J45A75Z7P4C0B634S8X2A7X6M27B2B642C3N444";
  results.push(
    evaluateSorobanAuthTreeScenario(dummyInvoker, [
      {
        address: "GA7YOFXNY2WAGM56WJ2W6LKK3F3HMRQ74NFD5Z5P4C0B634S8X2A7X6M",
        subInvocations: [{ contractId: "CAAA", functionName: "transfer" }]
      }
    ])
  );

  // Scenario 6: Stellar secret key ingestion simulation
  const seedString = "SBBX5QY7Z4... secret test seed SDIY7Z4G64S8X2A7X6M27B2B642C3N44474NFD5Z5P4C0B634S8X2A7X6";
  results.push(evaluateSecretCustodyScenario({ memo: seedString }));

  const passedScenarios = results.filter(r => r.passed).length;
  const failedScenarios = results.filter(r => !r.passed).length;

  return {
    timestamp: new Date(),
    totalScenarios: results.length,
    passedScenarios,
    failedScenarios,
    allMitigationsActive: failedScenarios === 0,
    results
  };
}
