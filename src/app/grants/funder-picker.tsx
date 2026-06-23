"use client";

import { useState } from "react";
import { Check, ChevronsUpDown, Plus, X } from "lucide-react";
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

/**
 * Searchable funder combobox for the grant form. Writes the chosen funder id to
 * a hidden <input name="funderId"> so the existing saveGrant logic is unchanged.
 * Includes an "Add funder" shortcut that opens the funder form in a new tab.
 */
export function FunderPicker({
  funders,
  initialFunderId,
  initialFunderName,
}: {
  funders: { id: number; name: string }[];
  initialFunderId: number | null;
  initialFunderName: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<{ id: number; name: string } | null>(
    initialFunderId && initialFunderName
      ? { id: initialFunderId, name: initialFunderName }
      : null
  );

  return (
    <div>
      <input type="hidden" name="funderId" value={selected?.id ?? ""} />
      <div className="flex gap-2">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-expanded={open}
              className="flex h-9 w-full items-center justify-between rounded-md border bg-white px-3 py-2 text-sm"
            >
              <span className={selected ? "" : "text-muted-foreground"}>
                {selected ? selected.name : "Select a funder…"}
              </span>
              <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
            <Command>
              <CommandInput placeholder="Search funders…" />
              <CommandList>
                <CommandEmpty>No funder found.</CommandEmpty>
                <CommandGroup>
                  <CommandItem
                    value="__none__"
                    onSelect={() => {
                      setSelected(null);
                      setOpen(false);
                    }}
                  >
                    <X className="mr-2 h-4 w-4" />
                    <span className="text-muted-foreground">Not linked</span>
                  </CommandItem>
                  {funders.map((f) => (
                    <CommandItem
                      key={f.id}
                      value={f.name}
                      onSelect={() => {
                        setSelected({ id: f.id, name: f.name });
                        setOpen(false);
                      }}
                    >
                      <Check
                        className={`mr-2 h-4 w-4 ${selected?.id === f.id ? "opacity-100" : "opacity-0"}`}
                      />
                      {f.name}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
        <a
          href="/grants/funders/new"
          target="_blank"
          rel="noopener noreferrer"
          title="Add a new funder (opens in a new tab)"
          className="inline-flex h-9 shrink-0 items-center gap-1 rounded-md border bg-white px-3 text-sm whitespace-nowrap hover:bg-muted"
        >
          <Plus className="h-4 w-4" />
          Add funder
        </a>
      </div>
    </div>
  );
}
