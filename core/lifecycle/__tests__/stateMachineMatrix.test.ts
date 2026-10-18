import { describe, expect, it } from "vitest";
import {
  allowedTransitions,
  applyTransition,
  type LifecycleMachine
} from "@/core/lifecycle/lifecycle";
import {
  notificationMachine,
  ownershipTransferMachine,
  RECORD_MACHINES,
  workerJobMachine
} from "@/core/lifecycle/records";

const machines: [string, LifecycleMachine][] = Object.entries(RECORD_MACHINES);

/** Every event name any rule of the machine uses. */
function eventsOf(machine: LifecycleMachine): string[] {
  return [...new Set(machine.definition.transitions.map((rule) => rule.event))];
}

/** Applies events in order and returns the visited states, or the first failure. */
function walk(machine: LifecycleMachine, start: string, events: string[]) {
  const visited = [start];
  let state = start;
  for (const event of events) {
    const outcome = applyTransition(machine, { id: "walk-1", state }, event, {
      at: "2026-01-01T00:00:00.000Z",
      correlationId: "corr-walk"
    });
    if (!outcome.ok) return { visited, failure: { state, event, code: outcome.code } };
    state = outcome.value.to;
    visited.push(state);
  }
  return { visited, failure: null };
}

describe("lifecycle transition matrix", () => {
  it("resolves every (state, event) pair to exactly the declared target or a stable rejection code", () => {
    for (const [kind, machine] of machines) {
      const declared = new Map(
        allowedTransitions(machine).map((rule) => [`${rule.from}|${rule.event}`, rule.to])
      );
      for (const state of machine.definition.states) {
        for (const event of eventsOf(machine)) {
          const outcome = applyTransition(machine, { id: `${kind}-1`, state }, event);
          const target = declared.get(`${state}|${event}`);
          const label = `${kind}: ${state} -${event}->`;
          if (target) {
            expect(outcome.ok, label).toBe(true);
            if (outcome.ok) expect(outcome.value.to, label).toBe(target);
          } else {
            expect(outcome.ok, label).toBe(false);
            if (!outcome.ok) {
              expect(outcome.code, label).toBe(
                machine.isTerminal(state) ? "terminal_state" : "invalid_transition"
              );
            }
          }
        }
      }
    }
  });

  it("rejects an undeclared event name from every state without changing the answer", () => {
    for (const [kind, machine] of machines) {
      for (const state of machine.definition.states) {
        const first = machine.resolve(state, "not_an_event");
        const second = machine.resolve(state, "not_an_event");
        expect(second, `${kind}: ${state}`).toEqual(first);
        expect(first).toMatchObject({
          ok: false,
          code: machine.isTerminal(state) ? "terminal_state" : "invalid_transition"
        });
      }
    }
  });

  it("rejects unknown and malformed states and events with their own codes", () => {
    for (const [kind, machine] of machines) {
      for (const state of ["", "UNKNOWN", "Queued ", "__proto__"]) {
        expect(machine.resolve(state, "start"), `${kind}: "${state}"`).toMatchObject({
          ok: false,
          code: "unknown_state"
        });
      }
      const live = machine.definition.states.find((state) => !machine.isTerminal(state)) as string;
      expect(machine.resolve(live, ""), kind).toMatchObject({ ok: false, code: "unknown_event" });
      expect(
        applyTransition(machine, { id: "x", state: 42 as unknown as string }, "start"),
        kind
      ).toMatchObject({ ok: false, code: "unknown_state" });
    }
  });
});

describe("terminal states", () => {
  it("are exactly the states with no outgoing rule", () => {
    for (const [kind, machine] of machines) {
      const withOutgoing = new Set(machine.definition.transitions.map((rule) => rule.from));
      const sinks = machine.definition.states.filter((state) => !withOutgoing.has(state));
      expect([...machine.definition.terminal].sort(), kind).toEqual([...sinks].sort());
    }
  });

  it("reject every event of the machine with terminal_state and expose no allowed events", () => {
    for (const [kind, machine] of machines) {
      for (const state of machine.definition.terminal) {
        expect(machine.allowedEvents(state), `${kind}: ${state}`).toEqual([]);
        expect(machine.view(state).terminal, `${kind}: ${state}`).toBe(true);
        for (const event of eventsOf(machine)) {
          expect(machine.canTransition(state, event), `${kind}: ${state} -${event}->`).toMatchObject({
            ok: false,
            code: "terminal_state"
          });
        }
      }
    }
  });
});

