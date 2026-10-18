import type { Result } from "@/core/result/result";

export interface UrlInfo {
  readonly url: string;
  readonly scheme: string;
  readonly host: string;
  readonly port: number | null;
  readonly pathname: string;
}

export interface FileTypeInfo {
  readonly fileName: string;
  /** Lowercase extension including the leading dot, e.g. `.json`. */
  readonly extension: string;
  readonly mime: string | null;
  readonly size: number;
}

export interface DestinationInfo {
  readonly destination: string;
  readonly kind: "stellar_public_key" | "allowed_list";
}

export type AllowListErrorCode =
  | "url_invalid"
  | "url_not_allowed"
  | "url_has_credentials"
  | "url_disallowed_port"
  | "file_type_not_allowed"
  | "file_too_large"
  | "destination_invalid"
  | "destination_not_allowed"
  | "destination_is_secret";

export interface UrlPolicy {
  readonly allowedSchemes: readonly string[];
  readonly allowedHosts: readonly string[];
  readonly allowedPorts: readonly number[];
}

export interface FileTypePolicy {
  readonly allowedExtensions: readonly string[];
  readonly allowedMimes: readonly string[];
  readonly maxSize: number;
}

export interface DestinationPolicy {
  readonly allowedDestinations: readonly string[];
  readonly allowStellarPublicKeys: boolean;
}

export interface UrlValidator {
  (url: string): Result<UrlInfo, AllowListErrorCode>;
}

export interface FileTypeValidator {
  (fileName: string, mime: string | null, size: number): Result<FileTypeInfo, AllowListErrorCode>;
}

export interface DestinationValidator {
  (destination: string): Result<DestinationInfo, AllowListErrorCode>;
}

/**
 * Default URL allow-list: only the Stellar network endpoints and Friendbot,
 * only over https, with no embedded credentials and no explicit ports.
 */
export const DEFAULT_URL_POLICY: UrlPolicy = {
  allowedSchemes: ["https:"],
  allowedHosts: [
    "horizon-testnet.stellar.org",
    "horizon.stellar.org",
    "soroban-testnet.stellar.org",
    "mainnet.sorobanrpc.com",
    "friendbot.stellar.org"
  ],
  allowedPorts: []
};

/**
 * Default file-type allow-list: the export / attachment types Utix handles,
 * capped at 10 MiB.
 */
export const DEFAULT_FILE_TYPE_POLICY: FileTypePolicy = {
  allowedExtensions: [".json", ".csv", ".png", ".jpg", ".jpeg", ".svg", ".txt"],
  allowedMimes: [
    "application/json",
    "text/csv",
    "image/png",
    "image/jpeg",
    "image/svg+xml",
    "text/plain"
  ],
  maxSize: 10 * 1024 * 1024
};

/**
 * Default destination allow-list: any well-formed Stellar public key is
 * accepted; no additional addresses are pre-approved.
 */
export const DEFAULT_DESTINATION_POLICY: DestinationPolicy = {
  allowedDestinations: [],
  allowStellarPublicKeys: true
};
