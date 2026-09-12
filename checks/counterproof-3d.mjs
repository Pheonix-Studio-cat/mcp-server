/**
 * Bricht die 3D-Werkzeuge absichtlich, und verlangt, dass check-3d.mjs es
 * merkt.
 *
 * Dasselbe Muster wie `counterproof.mjs`, aus demselben Grund: in diesem
 * Projekt sind sechs Pruefungen gruen gewesen, die nichts bewiesen haben --
 * eine davon, weil die Mutation einen String traf, der so nicht in der Datei
 * stand, und dann brav "nicht erkannt" meldete. Deshalb prueft dieses Skript
 * zuerst, dass jede Mutation ueberhaupt etwas veraendert hat.
 *
 * Die Brueche hier sind die, die im Betrieb Geld kosten wuerden:
 * der falsche Namensraum, ein Schluessel an der falschen Stelle, ein Parameter,
 * der zu einem Befehl wird, und eine Maschine ohne Deckel.
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";

const FILE = "src/threed.ts";
const BACKUP = "/tmp/threed.ts.orig";

const MUTATIONS = [
  [
    "der Job laeuft im Namensraum des Servers statt in dem des Aufrufers",
    "        const namespace = await whoami(callerKey);\n" +
      "        const repo = output_repo ?? `${namespace}/${DEFAULT_OUTPUT_REPO_NAME}`;",
    "        const namespace = \"Chinook416\";\n" +
      "        const repo = output_repo ?? `${namespace}/${DEFAULT_OUTPUT_REPO_NAME}`;",
  ],
  [
    "der Schluessel wandert aus secrets in environment",
    "            environment: {},\n            secrets: { HF_TOKEN: callerKey },",
    "            environment: { HF_TOKEN: callerKey },\n            secrets: {},",
  ],
  [
    "der Schluessel wandert in das Kommando",
    '          "--output-path",\n          path,\n        ];',
    '          "--output-path",\n          path,\n          "--token",\n          callerKey,\n        ];',
  ],
  [
    "die Sperre ohne Schluessel faellt weg",
    "      const callerKey = readCallerKey(request);\n      if (!callerKey) return noKey();\n\n      // Ein Prompt",
    "      const callerKey = readCallerKey(request);\n      if (false) return noKey();\n\n      // Ein Prompt",
  ],
  [
    "ein Prompt darf wieder mit einem Schalter beginnen",
    'if (cleaned.startsWith("-")) {',
    "if (false) {",
  ],
  [
    "output_repo wird nicht mehr geprueft",
    "if (output_repo !== undefined && !REPO_ID.test(output_repo)) {",
    "if (false) {",
  ],
  [
    "die Job-Kennung wird nicht mehr geprueft",
    "      if (!JOB_ID.test(job_id)) {\n        return failed(new Error(\"That is not a job id — they are hexadecimal.\"));\n      }\n\n      try {\n        const namespace = await whoami(callerKey);\n        const response = await fetch(`${HF}/api/jobs/${namespace}/${job_id}`, {",
    "      if (false) {\n        return failed(new Error(\"That is not a job id — they are hexadecimal.\"));\n      }\n\n      try {\n        const namespace = await whoami(callerKey);\n        const response = await fetch(`${HF}/api/jobs/${namespace}/${job_id}`, {",
  ],
  [
    "der Job bekommt kein Zeitlimit mehr",
    "            timeoutSeconds: TIMEOUT_SECONDS,",
    "",
  ],
  [
    "die Maschinenliste wird zu einer freien Zeichenkette",
    "        flavor: z\n          .enum(FLAVORS)",
    "        flavor: z\n          .string()",
  ],
  [
    "das Skript kommt aus einem Parameter statt aus dem Quelltext",
    '          "uv",\n          "run",\n          SCRIPT,',
    '          "uv",\n          "run",\n          (output_repo ?? SCRIPT),',
  ],
  [
    "die Zuschreibung faellt weg",
    '                "---",\n                MODEL.attribution,',
    '                "---",',
  ],
  [
    "die Auskunft verschweigt, dass das Modell eine Kopie ist",
    '  attribution:\n    "3d-gen-1 is a copy of MeshGPT-preview by MarcusLoren, built on " +',
    '  attribution:\n    "3d-gen-1 is an original model by Chinook416, built on " +',
  ],
  [
    "die Auskunft behauptet, ein Anbieter bediene das Modell",
    "          served_by_inference_providers: false,",
    "          served_by_inference_providers: true,",
  ],
  [
    "ein Aufruf geht an einen anderen Host",
    'const HF = "https://huggingface.co";',
    'const HF = "https://not-hugging-face.example";',
  ],
];

copyFileSync(FILE, BACKUP);
const missed = [];

for (const [name, from, to] of MUTATIONS) {
  const original = readFileSync(FILE, "utf8");
  const mutated = original.replace(from, to);
  if (mutated === original) {
    console.log(`AUFBAU-FEHLER  ${name}: das Muster kommt in ${FILE} nicht vor`);
    missed.push(name);
    continue;
  }
  writeFileSync(FILE, mutated);

  let caught = false;
  let firstFailure = "";
  try {
    execFileSync("node", ["checks/check-3d.mjs"], { encoding: "utf8" });
  } catch (error) {
    caught = true;
    // Ein Bruch, der den Bau zerlegt, statt eine Pruefung fehlschlagen zu
    // lassen, zaehlt auch: unbaubar ist nicht unbemerkt.
    const lines = ((error.stdout ?? "") + "\n" + (error.stderr ?? "")).split("\n");
    firstFailure =
      lines.find((l) => l.startsWith("FAIL")) ??
      lines.find((l) => /^\s*(error|Error|✘)/.test(l)) ??
      "";
  }

  console.log((caught ? "ERKANNT   " : "UEBERSEHEN" + " ") + name);
  if (caught && firstFailure) console.log("            " + firstFailure.trim().slice(0, 90));
  if (!caught) missed.push(name);

  writeFileSync(FILE, original);
}

copyFileSync(BACKUP, FILE);

console.log();
if (missed.length) {
  console.log("nicht erkannt: " + missed.join("; "));
  process.exit(1);
}
console.log("jeder absichtliche Bruch an den 3D-Werkzeugen wurde erkannt");
