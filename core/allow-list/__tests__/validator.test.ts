import { describe, expect, it } from "vitest";
import {
  createDestinationValidator,
  createFileTypeValidator,
  createUrlValidator,
  validateDestination,
  validateFileType,
  validateUrl,
  type AllowListErrorCode
} from "@/core/allow-list/validator";

const VALID_STELLAR_KEY = "G" + "A".repeat(55); // 56 chars, matches /^G[A-Z2-7]{55}$/

describe("URL allow-list validation", () => {
  it.each([
    ["https://horizon-testnet.stellar.org", "url"],
    ["https://horizon.stellar.org/", "url"],
    ["https://soroban-testnet.stellar.org", "url"],
    ["https://mainnet.sorobanrpc.com", "url"],
    ["https://friendbot.stellar.org", "url"]
  ])("accepts an allowed https endpoint %s", (url) => {
    const result = validateUrl(url);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.host).toBe(new URL(url).hostname);
      expect(result.value.scheme).toBe("https:");
    }
  });

  it.each([
    ["http://horizon-testnet.stellar.org", "url_not_allowed"],
    ["https://evil.example", "url_not_allowed"],
    ["ftp://horizon-testnet.stellar.org", "url_not_allowed"],
    ["javascript:alert(1)", "url_not_allowed"],
    ["https://horizon-testnet.stellar.org:8443", "url_disallowed_port"]
  ])("rejects a disallowed URL %s with %s", (url, code) => {
    const result = validateUrl(url);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(code as AllowListErrorCode);
  });

  it.each([
    ["https://user:secret@horizon-testnet.stellar.org", "url_has_credentials"],
    ["not a url", "url_invalid"],
    ["", "url_invalid"],
    ["   ", "url_invalid"]
  ])("rejects %j with %s", (url, code) => {
    const result = validateUrl(url);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(code as AllowListErrorCode);
  });

  it("strips the query string from the recorded URL", () => {
    const result = validateUrl("https://horizon-testnet.stellar.org/?x=1");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.pathname).toBe("/");
  });

  it("applies a custom policy (tighter allow-list)", () => {
    const strict = createUrlValidator({
      allowedSchemes: ["https:"],
      allowedHosts: ["horizon-testnet.stellar.org"],
      allowedPorts: []
    });
    expect(strict("https://horizon-testnet.stellar.org").ok).toBe(true);
    const other = strict("https://horizon.stellar.org");
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.code).toBe("url_not_allowed");
  });

  it("retry: a rejected URL is not silently retried; a corrected input is accepted", () => {
    const bad = validateUrl("https://evil.example");
    expect(bad.ok).toBe(false);
    const fixed = validateUrl("https://horizon-testnet.stellar.org");
    expect(fixed.ok).toBe(true);
  });
});

describe("file type allow-list validation", () => {
  it.each([
    ["report.json", "application/json", 100],
    ["data.csv", "text/csv", 100],
    ["image.png", "image/png", 1000],
    ["photo.jpg", "image/jpeg", 1000],
    ["photo.jpeg", "image/jpeg", 1000],
    ["diagram.svg", "image/svg+xml", 1000],
    ["notes.txt", "text/plain", 100],
    ["no-mime-provided.txt", null, 100]
  ])("accepts an allowed file type %s", (fileName, mime, size) => {
    const result = validateFileType(fileName, mime, size);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.extension).toBe("." + fileName.split(".").pop()!.toLowerCase());
      expect(result.value.size).toBe(size);
    }
  });

  it.each([
    ["script.exe", null, 100, "file_type_not_allowed"],
    ["report.json", "application/x-executable", 100, "file_type_not_allowed"],
    ["noextension", null, 100, "file_type_not_allowed"],
    [".hidden", null, 100, "file_type_not_allowed"],
    ["big.json", "application/json", 20 * 1024 * 1024, "file_too_large"],
    ["report.json", "application/json", -1, "file_type_not_allowed"]
  ])("rejects %j with %s", (fileName, mime, size, code) => {
    const result = validateFileType(fileName, mime, size);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(code as AllowListErrorCode);
  });

  it("applies a custom policy that only allows csv", () => {
    const csvOnly = createFileTypeValidator({
      allowedExtensions: [".csv"],
      allowedMimes: ["text/csv"],
      maxSize: 1024
    });
    expect(csvOnly("data.csv", "text/csv", 100).ok).toBe(true);
    expect(csvOnly("report.json", "application/json", 100).ok).toBe(false);
    expect(csvOnly("data.csv", "text/csv", 2048).ok).toBe(false);
  });

  it("retry: a blocked file type is rejected, then an allowed file type is accepted", () => {
    const bad = validateFileType("script.exe", null, 100);
    expect(bad.ok).toBe(false);
    const fixed = validateFileType("report.json", "application/json", 100);
    expect(fixed.ok).toBe(true);
  });
});