describe("reachability", () => {
  it("lets every state be reached from the initial state", () => {
    for (const [kind, machine] of machines) {
      const reached = new Set([machine.initial()]);
      const queue = [machine.initial()];
      while (queue.length > 0) {
        const state = queue.shift() as string;
        for (const rule of machine.definition.transitions) {
          if (rule.from === state && !reached.has(rule.to)) {
            reached.add(rule.to);
            queue.push(rule.to);
          }
        }
      }
      expect([...reached].sort(), kind).toEqual([...machine.definition.states].sort());
    }
  });

  it("lets every live state reach a terminal state, so no record can be stuck", () => {
    for (const [kind, machine] of machines) {
      for (const start of machine.definition.states) {
        const seen = new Set([start]);
        const queue = [start];
        let settles = machine.isTerminal(start);
        while (queue.length > 0 && !settles) {
          const state = queue.shift() as string;
          for (const rule of machine.definition.transitions) {
            if (rule.from !== state || seen.has(rule.to)) continue;
            seen.add(rule.to);
            queue.push(rule.to);
            if (machine.isTerminal(rule.to)) settles = true;
          }
        }
        expect(settles, `${kind}: ${start} can settle`).toBe(true);
      }
    }
  });
});

describe("recovery and terminal paths", () => {
  it("recovers a worker job through retrying back to running and success", () => {
    expect(walk(workerJobMachine, "queued", ["start", "fail", "start", "succeed"])).toEqual({
      visited: ["queued", "running", "retrying", "running", "succeeded"],
      failure: null
    });
  });

  it("recovers a retrying worker job by re-queueing it", () => {
    expect(walk(workerJobMachine, "retrying", ["retry", "start", "succeed"])).toEqual({
      visited: ["retrying", "queued", "running", "succeeded"],
      failure: null
    });
  });

  it("allows repeated failure while retrying and dead-letters on exhaustion", () => {
    expect(walk(workerJobMachine, "retrying", ["fail", "fail", "exhaust"])).toEqual({
      visited: ["retrying", "retrying", "retrying", "dead_lettered"],
      failure: null
    });
  });

  it("offers no recovery from either terminal worker state", () => {
    for (const settled of ["succeeded", "dead_lettered"]) {
      for (const event of ["start", "fail", "retry", "exhaust", "dead_letter", "succeed"]) {
        expect(walk(workerJobMachine, settled, [event]).failure, `${settled} -${event}->`).toEqual({
          state: settled,
          event,
          code: "terminal_state"
        });
      }
    }
  });

  it("does not let a running job be retried or re-queued directly", () => {
    expect(walk(workerJobMachine, "running", ["retry"]).failure).toEqual({
      state: "running",
      event: "retry",
      code: "invalid_transition"
    });
    expect(walk(workerJobMachine, "running", ["start"]).failure?.code).toBe("invalid_transition");
  });

  it("never moves a notification backwards", () => {
    expect(walk(notificationMachine, "unread", ["read", "archive", "purge"]).failure).toBeNull();
    expect(walk(notificationMachine, "archived", ["read"]).failure?.code).toBe("invalid_transition");
    expect(walk(notificationMachine, "read", ["read"]).failure?.code).toBe("invalid_transition");
    expect(walk(notificationMachine, "purged", ["read"]).failure?.code).toBe("terminal_state");
  });

  it("settles an ownership transfer exactly once", () => {
    for (const event of ["accept", "cancel", "reject", "expire"]) {
      const settled = walk(ownershipTransferMachine, "pending", [event]);
      expect(settled.failure, event).toBeNull();
      const state = settled.visited[1];
      expect(ownershipTransferMachine.isTerminal(state), event).toBe(true);
      for (const again of ["accept", "cancel", "reject", "expire"]) {
        expect(walk(ownershipTransferMachine, state, [again]).failure?.code, `${state} -${again}->`).toBe(
          "terminal_state"
        );
      }
    }
  });
});

describe("rejected transitions", () => {
  it("never mutate the record they were asked about", () => {
    for (const [kind, machine] of machines) {
      for (const state of machine.definition.terminal) {
        const record = Object.freeze({ id: `${kind}-1`, state });
        expect(() => applyTransition(machine, record, eventsOf(machine)[0])).not.toThrow();
        expect(record.state).toBe(state);
      }
    }
  });
});
