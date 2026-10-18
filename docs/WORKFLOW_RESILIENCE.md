# Workflow resilience

The resilience harnesses are deterministic and dependency-free. `archiveRecord`
and `restoreRecord` make lifecycle transitions explicit and idempotent;
`protectTelemetry` bounds event cardinality, applies field redaction, and uses
an injected sampler; `runChaosScenario` reproduces an interrupted sequence from
a seed; and `detectLostUpdate` exercises the read/modify/write interleaving
that race-prone mutations must protect.
