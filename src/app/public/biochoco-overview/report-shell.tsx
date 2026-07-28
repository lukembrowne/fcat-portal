"use client";

import { Fragment, useState } from "react";
import dynamic from "next/dynamic";
import type { Lang, ReportSnapshot } from "./lib/snapshot-types";
import { CONTENT, DEFAULT_LANG } from "./content";
import { HABITAT, HAB_ORDER } from "./lib/habitat";
import { fmt, spanLabel, tpl } from "./lib/format";
import { LanguageToggle } from "./language-toggle";
import { SpectrogramClip } from "./spectrogram-clip";

const OverviewMap = dynamic(() => import("./overview-map").then((m) => m.OverviewMap), {
  ssr: false,
  loading: () => (
    <div className="map-shell">
      <div id="map" />
    </div>
  ),
});

// Domestic animals excluded from the "wild species" camera list (matches the Desktop isWild).
const DOMESTIC = new Set([
  "Gallus gallus domesticus",
  "Canis lupus familiaris",
  "Bos taurus",
  "Anas platyrhynchos domesticus",
  "Equus caballus",
  "Felis catus",
  "Sus scrofa domesticus",
]);

// Scientific → English common name for the top acoustic species (ported from the
// Desktop BIRD map). Display-only; falls back to the scientific name.
const AUDIO_COMMON: Record<string, string> = {
  "Pulsatrix perspicillata": "Spectacled Owl",
  "Ramphastos ambiguus": "Yellow-throated Toucan",
  "Crypturellus soui": "Little Tinamou",
  "Nyctidromus albicollis": "Common Pauraque",
  "Phaethornis longirostris": "Long-billed Hermit",
  "Epinecrophylla fulviventris": "Fulvous-bellied Antwren",
  "Thamnophilus atrinucha": "Black-crowned Antshrike",
  "Volatinia jacarina": "Blue-black Grassquit",
  "Ramphocelus flammigerus": "Flame-rumped Tanager",
  "Patagioenas subvinacea": "Ruddy Pigeon",
  "Ramphastos brevis": "Chocó Toucan",
  "Poliocrania exsul": "Chestnut-backed Antbird",
  "Leptotila verreauxi": "White-tipped Dove",
  "Arremon aurantiirostris": "Orange-billed Sparrow",
  "Saltator maximus": "Buff-throated Saltator",
  "Myiozetetes cayanensis": "Rusty-margined Flycatcher",
  "Myrmotherula pacifica": "Pacific Antwren",
  "Ortalis erythroptera": "Rufous-headed Chachalaca",
  "Synallaxis brachyura": "Slaty Spinetail",
  "Lophotriccus pileatus": "Scale-crested Pygmy-Tyrant",
  "Tapera naevia": "Striped Cuckoo",
  "Phaethornis yaruqui": "White-whiskered Hermit",
  "Ciccaba nigrolineata": "Black-and-white Owl",
  "Troglodytes aedon": "House Wren",
};

/**
 * Scoped port of the standalone report's design system (parchment + forest,
 * serif display type). Everything is namespaced under `.bc-root` so it can't
 * leak into the portal's public layout chrome on the same page.
 */
