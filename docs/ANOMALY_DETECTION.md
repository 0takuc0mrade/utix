# Anomaly Detection Report

Maintainers need a way to spot unusual usage patterns in Utix before they become incidents or abuse. The anomaly detector consumes the same privacy-preserving events that flow through the analytics aggregator and produces a read-only report grouped by severity and affected resource.

## Signals

Every signal has a `type`, `severity`, an `affectedResource` (the event type or actor), observed vs. expected values, evidence, and triage steps.

| Signal type | What it detects | Default threshold |
| ----------- | ---------------- | ------------------- |
| `volume` | An event type concentrated in a 60-minute*bucket far above its median bucket count. | `max(10, median * 3)` events per bucket |
| `timing` | A burst of the same event type within a single minute. | `max(5, median * 4)` events per minute |
| `actor` | An actor producing many events in the window. | `max(10, avg per actor * 3)` events per actor |
| `failure` | A high failure rate for an event type. | `>= 25%` in a window with at least 5 failures |

Defaults live in `core/analytics/anomaly.ts` and can be overridden via `AnomalyDetectionConfig`.

## Report shape

```ts
import { AnomalyDetector } from 'core/analytics';

const report = new AnomalyDetector().detect(events);

report.signals         // all signals, sorted by severity then observed count
report.bySeverity      // { critical: [], warning: [], info: [] }
report.byResource      // { ticket_issued: [], ticket_transferred: [], ... }
report.notes           // low-confidence warnings (e.g. small sample)
```

The report is read-only: the detector does not mutate events or the aggregator state. It can be run on a schedule or on demand from an organizer dashboard route.

## Triage guide for maintainers

1. **Start with critical signals.** Open `report.bySeverity.critical` and work top-down. Each signal includes `triageSteps`.
2. **Confirm the resource is real.** Check the affected event type is still in use and not a deprecated or test-only path.
3. **Correlate with releases and campaigns.** A launch, marketing push, or organizer bulk issuance can produce legitimate spikes.
4. **Cross-reference signals.** A volume spike combined with an actor signal from the same actor is much stronger evidence than either alone.
5. **Check failure signals first if customers report problems.** A spike in `ticket_redeemed` failures often means a regression, not abuse.
6. **Document the outcome.** Record whether the signal was a real incident, a false positive, or a configuration change. This feeds the false-positive mitigation list below.

## False-positive mitigation

- Add known partner integrations and batch workers to `ignoredActors` so their high-volume behavior is not flagged.
- Exclude deprecated or test-only event types via `ignoredEventTypes`.
- Tune `windowHours` and the various thresholds for your organization's normal volume. Small event volumes produce low-confidence reports (see `report.notes`).
- Require two independent signals before escalating to an incident (e.g. volume + actor).
- Review the `minEventsForBaseline` threshold if you see frequent low-confidence notes.

## Validation

```bash
npm test -- core/analytics/__tests__/anomaly.test.ts
```

The test suite covers four scenarios from fixture data:

- Normal baseline -> no signals.
- Volume spike -> `volume` signal.
- Repeated failures -> `failure` signal.
- Suspicious actor -> `actor` signal.

Additionally, the suite verifies severity ordering, `ignoredActors` mitigation, and the low-confidence note for small samples.

## Integration notes

- The detector is pure and synchronous; wrap it in a scheduled job or call it from an admin route.
- It respects the aggregator's privacy rules because it only reads already-hashed `identifiers` and redacted metadata.
- Signals are serializable to JSON for dashboard consumption. `detectedAt` and `generatedAt` are `Date` objects and should be serialized as ISO strings.
