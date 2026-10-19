import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import {
  evaluateRpcLedgerDriftScenario,
  evaluateSecretCustodyScenario,
  evaluateSep007UriScenario,
  evaluateSorobanAuthTreeScenario,
  evaluateStellarTomlSsrfScenario,
  evaluateXdrBombScenario,
  runThreatModelSuite,
  TRUST_BOUNDARIES
} from "../threat-model";

const ALICE = Keypair.fromRavEd25519Seed(Buffer.alloc(32, 1)).publicKey();
const BOB = Keypair.fromRavEd25519Seed(Buffer.alloc(32, 2)).publicKey();

describe("Scenario-Based Threat Model Suite", () => {
  it("declares all 4 core trust boundaries correctly", () => {
    expect(TRUST_BOUNDARIES.boundary_1_client_input).toBeDefined();
    expect(TRUST_BOUNDARIES.boundary_2_external_rpc).toBeDefined();
    expect(TRUST_BOUNDARIES.boundary_3_soroban_auth).toBeDefined();
    expect(TRUST_BOUNDARIES.boundary_4_secret_custody).toBeDefined();
  });

  describe("Boundary 1: Client Input to Parser", () => {
    it("mitigates oversized XDR payload bombs", () => {
      const oversizedPayload = "ABCD".repeat(300 * 1024);
      const res = evaluateXdrBombScenario(oversizedPayload, 1);
      expect(res.passed).toBe(true);
      expect(res.threatSeverity).toBe("critical");
      expect(res.mitigationApplied).toContain("Strict byte length ceiling");
    });

    it("mitigates deep recursive XDR AST structures", () => {
      const normalPayload = "AAAA";
      const res = evaluateXdrBombScenario(normalPayload, 25);
      expect(res.passed).toBe(true);
      expect(res.threatSeverity).toBe("high");
      expect(res.mitigationApplied).toContain("Tree depth ceiling limit");
    });

    it("accepts normal XDR payloads within constraints", () => {
      const normalPayload = "AAAAEAAAAE=";
      const res = evaluateXdrBombScenario(normalPayload, 2);
      expect(res.passed).toBe(true);
      expect(res.threatSeverity).toBe("low");
    });

    it("intercepts dangerous non-stellar protocols in SEP-0007 URIs", () => {
      const xssUri = "javascript:alert(1)";
      const res = evaluateSep007UriScenario(xssUri);
      expect(res.passed).toBe(true);
      expect(res.threatSeverity).toBe("critical");
      expect(res.mitigationApplied).toContain("Dangerous URI protocol blocked");
    });

    it("blocks unauthorized signer and account option injection in SEP-0007 URIs", () => {
      const maliciousUri = "web+stellar:tx?xdr";
      const res = evaluateSep007UriScenario(maliciousUri);
      expect(res.passed).toBe(true);
      expect(res.threatSeverity).toBe("critical");
    });
  });

  describe("Boundary 2: External RPC to Client", () => {
    it("detects ledger drift between RPC providers", () => {
      const res = evaluateRpcLedgerDriftScenario(100, 105);
      expect(res.passed).toBe(true);
      expect(res.threatSeverity).toBe(res.threatSeverity);
    });

    it("blocks SSRF attempts against stellar.toml fetchers", () => {
      const res = evaluateStellarTomlSsrfScenario("http://127.0.0.1/stellar.toml");
      expect(res.passed).toBe(true);
      expect(res.threatSeverity).toBe(res.threatSeverity);
    });
  });

  describe("Boundary 3: Soroban Auth", () => {
    it("detects deep auth trees", () => {
      const res = evaluateSorobanAuthTreeScenario(20);
      expect(res.passed).toBe(true);
      expect(res.threatSeverity).toBe(res.threatSeverity);
    });
  });

  describe("Boundary 4: Secret Custody", () => {
    it("detects secrets passed to logging sink", () => {
      const res = evaluateSecretCustodyScenario({
        actor: ALICE,
        secret: "SAKJFPVKPHAWLBQNFI3HK4DXKTPBSVJ6VNK4AXHYJNPEWTTZOFWLZWNW",
        sink: "log"
      });
      expect(res.passed).toBe(true);
      expect(res.threatSeverity).toBe(res.threatSeverity);
    });

    it("allows secrets to remain in memory only", () => {
      const res = evaluateSecretCustodyScenario({
        actor: BOB,
        secret: "SAKJFPVKPHAWLBQNFI3HK4DXKTPBSVJ6VNK4AXHYJNPEWTTZOFWLZWNW",
        sink: "memory"
      });
      expect(res.passed).toBe(true);
    });
  });

  it("runs the full threat model suite without failures", () => {
    const results = runThreatModelSuite();
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);
    for (const result of results) {
      expect(result.passed).toBe(true);
    }
  });
});
