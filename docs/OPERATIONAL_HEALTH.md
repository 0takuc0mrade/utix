# Operational Health Dashboard

The operational health dashboard provides maintainers with actionable insights into system health, unresolved exceptions, and operational issues.

## Quick Start

```bash
npm run health:check
```

This command generates a comprehensive health report showing:
- Overall system status
- Health indicators for each component
- Unresolved exceptions
- Stale records requiring attention
- Key operational metrics

## Health Indicators

The dashboard monitors these critical components:

### Feature Registry
Status of the feature manifest system. Unhealthy status indicates registry load failures or corruption.

### Network Connectivity
Configuration status for Stellar network endpoints. Checks both testnet and mainnet URLs.

### Environment Configuration
Validates presence and validity of required environment variables.

## Status Levels

**Healthy**
All indicators are operating normally. No immediate action required.

**Degraded**
One or more indicators show warnings. System is functional but attention may be needed.

**Unhealthy**
Critical issues detected. Immediate investigation and remediation required.

## Unresolved Exceptions

The dashboard tracks exceptions that have not been resolved:
- Exception type and message
- Timestamp and unique ID
- Stack trace when available
- Contextual information

### Recording Exceptions

Components can record exceptions for tracking:

```typescript
import { healthMonitor } from '@/core/health/monitor';

healthMonitor.recordException({
  type: 'DataLoadError',
  message: 'Failed to load critical data',
  error: caughtError,
  context: { userId: '123', action: 'load' },
});
```

## Stale Records

Track records that have not been updated within expected timeframes:

```typescript
healthMonitor.recordStaleRecord({
  id: 'record-123',
  type: 'UserSession',
  lastActivity: new Date('2026-01-01'),
  details: { userId: '123' },
});
```

Query stale records by age:

```typescript
const weekOldRecords = healthMonitor.getStaleRecords(
  1000 * 60 * 60 * 24 * 7 // 7 days in milliseconds
);
```

## Output Formats

### Human-Readable

Default output provides formatted dashboard for manual review:

```bash
npm run health:check
```

### JSON

Machine-readable format for integration with monitoring systems:

```bash
npm run health:check -- --json
```

Example JSON output:

```json
{
  "timestamp": "2026-09-25T00:00:00.000Z",
  "overallStatus": "healthy",
  "indicators": [...],
  "unresolvedExceptions": [...],
  "staleRecords": [...],
  "metrics": {
    "totalFeatures": 10,
    "healthyFeatures": 10,
    "unresolvedExceptionCount": 0,
    "staleRecordCount": 0
  }
}
```

## Exit Codes

- **0** - System is healthy or degraded
- **1** - System is unhealthy
- **2** - Health check script error

## Monitoring Integration

### Automated Monitoring

Add health checks to your monitoring pipeline:

```yaml
- name: Check operational health
  run: npm run health:check -- --json > health-report.json
```

### Alert Configuration

Set up alerts based on health status:

```bash
STATUS=$(npm run health:check -- --json | jq -r '.overallStatus')
if [ "$STATUS" = "unhealthy" ]; then
  # Trigger alert
fi
```

### Scheduled Checks

Run health checks on a schedule:

```bash
# Crontab entry for hourly checks
0 * * * * cd /path/to/utix && npm run health:check >> /var/log/utix-health.log 2>&1
```

## Investigation Links

When issues are detected:

1. Review full exception details including stack traces
2. Check affected record IDs against logs
3. Cross-reference with deployment timeline
4. Verify network and infrastructure status
5. Run disaster recovery validation if needed

## Sensitive Information

The health dashboard automatically redacts:
- Authentication tokens
- Private keys
- User personally identifiable information
- Internal infrastructure details

Only aggregated metrics and sanitized identifiers are included.

## Adding Health Checks

To add custom health indicators:

1. Edit `core/health/monitor.ts`
2. Add your check method to `HealthMonitor` class
3. Call it from `runHealthChecks()`
4. Add test coverage in `core/health/__tests__/monitor.test.ts`

Example:

