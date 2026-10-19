"use client";

import { Badge, Button, Card, DataList } from "@/core/ui";
import { copy } from "@/features/duplicate-transaction-scanner/copy";
import {
  formatCreatedAt,
  formatFee,
  formatGroupState,
  formatOpTypes,
  formatTimeBucket,
} from "@/features/duplicate-transaction-scanner/lib/format";
import { isTerminalState } from "@/features/duplicate-transaction-scanner/lib/review";
import type {
  CandidateGroup,
  CandidateGroupState,
  DuplicateScanResult,
  ReviewInput,
} from "@/features/duplicate-transaction-scanner/types";
import type { DataListItem } from "@/core/ui/DataList";

interface DuplicateScannerResultProps {
  result: Omit<DuplicateScanResult, "groups">;
  groups: CandidateGroup[];
  onReview: (input: Omit<ReviewInput, "actorId">) => void;
}

function stateToBadgeTone(
  state: CandidateGroupState,
): "warning" | "danger" | "success" | "muted" | "info" {
  switch (state) {
    case "pending": return "warning";
    case "deferred": return "info";
    case "confirmed": return "danger";
    case "dismissed": return "muted";
  }
}

function CandidateGroupCard({
  group,
  onReview,
}: {
  group: CandidateGroup;
  onReview: DuplicateScannerResultProps["onReview"];
}) {
  const { fingerprint } = group;
  const terminal = isTerminalState(group.state);

  const fingerprintItems: DataListItem[] = [
    {
      label: copy.groupFingerprintLabel,
      value: (
        <span className="font-mono text-xs break-all">{fingerprint.value}</span>
      ),
    },
    { label: copy.groupSourceLabel, value: fingerprint.sourceAccount },
    { label: copy.groupOpsLabel, value: formatOpTypes(fingerprint.opTypesSorted) },
    { label: copy.groupFeeLabel, value: formatFee(fingerprint.feeCharged) },
    {
      label: copy.groupMemoLabel,
      value: fingerprint.memoType === "none"
        ? "—"
        : `${fingerprint.memoType}: ${fingerprint.memo || "—"}`,
    },
    { label: copy.groupWindowLabel, value: formatTimeBucket(fingerprint.timeBucket) },
    { label: copy.groupStateLabel, value: formatGroupState(group.state) },
  ];

  return (
    <Card className="space-y-4 p-4">
      {/* Header row: state badge + fingerprint short */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-bold text-[#172033]">
          {group.transactions.length} matching transactions
        </span>
        <Badge tone={stateToBadgeTone(group.state)}>
          {copy.states[group.state]}
        </Badge>
      </div>

      {/* Fingerprint details */}
      <DataList items={fingerprintItems} />

      {/* Transaction list */}
      <section aria-label={copy.groupTransactionsLabel}>
        <p className="mb-2 text-xs font-bold uppercase tracking-wide text-[#68758a]">
          {copy.groupTransactionsLabel}
        </p>
        <div className="space-y-2">
          {group.transactions.map((tx) => (
            <div
              key={tx.hash}
              className="rounded-md border border-[#e3ebf5] bg-[#f6faff] px-3 py-2 text-xs"
            >
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <span className="font-mono break-all text-[#172033]">{tx.hash}</span>
                <span className="text-[#68758a]">
                  {copy.transactionLedgerLabel} {tx.ledger}
                </span>
                <span className="text-[#68758a]">{formatCreatedAt(tx.createdAt)}</span>
                <Badge tone={tx.successful ? "success" : "danger"} className="text-[10px]">
                  {tx.successful ? copy.transactionSuccessful : copy.transactionFailed}
                </Badge>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Review actions — hidden for terminal groups */}
      {!terminal && (
        <div
          className="flex flex-wrap gap-2 pt-2 border-t border-[#e3ebf5]"
          role="group"
          aria-label={`Review group ${group.id.slice(0, 8)}`}
        >
          <Button
            variant="danger"
            size="sm"
            aria-label={copy.confirmAria}
            onClick={() => onReview({ groupId: group.id, action: "confirm" })}
          >
            {copy.confirmLabel}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            aria-label={copy.dismissAria}
            onClick={() => onReview({ groupId: group.id, action: "dismiss" })}
          >
            {copy.dismissLabel}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-label={copy.deferAria}
            onClick={() => onReview({ groupId: group.id, action: "defer" })}
          >
            {copy.deferLabel}
          </Button>
        </div>
      )}
    </Card>
  );
}

export function DuplicateScannerResult({
  result,
  groups,
  onReview,
}: DuplicateScannerResultProps) {
  const summary =
    groups.filter((g) => g.state === "pending" || g.state === "deferred").length === 0
      ? copy.resultSummaryNone(result.scannedCount)
      : copy.resultSummaryFound(result.scannedCount, result.groupCount);

  return (
    <section aria-label={copy.scanResultRegionLabel} className="space-y-4">
      {/* Summary */}
      <p className="text-sm text-[#172033]">{summary}</p>

      {/* Group list */}
      {groups.length > 0 && (
        <div
          role="list"
          aria-label={copy.groupListLabel}
          className="space-y-4"
        >
          {groups.map((group) => (
            <div key={group.id} role="listitem">
              <CandidateGroupCard group={group} onReview={onReview} />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
