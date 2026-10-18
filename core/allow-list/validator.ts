/**
 * Strict allow-list validation for URLs, file types, and destinations.
 *
 * Every validator returns a `Result`: an allowed value is carried back, and a
 * rejected value carries a specific error code the caller maps to recovery
 * guidance. Validators never throw for expected failures, and they are
 * stateless and identity-agnostic — the same input is rejected or accepted
 * regardless of who supplied it, so there is no authorization bypass through
 * the validation layer.
 *
 * Policies are injected with sensible defaults so a caller can tighten or
 * relax a list without touching the validation logic.
 */

import { err, ok, type Result } from "@/core/result/result";
import type {
  AllowListErrorCode,
  DestinationInfo,
  DestinationPolicy,
  DestinationValidator,
  FileTypeInfo,
  FileTypePolicy,
  FileTypeValidator,
  UrlInfo,
  UrlPolicy,
  UrlValidator
} from "./types";

const DEFAULT_PORT: Readonly<Record<string, number>> = { "http:": 80, "https:": 443 };

// A Stellar public key (StrKey ed25519): a leading `G` followed by 55
// base-32 characters. Validated without the SDK so this module stays
// dependency-light.
const STELLAR_PUBLIC_KEY = /^G[A-Z2-7]{55}$/;

function isStellarPublicKey(value: string): boolean {
  return STELLAR_PUBLIC_KEY.test(value);
}

export function createUrlValidator(policy: UrlPolicy = DEFAULT_URL_POLICY): UrlValidator {
  const allowedSchemes = new Set(policy.allowedSchemes);
  const allowedHosts = new Set(policy.allowedHosts);
  const allowedPorts = new Set(policy.allowedPorts);

  return (url): Result<UrlInfo, AllowListErrorCode> => {
    if (typeof url !== "string" || !url.trim()) return err("url_invalid");

    let parsed: URL;
    try {
      parsed = new URL(url.trim());
    } catch {
      return err("url_invalid");
    }

    if (!allowedSchemes.has(parsed.protocol)) return err("url_not_allowed");
    if (parsed.username || parsed.password) return err("url_has_credentials");
    if (!allowedHosts.has(parsed.hostname)) return err("url_not_allowed");

    const port = parsed.port ? Number(parsed.port) : null;
    if (port !== null) {
      const defaultPort = DEFAULT_PORT[parsed.protocol] ?? 0;
      // An explicit port is only tolerated when it is the scheme default or on
      // the allow-list; anything else is rejected outright.
      if (port !== defaultPort && !allowedPorts.has(port)) return err("url_disallowed_port");
    }

    return ok({
      url: parsed.toString(),
      scheme: parsed.protocol,
      host: parsed.hostname,
      port,
      pathname: parsed.pathname
    });
  };
}

export function createFileTypeValidator(
  policy: FileTypePolicy = DEFAULT_FILE_TYPE_POLICY
): FileTypeValidator {
  const allowedExtensions = new Set(policy.allowedExtensions.map((e) => e.toLowerCase()));
  const allowedMimes = new Set(policy.allowedMimes.map((m) => m.toLowerCase()));

  return (fileName, mime, size): Result<FileTypeInfo, AllowListErrorCode> => {
    if (typeof size !== "number" || !Number.isFinite(size) || size < 0) return err("file_type_not_allowed");
    if (size > policy.maxSize) return err("file_too_large");

    const dot = fileName.lastIndexOf(".");
    const extension =
      dot === -1 || dot === 0 || dot === fileName.length - 1 ? "" : fileName.slice(dot).toLowerCase();
    if (!extension || !allowedExtensions.has(extension)) return err("file_type_not_allowed");

    if (mime !== null && mime !== undefined && !allowedMimes.has(mime.toLowerCase())) {
      return err("file_type_not_allowed");
    }

    return ok({ fileName, extension, mime: mime ?? null, size });
  };
}

export function createDestinationValidator(
  policy: DestinationPolicy = DEFAULT_DESTINATION_POLICY
): DestinationValidator {
  const allowedDestinations = new Set(policy.allowedDestinations);

  return (destination): Result<DestinationInfo, AllowListErrorCode> => {
    if (typeof destination !== "string" || !destination.trim()) return err("destination_invalid");
    const value = destination.trim();

    // Reject secret seeds on the prefix alone, before any other check.
    if (value.startsWith("S")) return err("destination_is_secret");

    if (policy.allowStellarPublicKeys && isStellarPublicKey(value)) {
      return ok({ destination: value, kind: "stellar_public_key" });
    }

    if (allowedDestinations.has(value)) {
      return ok({ destination: value, kind: "allowed_list" });
    }

    return err("destination_not_allowed");
  };
}

/**
 * Convenience validators built from the default policies. Suitable for the
 * common case; callers with stricter requirements should use the factories.
 */
export const validateUrl = createUrlValidator();
export const validateFileType = createFileTypeValidator();
export const validateDestination = createDestinationValidator();
