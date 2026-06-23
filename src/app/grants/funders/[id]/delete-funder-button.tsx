"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { deleteFunder } from "../actions";

export function DeleteFunderButton({
  id,
  name,
  grantCount,
}: {
  id: number;
  name: string;
  grantCount: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onDelete() {
    const warn =
      grantCount > 0
        ? `This funder has ${grantCount} linked grant(s); they'll keep the name but become unlinked. `
        : "";
    if (!confirm(`${warn}Delete the funder "${name}"?`)) return;
    startTransition(async () => {
      const res = await deleteFunder(id);
      if (res.success) {
        router.push("/grants/funders");
        router.refresh();
      } else {
        setError(res.error);
      }
    });
  }

  return (
    <div className="text-right">
      <button
        type="button"
        onClick={onDelete}
        disabled={pending}
        className="rounded-md border border-red-200 text-red-700 px-3 py-2 text-sm hover:bg-red-50 disabled:opacity-50"
      >
        {pending ? "Deleting…" : "Delete"}
      </button>
      {error && <p className="text-xs text-red-600 mt-1">{error}</p>}
    </div>
  );
}