describe("destination allow-list validation", () => {
  it("accepts a well-formed Stellar public key by default", () => {
    const result = validateDestination(VALID_STELLAR_KEY);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kind).toBe("stellar_public_key");
      expect(result.value.destination).toBe(VALID_STELLAR_KEY);
    }
  });

  it("accepts a pre-approved destination from the allowed list", () => {
    const list = createDestinationValidator({
      allowedDestinations: ["G" + "B".repeat(55), "https://webhook.example"],
      allowStellarPublicKeys: false
    });
    expect(list("G" + "B".repeat(55)).ok).toBe(true);
    if (list("G" + "B".repeat(55)).ok) {
      expect(list("G" + "B".repeat(55)).value.kind).toBe("allowed_list");
    }
    expect(list("https://webhook.example").ok).toBe(true);
  });

  it.each([
    ["S" + "A".repeat(55), "destination_is_secret"],
    ["", "destination_invalid"],
    ["   ", "destination_invalid"],
    ["not-a-destination", "destination_not_allowed"],
    ["G" + "!".repeat(55), "destination_not_allowed"]
  ])("rejects %j with %s", (destination, code) => {
    const result = validateDestination(destination);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(code as AllowListErrorCode);
  });

  it("rejects a stellar public key when public keys are disabled", () => {
    const noKeys = createDestinationValidator({
      allowedDestinations: [],
      allowStellarPublicKeys: false
    });
    expect(noKeys(VALID_STELLAR_KEY).ok).toBe(false);
    if (!noKeys(VALID_STELLAR_KEY).ok) {
      expect(noKeys(VALID_STELLAR_KEY).code).toBe("destination_not_allowed");
    }
  });

  it("rejects secret seeds on the prefix alone before any other check", () => {
    const result = validateDestination("S" + "A".repeat(55));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("destination_is_secret");
  });

  it("retry: a rejected destination is not retried silently; a corrected destination is accepted", () => {
    const bad = validateDestination("not-a-destination");
    expect(bad.ok).toBe(false);
    const fixed = validateDestination(VALID_STELLAR_KEY);
    expect(fixed.ok).toBe(true);
  });
});

describe("validation is identity-agnostic (no authorization bypass)", () => {
  it("produces the same strict result regardless of the caller", () => {
    // Validation has no notion of caller identity: it applies uniformly.
    const checks = [
      validateUrl("https://evil.example").ok === false,
      validateUrl("https://user:p@x.example").ok === false,
      validateFileType("script.exe", null, 100).ok === false,
      validateDestination("S" + "A".repeat(55)).ok === false
    ];
    for (const rejected of checks) {
      expect(rejected).toBe(true);
    }
    // A corrected input is accepted the same way every time.
    expect(validateUrl("https://horizon-testnet.stellar.org").ok).toBe(true);
    expect(validateDestination(VALID_STELLAR_KEY).ok).toBe(true);
  });
});
