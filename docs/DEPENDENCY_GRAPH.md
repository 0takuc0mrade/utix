# Cross-resource dependency graph (#187)

`analyzeImpact(nodes, rootId, auth, direction?)` in `core/dependencies/graph.ts` is a read-only impact analysis over resources (events, tickets, users, operations, external references). Each node lists the ids it `dependsOn`.

## Reading a result

- `direction: "dependents"` (default) answers "what is affected if this resource changes?". `direct` are resources that depend on the root; `indirect` depend on it through others. `depth` is the shortest distance.
- `direction: "dependencies"` answers "what does this resource rely on?" the same way.
- `cycles` lists cycles through the root as `[root, ..., root]`. A cycle is not an error: each resource is still reported once. Treat it as a sign the change cannot be ordered safely.
- `missingReferences` lists dangling ids on resources in the result (`from` references `missingId`, which is not in the graph). Resolve these first; the impact may be larger than reported.

## Permissions and redaction

Requires `view:dashboard`. Resources flagged `restricted` are redacted for roles without `admin:config`: their id and kind become `redacted:<n>` / `redacted`, while their depth still counts, so the shape of the impact stays accurate. `redactedCount` says how many were hidden. A restricted root returns `permission_denied`; an unknown root returns `resource_not_found`.
