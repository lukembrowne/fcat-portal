"use client";

import { useState } from "react";
import { ChevronRight } from "lucide-react";

interface CollapsibleSectionProps {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}

export function CollapsibleSection({
  title,
  defaultOpen = false,
  children,
}: CollapsibleSectionProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div>
      <button
        type="button"
        className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground cursor-pointer select-none"
        onClick={() => setOpen(!open)}
      >
        <ChevronRight
          className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-90" : ""}`}
        />
        {title}
      </button>
      {open && <div className="mt-3">{children}</div>}
    </div>
  );
}