const CSS = `
.bc-root{
  --parchment:#f4efe3;--paper:#fffdf7;--ink:#2f271b;--ink-soft:#6d6047;--line:#e4dcc9;
  --forest:#2f6b34;--forest-deep:#22491f;--canopy:#5f9a3f;--gold:#bd8127;--sage:#e7ecdf;
  --shadow:0 1px 2px rgba(47,39,27,.06),0 6px 20px rgba(47,39,27,.07);
  --serif:"Iowan Old Style","Palatino Linotype",Palatino,"Book Antiqua",Georgia,"Times New Roman",serif;
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  position:relative;left:50%;right:50%;width:100vw;margin-left:-50vw;margin-right:-50vw;
  margin-top:-1.5rem;margin-bottom:-1.5rem;
  background:var(--parchment);color:var(--ink);font-family:var(--sans);font-size:17px;line-height:1.6;
  -webkit-font-smoothing:antialiased;
}
.bc-root *{box-sizing:border-box}
.bc-root img{max-width:100%;display:block}
.bc-root a{color:var(--forest);text-decoration:none}.bc-root a:hover{text-decoration:underline}
.bc-root h1,.bc-root h2,.bc-root h3{font-family:var(--serif);font-weight:600;line-height:1.12;text-wrap:balance;margin:0}
.bc-root .wrap{max-width:980px;margin:0 auto;padding:0 28px}
.bc-root .eyebrow{font-size:12.5px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--forest);margin:0 0 14px}
.bc-root .tnum{font-variant-numeric:tabular-nums}
.bc-root section{padding:62px 0}
.bc-root .section-head{margin-bottom:34px}
.bc-root .section-head h2{font-size:clamp(28px,4.4vw,42px);letter-spacing:-.01em}
.bc-root .section-head p{color:var(--ink-soft);max-width:64ch;margin:14px 0 0;font-size:17px}
.bc-root .rule{height:3px;width:52px;background:var(--forest);border-radius:2px;margin-bottom:22px}
.bc-root .paper{background:var(--paper);border-top:1px solid var(--line);border-bottom:1px solid var(--line)}

/* actions (portal-only wrapper) — inline in the hero, just above the meta line */
.bc-root .hero-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:26px}
.bc-root .abtn{font-family:var(--sans);font-size:13px;font-weight:600;color:var(--forest-deep);background:rgba(255,253,247,.92);backdrop-filter:blur(6px);border:1px solid rgba(228,220,201,.9);border-radius:999px;padding:6px 13px;cursor:pointer;text-decoration:none;box-shadow:0 1px 6px rgba(15,28,14,.28)}
.bc-root .abtn:hover{background:#fffdf7;text-decoration:none}

/* hero */
.bc-root .hero{position:relative;min-height:38vh;display:flex;align-items:flex-end;color:#f7f4ea;overflow:hidden;background:var(--forest-deep)}
.bc-root .hero__img{position:absolute;inset:0;background-size:cover;background-position:center 42%}
.bc-root .hero__scrim{position:absolute;inset:0;background:linear-gradient(180deg,rgba(20,38,18,.34),rgba(20,38,18,.12) 34%,rgba(18,32,16,.62) 78%,rgba(15,28,14,.86))}
.bc-root .hero__inner{position:relative;width:100%;max-width:980px;margin:0 auto;padding:0 28px 54px}
.bc-root .hero .eyebrow{color:#cfe0bd;margin-bottom:18px}
.bc-root .hero h1{font-size:clamp(46px,9vw,104px);letter-spacing:-.01em;margin:0 0 8px;color:#fff;text-shadow:0 2px 24px rgba(10,24,8,.5)}
.bc-root .hero__sub{font-family:var(--serif);font-size:clamp(19px,2.6vw,27px);font-weight:400;max-width:32ch;line-height:1.3;color:#eef3e6;text-shadow:0 1px 14px rgba(10,24,8,.5)}
.bc-root .hero__meta{margin-top:12px;display:flex;flex-wrap:wrap;gap:10px 22px;font-size:14px;color:#d7e3c8;align-items:center}
.bc-root .chip{display:inline-flex;align-items:center;gap:8px;background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.28);padding:5px 13px;border-radius:999px;font-size:13px}
.bc-root .chip .dot{width:7px;height:7px;border-radius:50%;background:var(--canopy)}

/* objectives */
.bc-root .obj-grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}
.bc-root .obj{background:var(--paper);border:1px solid var(--line);border-radius:14px;padding:22px 24px;box-shadow:var(--shadow)}
.bc-root .obj .num{font-family:var(--serif);font-size:15px;font-weight:600;color:var(--forest);letter-spacing:.02em}
.bc-root .obj h3{font-size:19px;margin:8px 0 6px}
.bc-root .obj p{margin:0;color:var(--ink-soft);font-size:15px;line-height:1.55}
.bc-root .goals{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-top:22px}
.bc-root .goal{background:var(--forest-deep);color:#eef3e6;border-radius:12px;padding:18px 20px}
.bc-root .goal .t{font-family:var(--serif);font-size:19px;color:#fff;font-weight:600;line-height:1.18}
.bc-root .goal .l{color:#c3d5b1;font-size:13.5px;margin-top:8px;line-height:1.42}

/* method cards */
.bc-root .cards{display:grid;grid-template-columns:repeat(2,1fr);gap:18px}
.bc-root .card{background:var(--paper);border:1px solid var(--line);border-radius:14px;padding:24px;box-shadow:var(--shadow)}
.bc-root .card .ic{width:36px;height:36px;color:var(--forest);margin-bottom:14px}
.bc-root .card h3{font-size:20px;margin-bottom:5px}
.bc-root .card .model{font-size:12.5px;color:var(--gold);font-weight:600;margin-bottom:10px}
.bc-root .card p{margin:0;color:var(--ink-soft);font-size:15px;line-height:1.55}

/* habitat photo cards */
.bc-root .hab-head{margin-top:52px;margin-bottom:22px}
.bc-root .hab-head h3{font-family:var(--serif);font-size:24px}
.bc-root .hab-head p{color:var(--ink-soft);font-size:15.5px;margin:8px 0 0;max-width:60ch}
.bc-root .hab-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:22px}
.bc-root .field-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:22px}
.bc-root .hc{background:var(--paper);border:1px solid var(--line);border-radius:13px;overflow:hidden;box-shadow:var(--shadow)}
.bc-root .hc .ph{aspect-ratio:3/2;width:100%;object-fit:cover;background:var(--sage)}
.bc-root .hc .bar{height:4px}
.bc-root .hc .body{padding:13px 15px 16px}
.bc-root .hc .nm{font-family:var(--serif);font-weight:600;font-size:16px;line-height:1.15}
.bc-root .hc .ds{color:var(--ink-soft);font-size:12.5px;margin-top:3px;line-height:1.4}
.bc-root .hc .ct{font-size:12px;color:var(--forest);font-weight:600;margin-top:8px}

/* stat band */
.bc-root .stats-band{background:var(--forest-deep);color:#eef3e6}
.bc-root .stats-band .eyebrow{color:#a9c891}.bc-root .stats-band h2{color:#fff}.bc-root .stats-band .section-head p{color:#cbdabc}
.bc-root .stat-grid{display:flex;flex-wrap:wrap;gap:1px;background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.12);border-radius:14px;overflow:hidden}
.bc-root .stat{background:var(--forest-deep);padding:22px 20px;flex:1 1 calc(25% - 1px)}
.bc-root .stat .n{font-family:var(--serif);font-size:clamp(30px,4.4vw,44px);font-weight:600;color:#fff;line-height:1;letter-spacing:-.01em}
.bc-root .stat .l{margin-top:10px;font-size:13.5px;color:#c3d5b1;line-height:1.35}
.bc-root .stat .sub{font-size:12px;color:#8fae76;margin-top:3px}
.bc-root .stat-note{margin-top:18px;font-size:13.5px;color:#c3d5b1;line-height:1.55;max-width:78ch}

/* map */
.bc-root .map-section{background:var(--paper);border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
.bc-root #map{height:560px;width:100%;background:#dce4d3;z-index:0}
.bc-root .map-shell{position:relative;border-radius:16px;overflow:hidden;box-shadow:var(--shadow);border:1px solid var(--line)}
.bc-root .legend{position:absolute;right:14px;bottom:14px;z-index:500;background:rgba(255,253,247,.94);border:1px solid var(--line);border-radius:11px;padding:12px 14px;font-size:12.5px;box-shadow:var(--shadow);max-width:220px}
.bc-root .legend b{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-soft);display:block;margin-bottom:8px}
.bc-root .legend .row{display:flex;align-items:center;gap:9px;margin:5px 0}
.bc-root .legend .sw{width:12px;height:12px;border-radius:50%;flex:none;border:1.5px solid rgba(255,255,255,.9)}
.bc-root .legend .row span.c{margin-left:auto;color:var(--ink-soft);font-variant-numeric:tabular-nums}
.bc-root .leaflet-popup-content{font-family:var(--sans);font-size:13.5px;line-height:1.5;margin:11px 14px}
.bc-root .leaflet-popup-content .pt{font-family:var(--serif);font-weight:600;font-size:15px;color:var(--forest-deep)}
.bc-root .leaflet-popup-content .pr{color:var(--ink-soft)}

/* species */
.bc-root .two{display:grid;grid-template-columns:1fr 1fr;gap:42px}
.bc-root .sp-title{font-family:var(--serif);font-size:22px;font-weight:600;margin:0 0 4px}
.bc-root .sp-cap{color:var(--ink-soft);font-size:14px;margin:0 0 20px}
.bc-root .bars{display:flex;flex-direction:column;gap:12px}
.bc-root .bar{display:grid;grid-template-columns:1fr auto;gap:4px 12px;align-items:baseline}
.bc-root .bar .nm{font-weight:600;font-size:14.5px}
.bc-root .bar .nm i{font-weight:400;font-style:italic;color:var(--ink-soft);font-size:13px}
.bc-root .bar .ct{font-variant-numeric:tabular-nums;font-weight:600;color:var(--forest-deep);font-size:14px}
.bc-root .bar .track{grid-column:1/3;height:9px;background:var(--sage);border-radius:5px;overflow:hidden}
.bc-root .bar .fill{display:block;height:100%;border-radius:5px;background:linear-gradient(90deg,var(--forest),var(--canopy))}
.bc-root .bar.audio .fill{background:linear-gradient(90deg,#3a6ea5,#69a7c9)}
.bc-root .bar.audio .ct{color:#2f5f8f}

/* bonus camera-trap media */
.bc-root .audio-list{list-style:none;padding:0;margin:22px 0 0;display:grid;grid-template-columns:1fr 1fr;gap:22px}
.bc-root .audio-list li{background:var(--paper);border:1px solid var(--line);border-radius:13px;overflow:hidden;box-shadow:var(--shadow)}
.bc-root .audio-list .lab{font-size:14.5px;padding:13px 15px 10px}
.bc-root .audio-list .lab b{font-family:var(--serif);font-weight:600}
.bc-root .audio-list .lab i{font-style:italic;color:var(--ink-soft)}
.bc-root .spec-clip{display:block}
.bc-root .spec-canvas-wrap{position:relative;height:132px;background:#140b1e}
.bc-root .spec-canvas{display:block;width:100%;height:132px}
.bc-root .spec-playhead{position:absolute;top:0;bottom:0;left:0;width:2px;background:rgba(255,255,255,.85);box-shadow:0 0 6px rgba(255,255,255,.7);opacity:0;pointer-events:none;transition:opacity .2s}
.bc-root .spec-status{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#c9b8dd;font-size:12.5px;letter-spacing:.02em}
.bc-root .audio-list audio{width:100%;height:34px;display:block;border-top:1px solid var(--line)}

/* platform gallery */
.bc-root .plat{background:var(--paper);border-top:1px solid var(--line)}
.bc-root .gal{display:flex;flex-direction:column;gap:38px;margin-top:14px}
.bc-root .shot{margin:0;max-width:100%}
.bc-root .browser{border:1px solid var(--line);border-radius:12px;overflow:hidden;box-shadow:var(--shadow);background:#fff}
.bc-root .browser .bchrome{display:flex;align-items:center;gap:9px;padding:9px 13px;background:#ece5d4;border-bottom:1px solid var(--line)}
.bc-root .browser .bdots{display:flex;gap:6px;flex:none}
.bc-root .browser .bdots i{width:11px;height:11px;border-radius:50%;display:block}
.bc-root .browser .bdots i:nth-child(1){background:#e0655b}.bc-root .browser .bdots i:nth-child(2){background:#e3b341}.bc-root .browser .bdots i:nth-child(3){background:#57a45b}
.bc-root .browser .baddr{flex:1;background:#fffdf7;border:1px solid var(--line);border-radius:7px;padding:5px 13px;font-size:12.5px;color:var(--ink-soft);max-width:440px}
.bc-root .browser img{width:100%;display:block}
.bc-root .shot .cap{padding:0 4px 14px}
.bc-root .shot .cap b{font-family:var(--serif);font-size:17px;font-weight:600;display:block;margin-bottom:3px}
.bc-root .shot .cap span{color:var(--ink-soft);font-size:14px;line-height:1.5}
.bc-root .also{margin-top:44px;padding-top:30px;border-top:1px solid var(--line)}
.bc-root .also-t{font-family:var(--serif);font-size:15px;font-weight:600;letter-spacing:.02em;color:var(--forest);text-transform:uppercase;margin-bottom:16px}
.bc-root .also ul{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:1fr 1fr;gap:12px 30px}
.bc-root .also li{position:relative;padding-left:22px;color:var(--ink-soft);font-size:14.5px;line-height:1.5}
.bc-root .also li::before{content:"";position:absolute;left:2px;top:8px;width:7px;height:7px;border-radius:50%;background:var(--canopy)}

/* collaborate */
.bc-root .list{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:16px}
.bc-root .list.opp-list{display:grid;grid-template-columns:1fr 1fr;column-gap:42px;row-gap:16px}
.bc-root .list li{padding-left:26px;position:relative;font-size:15.5px;line-height:1.5}
.bc-root .list li::before{content:"";position:absolute;left:0;top:9px;width:9px;height:9px;border-radius:50%;background:var(--canopy);box-shadow:0 0 0 3px var(--sage)}
.bc-root .list li b{display:block;font-family:var(--serif);font-size:16.5px;font-weight:600;color:var(--ink);margin-bottom:1px}
.bc-root .list li span{color:var(--ink-soft)}
.bc-root .cta{margin-top:46px;background:linear-gradient(135deg,var(--forest-deep),var(--forest));color:#eef3e6;border-radius:18px;padding:38px 40px;box-shadow:var(--shadow)}
.bc-root .cta h3{color:#fff;font-size:26px;margin-bottom:10px}
.bc-root .cta p{margin:0 0 22px;color:#d3e2c5;max-width:58ch}
.bc-root .contacts{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
.bc-root .contact{background:rgba(255,255,255,.09);border:1px solid rgba(255,255,255,.16);border-radius:12px;padding:16px 18px}
.bc-root .contact .nm{font-family:var(--serif);font-weight:600;color:#fff;font-size:16px}
.bc-root .contact .role{color:#a9c891;font-size:12.5px;margin:2px 0 8px}
.bc-root .contact a{color:#fff;text-decoration:underline;font-size:13.5px;word-break:break-word}

/* funders & acknowledgements */
.bc-root .ack-grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}
.bc-root .ack{background:var(--paper);border:1px solid var(--line);border-radius:14px;padding:22px 24px;box-shadow:var(--shadow)}
.bc-root .ack h3{font-size:15px;font-weight:600;letter-spacing:.02em;text-transform:uppercase;color:var(--forest)}
.bc-root .ack .lead{margin:10px 0 0;color:var(--ink-soft);font-size:14.5px;line-height:1.5}
.bc-root .ack ul{list-style:none;margin:16px 0 0;padding:0;display:flex;flex-direction:column;gap:12px}
.bc-root .ack li{padding-left:22px;position:relative}
.bc-root .ack li::before{content:"";position:absolute;left:2px;top:8px;width:7px;height:7px;border-radius:50%;background:var(--canopy)}
.bc-root .ack .nm{font-family:var(--serif);font-size:16.5px;font-weight:600;color:var(--ink);line-height:1.3}
.bc-root .ack .note{color:var(--ink-soft);font-size:13.5px;line-height:1.45;margin-top:2px}

/* footer */
.bc-root .ft{background:#1b3618;color:#bcd0ac;padding:38px 0;font-size:13.5px;line-height:1.6}
.bc-root .ft b{color:#fff;font-family:var(--serif)}
.bc-root .empty{color:var(--ink-soft);font-size:15px}

@media (max-width:820px){
  .bc-root .obj-grid,.bc-root .cards,.bc-root .two,.bc-root .opp-list,.bc-root .gal{grid-template-columns:1fr;gap:18px}
  .bc-root .stat{flex-basis:calc(50% - 1px)}
  .bc-root .hab-grid{grid-template-columns:repeat(2,1fr)}
  .bc-root .field-grid{grid-template-columns:1fr}
  .bc-root .goals,.bc-root .contacts,.bc-root .also ul,.bc-root .ack-grid{grid-template-columns:1fr}
}
@media print{
  .bc-root .hero-actions{display:none!important}
  .bc-root{margin:0;width:auto;left:auto;right:auto}
  .bc-root .hero{min-height:0;height:330px}
  .bc-root section{padding:20px 0;break-inside:avoid}
  .bc-root .stats-band,.bc-root .plat{break-inside:avoid}
  .bc-root .card,.bc-root .obj,.bc-root .hc,.bc-root .shot,.bc-root .browser,.bc-root .cta,.bc-root .map-shell,.bc-root .ack{break-inside:avoid}
  .bc-root #map{height:340px}
}
`;

