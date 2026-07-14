"use client";

import { useState } from "react";
import Link from "next/link";
import type { Lang, ReportSnapshot } from "./lib/snapshot-types";
import { CONTENT, DEFAULT_LANG } from "./content";
import { LanguageToggle } from "./language-toggle";

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

function Stat({ n, label, sub }: { n: string; label: string; sub?: string }) {
  return (
    <div className="flex min-w-[7rem] flex-1 basis-[calc(25%-1rem)] flex-col gap-0.5 rounded-xl border border-border/50 bg-card px-4 py-3">
      <span className="text-2xl font-bold tabular-nums">{n}</span>
      <span className="text-sm text-muted-foreground">{label}</span>
      {sub ? <span className="text-xs text-muted-foreground/80">{sub}</span> : null}
    </div>
  );
}

function Section({
  heading,
  children,
}: {
  heading: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <h2 className="text-xl font-semibold">{heading}</h2>
      {children}
    </section>
  );
}

export function ReportShell({ snapshot }: { snapshot: ReportSnapshot }) {
  const [lang, setLang] = useState<Lang>(DEFAULT_LANG);
  const c = CONTENT[lang];
  const s = snapshot.stats;

  const rs = s.retrievedSensors;
  const subWords = c.statLabels.deploymentsSub.split(" · ");
  const deploymentsSub = `${rs.cam} ${subWords[0]} · ${rs.audio} ${subWords[1]} · ${rs.climate} ${subWords[2]}`;
  const publishedDate = new Date(snapshot.generatedAt).toLocaleDateString(
    lang === "es" ? "es-EC" : "en-US",
    { year: "numeric", month: "long", day: "numeric" },
  );

  return (
    <div className="space-y-10 pb-16">
      {/* Header actions */}
      <div className="flex items-center justify-between gap-3 print:hidden" data-report-actions>
        <span className="text-xs text-muted-foreground">
          {c.ui.publishedAt} {publishedDate}
        </span>
        <div className="flex items-center gap-2">
          <a
            href={`/public/biochoco-overview/download?lang=${lang}`}
            className="rounded-full border border-border/60 px-3 py-1 text-sm font-medium transition-colors hover:bg-muted"
          >
            {c.ui.download}
          </a>
          <button
            type="button"
            onClick={() => window.print()}
            className="rounded-full border border-border/60 px-3 py-1 text-sm font-medium transition-colors hover:bg-muted"
          >
            {c.ui.print}
          </button>
          <LanguageToggle lang={lang} onToggle={setLang} />
        </div>
      </div>

      {/* Hero */}
      <header className="space-y-3">
        <p className="text-sm font-medium uppercase tracking-[0.18em] text-muted-foreground">
          {c.eyebrow}
        </p>
        <h1 className="text-3xl font-bold leading-tight sm:text-4xl">{c.title}</h1>
        <p className="max-w-2xl text-lg text-muted-foreground">{c.subtitle}</p>
        <p className="max-w-2xl text-muted-foreground">{c.intro}</p>
      </header>

      {/* Stats */}
      <div className="flex flex-wrap gap-3">
        <Stat n={fmt(s.retrievedCount)} label={c.statLabels.deployments} sub={deploymentsSub} />
        <Stat n={fmt(s.distinctSites)} label={c.statLabels.sites} />
        <Stat n={fmt(s.cameraRealSpecies)} label={c.statLabels.cameraSpecies} />
        <Stat
          n={fmt(s.audioSpeciesCount)}
          label={c.statLabels.audioSpecies}
          sub={c.statLabels.audioSpeciesSub}
        />
        <Stat n={fmt(s.totalDetections)} label={c.statLabels.detections} />
        <Stat n={fmt(s.cameraTrapDays)} label={c.statLabels.cameraTrapDays} />
        <Stat n={fmt(s.ibutton.readings)} label={c.statLabels.iButtonReadings} />
      </div>

      <Section heading={c.learn.heading}>
        {c.learn.body.map((p, i) => (
          <p key={i} className="max-w-2xl text-muted-foreground">
            {p}
          </p>
        ))}
      </Section>

      <Section heading={c.methods.heading}>
        {c.methods.body.map((p, i) => (
          <p key={i} className="max-w-2xl text-muted-foreground">
            {p}
          </p>
        ))}
      </Section>

      {/* Species */}
      <Section heading={c.species.heading}>
        <div className="grid gap-6 sm:grid-cols-2">
          <div className="space-y-2">
            <h3 className="font-medium">{c.species.cameraHeading}</h3>
            <ul className="space-y-1">
              {s.cameraTopSpecies.map((sp) => (
                <li key={sp.sci} className="flex items-baseline justify-between gap-3 text-sm">
                  <span>
                    <span className="italic">{sp.sci}</span>
                    {sp.spanishName ? (
                      <span className="text-muted-foreground"> · {sp.spanishName}</span>
                    ) : null}
                  </span>
                  <span className="tabular-nums text-muted-foreground">
                    {fmt(sp.detections)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <div className="space-y-2">
            <h3 className="font-medium">{c.species.audioHeading}</h3>
            <ul className="space-y-1">
              {s.audioTopSpecies.map((sp) => (
                <li key={sp.sci} className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="italic">{sp.sci}</span>
                  <span className="tabular-nums text-muted-foreground">
                    {fmt(sp.detections)}
                  </span>
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground/80">{c.species.audioCaveat}</p>
          </div>
        </div>
      </Section>

      {/* Media */}
      <Section heading={c.media.heading}>
        {snapshot.images.length === 0 && snapshot.audio.length === 0 ? (
          <p className="text-sm text-muted-foreground">{c.media.empty}</p>
        ) : (
          <div className="space-y-6">
            {snapshot.images.length > 0 ? (
              <div className="space-y-2">
                <h3 className="font-medium">{c.media.photosHeading}</h3>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  {snapshot.images.map((img) => (
                    <figure key={img.imageId} className="space-y-1">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={`/api/public/report-images/${img.imageId}?size=large`}
                        alt={img.caption[lang]}
                        loading="lazy"
                        className="aspect-[4/3] w-full rounded-lg object-cover"
                      />
                      <figcaption className="text-xs text-muted-foreground">
                        {img.caption[lang]}
                      </figcaption>
                    </figure>
                  ))}
                </div>
              </div>
            ) : null}
            {snapshot.audio.length > 0 ? (
              <div className="space-y-2">
                <h3 className="font-medium">{c.media.audioHeading}</h3>
                <ul className="space-y-3">
                  {snapshot.audio.map((clip) => (
                    <li key={clip.audioId} className="space-y-1">
                      <p className="text-sm">
                        <span className="italic">{clip.speciesLabel}</span>
                        <span className="text-muted-foreground"> — {clip.caption[lang]}</span>
                      </p>
                      <audio
                        controls
                        preload="none"
                        className="w-full max-w-md"
                        src={`/api/public/report-audio/${clip.audioId}`}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        )}
      </Section>

      {/* Sampling extent */}
      <Section heading={c.map.heading}>
        <p className="text-sm text-muted-foreground">
          {fmt(s.deployments.length)} / {fmt(s.retrievedCount)} · {c.map.note}
        </p>
      </Section>

      {/* Collaborate */}
      <Section heading={c.collaborate.heading}>
        {c.collaborate.body.map((p, i) => (
          <p key={i} className="max-w-2xl text-muted-foreground">
            {p}
          </p>
        ))}
        <div className="space-y-1 pt-2">
          <h3 className="font-medium">{c.collaborate.contactsHeading}</h3>
          <ul className="space-y-1 text-sm">
            {c.contacts.map((contact) => (
              <li key={contact.email}>
                <span className="font-medium">{contact.name}</span>
                <span className="text-muted-foreground"> · {contact.role} · </span>
                <Link href={`mailto:${contact.email}`} className="underline">
                  {contact.email}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </Section>

      <footer className="border-t pt-6 text-xs text-muted-foreground">{c.footer}</footer>
    </div>
  );
}
