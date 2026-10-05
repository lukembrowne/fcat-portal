"use client";

import { Download } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { triggerYieldsKey } from "./download-menu-keys";

/**
 * "Descargar" at the end of the clip's metadata line: one small trigger for
 * the cut clip and the source recording, which used to be two full-width
 * buttons on a row of their own.
 *
 * The review page is keyboard-driven, so the trigger must never sit on a key
 * the page uses. Closing the menu does NOT hand focus back to it (focus falls
 * to the page, where the shortcuts live), and Space on a trigger that does
 * have focus — after a Tab, say — plays/pauses instead of opening the menu.
 */
export function DownloadMenu({ sampleId }: { sampleId: number }) {
  const base = `/api/audio/validation-clip?sample=${sampleId}`;
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 data-[state=open]:bg-muted data-[state=open]:text-foreground"
        onKeyDown={(e) => {
          // Radix opens on Space; the page's own handler (on window) still
          // sees the key and plays/pauses, which is what Space means here.
          if (triggerYieldsKey(e.key)) e.preventDefault();
        }}
      >
        <Download className="h-3 w-3" />
        Descargar
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="min-w-[13rem]"
        onCloseAutoFocus={(e) => {
          // Radix would refocus the trigger, and a focused button is one
          // stray Space or Enter away from reopening.
          e.preventDefault();
          if (document.activeElement instanceof HTMLElement) {
            document.activeElement.blur();
          }
        }}
      >
        <DropdownMenuItem asChild className="text-xs">
          <a href={`${base}&download=1`} download>
            Clip (~6 s, .m4a)
          </a>
        </DropdownMenuItem>
        <DropdownMenuItem asChild className="text-xs">
          <a href={`${base}&source=1`} download>
            Grabación completa (1 min)
          </a>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
