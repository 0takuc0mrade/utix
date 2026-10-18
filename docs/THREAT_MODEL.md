# Utix Threat Model: Cross-Boundary Trust Decisions

## Context and Purpose

Utix is an open-source, read-only developer toolkit for Stellar and Soroban. Utix tools inspect transactions, decode XDR, query Horizon and Soroban RPCs, resolve federation addresses, and generate payment requests.

Because Utix runs directly in the client browser and interacts with external distributed networks, it operates across four distinct **Trust Boundaries**. A compromise or unhandled edge case at any boundary could expose users to spoofed assets, unauthorized account modifications, denial of service, or secret key leakage.

This threat model outlines the trust boundaries, abuse cases, STRIDE classifications, concrete mitigations, operational edge cases, failure modes, and recovery procedures.

## Trust Boundaries

```
[Untrusted Client / Web / QR] 
        │
        ▼ (Boundary 1)
[Utix Input Parsers & Validators] -> (Boundary 4: Zero-Trust Custody) -> [No Private Keys Retained]
        │
        ▼ (Boundary 2)
[External Horizon / RPC / TOML Providers]
        │
        ▼ (Boundary 3)
[Soroban Diagnostics & User Approval Flow]
```

### Boundary 1: Untrusted Public Client -> Utix Input Parsers
- **Source**: Untrusted user input, query parameters, web browsers, QR code scanners.
- **Destination**: Client-side parsing engines (XDR inspector, SEP-0007 parser, StrKey validator).
- **Default Policy**: `sanitize_and_bound`. Never execute or parse unbounded inputs.

### Boundary 2: Utix Core -> External Network RPC & Horizon Providers
- **Source**: Utix core network client.
- **Destination**: Public Stellar Horizon nodes, Soroban RPC servers, and anchor domain servers (`stellar.toml`).
- **Default Policy**: `reject_untrusted`. Verify domain reputation, enforce HTTPS, and validate ledger sequence monotonicity.

### Boundary 3: Soroban Contract Diagnostics -> User Simulation
- **Source**: Soroban contract analysis engine.
- **Destination**: User approval screen and key decision view.
- **Default Policy**: `reject_untrusted`. Enforce explicit root invoker authorization and detect unverified sub-invocations.

### Boundary 4: Zero-Trust Custody & Secret Scrubbing Boundary
- **Source**: Any inbound data stream, memo, URL, or JSON payload.
- **Destination**: Utix state, local storage, telemetry, and error logs.
- **Default Policy**: `zero_trust_refuse`. Utix is strictly read-only. Secret seeds (`S...`) are immediately intercepted and rejected.

## Scenario-Based Abuse Cases & Mitigations

### 1. XDR Bomb & Malformed Payloads
- **Threat (STRIDE: Denial of Service)**: Attacker crafts a deeply nested or multi-megabyte XDR payload to induce CPU lockup or call-stack overflow in client browsers.
- **Mitigation**:
  * Byte size ceiling enforced before deserialization: `MAX_XDR_PAYLOAD_BYTES = 256 KB`.
  * Recursive AST depth ceiling enforced: `MAX_XDR_RECURSION_DEPTH = 16`.
  * Character set pre-validation: rejects non-base64 input before parser initialization.
- **Executable Check**: `evaluateXdrBombScenario(payload, depth)`.

### 2. SEP-0007 URI & Signer Spoofing
- **Threat (STRIDE: Elevation of Privilege / Tampering)**: Attacker creates a malicious QR code or `web+stellar:` link that attempts script execution (`javascript:`) or injects unauthorized `setOptions` parameters to replace signers or lower account thresholds.
- **Mitigation**:
  * Strict protocol whitelist: allows only `web+stellar:`. Rejects `javascript:`, `data:`, `file:`.
  * Parameter allowlisting: rejects dangerous account configuration flags (`signer`, `masterWeight`, `setFlags`).
  * StrKey verification: ensures destination is a valid 56-character Ed25519 public key.
- **Executable Check**: `evaluateSep007UriScenario(uriString)`.

### 3. Stellar.toml SSRF & Network Boundary Bypass
- **Threat (STRIDE: Information Disclosure / Spoofing)**: Attacker inputs an anchor domain resolving to private IP space (`127.0.0.1`, `10.0.0.0/8`, `192.168.0.0/16`) or cloud metadata endpoints (`169.254.169.254`) to query internal cloud credentials.
- **Mitigation**:
  * Protocol constraint: strictly HTTPS (`https:`).
  * Hostname constraint: blocks `localhost`, `0.0.0.0`, and private IP patterns.
  * Timeout bounds: HTTP request timeout capped at 5 seconds.
- **Executable Check**: `evaluateStellarTomlSsrfScenario(domainOrUrl)`.

### 4. RPC Ledger Sequence Freshness Drift & Split-Brain
- **Threat (STRIDE: Tampering / Repudiation)**: Stale, partitioned, or malicious Horizon nodes return outdated ledger sequences, tricking developers into building transactions with invalid sequence numbers or believing transactions failed.
- **Mitigation**:
  * Monotonicity assertion: ledger sequence must never move backwards (`observedSequence >= currentSequence`).
  * Consensus drift ceiling: multi-source sequence drift must not exceed `MAX_ALLOWED_LEDGER_DRIFT = 5` ledgers.
- **Executable Check**: `evaluateRpcLedgerDriftScenario(current, observed, secondary)`.

### 5. Soroban Auth Tree Manipulation
- **Threat (STRIDE: Elevation of Privilege)**: Malicious smart contracts present authorization trees where nested sub-invocations perform unauthorized token transfers from third-party addresses without root invoker consent.
- **Mitigation**:
  * Recursive authorization tree validation: ensures sub-invocations match root invoker credentials.
  * Disallowed transfer branches: flags unauthorized token transfers lacking explicit invocation credentials.
- **Executable Check**: `evaluateSorobanAuthTreeScenario(rootInvoker, credentials)`.

### 6. Secret Key Leakage & Zero-Trust Custody
- **Threat (STRIDE: Information Disclosure)**: User accidentally pastes a Stellar secret seed (`S...`) into a transaction search bar, memo, or URI parameter.
- **Mitigation**:
  * Regex boundary interceptor: detects `/\bS[A-Z2-7]{55}\b/g`.
  * Zero-trust invariant: immediately rejects operation with an explicit security error and redacts the secret from memory, state, and telemetry.
- **Executable Check**: `evaluateSecretCustodyScenario(data)`.

## Operational Edge Cases and Failure Modes

1. **Stale DNS / Network Partitions**: If public Horizon endpoints lag behind the network, Utix triggers sequence freshness warnings and prompts the user to switch RPC endpoints.
2. **Anchor Domain Timeouts**: If a `stellar.toml` fetch times out or returns non-200 status, Utix fails closed, displaying an unverified warning rather than caching partial metadata.
3. **Deeply Nested Transaction Envelopes**: When XDR recursion exceeds depth 16, Utix aborts with an informative warning rather than crashing the browser tab.

## Rollback and Recovery Steps

1. If an untrusted parser bug is discovered:
   - Immediately disable the affected feature slice via the emergency feature flag / kill-switch.
   - Run post-rollback validation: `npm run rollback:verify`.
   - Confirm zero-trust secret custody invariant is maintained.
2. In case of malicious endpoint poisoning:
   - Clear browser cache and reset RPC endpoint configurations to official Stellar defaults (`horizon.stellar.org`).
   - Run the threat model verification suite: `npm test -- core/security`.
