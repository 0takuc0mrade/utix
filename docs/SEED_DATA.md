# Contributor seed data

`core/seed/` is a deterministic dataset for local development and tests. It
needs no production credentials, network or clock, and every address is a
`G_SEED_*` placeholder rather than a real Stellar key, so it is safe to commit
and to load anywhere.

## What it contains

Relative to one fixed instant, `SEED_NOW` (2026-06-01T00:00:00Z):

| Records          | Edge cases covered                                                                 |
| ---------------- | ----------------------------------------------------------------------------------- |
| 5 events         | active, paused, sold out, completed (historical) and cancelled                      |
| 10 tickets       | every status: issued, transferred, locked, redeemed, expired, burned                 |
| 2 transfers      | one recent, one over a year old (historical)                                        |
| 3 settlements    | two settled, and `settle-seed-failed`, which moved no money and left the ticket with its seller |
| 5 authorizations | active, renewed, expired (still renewable), cleaned and revoked                      |
| 3 workflows      | on time, completed, and `wf-seed-overdue` (a refund review past its due date)       |

Revoked access appears twice: a fraud-locked ticket owned by a blacklisted
account, and a revoked delegated authorization.

Fees in the settlements were computed with the fee module (see
[FEES.md](./FEES.md)) using a 1% protocol fee with a 0.01 XLM minimum plus each
event's organizer fee.

## Loading and resetting

```ts
import { createSeedDataset, validateSeedDataset } from "@/core/seed";

const dataset = createSeedDataset(); // fresh, independent copy
validateSeedDataset(dataset); // [] when the records agree
```

`dataset.state` is a `DomainState` (see `core/invariants`), so it can be passed
to `DomainInvariantChecker` or the invariant-checked mutations directly.

Nothing is written anywhere. **Resetting is calling `createSeedDataset()` again**:
every call returns a pristine copy, and mutating one never affects another.

## Validation

```bash
npm run verify:seed
```

runs `core/seed/__tests__/seed.test.ts`, which loads the dataset and confirms it
is internally consistent. `validateSeedDataset` returns every inconsistency as an
issue with a code, an entity id and a message. It checks that:

- the domain invariants hold (`DomainInvariantChecker.verifyAll`);
- every address is a `G_SEED_*` placeholder;
- tickets reference real events and each event's `issuedCount` matches its tickets;
- every transfer has exactly one matching settled settlement, and every settled
  settlement has its transfer;
- a failed settlement has no transfer and states why;
- every settlement's stored fees equal the fee module's breakdown;
- authorizations are internally consistent (resources exist, revoked and cleaned
  records carry their timestamps, cleaned ones were past the renewal grace period);
- workflows reference real tickets and have coherent dates;
- nothing is dated after `SEED_NOW`.

## Extending it

Add records as literals in `core/seed/data.ts`, keep them relative to
`SEED_NOW`, use `G_SEED_*` placeholders, and run `npm run verify:seed`. A
settlement's fees should be computed with the fee module, not hand-estimated.
