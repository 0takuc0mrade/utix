import { describe, expect, it } from 'vitest';
import { createIdempotencyStore, withIdempotency, type IdempotencyStorage } from '@/core/idempotency/idempotency';
import { createMemoryProjectionStore } from '@/core/replay/store';
import { err, ok } from '@/core/result/result';
import { DomainInvariantChecker } from '../checker';
import { commitMutation, createMemoryStateCell, type StateCell } from '../commit';
import { issueTicket, redeemTicket, transferTicket, type TransferTicketParams } from '../mutations';
import type { DomainState, Ticket } from '../types';

/**
 * Concurrency stress tests for the critical mutation paths (#192).
 *
 * Every race here is deterministic. The mutations are synchronous, so the
 * interleaving comes from `commitMutation` awaiting its cell: every call that
 * starts in the same tick reads the same snapshot, and the order in which they
 * then try to commit is the order they were started. There are no timers, no
 * sleeps and no randomness, so a failure reproduces exactly.
 */

const VALID_FROM = 1_000;
const VALID_UNTIL = 2_000;
const INSIDE_WINDOW = 1_500;

function ticket(id: string, ownerAddress: string, overrides: Partial<Ticket> = {}): Ticket {
  return {
    id,
    eventId: 'evt-1',
    tierId: 'general',
    ownerAddress,
    priceStroops: 100,
    status: 'issued',
    issuedAt: 0,
    validFrom: VALID_FROM,
    validUntil: VALID_UNTIL,
    fraudFlag: false,
    nonce: 0,
    metadataHash: '',
    ...overrides
  };
}

function stateWith(capacity: number, tickets: Ticket[] = []): DomainState {
  return {
    events: new Map([
      [
        'evt-1',
        {
          id: 'evt-1',
          organizerAddress: 'G_ORGANIZER',
          totalCapacity: capacity,
          issuedCount: tickets.length,
          status: 'active',
          feeBasisPoints: 250
        }
      ]
    ]),
    tickets: new Map(tickets.map((item) => [item.id, item])),
    transfers: [],
    processedNonces: new Set<string>(),
    blacklistedAddresses: new Set<string>()
  };
}

async function current(cell: StateCell): Promise<DomainState> {
  return (await cell.read()).state;
}

const issue = (id: string, owner = `G_BUYER_${id}`) => ({
  id,
  eventId: 'evt-1',
  tierId: 'general',
  ownerAddress: owner,
  priceStroops: 100,
  validFrom: VALID_FROM,
  validUntil: VALID_UNTIL
});

function transferParams(overrides: Partial<TransferTicketParams> & Pick<TransferTicketParams, 'id' | 'toAddress' | 'nonce'>) {
  return {
    ticketId: 't-1',
    fromAddress: 'G_ALICE',
    priceStroops: 100,
    organizerFeeStroops: 5,
    protocolFeeStroops: 5,
    sellerProceedsStroops: 90,
    timestamp: INSIDE_WINDOW,
    ...overrides
  };
}

