import { GitCompare } from "lucide-react";
import { EmptyState } from "@/core/ui";
import { copy } from "@/features/duplicate-transaction-scanner/copy";

export function DuplicateScannerEmptyState() {
  return (
    <EmptyState
      icon={GitCompare}
      title={copy.emptyHeading}
      description={copy.emptyBody}
    />
  );
}
