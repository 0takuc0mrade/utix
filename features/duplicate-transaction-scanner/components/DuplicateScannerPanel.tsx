"use client";

import { useNetwork } from "@/core/network/NetworkProvider";
import { SkeletonRows, StatusMessage } from "@/core/ui";
import { copy } from "@/features/duplicate-transaction-scanner/copy";
import { DuplicateScannerEmptyState } from "@/features/duplicate-transaction-scanner/components/DuplicateScannerEmptyState";
import { DuplicateScannerForm } from "@/features/duplicate-transaction-scanner/components/DuplicateScannerForm";
import { DuplicateScannerResult } from "@/features/duplicate-transaction-scanner/components/DuplicateScannerResult";
import { useDuplicateScanner } from "@/features/duplicate-transaction-scanner/hooks/useDuplicateScanner";
import type { ReviewInput } from "@/features/duplicate-transaction-scanner/types";

/**
 * A stable "actor id" derived from the session. In a real deployment this
 * would come from auth context; here we use a per-session random string
 * persisted in sessionStorage so the audit trail is always attributed.
 */
function getSessionActorId(): string {
  if (typeof window === "undefined") return "anonymous";
  const key = "utix:dup-scan:actor";
  const existing = sessionStorage.getItem(key);
  if (existing) return existing;
  const id = `session:${crypto.randomUUID()}`;
  sessionStorage.setItem(key, id);
  return id;
}

export function DuplicateScannerPanel() {
  const { network } = useNetwork();
  const scanner = useDuplicateScanner();

  function handleScan(rawHashes: string) {
    void scanner.scan(rawHashes, network);
  }

  function handleReview(input: Omit<ReviewInput, "actorId">) {
    scanner.review({ ...input, actorId: getSessionActorId() });
  }

  return (
    <div className="space-y-6">
      {/* Input form is always visible so users can re-scan */}
      <DuplicateScannerForm
        onScan={handleScan}
        isLoading={scanner.phase === "loading"}
      />

      {/* Result area */}
      {scanner.phase === "idle" && (
        <DuplicateScannerEmptyState />
      )}

      {scanner.phase === "loading" && (
        <SkeletonRows rows={4} />
      )}

      {scanner.phase === "error" && scanner.errorCode && (
        <StatusMessage
          type="error"
          title="Scan failed"
          description={copy.errors[scanner.errorCode]}
        />
      )}

      {scanner.phase === "success" && scanner.result && (
        <DuplicateScannerResult
          result={scanner.result}
          groups={scanner.groups}
          onReview={handleReview}
        />
      )}
    </div>
  );
}
