"use client";

/**
 * Funder cell for the /grants table (rendered as the sub-line under the grant
 * name). Display shows a link to the linked funder, an "unlinked" one-off name,
 * or nothing. Editors get a combobox (reusing the FunderPicker pattern) to link a
 * funder, clear the link, or type a one-off name — each saved via updateGrantField.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ChevronsUpDown, Check, X, Plus, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { updateGrantField } from "./actions";

export function EditableFunder({
  grantId,
  funderId,
  funderName,
  funderNameRaw,
  funderOptions,
  canEdit,
}: {
  grantId: number;
  funderId: number | null;
  funderName: string | null;
  funderNameRaw: string | null;
  funderOptions: { id: number; name: string }[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [rawDraft, setRawDraft] = useState(funderNameRaw ?? "");

  function saveField(field: "funderId" | "funderNameRaw", value: string | null) {
    startTransition(async () => {
      const res = await updateGrantField(grantId, field, value);
      if (res.success) {
        setOpen(false);
        router.refresh();
      }
    });
  }

  // --- Display line (shared by viewer + editor) ---
  const line =
    funderId && funderName ? (
      <a
        href={`/grants/funders/${funderId}`}
        className="relative z-10 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline"
        title={`View funder: ${funderName}`}
      >
        ↗ {funderName}
      </a>
    ) : funderNameRaw ? (
      <span className="text-xs text-muted-foreground italic">
        {funderNameRaw}{" "}
        <Badge variant="secondary" className="bg-amber-100 text-amber-800">
          unlinked
        </Badge>
      </span>
    ) : (
      <span className="text-xs text-muted-foreground">No funder</span>
    );

  if (!canEdit) return line;

  return (
    <div className="relative z-10 mt-0.5 flex items-center gap-1">
      {line}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            title="Change funder"
            className="inline-flex items-center rounded border px-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : <ChevronsUpDown className="h-3 w-3" />}
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-72 p-0" align="start">
          <Command>
            <CommandInput placeholder="Search funders…" />
            <CommandList>
              <CommandEmpty>No funder found.</CommandEmpty>
              <CommandGroup>
                <CommandItem value="__none__" onSelect={() => saveField("funderId", null)}>
                  <X className="mr-2 h-4 w-4" />
                  <span className="text-muted-foreground">Not linked</span>
                </CommandItem>
                {funderOptions.map((f) => (
                  <CommandItem key={f.id} value={f.name} onSelect={() => saveField("funderId", String(f.id))}>
                    <Check className={`mr-2 h-4 w-4 ${funderId === f.id ? "opacity-100" : "opacity-0"}`} />
                    {f.name}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
          <div className="border-t p-2">
            <label className="block text-xs text-muted-foreground mb-1">
              …or a one-off name (unlinked)
            </label>
            <div className="flex gap-1">
              <input
                value={rawDraft}
                onChange={(e) => setRawDraft(e.target.value)}
                placeholder="One-off funder name"
                className="flex-1 rounded border bg-white px-1.5 py-1 text-xs"
              />
              <button
                type="button"
                onClick={() => saveField("funderNameRaw", rawDraft.trim() === "" ? null : rawDraft.trim())}
                className="rounded border px-2 py-1 text-xs hover:bg-muted"
              >
                Save
              </button>
            </div>
            <a
              href="/grants/funders/new"
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              <Plus className="h-3 w-3" />
              Add a new funder
            </a>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
