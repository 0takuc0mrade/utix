"use client";

import { useState } from "react";
import { Button, Field, Textarea } from "@/core/ui";
import { copy } from "@/features/duplicate-transaction-scanner/copy";

interface DuplicateScannerFormProps {
  onScan: (rawHashes: string) => void;
  isLoading: boolean;
}

export function DuplicateScannerForm({ onScan, isLoading }: DuplicateScannerFormProps) {
  const [raw, setRaw] = useState("");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onScan(raw);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4" noValidate>
      <Field
        label={copy.hashesLabel}
        hint={copy.hashesHint}
        required
      >
        {({ inputId, describedBy }) => (
          <Textarea
            id={inputId}
            aria-describedby={describedBy}
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            placeholder={copy.hashesPh}
            rows={6}
            disabled={isLoading}
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
          />
        )}
      </Field>

      <Button type="submit" disabled={isLoading || !raw.trim()}>
        {isLoading ? copy.loadingLabel : copy.submitLabel}
      </Button>
    </form>
  );
}