// Method-card icons (ported verbatim from the Desktop <svg class="ic">).
const ICONS: React.ReactNode[] = [
  <Fragment key="cam">
    <path d="M3 8h4l1.5-2h7L17 8h4v11H3z" />
    <circle cx="12" cy="13" r="3.4" />
  </Fragment>,
  <path key="mic" d="M3 12h2l2-6 3 15 3-19 3 13 2-3h3" />,
  <Fragment key="temp">
    <path d="M10 14V5a2 2 0 0 1 4 0v9a4 4 0 1 1-4 0z" />
    <path d="M12 9v5" />
  </Fragment>,
  <Fragment key="hab">
    <path d="M12 22V12" />
    <path d="M12 12c0-4 3-6 3-6M12 12c0-3-3-5-3-5M12 16c0-2 3-3 3-3" />
    <path d="M6 22h12" />
  </Fragment>,
];

function Bars({
  rows,
  audio,
}: {
  rows: { key: string; label: React.ReactNode; count: number }[];
  audio?: boolean;
}) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <div className="bars">
      {rows.map((r) => (
        <div key={r.key} className={audio ? "bar audio" : "bar"}>
          {r.label}
          <span className="ct tnum">{fmt(r.count)}</span>
          <span className="track">
            <span className="fill" style={{ width: `${(r.count / max) * 100}%` }} />
          </span>
        </div>
      ))}
    </div>
  );
}

