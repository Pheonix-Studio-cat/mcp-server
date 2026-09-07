/**
 * Bricht den Server absichtlich, und verlangt, dass check-caracat.mjs es
 * merkt.
 *
 * In diesem Projekt sind sechs Pruefungen gruen gewesen, die nichts bewiesen
 * haben. Zwei Host-Pruefungen liefen gegen eine Route, die nie zutraf; eine
 * Mutation traf einen String, der so nicht in der Datei stand, und meldete
 * dann brav "nicht erkannt". Deshalb prueft dieses Skript zuerst, dass jede
 * Mutation ueberhaupt etwas veraendert hat.
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";

const FILE = "src/caracat.ts";
const BACKUP = "/tmp/caracat.ts.orig";
const INDEX = "src/index.ts";
const INDEX_BACKUP = "/tmp/index.ts.orig";

/** Welche Datei eine Mutation anfasst -- die meisten caracat.ts, eine index.ts. */
const fileFor = (name) => (name.includes("URL laedt") ? INDEX : FILE);

const MUTATIONS = [
  [
    "ein Assistent zeigt auf eine Kopie unter unserem eigenen Konto",
    'model: "Qwen/Qwen3-Coder-Next",',
    'model: "Chinook416/caracat-pro",',
  ],
  [
    "die Persoenlichkeiten werden vertauscht",
    '    persona: "code",',
    '    persona: "pro",',
  ],
  [
    "der Schluessel wandert in den Rumpf",
    "      model: assistant.model,",
    "      model: assistant.model,\n      key: callerKey,",
  ],
  [
    "die Sperre ohne Schluessel faellt weg",
    "      if (!callerKey) {",
    "      if (false) {",
  ],
  [
    "die Zuschreibung wird weggelassen",
    "  return `${answer}\\n\\n---\\n${assistant.attribution}`;",
    "  return answer;",
  ],
  [
    "der Denk-Modus haengt eine zweite System-Nachricht an",
    "  if (system) messages.push({ role: \"system\", content: system });",
    "  if (persona) messages.push({ role: \"system\", content: persona });\n" +
      "  if (deep) messages.push({ role: \"system\", content: DEEP_INSTRUCTION });",
  ],
  [
    "ein Werkzeug, das eine beliebige URL laedt, kommt zurueck",
    '  return server;',
    '  server.registerTool(\n' +
      '    "fetch_url",\n' +
      '    { description: "laedt eine URL", inputSchema: { url: z.string() } },\n' +
      '    async ({ url }) => ({ content: [{ type: "text", text: url }] }),\n' +
      '  );\n  return server;',
  ],
  [
    "der Endpunkt zeigt woanders hin",
    'const ENDPOINT = "https://router.huggingface.co/v1/chat/completions";',
    'const ENDPOINT = "https://not-the-router.example/v1/chat/completions";',
  ],
];

copyFileSync(FILE, BACKUP);
copyFileSync(INDEX, INDEX_BACKUP);
const missed = [];

for (const [name, from, to] of MUTATIONS) {
  const target = fileFor(name);
  const original = readFileSync(target, "utf8");
  const mutated = original.replace(from, to);
  if (mutated === original) {
    console.log(`AUFBAU-FEHLER  ${name}: das Muster kommt in ${target} nicht vor`);
    missed.push(name);
    continue;
  }
  writeFileSync(target, mutated);

  let caught = false;
  let firstFailure = "";
  try {
    execFileSync("node", ["checks/check-caracat.mjs"], { encoding: "utf8" });
  } catch (error) {
    caught = true;
    firstFailure =
      (error.stdout ?? "").split("\n").find((l) => l.startsWith("FAIL")) ?? "";
  }

  console.log((caught ? "ERKANNT   " : "UEBERSEHEN" + " ") + name);
  if (caught && firstFailure) console.log("            " + firstFailure.slice(0, 90));
  if (!caught) missed.push(name);

  writeFileSync(target, original);
}

copyFileSync(BACKUP, FILE);
copyFileSync(INDEX_BACKUP, INDEX);

console.log();
if (missed.length) {
  console.log("nicht erkannt: " + missed.join("; "));
  process.exit(1);
}
console.log("jeder absichtliche Bruch wurde erkannt");