```typescript
private async checkCustomComponent(): Promise<void> {
  try {
    // Your health check logic
    
    this.indicators.push({
      name: 'Custom Component',
      status: 'healthy',
      message: 'Component is operational',
      lastChecked: new Date(),
    });
  } catch (error) {
    this.indicators.push({
      name: 'Custom Component',
      status: 'unhealthy',
      message: 'Component check failed',
      details: { error: String(error) },
      lastChecked: new Date(),
    });
  }
}
```

## Best Practices

- Run health checks after deployments
- Monitor health check exit codes in CI/CD
- Archive health reports for trend analysis
- Investigate degraded status before it becomes unhealthy
- Document resolution steps for common issues
- Keep exception context minimal but actionable
- Set reasonable thresholds for stale record alerts

## Synthetic Monitoring (#269)

`core/health/synthetic.ts` probes the critical journey against **live** Horizon.
The critical journey is the operation browser covered by
`tests/e2e/critical-journey.spec.ts`. That e2e spec proves the UI against mocked
Horizon. The probe proves the same Horizon contract upstream, on a schedule.

```bash
UTIX_USER_ROLE=service npm run synthetic:monitor -- --network testnet [--json]
```

`.github/workflows/synthetic-monitor.yml` runs it every 30 minutes for testnet
and mainnet, and can also be started by hand (`workflow_dispatch`). It needs
Node 24 and no installed dependencies.

| Step | Request | Checks |
| :--- | :--- | :--- |
| `horizon.root` | `GET /` | `network_passphrase` matches the network; `core_latest_ledger − history_latest_ledger` ≤ 5 |
| `operations.discover` | `GET /operations?order=desc&limit=1` | Finds a currently active `G…` account, so no fixture can be wiped by a testnet reset |
| `account.operations` | `GET /accounts/{id}/operations?order=desc&limit=20` | Non-empty page with numeric, strictly descending `paging_token`s |
| `account.operations.older` | same + `cursor=<last paging_token>` | Runs only when page one is full (as "Load more" does); every token is below the cursor |

| Status | Meaning | Exit code |
| :--- | :--- | :--- |
| `healthy` | Every step passed on its first attempt, within budget | 0 |
| `degraded` | Passed, but needed a retry, exceeded 5 s, or ingestion lags by > 5 ledgers | 0 |
| `unhealthy` | A step failed; the journey stops at that step | 1 |
| refused / crash | Role lacks `admin:health`, or the probe threw | 2 |

Each run emits one `synthetic.journey` telemetry event that carries the
correlation id printed in the report.

### Failure and retry behaviour

- **Retried**, up to 3 attempts with backoff 500 ms → 1 s: HTTP 429
  (`rate_limited`), 5xx (`server_error`), network failure (`transport`), and
  no response within 10 s (`timeout`). A `Retry-After` header (seconds or
  HTTP-date) lengthens the wait. No single wait exceeds 10 s.
- **Not retried**, because a retry cannot fix them: `network_mismatch` (wrong
  passphrase, meaning the URL points at the other network), `malformed_payload`,
  `http_status` (another 4xx), `no_activity` and `pagination_broken`.
- **Authorization**: viewers and unknown roles get `synthetic_unauthorized`
  before any request is made. `service` and `maintainer` hold `admin:health`.

### Operational edge cases

- **Rate limits**: one run makes at most 4 requests (12 with every retry).
  Horizon's default limit (`PER_HOUR_RATE_LIMIT`) is 3,600 requests per hour
  per IP, so a 30-minute schedule uses a negligible share of it.
- **Testnet resets** wipe accounts. Choosing the account from the latest
  operation keeps the probe working across a reset.
- **An idle network** gives `no_activity`. That is unhealthy for the public
  networks, but expected on a fresh private network.
- **Ingestion lag** of a few ledgers is normal under load. It is reported as
  `degraded` above 5 ledgers, which matches the stale-cache tolerance.

### Recovery and rollback

- On `unhealthy`, read the failed step's `errorCode`. Rerun with `--json` and
  find the run by its correlation id in telemetry.
- Point the probe at another Horizon with `NEXT_PUBLIC_HORIZON_TESTNET_URL` or
  `NEXT_PUBLIC_HORIZON_MAINNET_URL`.
- The probe is read-only and changes no existing contract. To roll back, disable
  or delete the workflow. Nothing else depends on it.
