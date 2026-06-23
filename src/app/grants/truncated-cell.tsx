/**
 * Long-text table cell that reveals its full content by expanding the row
 * vertically on hover (CSS only). Replaces the old popup-tooltip approach.
 *
 * The cell is raised (`relative z-20`) ABOVE the row's full-row link overlay
 * (`after:absolute after:inset-0` on the first cell). Without this the overlay
 * sits on top of the notes, so (a) hovering the text never reaches it and
 * (b) clicking to read the note navigates away instead. Raised above the
 * overlay, the note is directly hoverable and selectable without navigating.
 *
 * Two hover triggers: `hover:` expands when the cursor is over the note itself;
 * `group-hover:` (parent <TableRow> must have `group`) also expands when
 * hovering anywhere else on the row.
 */
export function ExpandCell({ text }: { text: string | null | undefined }) {
  if (!text) return <span className="text-muted-foreground">—</span>;
  return (
    <div className="relative z-20 max-w-[260px] cursor-text whitespace-pre-wrap text-sm line-clamp-2 hover:line-clamp-none group-hover:line-clamp-none">
      {text}
    </div>
  );
}
