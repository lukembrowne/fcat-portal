---
module: Camera Trap (Training Exports)
date: 2026-05-14
problem_type: ui_bug
component: react_component
symptoms:
  - "Hovering a non-zero count cell changes cursor to the help indicator (?) but no tooltip text appears"
  - "title attribute is set on the span but browser does not render a tooltip"
  - "Native HTML title tooltips silently fail to appear on small inline targets inside a table"
root_cause: native_title_unreliable
resolution_type: code_fix
severity: low
tags: [tooltip, title-attribute, radix-ui, shadcn, ux, react, training-exports]
---

# Native `title` tooltip does not render in training-exports preview table

## Problem

In the training-export preview at `/camera-trap/training-exports`, each split cell uses `splitCell(...)` to render an inline `images (deployments)` string with a hover tooltip listing the deployment names contributing to that split.

Initial implementation used the native HTML `title` attribute:

```tsx
<span title={tooltip} className={tooltip ? "cursor-help" : undefined}>
  {count.toLocaleString("es-EC")}{" "}
  <span className="text-xs text-muted-foreground">({deployments})</span>
</span>
```

The `cursor-help` class applied correctly (cursor became `?` on hover), confirming the span was receiving pointer events. **But no tooltip ever appeared.** The user reported "it changes to a question mark but nothing shows up."

## Environment

- Module: Camera Trap / Training Exports
- Affected file: `src/app/camera-trap/training-exports/export-form.tsx` (`splitCell` helper, ~line 144)
- Browser: macOS Safari and Chrome (both reproduced)
- Date observed: 2026-05-14

## Root Cause

Native HTML `title` tooltips are notoriously unreliable on inline targets, especially small ones nested in table cells:

1. **Long default hover delay** — most browsers wait ~700ms before showing a title tooltip. If the user moves the mouse during that window (very natural when scanning a table), the tooltip never fires.
2. **No styling control** — native tooltips inherit OS chrome and can't be made visually obvious.
3. **Inconsistent rendering on tight inline targets** — small inline spans inside `<td>` cells with `tabular-nums` or `text-right` styling can fail to trigger the tooltip in some browser/OS combinations even when `title` is correctly set on the DOM node.
4. **Commas and long content silently render** but feel "broken" — even when it does fire, a comma-separated list of 38 deployment names in a single line is hard to read.

The browser's behavior isn't a bug — it's just an unhelpful UX primitive that has no business being used for content the user actively needs to read.

## Solution

Switch to the existing shadcn/Radix Tooltip primitive already in the project at `src/components/ui/tooltip.tsx`. It portals the tooltip content into the document root (so it can't be clipped by parent CSS), supports a configurable delay, and renders with the project's Tailwind theme.

```tsx
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

function SplitCell({
  count,
  deployments,
  names,
}: {
  count: number;
  deployments: number;
  names: string[];
}) {
  if (count === 0) {
    return <span className="text-muted-foreground">0</span>;
  }
  const inner = (
    <span className="cursor-help underline decoration-dotted decoration-muted-foreground/40 underline-offset-2">
      {count.toLocaleString("es-EC")}{" "}
      <span className="text-xs text-muted-foreground">({deployments})</span>
    </span>
  );
  if (deployments === 0 || names.length === 0) return inner;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{inner}</TooltipTrigger>
      <TooltipContent side="left" className="max-w-xs">
        <div className="font-medium mb-1">
          {deployments}{" "}
          {deployments === 1 ? "instalación" : "instalaciones"}
        </div>
        <div className="text-left leading-snug">
          {names.join(", ")}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
```

Then wrap the table in a single `TooltipProvider` so all cells share one root with a snappy delay:

```tsx
<TooltipProvider delayDuration={150}>
  <div className="mt-3 overflow-x-auto">
    <table>...</table>
  </div>
</TooltipProvider>
```

The dotted underline + `cursor-help` style on the trigger gives a visual hint that the cell is interactive — important because users won't try hovering a number cell that looks like static text.

## Prevention

**Rule of thumb:** the native HTML `title` attribute is for screen readers and last-resort fallback hints. Never use it for content a sighted user is expected to read. Reach for the Radix/shadcn `Tooltip` from `src/components/ui/tooltip.tsx` instead — it's already installed and the styling is consistent with the rest of the app.

Signs you should switch from `title` to a real tooltip component:

- The tooltip content is multi-line or longer than ~30 chars
- Users need to read it as part of normal flow (not just an accessibility fallback)
- The tooltip target is small or inline inside a complex layout
- You want any control over delay, position, or styling

## Related

- shadcn tooltip primitive: `src/components/ui/tooltip.tsx`
- Plan that introduced this code: `/Users/luke/.claude/plans/how-do-i-then-quirky-knuth.md`
