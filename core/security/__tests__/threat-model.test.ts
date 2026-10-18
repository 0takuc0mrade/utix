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

const ALICE = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1)).publicKey();
const BOB = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 2)).publicKey();

describe("Scenario-Based Threat Model Suite", () => {
  it("declares all 4 core trust boundaries correctly", () => {
    expect(TRUST_BOUNDARIES.boundary_1_client_input).toBeDefined();
    expect(TRUST_BOUNDARIES.boundary_2_external_rpc).toBeDefined();
    expect(TRUST_BOUNDARIES.boundary_3_soroban_auth).toBeDefined();
    expect(TRUST_BOUNDARIES.boundary_4_secret_custody).toBeDefined();
  });

  describe("Boundary 1: Client Input to Parser", () => {
    it("mitigates oversized XDR payload bombs", () => {
      const oversizedPayload = "A".repeat(300 * 1024);
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
      const normalPayload = "AAAAEAAAAAE=";
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
      const maliciousUri = `web+stellar:tx?xdr=AAAA&signer=${BOB}&masterWeight=0`;
      const res = evaluateSep007UriScenario(maliciousUri);
      expect(res.passed).toBe(true);
      expect(res.threatSeverity).toBe("critical");
      expect(res.mitigationApplied).toContain("Privilege escalation and signer injection blocked");
    });

    it("accepts valid benign payment URIs", () => {
      const safeUri = `web+stellar:pay?destination=${ALICE}&amount=10.5&memo=tickets`;
      const res = evaluateSep007UriScenario(safeUri);
      expect(res.passed).toBe(true);
      expect(res.threatSeverity).toBe("low");
    });
  });

  describe("Boundary 2: Core to External Horizon & RPC", () => {
    it("blocks cloud metadata service (169.254.169.254) SSRF attempts", () => {
      const ssrfTarget = "https://169.254.169.254/latest/meta-data";
      const res = evaluateStellarTomlSsrfScenario(ssrfTarget);
      expect(res.passed).toBe(true);
      expect(res.threatSeverity).toBe("critical");
      expect(res.mitigationApplied).toContain("Private / Cloud metadata IP range blocked");
    });

    it("blocks local loopback (127.0.0.1 and localhost) SSRF", () => {
      const loopbackTarget = "https://localhost:8080/.well-known/stellar.toml";
      const res = evaluateStellarTomlSsrfScenario(loopbackTarget);
      expect(res.passed).toBe(true);
      expect(res.threatSeverity).toBe("critical");
      expect(res.mitigationApplied).toContain("Loopback host blocked");
    });

    it("blocks unencrypted HTTP protocols", () => {
      const insecureTarget = "http://stellar.org/.well-known/stellar.toml";
      const res = evaluateStellarTomlSsrfScenario(insecureTarget);
      expect(res.passed).toBe(true);
      expect(res.threatSeverity).toBe("critical");
      expect(res.mitigationApplied).toContain("Insecure non-HTTPS endpoint rejected");
    });

    it("allows valid public HTTPS domains", () => {
      const validDomain = "https://stellar.org";
      const res = evaluateStellarTomlSsrfScenario(validDomain);
      expect(res.passed).toBe(true);
      expect(res.threatSeverity).toBe("low");
    });

    it("intercepts backwards-moving RPC ledger sequences", () => {
      const res = evaluateRpcLedgerDriftScenario(1000, 990);
      expect(res.passed).toBe(true);
      expect(res.threatSeverity).toBe("critical");
      expect(res.mitigationApplied).toContain("Monotonic sequence assertion rejected");
    });

    it("flags multi-source consensus drift exceeding drift ceiling", () => {
      const res = evaluateRpcLedgerDriftScenario(1000, 1000, 1010);
      expect(res.passed).toBe(true);
      expect(res.threatSeverity).toBe("high");
      expect(res.mitigationApplied).toContain("Consensus drift ceiling flagged split-brain");
    });
  });

  describe("Boundary 3: Soroban Contract Diagnostics", () => {
    it("blocks unauthorized transfer sub-invocations without root authority", () => {
      const res = evaluateSorobanAuthTreeScenario(ALICE, [
        {
          address: BOB,
          subInvocations: [{ contractId: "CDUMMYCONTRACT", functionName: "transfer" }]
        }
      ]);
      expect(res.passed).toBe(true);
      expect(res.threatSeverity).toBe("critical");
      expect(res.mitigationApplied).toContain("Unauthorized sub-invocation branch in Soroban auth tree blocked");
    });

    it("allows authorized sub-invocations matching root authority", () => {
      const res = evaluateSorobanAuthTreeScenario(ALICE, [
        {
          address: ALICE,
          subInvocations: [{ contractId: "CDUMMYCONTRACT", functionName: "transfer" }]
        }
      ]);
      expect(res.passed).toBe(true);
      expect(res.threatSeverity).toBe("low");
    });
  });

  describe("Boundary 4: Zero-Trust Secret Custody", () => {
    it("intercepts raw Stellar secret seed keys in input payloads", () => {
      const dummySeed = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7)).secret();
      const res = evaluateSecretCustodyScenario({ userMemo: `my key is ${dummySeed}` });
      expect(res.passed).toBe(true);
      expect(res.threatSeverity).toBe("critical");
      expect(res.mitigationApplied).toContain("Zero-trust custody boundary intercepted and rejected raw Stellar secret key");
    });

    it("passes clean inputs without secret keys", () => {
      const res = evaluateSecretCustodyScenario({ accountId: ALICE, memo: "Invoice #1234" });
      expect(res.passed).toBe(true);
      expect(res.threatSeverity).toBe("low");
    });
  });

  it("executes the full threat model suite and confirms all mitigations are active", () => {
    const suite = runThreatModelSuite();
    expect(suite.totalScenarios).toBe(6);
    expect(suite.passedScenarios).toBe(6);
    expect(suite.failedScenarios).toBe(0);
    expect(suite.allMitigationsActive).toBe(true);
  });
});
