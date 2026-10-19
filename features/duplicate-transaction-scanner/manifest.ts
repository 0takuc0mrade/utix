import { GitCompare } from "lucide-react";
import type { FeatureManifest } from "@/core/registry/types";

export const manifest: FeatureManifest = {
  slug: "duplicate-transaction-scanner",
  title: "Duplicate Transaction Scanner",
  description:
    "Detect duplicate Stellar transactions by deterministic fingerprint and review candidate groups with an audited confirm/dismiss/defer workflow.",
  character:
    "A vigilant lens sweeps transaction history, flagging identical fingerprints before they cause confusion.",
  category: "transactions",
  status: "working",
  icon: GitCompare,
  networks: ["testnet", "mainnet"],
  keywords: [
    "duplicate",
    "transaction",
    "fingerprint",
    "merge",
    "review",
    "audit",
    "scan",
    "deduplication",
  ],
};
