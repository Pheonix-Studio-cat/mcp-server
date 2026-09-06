/**
 * Holt die drei Caracat-Persoenlichkeiten und schreibt sie nach
 * src/personas.generated.ts.
 *
 * Warum zur Bauzeit und nicht zur Laufzeit
 * ----------------------------------------
 * Die Dateien liegen in prompts/ des Modell-Repos und sollen dort ihre einzige
 * Quelle haben -- eine zweite Kopie in diesem Repo waere eine, die driftet.
 * Sie hier zur Laufzeit zu holen ginge auch, kostet aber bei jedem Kaltstart
 * eine Runde zu GitHub und macht einen fremden Dienst zum Teil des heissen
 * Pfades. Vor dem Deploy geholt faellt ein Fehlschlag beim Deploy auf statt
 * beim Benutzer.
 *
 * Warum so umstaendlich fuer drei curl-Aufrufe
 * --------------------------------------------
 * Weil dasselbe im Website-Repo dreimal schiefgegangen ist. Zweimal hat
 * raw.githubusercontent einen 404 zwischengespeichert, einmal existierte die
 * Datei schlicht noch nicht -- und jedes Mal ging der Build gruen durch, mit
 * einem Assistenten, der sich als sein Basismodell vorstellte.
 *
 * Also: Wiederholen, am Cache vorbeifragen, den Inhalt pruefen -- und hier,
 * anders als dort, am Ende **abbrechen**. Eine Website ohne Persoenlichkeit
 * ist beschaedigt; ein MCP-Server ohne sie waere schlicht falsch, denn seine
 * einzige Aufgabe ist es, Caracat zu sein.
 */

import { mkdir, writeFile } from "node:fs/promises";

const BASE =
  "https://raw.githubusercontent.com/Pheonix-Studio-cat/" +
  "training-and-devoloping-caracat-code/main/prompts";

/** Schluessel, Datei, und der Name, den die Datei ueber sich selbst sagt. */
const PERSONAS = [
  ["chat", "caracat_ai_persona.md", "Caracat AI"],
  ["code", "caracat_persona.md", "Caracat Code"],
  ["pro", "caracat_pro_persona.md", "Caracat Pro"],
];

const ATTEMPTS = 4;
const PAUSES = [2000, 6000, 18000];

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * Alles vor der ersten Zeile, die nur aus `---` besteht, ist Kopf fuer
 * menschliche Leser und geht nicht an das Modell. Dieselbe Regel wie in
 * src/caracat_code/persona.py des Modell-Repos.
 */
function extractPrompt(text) {
  const lines = text.split("\n");
  const separator = lines.findIndex((line) => line.trim() === "---");
  return (separator === -1 ? lines : lines.slice(separator + 1)).join("\n").trim();
}

async function fetchPersona(name, source, expect) {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    process.stdout.write(`Hole ${name} (Versuch ${attempt} von ${ATTEMPTS})… `);

    // Der wechselnde Parameter ist der Punkt: er macht jeden Versuch zu einer
    // Adresse, die der Cache nicht kennt.
    const url = `${BASE}/${source}?v=${Date.now()}-${attempt}`;

    try {
      const response = await fetch(url, {
        headers: { "cache-control": "no-cache" },
        signal: AbortSignal.timeout(30000),
      });
      if (response.ok) {
        const text = await response.text();
        // Den Transfer zu pruefen genuegt nicht: eine leere 200 und eine
        // GitHub-Fehlerseite sind beide "erfolgreich". Jede Datei nennt sich
        // selbst, und das ist der billigste Beweis, dass die richtige ankam.
        if (text.includes(expect)) {
          const prompt = extractPrompt(text);
          if (prompt.length > 0) {
            console.log(`ok — ${text.length} Bytes, nennt sich "${expect}"`);
            return prompt;
          }
        }
        console.log(`angekommen, aber unbrauchbar (${text.length} Bytes)`);
      } else {
        console.log(`HTTP ${response.status}`);
      }
    } catch (error) {
      console.log(`fehlgeschlagen: ${error.message}`);
    }

    if (attempt < ATTEMPTS) {
      const pause = PAUSES[attempt - 1];
      console.log(`  warte ${pause / 1000}s`);
      await sleep(pause);
    }
  }

  throw new Error(
    `${name} konnte nicht geholt werden. Der Server wuerde ohne seine ` +
      `Persoenlichkeit ausliefern und waere dann nicht Caracat, sondern ein ` +
      `nackter Modellaufruf. Deploy abgebrochen.`,
  );
}

const entries = [];
for (const [name, source, expect] of PERSONAS) {
  entries.push([name, await fetchPersona(name, source, expect)]);
}

const generated =
  "// ERZEUGT von scripts/fetch-personas.mjs — nicht von Hand aendern.\n" +
  "//\n" +
  "// Die Quelle sind die Dateien in prompts/ des Modell-Repos:\n" +
  "// https://github.com/Pheonix-Studio-cat/training-and-devoloping-caracat-code\n" +
  "//\n" +
  "// Diese Datei steht in .gitignore. Sie entsteht bei `npm run build` und\n" +
  "// bei `npm run deploy`, damit es nur eine Quelle gibt.\n\n" +
  "export const PERSONAS: Record<string, string> = " +
  JSON.stringify(Object.fromEntries(entries), null, 2) +
  ";\n";

await mkdir("src", { recursive: true });
await writeFile("src/personas.generated.ts", generated, "utf8");

console.log(`\nGeschrieben: src/personas.generated.ts (${generated.length} Bytes)`);
