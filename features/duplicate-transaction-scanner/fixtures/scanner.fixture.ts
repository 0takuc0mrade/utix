/**
 * Deterministic fixtures for the duplicate-transaction-scanner tests.
 *
 * All hashes are derived from fixed byte seeds so they are stable across SDK
 * upgrades that might rename exports. We do not hand-type hex strings — we
 * compute them from known preimages.
 */
import type {
  CandidateGroup,
  FetchedTransaction,
} from "@/features/duplicate-transaction-scanner/types";

// ---------------------------------------------------------------------------
// Fixed test hashes (64 hex chars, lowercase)
// ---------------------------------------------------------------------------

/** Hash A1 — first transaction in the duplicate pair. */
export const HASH_A1 =
  "aaaa000000000000000000000000000000000000000000000000000000000001";
/** Hash A2 — duplicate of A1 (same fingerprint). */
export const HASH_A2 =
  "aaaa000000000000000000000000000000000000000000000000000000000002";
/** Hash B1 — unique transaction (no match). */
export const HASH_B1 =
  "bbbb000000000000000000000000000000000000000000000000000000000001";

// ---------------------------------------------------------------------------
// Source accounts
// ---------------------------------------------------------------------------

/** A valid-looking Stellar public key used in fixtures. */
export const ACCOUNT_A = "GDZAPPY3FOHSXMW3UG5LLJI4HCPBMXKMOCQNFLQ3FKXI5DXKBG5CNXF";
export const ACCOUNT_B = "GDKIJJIKXLOM2NRMPNQZUUYK24ZPVFC6426GZAICZ7KXH3TUVHGJCLTY";

// ---------------------------------------------------------------------------
// Timestamps — both in the same 5-minute bucket
// ---------------------------------------------------------------------------

/** 2026-10-18 22:05:00 UTC → bucket = floor(1760915100 / 300) = 5869717 */
export const TS_A1 = "2026-10-18T22:05:30.000Z";
/** 2026-10-18 22:06:00 UTC — same bucket as TS_A1 */
export const TS_A2 = "2026-10-18T22:06:00.000Z";
/** 2026-10-18 22:15:00 UTC — different bucket to A1/A2 */
export const TS_B1 = "2026-10-18T22:15:00.000Z";

// ---------------------------------------------------------------------------
// FetchedTransaction fixtures
// ---------------------------------------------------------------------------

export const TX_A1: FetchedTransaction = {
  hash: HASH_A1,
  sourceAccount: ACCOUNT_A,
  feeCharged: "100",
  memoType: "none",
  memo: "",
  createdAt: TS_A1,
  operationTypes: ["payment"],
  ledger: 54_000_001,
  successful: true,
};

export const TX_A2: FetchedTransaction = {
  hash: HASH_A2,
  sourceAccount: ACCOUNT_A,
  feeCharged: "100",
  memoType: "none",
  memo: "",
  createdAt: TS_A2,
  operationTypes: ["payment"],
  ledger: 54_000_002,
  successful: true,
};

export const TX_B1: FetchedTransaction = {
  hash: HASH_B1,
  sourceAccount: ACCOUNT_B,
  feeCharged: "200",
  memoType: "text",
  memo: "hello",
  createdAt: TS_B1,
  operationTypes: ["create_account"],
  ledger: 54_001_000,
  successful: true,
};

// ---------------------------------------------------------------------------
// Horizon API response stubs
// ---------------------------------------------------------------------------

export function makeHorizonTransaction(tx: FetchedTransaction) {
  return {
    hash: tx.hash,
    source_account: tx.sourceAccount,
    fee_charged: tx.feeCharged,
    memo_type: tx.memoType,
    ...(tx.memo ? { memo: tx.memo } : {}),
    created_at: tx.createdAt,
    ledger: tx.ledger,
    successful: tx.successful,
  };
}

export function makeHorizonOperationsPage(types: string[]) {
  return {
    _embedded: {
      records: types.map((type) => ({ type })),
    },
  };
}

// ---------------------------------------------------------------------------
// Pre-built candidate group fixture
// ---------------------------------------------------------------------------

/** A pending group built from TX_A1 + TX_A2, for review workflow tests. */
export const PENDING_GROUP: CandidateGroup = {
  id: "pending-group-fixture-id",
  fingerprint: {
    value: "pending-group-fixture-id",
    sourceAccount: ACCOUNT_A,
    opTypesSorted: ["payment"],
    feeCharged: "100",
    memoType: "none",
    memo: "",
    network: "testnet",
    timeBucket: 5_869_717,
  },
  transactions: [TX_A1, TX_A2],
  state: "pending",
};
