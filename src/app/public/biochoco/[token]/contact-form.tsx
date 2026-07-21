"use client";

import { useState } from "react";
import { submitLandownerContact } from "./actions";
import { MessageCircle, CheckCircle2 } from "lucide-react";

export function ContactForm({ token }: { token: string }) {
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">(
    "idle",
  );
  const [error, setError] = useState("");

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (status === "sending") return;
    setStatus("sending");
    setError("");
    const fd = new FormData(e.currentTarget);
    fd.set("token", token);
    const res = await submitLandownerContact(fd);
    if (res.success) {
      setStatus("sent");
    } else {
      setStatus("error");
      setError(res.error);
    }
  }

  if (status === "sent") {
    return (
      <section className="rounded-2xl border bg-muted/40 p-6 text-center space-y-2">
        <CheckCircle2 className="mx-auto h-8 w-8 text-green-600" />
        <p className="font-medium">¡Gracias! Recibimos tu mensaje.</p>
        <p className="text-sm text-muted-foreground">
          El equipo de FCAT te responderá pronto.
        </p>
      </section>
    );
  }

  return (
    <section className="rounded-2xl border p-5 sm:p-6 space-y-4">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <MessageCircle className="h-5 w-5" />
          ¿Tiene alguna pregunta o comentario?
        </h2>
        <p className="text-sm text-muted-foreground">
          Escríbanos y el equipo de FCAT le responderá.
        </p>
      </div>

      <form onSubmit={onSubmit} className="space-y-3">
        {/* Honeypot — hidden from humans, tempting to bots */}
        <input
          type="text"
          name="website"
          tabIndex={-1}
          autoComplete="off"
          aria-hidden="true"
          className="hidden"
        />

        <textarea
          name="message"
          required
          rows={4}
          maxLength={2000}
          placeholder="Su mensaje…"
          className="w-full rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
        />

        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="prefersCall" className="h-4 w-4" />
          Prefiero que me llamen
        </label>

        {status === "error" && (
          <p className="text-sm text-red-600" role="alert">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={status === "sending"}
          className="inline-flex items-center justify-center rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
        >
          {status === "sending" ? "Enviando…" : "Enviar mensaje"}
        </button>
      </form>
    </section>
  );
}
