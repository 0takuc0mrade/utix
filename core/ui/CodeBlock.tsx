import { cn } from "@/core/lib/cn";

/**
 * Renders a pre-formatted code block.
 *
 * Security notes:
 * - "children" is always rendered as a text node inside `<code>`, never as HTML.
 *   React escapes text nodes, so untrusted input such as `<script>` or
 *   `<img src=x onerror=...>` is rendered literally and cannot execute.
 * - No `dangerouslySetInnerHTML` is used, so content cannot escape the
 *   code block sandbox or inject markup into the parent document.
 * - `pre` uses `overflow-x-auto` and wraps the code text node directly, so
 *   long or malicious input cannot break layout or inject additional
 *   elements.
 * - Only the optional `className` prop is applied to the root figure; it is
 *   expected to come from trusted call sites and is not derived from
 *   untrusted content.
 */
export function CodeBlock({
  children,
  label,
  className
}: {
  children: string;
  label?: string;
  className?: string;
}) {
  return (
    <figure className={cn("space-y-2", className)}>
      {label ? (
        <figcaption className="text-xs font-bold uppercase tracking-wide text-[#68758a]">
          {label}
        </figcaption>
      ) : null}
      <pre className="overflow-x-auto rounded-md border border-[#c7d6e8] bg-[#f7fafd] p-4 text-xs leading-6 text-[#172033]">
        <code>{children}</code>
      </pre>
    </figure>
  );
}
