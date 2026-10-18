export interface TelemetryProtectionOptions { readonly sampleRate?: number; readonly maxCardinality?: number; readonly redactKeys?: readonly string[]; readonly random?: () => number; }
export interface ProtectedTelemetry { readonly sampled: boolean; readonly event: Record<string, unknown> | null; }
const DEFAULT_REDACT_KEYS = ["secret", "token", "password", "seed", "authorization", "credential"];
export function protectTelemetry(event: Record<string, unknown>, options: TelemetryProtectionOptions = {}): ProtectedTelemetry {
  const rate = Math.min(1, Math.max(0, options.sampleRate ?? 1)); const sampled = (options.random ?? Math.random)() < rate;
  if (!sampled) return { sampled: false, event: null };
  const keys = new Set((options.redactKeys ?? DEFAULT_REDACT_KEYS).map((key) => key.toLowerCase()));
  const entries = Object.entries(event).slice(0, options.maxCardinality ?? 100);
  return { sampled: true, event: Object.fromEntries(entries.map(([key, value]) => [key, keys.has(key.toLowerCase()) || /secret|token|password|seed|auth|credential/i.test(key) ? "[REDACTED]" : value])) };
}
