"use client";

import { useCallback, useEffect, useState } from "react";
import { parseDuplicateScanInput } from "@/features/duplicate-transaction-scanner/schema";
import { scanForDuplicates } from "@/features/duplicate-transaction-scanner/lib/scanner";
import {
  applyReview,
  loadGroups,
  mergeIntoStore,
  saveGroups,
} from "@/features/duplicate-transaction-scanner/lib/review";
import type {
  CandidateGroup,
  DuplicateScanErrorCode,
  DuplicateScanResult,
  ReviewInput,
} from "@/features/duplicate-transaction-scanner/types";
import type { Result } from "@/core/result/result";

export type DuplicateScannerPhase = "idle" | "loading" | "success" | "error";

export interface DuplicateScannerState {
  phase: DuplicateScannerPhase;
  /** The most recent scan result (metadata only — groups live in `groups`). */
  result: Omit<DuplicateScanResult, "groups"> | null;
  /**
   * The full merged group list: includes persisted review decisions from
   * previous scans as well as the results of the latest scan.
   */
  groups: CandidateGroup[];
  errorCode: DuplicateScanErrorCode | null;
}

const INITIAL_STATE: DuplicateScannerState = {
  phase: "idle",
  result: null,
  groups: [],
  errorCode: null,
};

export interface DuplicateScannerActions {
  scan: (rawHashes: string, network: string) => Promise<void>;
  review: (input: ReviewInput) => Result<void, DuplicateScanErrorCode>;
  reset: () => void;
}

export function useDuplicateScanner(): DuplicateScannerState & DuplicateScannerActions {
  const [state, setState] = useState<DuplicateScannerState>(INITIAL_STATE);

  // Hydrate persisted groups on mount.
  useEffect(() => {
    const persisted = loadGroups();
    if (persisted.length > 0) {
      setState((s) => ({ ...s, groups: persisted }));
    }
  }, []);

  const scan = useCallback(async (rawHashes: string, network: string) => {
    const parseResult = parseDuplicateScanInput(rawHashes, network);
    if (!parseResult.ok) {
      setState((s) => ({ ...s, phase: "error", errorCode: parseResult.code }));
      return;
    }

    setState((s) => ({ ...s, phase: "loading", errorCode: null }));

    const scanResult = await scanForDuplicates(parseResult.value);
    if (!scanResult.ok) {
      setState((s) => ({ ...s, phase: "error", errorCode: scanResult.code }));
      return;
    }

    const { groups: freshGroups, ...meta } = scanResult.value;

    // Merge fresh results with the persisted store so existing review
    // decisions (confirmed, dismissed, deferred) are preserved.
    const currentStored = loadGroups();
    const merged = mergeIntoStore(freshGroups, currentStored);
    saveGroups(merged);

    setState({
      phase: "success",
      result: meta,
      groups: merged,
      errorCode: null,
    });
  }, []);

  const review = useCallback(
    (input: ReviewInput): Result<void, DuplicateScanErrorCode> => {
      let outcome: Result<void, DuplicateScanErrorCode> = {
        ok: false,
        code: "invalid_transition",
      };

      setState((s) => {
        const idx = s.groups.findIndex((g) => g.id === input.groupId);
        if (idx === -1) return s;

        const group = s.groups[idx];
        const reviewResult = applyReview(group, input);
        if (!reviewResult.ok) {
          outcome = reviewResult;
          return s;
        }

        outcome = { ok: true, value: undefined };
        const updated = [...s.groups];
        updated[idx] = reviewResult.value;

        // Persist after state update.
        saveGroups(updated);
        return { ...s, groups: updated };
      });

      return outcome;
    },
    [],
  );

  const reset = useCallback(() => {
    setState(INITIAL_STATE);
  }, []);

  return { ...state, scan, review, reset };
}
