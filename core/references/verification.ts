/**
 * Resilient external reference verification (#188).
 *
 * A reference is a URI the protocol depends on but does not control, such as an
 * event's metadata document or a ticket's artwork. `verifyReference` fetches it
 * through an injected fetcher, retries transient failures with exponential
 * backoff, and always settles on a persisted record: `verified`, or `failed`
 * with a code and an action a maintainer can take. It never throws and never
 * waits longer than `maxAttempts * timeoutMs` plus the backoff delays.
 *
 * Only transient failures (`timeout`, `unreachable`) are retried. A malformed,
 * stale or mismatching response will not improve on a second fetch, so it
 * fails immediately.
 */

export type ReferenceFailureCode =
  | "invalid_reference"
  | "timeout"
  | "unreachable"
  | "malformed_response"
  | "stale_response"
  | "hash_mismatch";

export interface ExternalReference {
  readonly id: string;
  /** What depends on the reference, e.g. `event_metadata`. */
  readonly kind: string;
  readonly uri: string;
  /** When set, the response's `contentHash` must equal it. */
  readonly expectedHash?: string;
}

/** What a fetcher must resolve with. Anything else is a malformed response. */
export interface ReferenceResponse {
  readonly contentHash: string;
  /** ISO timestamp of when the source produced this content. */
  readonly observedAt: string;
}

export type ReferenceFetcher = (uri: string, signal: AbortSignal) => Promise<unknown>;

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly timeoutMs: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  /** Responses observed longer ago than this are rejected as stale. */
  readonly maxStalenessMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  timeoutMs: 5_000,
  baseDelayMs: 200,
  maxDelayMs: 2_000,
  maxStalenessMs: 24 * 60 * 60 * 1000
};

export interface VerificationFailure {
  readonly code: ReferenceFailureCode;
  readonly message: string;
  /** What a maintainer should do next. */
  readonly action: string;
  /** True when the failure was transient and the attempts ran out. */
  readonly retriesExhausted: boolean;
}

export interface VerificationRecord {
  readonly referenceId: string;
  readonly status: "verified" | "failed";
  readonly attempts: number;
  /** ISO timestamp of the final attempt. */
  readonly checkedAt: string;
  readonly source: { readonly kind: string; readonly uri: string };
  readonly contentHash?: string;
  readonly failure?: VerificationFailure;
}

/** Persistence for verification results; swap in durable storage as needed. */
export interface VerificationStore {
  get(referenceId: string): VerificationRecord | undefined;
  put(record: VerificationRecord): void;
  list(): VerificationRecord[];
}

export function createVerificationStore(): VerificationStore {
  const records = new Map<string, VerificationRecord>();
  return {
    get: (referenceId) => records.get(referenceId),
    put: (record) => void records.set(record.referenceId, record),
    list: () => [...records.values()]
  };
}

export interface VerifyDeps {
  readonly fetcher: ReferenceFetcher;
  readonly store?: VerificationStore;
  readonly policy?: Partial<RetryPolicy>;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const FAILURE_ACTIONS: Record<ReferenceFailureCode, string> = {
  invalid_reference: "Correct the reference URI; only https: and ipfs: URIs can be verified.",
  timeout: "Check that the host is responsive, then re-run verification.",
  unreachable: "Check that the URI resolves and the host is up, then re-run verification.",
  malformed_response: "Fix the source so it returns a contentHash and an ISO observedAt.",
  stale_response: "Republish the content at the source so observedAt is recent.",
  hash_mismatch: "Content changed since it was referenced. Confirm the change, then update the expected hash."
};

const TRANSIENT: readonly ReferenceFailureCode[] = ["timeout", "unreachable"];

class AttemptFailure extends Error {
  constructor(readonly code: ReferenceFailureCode, message: string) {
    super(message);
  }
}

function isSupportedUri(uri: string): boolean {
  try {
    const { protocol } = new URL(uri);
    return protocol === "https:" || protocol === "ipfs:";
  } catch {
    return false;
  }
}

function fetchWithTimeout(
  fetcher: ReferenceFetcher,
  uri: string,
  timeoutMs: number
): Promise<unknown> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new AttemptFailure("timeout", `No response within ${timeoutMs}ms`));
    }, timeoutMs);
  });
  const request = Promise.resolve()
    .then(() => fetcher(uri, controller.signal))
    .catch((cause: unknown) => {
      throw new AttemptFailure(
        "unreachable",
        cause instanceof Error ? cause.message : "Fetch failed"
      );
    });
  return Promise.race([request, timeout]).finally(() => clearTimeout(timer));
}

function parseResponse(
  body: unknown,
  reference: ExternalReference,
  policy: RetryPolicy,
  nowMs: number
): ReferenceResponse {
  const candidate = body as Partial<ReferenceResponse> | null;
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    typeof candidate.contentHash !== "string" ||
    candidate.contentHash === "" ||
    typeof candidate.observedAt !== "string" ||
    Number.isNaN(Date.parse(candidate.observedAt))
  ) {
    throw new AttemptFailure("malformed_response", "Response lacks a contentHash or valid observedAt");
  }
  if (nowMs - Date.parse(candidate.observedAt) > policy.maxStalenessMs) {
    throw new AttemptFailure("stale_response", `Content observed at ${candidate.observedAt} is too old`);
  }
  if (reference.expectedHash !== undefined && candidate.contentHash !== reference.expectedHash) {
    throw new AttemptFailure("hash_mismatch", "contentHash differs from the expected hash");
  }
  return { contentHash: candidate.contentHash, observedAt: candidate.observedAt };
}

export async function verifyReference(
  reference: ExternalReference,
  deps: VerifyDeps
): Promise<VerificationRecord> {
  const policy: RetryPolicy = { ...DEFAULT_RETRY_POLICY, ...deps.policy };
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const source = { kind: reference.kind, uri: reference.uri };

  const settle = (
    attempts: number,
    outcome: { contentHash: string } | { failure: AttemptFailure }
  ): VerificationRecord => {
    const base = {
      referenceId: reference.id,
      attempts,
      checkedAt: new Date(now()).toISOString(),
      source
    };
    let record: VerificationRecord;
    if ("failure" in outcome) {
      const { code, message } = outcome.failure;
      record = {
        ...base,
        status: "failed",
        failure: {
          code,
          message,
          action: FAILURE_ACTIONS[code],
          retriesExhausted: TRANSIENT.includes(code)
        }
      };
    } else {
      record = { ...base, status: "verified", contentHash: outcome.contentHash };
    }
    deps.store?.put(record);
    return record;
  };

  if (!isSupportedUri(reference.uri)) {
    return settle(0, { failure: new AttemptFailure("invalid_reference", `Unsupported URI "${reference.uri}"`) });
  }

  let last = new AttemptFailure("unreachable", "No attempt was made");
  for (let attempt = 1; attempt <= Math.max(1, policy.maxAttempts); attempt += 1) {
    try {
      const body = await fetchWithTimeout(deps.fetcher, reference.uri, policy.timeoutMs);
      const response = parseResponse(body, reference, policy, now());
      return settle(attempt, { contentHash: response.contentHash });
    } catch (cause) {
      last = cause instanceof AttemptFailure ? cause : new AttemptFailure("unreachable", "Fetch failed");
      if (!TRANSIENT.includes(last.code)) return settle(attempt, { failure: last });
      if (attempt < policy.maxAttempts) {
        await sleep(Math.min(policy.baseDelayMs * 2 ** (attempt - 1), policy.maxDelayMs));
      }
    }
  }
  return settle(Math.max(1, policy.maxAttempts), { failure: last });
}
