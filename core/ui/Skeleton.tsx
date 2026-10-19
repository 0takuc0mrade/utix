import { cn } from "@/core/lib/cn";

// data-contract-state marks these as the shared loading affordance so a
// slice's tests can assert the loading state via @/core/testing/contract.
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      data-contract-state="loading"
      aria-hidden
      className={cn("animate-pulse motion-reduce:animate-none rounded-md bg-[#e3ebf5]", className)}
    />
  );
}

export function SkeletonRows({ rows = 3, className }: { rows?: number; className?: string }) {
  return (
    <div data-contract-state="loading" className={cn("space-y-2", className)} aria-hidden>
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className="h-10 w-full" />
      ))}
    </div>
  );
}
