/**
 * Faehrt die Videoeditor-Werkzeuge gegen den echten Handler.
 *
 * Nach demselben Muster wie `check-caracat.mjs`: der exportierte `fetch` wird
 * gebuendelt, importiert und direkt aufgerufen. Geprueft wird das, was
 * ausgeliefert wird, nicht eine nachgebaute Kopie der Logik.
 *
 * Hier wird **kein** Netz gebraucht und **kein** Schluessel: diese Werkzeuge
 * rufen nichts von aussen auf. Genau das ist auch die erste Pruefung -- ein
 * Werkzeug, das unbemerkt anfaengt, irgendwohin zu sprechen, waere eine
 * Rechnung und ein Datenabfluss zugleich.
 *
 * Die zwei Dinge, die am teuersten waeren, wenn sie falsch waeren:
 *
 *   1. ein Plan, der Unsinn ist und trotzdem als gueltig zurueckkommt -- der
 *      Mensch merkt es erst nach dem Export;
 *   2. ein Link, der auf etwas anderes zeigt als auf den Editor.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const problems = [];

function check(name, ok, detail = "") {
  console.log((ok ? "PASS  " : "FAIL  ") + name + (detail ? "  " + detail : ""));
  if (!ok) problems.push(name);
}

const work = mkdtempSync(join(tmpdir(), "editor-check-"));
const bundle = join(work, "worker.mjs");
execFileSync(
  "node_modules/.bin/esbuild",
  ["src/index.ts", "--bundle", "--format=esm", "--platform=node",
   `--outfile=${bundle}`, "--log-level=error"],
  { stdio: "inherit" },
);
const worker = (await import(pathToFileURL(bundle).href)).default;

// --- jeder ausgehende Aufruf ist hier ein Fehler ---------------------------
let outgoing = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (...args) => {
  outgoing += 1;
  return realFetch(...args);
};

async function rpc(method, params = {}) {
  const response = await worker.fetch(
    new Request("https://example.invalid/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
    {},
    { waitUntil() {}, passThroughOnException() {} },
  );
  const text = await response.text();
  const line = text.split("\n").find((l) => l.startsWith("data: ")) ?? text;
  return JSON.parse(line.replace(/^data: /, ""));
}

const call = (name, args = {}) => rpc("tools/call", { name, arguments: args });
const textOf = (r) => (r.result?.content ?? []).map((c) => c.text).join("\n");

// ===========================================================================
console.log("\n-- die Werkzeuge sind da --");
const listed = await rpc("tools/list");
const names = (listed.result?.tools ?? []).map((t) => t.name);
for (const wanted of ["video_editor", "build_cut_plan", "check_cut_plan", "cut_plan_format"]) {
  check(`${wanted} ist registriert`, names.includes(wanted));
}
check("die Caracat-Werkzeuge sind noch da", names.includes("ask_caracat_ai") && names.includes("list_assistants"));

// ===========================================================================
console.log("\n-- ohne Schluessel, ohne Netz --");
const intro = await call("video_editor");
check("video_editor antwortet ohne Authorization-Header", !intro.result?.isError);
check("und nennt die Adresse des Editors",
  textOf(intro).includes("pheonix-studio-cat.github.io/cut-video-connector"));
check("und sagt, dass nichts hochgeladen wird", /no upload|never uploaded|nothing is ever uploaded/i.test(textOf(intro)));
check("und sagt auch, was es NICHT kann", /cannot do/i.test(textOf(intro)));
check("und warnt, dass Weichzeichnen keine Entfernung ist", /blur is not a removal/i.test(textOf(intro)));

// ===========================================================================
console.log("\n-- einen Schnitt bauen --");
const built = await call("build_cut_plan", {
  source: { name: "clip.mp4", duration: 60, width: 1920, height: 1080, fps: 30 },
  remove: [[10, 20], [40, 45]],
});
check("build_cut_plan meldet keinen Fehler", !built.result?.isError, textOf(built).split("\n")[0]);
const plan = built.result?.structuredContent?.plan;
check("und liefert einen Plan", !!plan);
check("mit dem richtigen Format", plan?.format === "cut-plan" && plan?.version === 1);
check("drei Teile bleiben uebrig", plan?.clips?.length === 3,
  JSON.stringify(plan?.clips?.map((c) => [c.start, c.end])));
check("und zwar genau die richtigen",
  JSON.stringify(plan?.clips?.map((c) => [c.start, c.end])) === JSON.stringify([[0, 10], [20, 40], [45, 60]]));
const summary = built.result?.structuredContent?.summary;
check("fuenfzehn Sekunden sind weg", summary?.removed_duration === 15, `gemeldet: ${summary?.removed_duration}`);
check("und der Export ist 45 Sekunden lang", summary?.output_duration === 45);

// Ueberlappende und unsortierte Bereiche sind der Normalfall, wenn sie
// einzeln beschrieben wurden. Wer sie von Hand zusammenrechnet, rechnet
// falsch -- deshalb rechnet das Werkzeug.
const overlapping = await call("build_cut_plan", {
  source: { duration: 30 },
  remove: [[20, 25], [5, 10], [8, 12]],
});
const overlapClips = overlapping.result?.structuredContent?.plan?.clips?.map((c) => [c.start, c.end]);
check("ueberlappende und unsortierte Schnitte werden zusammengefasst",
  JSON.stringify(overlapClips) === JSON.stringify([[0, 5], [12, 20], [25, 30]]),
  JSON.stringify(overlapClips));

const reordered = await call("build_cut_plan", {
  source: { duration: 30 },
  keep: [[20, 25], [0, 5]],
});
const keptClips = reordered.result?.structuredContent?.plan?.clips?.map((c) => [c.start, c.end]);
check("keep behaelt die angegebene Reihenfolge -- damit ist Umsortieren moeglich",
  JSON.stringify(keptClips) === JSON.stringify([[20, 25], [0, 5]]), JSON.stringify(keptClips));

const everything = await call("build_cut_plan", { source: { duration: 10 }, remove: [[0, 10]] });
check("alles wegzuschneiden wird abgelehnt statt leer exportiert",
  everything.result?.isError === true, textOf(everything));

const noDuration = await call("build_cut_plan", { source: { duration: 0 } });
check("eine Laufzeit von null wird abgelehnt", noDuration.result?.isError === true);

// ===========================================================================
console.log("\n-- der Link --");
const link = built.result?.structuredContent?.link;
check("der Link zeigt auf den Editor",
  typeof link === "string" && link.startsWith("https://pheonix-studio-cat.github.io/cut-video-connector/#plan="));
check("und nur dorthin", (link.match(/https?:\/\//g) ?? []).length === 1);

// Der Plan im Link muss derselbe sein wie der zurueckgegebene. Ein Link, der
// etwas anderes enthaelt als das, was das Werkzeug gemeldet hat, ist die
// unangenehmste Sorte Fehler: beides sieht richtig aus, nur nicht zusammen.
const encoded = link.split("#plan=")[1];
const b64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
const decoded = JSON.parse(
  Buffer.from(b64 + "=".repeat((4 - (b64.length % 4)) % 4), "base64").toString("utf8"),
);
check("im Link steckt derselbe Plan wie in der Antwort",
  JSON.stringify(decoded.clips.map((c) => [c.start, c.end])) ===
  JSON.stringify(plan.clips.map((c) => [c.start, c.end])));
check("und er ist gueltiges JSON mit Format und Version",
  decoded.format === "cut-plan" && decoded.version === 1);

// ===========================================================================
console.log("\n-- eine Radierung --");
const erased = await call("build_cut_plan", {
  source: { name: "strasse.mp4", duration: 20, width: 1920, height: 1080, fps: 30 },
  erase: [{
    method: "temporal-median",
    from: 2, to: 8,
    keys: [
      { t: 2, shape: { type: "rect", x: 0.3, y: 0.4, w: 0.1, h: 0.2 } },
      { t: 8, shape: { type: "rect", x: 0.6, y: 0.4, w: 0.1, h: 0.2 } },
    ],
  }],
});
check("eine Radierung geht durch", !erased.result?.isError, textOf(erased).split("\n")[0]);
const era = erased.result?.structuredContent?.plan?.erasures?.[0];
check("sie hat eine id", typeof era?.id === "string" && era.id.length > 0);
check("das Verfahren bleibt erhalten", era?.method === "temporal-median");
check("beide Keyframes sind da", era?.keys?.length === 2);
check("das Video bleibt ungeschnitten", erased.result?.structuredContent?.plan?.clips?.length === 1);

// ===========================================================================
console.log("\n-- was abgelehnt wird --");
const pixels = await call("check_cut_plan", {
  plan: {
    format: "cut-plan", version: 1,
    source: { name: "a.mp4", duration: 10 },
    clips: [{ id: "c1", start: 0, end: 10 }],
    erasures: [{
      id: "e1", method: "blur", from: 0, to: 5,
      keys: [{ t: 0, shape: { type: "rect", x: 640, y: 360, w: 200, h: 200 } }],
    }],
    output: {},
  },
});
check("Maskenkoordinaten in Pixeln werden abgelehnt", pixels.result?.isError === true);
check("und die Meldung sagt, warum", /fractions of the frame|not pixels/i.test(textOf(pixels)),
  "das ist der haeufigste Fehler beim Schreiben von Hand");

const reversed = await call("check_cut_plan", {
  plan: {
    format: "cut-plan", version: 1,
    source: { name: "a.mp4", duration: 10 },
    clips: [{ id: "c1", start: 8, end: 3 }],
    erasures: [], output: {},
  },
});
check("ein umgedrehter Schnitt wird abgelehnt", reversed.result?.isError === true);

const tooLong = await call("check_cut_plan", {
  plan: {
    format: "cut-plan", version: 1,
    source: { name: "a.mp4", duration: 10 },
    clips: [{ id: "c1", start: 0, end: 99 }],
    erasures: [], output: {},
  },
});
check("ein Teil hinter dem Ende der Quelle wird abgelehnt", tooLong.result?.isError === true);

const wrongFormat = await call("check_cut_plan", { plan: { format: "premiere", version: 1 } });
check("ein fremdes Format wird abgelehnt", wrongFormat.result?.isError === true);

const notJson = await call("check_cut_plan", { plan: "{kaputt" });
check("kaputtes JSON wird abgelehnt, nicht halb geladen", notJson.result?.isError === true);
check("und die Meldung nennt den Grund", /not valid JSON/i.test(textOf(notJson)));

// ===========================================================================
console.log("\n-- was nur eine Warnung ist --");
const lateKeys = await call("check_cut_plan", {
  plan: {
    format: "cut-plan", version: 1,
    source: { name: "a.mp4", duration: 20 },
    clips: [{ id: "c1", start: 0, end: 20 }],
    erasures: [{
      id: "e1", method: "temporal-median", from: 0, to: 20,
      keys: [
        { t: 0, shape: { type: "rect", x: 0.1, y: 0.1, w: 0.2, h: 0.2 } },
        { t: 5, shape: { type: "rect", x: 0.4, y: 0.1, w: 0.2, h: 0.2 } },
      ],
    }],
    output: {},
  },
});
check("Keyframes, die vor dem Ende der Radierung aufhoeren, sind kein Fehler",
  lateKeys.result?.isError !== true);
check("aber es wird gesagt",
  /holds where it was|walk out from under/i.test(textOf(lateKeys)),
  "sonst merkt es der Mensch erst am Ende des Exports");

// ===========================================================================
console.log("\n-- das Format erklaeren --");
const help = await call("cut_plan_format");
check("cut_plan_format antwortet", !help.result?.isError);
const helpText = textOf(help);
check("es nennt die Sekundenregel", /seconds of the original file/i.test(helpText));
check("es nennt die Bruchteilregel", /fractions of the frame/i.test(helpText));
check("es erklaert das Halten der Maske", /held before the first and\s+after the last/i.test(helpText));
check("es zaehlt alle vier Verfahren auf",
  ["temporal-median", "inpaint", "blur", "pixelate"].every((m) => helpText.includes(m)));

// ===========================================================================
console.log("\n-- nichts davon ruft irgendwo an --");
check("kein einziger ausgehender Aufruf in allen Pruefungen oben", outgoing === 0,
  `${outgoing} Aufrufe`);

globalThis.fetch = realFetch;
rmSync(work, { recursive: true, force: true });

console.log("");
if (problems.length) {
  console.log(`${problems.length} Pruefung(en) fehlgeschlagen:`);
  for (const p of problems) console.log(`  ${p}`);
  process.exit(1);
}
console.log("alle Videoeditor-Pruefungen bestanden");
