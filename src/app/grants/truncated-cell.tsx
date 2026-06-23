"use client";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/**
 * One-line cell that clamps long text and shows the full value on hover.
 *
 * Uses a Radix tooltip (not the native `title` attr) and a `relative z-10`
 * trigger so it sits ABOVE the table row's full-row link overlay
 * (`after:absolute after:inset-0`), which otherwise intercepts the hover.
 */
export function TruncatedCell({
  text,
  className,
}: {
  text: string | null | undefined;
  className?: string;
}) {
  if (!text) return <span className="text-muted-foreground">—</span>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={`relative z-10 block max-w-[220px] cursor-default truncate text-sm ${className ?? ""}`}
        >
          {text}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-sm whitespace-pre-wrap break-words">
        {text}
      </TooltipContent>
    </Tooltip>
  );
}