export function ReportShell({ snapshot }: { snapshot: ReportSnapshot }) {
  const [lang, setLang] = useState<Lang>(DEFAULT_LANG);
  const c = CONTENT[lang];
  const s = snapshot.stats;

  const rs = s.retrievedSensors;
  const span = spanLabel(s.samplingSpan.start, s.samplingSpan.end, lang);
  const publishedDate = new Date(snapshot.generatedAt).toLocaleDateString(
    lang === "es" ? "es-EC" : "en-US",
    { year: "numeric", month: "long", day: "numeric" },
  );

  const byType = s.cameraSpeciesByType ?? {};
  const tb = (s.audio.bytes / 1e12).toFixed(2);
  const inField = Math.max(0, s.deploymentCount - s.retrievedCount);

  // 8 stat tiles: value + interpolated sub. Index-coupled to c.stats.tiles
  // (content.ts) and to the same arrays in download/route.ts — keep all three
  // in the same order.
  const statVars = {
    cam: rs.cam,
    audio: rs.audio,
    climate: rs.climate,
    span,
    mammals: byType.mammal ?? 0,
    birds: byType.bird ?? 0,
    tb,
    loggers: s.ibutton.processed,
    conf: s.audioThreshold,
  };
  const statValues = [
    s.retrievedCount,
    s.cameraTrapDays,
    s.uploadCounts.camPhotos,
    s.totalDetections ?? 0,
    s.cameraRealSpecies,
    s.audio.files,
    s.audioDetections08 ?? 0,
    s.ibutton.readings,
  ];

  const camWild = s.cameraTopSpecies.filter((sp) => !DOMESTIC.has(sp.sci)).slice(0, 9);
  const audTop = s.audioTopSpecies.slice(0, 9);

  // Cache-buster for the spectrogram route: re-publishing re-renders the images
  // under the same audio ids, so the URL has to change or browsers would keep
  // serving the previous publish's image from the immutable cache.
  const specVersion = Date.parse(snapshot.generatedAt) || 0;

  return (
    <div className="bc-root">
      <style>{CSS}</style>

      {/* 1 · Hero */}
      <header className="hero">
        <div className="hero__img" style={{ backgroundImage: "url(/biochoco-overview/hero.jpg)" }} />
        <div className="hero__scrim" />

        <div className="hero__inner">
          <p className="eyebrow">{c.hero.eyebrow}</p>
          <h1>{c.hero.title}</h1>
          <p className="hero__sub">{c.hero.sub}</p>

          {/* Controls (portal-only wrapper) — sit just above the meta line */}
          <div className="hero-actions">
            <a className="abtn" href={`/public/biochoco-overview/download?lang=${lang}`}>
              {c.ui.download}
            </a>
            <button type="button" className="abtn" onClick={() => window.print()}>
              {c.ui.print}
            </button>
            <LanguageToggle lang={lang} onToggle={setLang} />
          </div>

          <div className="hero__meta">
            <span className="chip">
              <span className="dot" /> {tpl(c.hero.liveDate, { date: publishedDate })}
            </span>
            <span>{c.hero.metaSensors}</span>
          </div>
        </div>
      </header>

      {/* 2 · What we are trying to learn */}
      <section>
        <div className="wrap">
          <div className="section-head">
            <div className="rule" />
            <h2>{c.learn.heading}</h2>
            {c.learn.intro.map((para, i) => (
              <p key={i}>{para}</p>
            ))}
          </div>
          <div className="obj-grid">
            {c.learn.objectives.map((o) => (
              <div className="obj" key={o.num}>
                <div className="num">{o.num}</div>
                <h3>{o.title}</h3>
                <p>{o.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* 3 · How each station works */}
      <section className="paper">
        <div className="wrap">
          <div className="section-head">
            <div className="rule" />
            <h2>{c.methods.heading}</h2>
            <p>{c.methods.intro}</p>
          </div>
          <div className="cards">
            {c.methods.cards.map((card, i) => (
              <div className="card" key={card.title}>
                <svg
                  className="ic"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.7"
                >
                  {ICONS[i]}
                </svg>
                <h3>{card.title}</h3>
                <div className="model">{card.model}</div>
                <p>{card.body}</p>
              </div>
            ))}
          </div>

          <div className="hab-head">
            <h3>{c.methods.habitatHead.title}</h3>
            <p>{c.methods.habitatHead.body}</p>
          </div>
          <div className="hab-grid">
            {HAB_ORDER.map((k) => {
              const count = s.habitatCounts?.[k] ?? 0;
              const word = count === 1 ? c.methods.sitesSampledOne : c.methods.sitesSampledMany;
              return (
                <div className="hc" key={k}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img className="ph" src={`/biochoco-overview/habitat/${k}.jpg`} alt={HABITAT[k].name[lang]} />
                  <div className="bar" style={{ background: HABITAT[k].color }} />
                  <div className="body">
                    <div className="nm">{HABITAT[k].name[lang]}</div>
                    <div className="ds">{HABITAT[k].description[lang]}</div>
                    <div className="ct">
                      {count} {word}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* 4 · Where the network stands today */}
      <section className="stats-band">
        <div className="wrap">
          <div className="section-head">
            <p className="eyebrow">{c.stats.eyebrow}</p>
            <h2>{c.stats.heading}</h2>
            <p>{tpl(c.stats.spanLine, { span })}</p>
          </div>
          <div className="stat-grid">
            {c.stats.tiles.map((tile, i) => (
              <div className="stat" key={tile.label}>
                <div className="n tnum">{fmt(statValues[i])}</div>
                <div className="l">{tile.label}</div>
                <div className="sub">{tpl(tile.sub, statVars)}</div>
              </div>
            ))}
          </div>
          <p className="stat-note">
            {tpl(c.stats.note, {
              deploymentCount: fmt(s.deploymentCount),
              retrievedCount: fmt(s.retrievedCount),
              inField: fmt(inField),
            })}
          </p>
        </div>
      </section>

      {/* 5 · Where we are working (map) */}
      <section className="map-section">
        <div className="wrap">
          <div className="section-head">
            <div className="rule" />
            <h2>{c.map.heading}</h2>
            <p>{c.map.note}</p>
          </div>
          <OverviewMap
            deployments={s.deployments}
            habitatCounts={s.habitatCounts ?? {}}
            legendTitle={c.map.legendTitle}
            lang={lang}
          />
        </div>
      </section>

      {/* 6 · Who is showing up */}
      <section className="paper">
        <div className="wrap">
          <div className="section-head">
            <div className="rule" />
            <h2>{c.species.heading}</h2>
            <p>{c.species.intro}</p>
          </div>
          <div className="two">
            <div>
              <p className="sp-title">{c.species.onCamera}</p>
              <p className="sp-cap">{tpl(c.species.camCap, { n: fmt(s.cameraRealSpecies) })}</p>
              <Bars
                rows={camWild.map((sp) => {
                  const name =
                    lang === "es"
                      ? sp.spanishName || sp.commonName || sp.sci
                      : sp.commonName || sp.sci;
                  return {
                    key: sp.sci,
                    count: sp.detections,
                    label: (
                      <span className="nm">
                        {name}
                        {name !== sp.sci ? <i> {sp.sci}</i> : null}
                      </span>
                    ),
                  };
                })}
              />
            </div>
            <div>
              <p className="sp-title">{c.species.bySound}</p>
              <p className="sp-cap">{tpl(c.species.audCap, { n: fmt(s.audio.files) })}</p>
              <Bars
                audio
                rows={audTop.map((sp) => {
                  const common = AUDIO_COMMON[sp.sci];
                  return {
                    key: sp.sci,
                    count: sp.detections,
                    label: (
                      <span className="nm">
                        {common ?? sp.sci}
                        {common ? <i> {sp.sci}</i> : null}
                      </span>
                    ),
                  };
                })}
              />
            </div>
          </div>
        </div>
      </section>

      {/* 7 · [BONUS] From the field — curated camera-trap media (omit when empty) */}
      {(snapshot.images.length > 0 || snapshot.audio.length > 0) && (
        <section>
          <div className="wrap">
            <div className="section-head">
              <div className="rule" />
              <h2>{c.bonus.heading}</h2>
            </div>
            {snapshot.images.length > 0 && (
              <div className="field-grid">
                {snapshot.images.map((img) => (
                  <figure key={img.imageId} className="hc" style={{ margin: 0 }}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      className="ph"
                      src={`/api/public/report-images/${img.imageId}?size=large`}
                      alt={img.caption[lang]}
                      loading="lazy"
                    />
                    <figcaption className="body">
                      <div className="nm">{img.speciesLabel}</div>
                      <div className="ds">{img.caption[lang]}</div>
                    </figcaption>
                  </figure>
                ))}
              </div>
            )}
            {snapshot.audio.length > 0 && (
              <ul className="audio-list">
                {snapshot.audio.map((clip) => (
                  <li key={clip.audioId}>
                    <div className="lab">
                      <b>{clip.speciesLabel}</b> — {clip.caption[lang]}
                    </div>
                    <SpectrogramClip
                      src={`/api/public/report-audio/${clip.audioId}`}
                      label={clip.speciesLabel}
                      pngSrc={
                        clip.hasSpectrogram
                          ? `/api/public/report-spectrogram/${clip.audioId}?v=${specVersion}`
                          : undefined
                      }
                    />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      )}

      {/* 8 · One open platform */}
      <section className="plat">
        <div className="wrap">
          <div className="section-head">
            <div className="rule" />
            <h2>{c.platform.heading}</h2>
            <p>{c.platform.intro}</p>
          </div>
          <div className="gal">
            {c.platform.gallery.map((shot) => (
              <figure className="shot" key={shot.title}>
                <figcaption className="cap">
                  <b>{shot.title}</b>
                  <span>{shot.caption}</span>
                </figcaption>
                <div className="browser">
                  <div className="bchrome">
                    <div className="bdots">
                      <i />
                      <i />
                      <i />
                    </div>
                    <div className="baddr">{shot.addr}</div>
                  </div>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`/biochoco-overview/gallery/${shot.file}`} alt={shot.title} />
                </div>
              </figure>
            ))}
          </div>
          <div className="also">
            <div className="also-t">{c.platform.bulletsTitle}</div>
            <ul>
              {c.platform.bullets.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {/* 9 · Where collaborators come in */}
      <section>
        <div className="wrap">
          <div className="section-head">
            <div className="rule" />
            <h2>{c.collaborate.heading}</h2>
            <p>{c.collaborate.intro}</p>
          </div>
          <div>
            <p className="sp-title" style={{ marginBottom: 16 }}>
              {c.collaborate.oppListTitle}
            </p>
            <ul className="list opp-list">
              {c.collaborate.oppList.map((it) => (
                <li key={it.title}>
                  <b>{it.title}</b>
                  <span>{it.body}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="cta">
            <h3>{c.collaborate.ctaHeading}</h3>
            <p>{c.collaborate.ctaBody}</p>
            <div className="contacts">
              {c.contacts.map((contact) => (
                <div key={contact.name} className="contact">
                  <div className="nm">{contact.name}</div>
                  <div className="role">{contact.role}</div>
                  {contact.email && (
                    <a href={`mailto:${contact.email}`}>{contact.email}</a>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* 10 · Funders & acknowledgements */}
      <section>
        <div className="wrap">
          <div className="section-head">
            <div className="rule" />
            <h2>{c.acknowledgements.heading}</h2>
          </div>
          <div className="ack-grid">
            {c.acknowledgements.groups.map((group) => (
              <div className="ack" key={group.title}>
                <h3>{group.title}</h3>
                {group.body && <p className="lead">{group.body}</p>}
                <ul>
                  {group.entries.map((entry) => (
                    <li key={entry.name}>
                      <div className="nm">{entry.name}</div>
                      {entry.note && <div className="note">{entry.note}</div>}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* 11 · Footer */}
      <div className="ft">
        <div className="wrap">
          <b>{c.footer.org}</b>
          <br />
          {c.footer.tagline}
          <br />
          {tpl(c.footer.date, { date: publishedDate })}
        </div>
      </div>
    </div>
  );
}
