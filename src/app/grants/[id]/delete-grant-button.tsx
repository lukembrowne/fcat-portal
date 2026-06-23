"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { deleteGrant } from "../actions";

export function DeleteGrantButton({ id, name }: { id: number; name: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onDelete() {
    if (!confirm(`Delete the grant "${name}"? This cannot be undone.`)) {
      return;
    }
    startTransition(async () => {
      const res = await deleteGrant(id);
      if (res.success) {
        router.push("/grants");
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
