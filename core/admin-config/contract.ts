import type { AdminConfigKey } from "./types";

export const REQUIRED_CONFIGURATION: readonly AdminConfigKey[] = [
  "network.endpoint", "network.passphrase", "role.default", "health.checkInterval"
];

export interface ConfigurationSnapshot { readonly environment: string; readonly values: Readonly<Record<string, unknown>>; }
export interface ConfigurationContractResult { readonly valid: boolean; readonly missing: readonly string[]; readonly invalid: readonly string[]; }

export function validateConfigurationContract(snapshot: ConfigurationSnapshot): ConfigurationContractResult {
  const missing = REQUIRED_CONFIGURATION.filter((key) => !(key in snapshot.values));
  const invalid = Object.keys(snapshot.values).filter((key) => !REQUIRED_CONFIGURATION.includes(key as AdminConfigKey));
  return { valid: missing.length === 0 && invalid.length === 0, missing, invalid };
}

export function compareConfigurationContracts(snapshots: readonly ConfigurationSnapshot[]): ConfigurationContractResult {
  const results = snapshots.map(validateConfigurationContract);
  return {
    valid: results.every((result) => result.valid),
    missing: results.flatMap((result, index) => result.missing.map((key) => `${snapshots[index].environment}:${key}`)),
    invalid: results.flatMap((result, index) => result.invalid.map((key) => `${snapshots[index].environment}:${key}`))
  };
}
