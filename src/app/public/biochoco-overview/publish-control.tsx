"use client";

import { useState, useTransition } from "react";
import { publishBiochocoOverview } from "./publish-actions";

/** Admin control: regenerate + publish the public overview snapshot. */
export function PublishControl() {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  function onPublish() {
    setMessage(null);
    startTransition(async () => {
      const result = await publishBiochocoOverview();
      if (result.success) {
        const { imageCount, audioCount } = result.data;
        setMessage({
          ok: true,
          text: `Publicado. ${imageCount} fotos · ${audioCount} audios · datos actualizados.`,
        });
      } else {
        setMessage({ ok: false, text: result.error });
      }
    });
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={onPublish}
        disabled={pending}
        className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
      >
        {pending ? "Publicando…" : "Regenerar y publicar"}
      </button>
      {message ? (
        <p className={`text-sm ${message.ok ? "text-green-600" : "text-red-600"}`}>
          {message.text}
        </p>
      ) : null}
    </div>
  );
}