describe('concurrent issuance', () => {
  it('lets every request succeed while capacity remains, with no duplicate ids', async () => {
    const cell = createMemoryStateCell(stateWith(10));
    const outcomes = await Promise.all(
      ['a', 'b', 'c', 'd'].map((id) => commitMutation(cell, (state) => issueTicket(state, issue(id)), { maxAttempts: 20 }))
    );

    expect(outcomes.every((outcome) => outcome.ok)).toBe(true);
    const state = await current(cell);
    expect([...state.tickets.keys()].sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(state.events.get('evt-1')!.issuedCount).toBe(4);
    expect(DomainInvariantChecker.verifyAll(state)).toEqual([]);
  });

  it('never oversells: exactly capacity requests win and the rest see the capacity invariant', async () => {
    const capacity = 3;
    const cell = createMemoryStateCell(stateWith(capacity));
    const ids = Array.from({ length: 12 }, (_, index) => `t-${index}`);

    const outcomes = await Promise.all(
      ids.map((id) => commitMutation(cell, (state) => issueTicket(state, issue(id)), { maxAttempts: 20 }))
    );

    const winners = outcomes.filter((outcome) => outcome.ok);
    const losers = outcomes.filter((outcome) => !outcome.ok);
    expect(winners).toHaveLength(capacity);
    for (const loser of losers) {
      expect(loser).toMatchObject({ ok: false, reason: 'rejected', code: { invariantId: 'INV-10' } });
    }

    const state = await current(cell);
    expect(state.tickets.size).toBe(capacity);
    expect(state.events.get('evt-1')!.issuedCount).toBe(capacity);
    expect(DomainInvariantChecker.verifyAll(state)).toEqual([]);
  });

  it('is repeatable: the same race produces the same winners every run', async () => {
    const run = async () => {
      const cell = createMemoryStateCell(stateWith(2));
      const outcomes = await Promise.all(
        ['x', 'y', 'z', 'w'].map((id) => commitMutation(cell, (state) => issueTicket(state, issue(id)), { maxAttempts: 20 }))
      );
      return outcomes.map((outcome) => outcome.ok);
    };
    expect(await run()).toEqual(await run());
  });
});

describe('concurrent redemption', () => {
  it('redeems a ticket exactly once; every other attempt is refused as terminal', async () => {
    const cell = createMemoryStateCell(stateWith(5, [ticket('t-1', 'G_ALICE')]));
    const attempts = Array.from({ length: 8 }, () =>
      commitMutation(
        cell,
        (state) => redeemTicket(state, { ticketId: 't-1', claimerAddress: 'G_ALICE', timestamp: INSIDE_WINDOW }),
        { maxAttempts: 20 }
      )
    );
    const outcomes = await Promise.all(attempts);

    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
    for (const outcome of outcomes.filter((item) => !item.ok)) {
      expect(outcome).toMatchObject({ reason: 'rejected', code: { invariantId: 'INV-03' } });
    }
    expect((await current(cell)).tickets.get('t-1')!.status).toBe('redeemed');
  });

  it('refuses a redemption that races a transfer away from the claimer', async () => {
    const cell = createMemoryStateCell(stateWith(5, [ticket('t-1', 'G_ALICE')]));
    const [transferred, redeemed] = await Promise.all([
      commitMutation(cell, (state) => transferTicket(state, transferParams({ id: 'x-1', toAddress: 'G_BOB', nonce: 'n-1' }))),
      commitMutation(cell, (state) => redeemTicket(state, { ticketId: 't-1', claimerAddress: 'G_ALICE', timestamp: INSIDE_WINDOW }))
    ]);

    expect(transferred.ok).toBe(true);
    expect(redeemed).toMatchObject({ ok: false, reason: 'rejected' });
    const final = (await current(cell)).tickets.get('t-1')!;
    expect(final.ownerAddress).toBe('G_BOB');
    expect(final.status).toBe('transferred');
  });
});

describe('concurrent transfers', () => {
  it('lets only one of several conflicting transfers of the same ticket land', async () => {
    const cell = createMemoryStateCell(stateWith(5, [ticket('t-1', 'G_ALICE')]));
    const recipients = ['G_BOB', 'G_CAROL', 'G_DAVE', 'G_ERIN'];
    const outcomes = await Promise.all(
      recipients.map((to, index) =>
        commitMutation(cell, (state) => transferTicket(state, transferParams({ id: `x-${index}`, toAddress: to, nonce: `n-${index}` })), {
          maxAttempts: 20
        })
      )
    );

    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
    for (const outcome of outcomes.filter((item) => !item.ok)) {
      expect(outcome).toMatchObject({ reason: 'rejected', code: { invariantId: 'INV-02' } });
    }
    const state = await current(cell);
    expect(state.transfers).toHaveLength(1);
    expect(state.tickets.get('t-1')!.ownerAddress).toBe(state.transfers[0].toAddress);
    expect(state.tickets.get('t-1')!.nonce).toBe(1);
    expect(state.processedNonces.size).toBe(1);
  });

  it('rejects a replayed nonce on a second ticket instead of recording two transfers', async () => {
    const cell = createMemoryStateCell(stateWith(5, [ticket('t-1', 'G_ALICE'), ticket('t-2', 'G_ALICE')]));
    const outcomes = await Promise.all([
      commitMutation(cell, (state) => transferTicket(state, transferParams({ id: 'x-1', ticketId: 't-1', toAddress: 'G_BOB', nonce: 'shared' })), {
        maxAttempts: 5
      }),
      commitMutation(cell, (state) => transferTicket(state, transferParams({ id: 'x-2', ticketId: 't-2', toAddress: 'G_BOB', nonce: 'shared' })), {
        maxAttempts: 5
      })
    ]);

    expect(outcomes.map((outcome) => outcome.ok)).toEqual([true, false]);
    expect(outcomes[1]).toMatchObject({ reason: 'rejected', code: { invariantId: 'INV-09' } });
    const state = await current(cell);
    expect(state.transfers.map((transfer) => transfer.id)).toEqual(['x-1']);
    expect(state.tickets.get('t-2')!.ownerAddress).toBe('G_ALICE');
  });
});

describe('lost races and retries', () => {
  it('reports a conflict, changes nothing, and succeeds on retry', async () => {
    const cell = createMemoryStateCell(stateWith(5));
    const [first, second] = await Promise.all([
      commitMutation(cell, (state) => issueTicket(state, issue('a')), { maxAttempts: 1 }),
      commitMutation(cell, (state) => issueTicket(state, issue('b')), { maxAttempts: 1 })
    ]);

    expect(first).toMatchObject({ ok: true, attempts: 1 });
    expect(second).toEqual({ ok: false, reason: 'conflict', attempts: 1 });
    expect([...(await current(cell)).tickets.keys()]).toEqual(['a']);

    const retry = await commitMutation(cell, (state) => issueTicket(state, issue('b')), { maxAttempts: 1 });
    expect(retry).toMatchObject({ ok: true, attempts: 1 });
    expect([...(await current(cell)).tickets.keys()].sort()).toEqual(['a', 'b']);
  });

  it('counts the attempts a loser needed before it won', async () => {
    const cell = createMemoryStateCell(stateWith(5));
    const outcomes = await Promise.all(
      ['a', 'b', 'c'].map((id) => commitMutation(cell, (state) => issueTicket(state, issue(id)), { maxAttempts: 5 }))
    );
    expect(outcomes.map((outcome) => outcome.attempts)).toEqual([1, 2, 3]);
  });
});

describe('duplicate retries with an idempotency key', () => {
  function memoryStorage(): IdempotencyStorage {
    const values = new Map<string, string>();
    return {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => void values.set(key, value),
      removeItem: (key) => void values.delete(key)
    };
  }

  it('records one transfer however many times the request is submitted', async () => {
    const cell = createMemoryStateCell(stateWith(5, [ticket('t-1', 'G_ALICE')]));
    const store = createIdempotencyStore({ storage: memoryStorage(), now: () => 0, newId: () => 'corr' });
    const params = transferParams({ id: 'x-1', toAddress: 'G_BOB', nonce: 'n-1' });
    const submit = () =>
      withIdempotency(store, {
        key: 'transfer:t-1:attempt-1',
        operation: 'ticket.transfer',
        request: params,
        run: async () => {
          const outcome = await commitMutation(cell, (state) => transferTicket(state, params), { maxAttempts: 20 });
          return outcome.ok ? ok(params.id) : err('transfer_rejected');
        }
      });

    const simultaneous = await Promise.all([submit(), submit(), submit(), submit(), submit()]);
    const executed = simultaneous.filter((result) => result.ok && !result.value.replayed);
    const inFlight = simultaneous.filter((result) => !result.ok && result.code === 'idempotency_in_flight');
    expect(executed).toHaveLength(1);
    expect(inFlight).toHaveLength(4);

    // A retry after the first attempt settled replays the stored outcome.
    const retried = await submit();
    expect(retried).toMatchObject({ ok: true, value: { value: 'x-1', replayed: true } });

    const state = await current(cell);
    expect(state.transfers).toHaveLength(1);
    expect(state.tickets.get('t-1')!.nonce).toBe(1);
  });

  it('refuses a reused key for a different request without running it', async () => {
    const cell = createMemoryStateCell(stateWith(5, [ticket('t-1', 'G_ALICE')]));
    const store = createIdempotencyStore({ storage: memoryStorage(), now: () => 0, newId: () => 'corr' });
    const run = (params: TransferTicketParams) => () =>
      commitMutation(cell, (state) => transferTicket(state, params)).then((outcome) => (outcome.ok ? ok(params.id) : err('transfer_rejected')));

    const first = transferParams({ id: 'x-1', toAddress: 'G_BOB', nonce: 'n-1' });
    const other = transferParams({ id: 'x-2', toAddress: 'G_CAROL', nonce: 'n-2' });
    await withIdempotency(store, { key: 'transfer:reused', operation: 'ticket.transfer', request: first, run: run(first) });
    const reused = await withIdempotency(store, { key: 'transfer:reused', operation: 'ticket.transfer', request: other, run: run(other) });

    expect(reused).toMatchObject({ ok: false, code: 'idempotency_key_conflict' });
    expect((await current(cell)).transfers.map((transfer) => transfer.id)).toEqual(['x-1']);
  });
});

describe('lock timeout', () => {
  const TTL = 1_000;

  it('grants a projection lock to exactly one of several simultaneous owners', () => {
    const store = createMemoryProjectionStore();
    const granted = ['run-1', 'run-2', 'run-3'].filter((owner) => store.acquireLock('tickets', owner, 0, TTL));
    expect(granted).toEqual(['run-1']);
  });

  it('keeps the lock until the timeout, then lets another owner take it over', () => {
    const store = createMemoryProjectionStore();
    expect(store.acquireLock('tickets', 'run-1', 0, TTL)).toBe(true);
    expect(store.acquireLock('tickets', 'run-2', TTL - 1, TTL)).toBe(false);
    expect(store.acquireLock('tickets', 'run-2', TTL, TTL)).toBe(true);
    // The first owner has lost it and can no longer refresh or release it.
    expect(store.acquireLock('tickets', 'run-1', TTL + 1, TTL)).toBe(false);
    store.releaseLock('tickets', 'run-1');
    expect(store.acquireLock('tickets', 'run-3', TTL + 2, TTL)).toBe(false);
  });

  it('lets the live owner refresh its own lock and frees it on release', () => {
    const store = createMemoryProjectionStore();
    expect(store.acquireLock('tickets', 'run-1', 0, TTL)).toBe(true);
    expect(store.acquireLock('tickets', 'run-1', TTL - 1, TTL)).toBe(true);
    expect(store.acquireLock('tickets', 'run-2', TTL, TTL)).toBe(false);
    store.releaseLock('tickets', 'run-1');
    expect(store.acquireLock('tickets', 'run-2', TTL, TTL)).toBe(true);
  });

  it('expires an abandoned in-flight idempotency claim instead of replaying it', () => {
    let now = 0;
    const values = new Map<string, string>();
    const store = createIdempotencyStore({
      ttlMs: TTL,
      now: () => now,
      newId: () => 'corr',
      storage: {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => void values.set(key, value),
        removeItem: (key) => void values.delete(key)
      }
    });
    const request = { key: 'claim:abandoned-1', operation: 'ticket.transfer', request: { id: 1 } };

    expect(store.begin(request).ok).toBe(true);
    now = TTL - 1;
    expect(store.begin(request)).toMatchObject({ ok: false, code: 'idempotency_in_flight' });
    now = TTL;
    expect(store.begin(request)).toMatchObject({ ok: false, code: 'idempotency_key_expired' });
  });
});
