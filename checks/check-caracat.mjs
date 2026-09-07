/**
 * Faehrt den Worker mit gefaelschten Anfragen und einem gestubbten Hugging
 * Face. Nichts wird deployt, nichts kostet Geld.
 *
 * Nach dem Muster von check_worker.mjs im Website-Repo: der exportierte fetch
 * wird importiert und direkt aufgerufen. Was hier geprueft wird, ist genau das,
 * was ausgeliefert wird -- keine nachgebaute Kopie der Logik.
 *
 * Die zwei Dinge, die am teuersten waeren, wenn sie falsch waeren:
 *
 *   1. ein Aufruf, der ein anderes Modell nennt als das gemeinte -- besonders
 *      eine Kopie unter dem eigenen Konto, die kein Anbieter bedient;
 *   2. der Schluessel des Aufrufers, der irgendwo landet ausser im ausgehenden
 *      Header.
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

// --- den Worker buendeln, damit Node ihn importieren kann ------------------
const work = mkdtempSync(join(tmpdir(), "caracat-check-"));
const bundle = join(work, "worker.mjs");
execFileSync(
  "node_modules/.bin/esbuild",
  // --platform=node, weil `agents` node:async_hooks importiert. Der Worker
  // laeuft spaeter auf der Workers-Runtime, die dieselben Node-Builtins
  // bereitstellt (nodejs_compat in wrangler.jsonc) -- hier wird nur gebuendelt,
  // damit Node den Handler importieren kann.
  ["src/index.ts", "--bundle", "--format=esm", "--platform=node",
   `--outfile=${bundle}`, "--log-level=error"],
  { stdio: "inherit" },
);
const worker = (await import(pathToFileURL(bundle).href)).default;

// --- der gestubbte Anbieter -----------------------------------------------
const KEY = "not-a-real-token";
let sent = null;
let sentAuth = null;
let reply = { ok: true, status: 200, body: { choices: [{ message: { content: "Eine Antwort." } }] } };

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
  sent = { url: String(url), body: JSON.parse(options.body ?? "{}") };
  sentAuth = options.headers?.Authorization ?? options.headers?.authorization ?? null;
  return new Response(
    typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body),
    { status: reply.status, headers: { "content-type": "application/json" } },
  );
};

/** Eine JSON-RPC-Anfrage an /mcp, mit oder ohne Schluessel. */
async function rpc(method, params = {}, { key = KEY } = {}) {
  sent = null;
  sentAuth = null;
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (key) headers.authorization = `Bearer ${key}`;

  const response = await worker.fetch(
    new Request("https://example.test/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
    {},
    { waitUntil() {}, passThroughOnException() {} },
  );

  const text = await response.text();
  // Die Antwort kommt je nach Aushandlung als JSON oder als SSE.
  const line = text.split("\n").find((l) => l.startsWith("data:"));
  const payload = JSON.parse(line ? line.slice(5).trim() : text);
  return { status: response.status, payload, text };
}

const toolText = (payload) =>
  (payload.result?.content ?? []).map((c) => c.text ?? "").join("\n");

// --- 1. die Werkzeugliste --------------------------------------------------
{
  const { payload } = await rpc("tools/list");
  const names = (payload.result?.tools ?? []).map((t) => t.name).sort();
  check("die vier Caracat-Werkzeuge sind da",
    ["ask_caracat_ai", "ask_caracat_code", "ask_caracat_pro", "list_assistants"]
      .every((n) => names.includes(n)), names.join(", "));
  check("und die drei harmlosen Beispielwerkzeuge sind noch da",
    ["greet", "add", "get_time"].every((n) => names.includes(n)), names.join(", "));
  // fetch_url ist am 2026-09-07 entfernt worden, als der Worker unter einer
  // oeffentlichen Adresse erreichbar wurde. Es lud jede URL ohne
  // Authentifizierung; ein Werkzeug, das wieder auftaucht, ist ein offener
  // Proxy, den niemand bemerkt haette.
  check("fetch_url ist weg und kommt nicht zurueck",
    !names.includes("fetch_url"), names.join(", "));
  check("kein Werkzeug nimmt eine Modelladresse entgegen",
    !(payload.result?.tools ?? []).some((t) =>
      Object.keys(t.inputSchema?.properties ?? {}).some((p) => /model|endpoint|host/i.test(p))),
  );
}

// --- 2. jeder Assistent ruft sein eigenes Modell auf ------------------------
for (const [tool, model, temperature] of [
  ["ask_caracat_ai", "openai/gpt-oss-20b", 0.6],
  ["ask_caracat_code", "Qwen/Qwen3-Coder-Next", 0.2],
  ["ask_caracat_pro", "deepseek-ai/DeepSeek-V3.1", 0.6],
]) {
  const { payload } = await rpc("tools/call", { name: tool, arguments: { question: "Hallo" } });
  check(`${tool} ruft ${model} auf`, sent?.body?.model === model, String(sent?.body?.model));
  check(`${tool} nennt keine Kopie unter unserem eigenen Konto`,
    !JSON.stringify(sent?.body ?? {}).toLowerCase().includes("chinook416"));
  check(`${tool} geht an den Router, an keine andere Adresse`,
    sent?.url === "https://router.huggingface.co/v1/chat/completions", String(sent?.url));
  check(`${tool} benutzt seine eigene Temperatur`,
    sent?.body?.temperature === temperature, String(sent?.body?.temperature));
  check(`${tool} schickt die Persoenlichkeit als System-Nachricht`,
    sent?.body?.messages?.[0]?.role === "system" &&
    /Caracat/.test(sent?.body?.messages?.[0]?.content ?? ""),
    (sent?.body?.messages?.[0]?.content ?? "").slice(0, 40));
  check(`${tool} haengt die Zuschreibung an die Antwort`,
    /is based on/.test(toolText(payload)), toolText(payload).slice(-60));
}

// --- 3. die Persoenlichkeiten werden nicht vertauscht ----------------------
{
  await rpc("tools/call", { name: "ask_caracat_code", arguments: { question: "x" } });
  const codeSystem = sent.body.messages[0].content;
  await rpc("tools/call", { name: "ask_caracat_pro", arguments: { question: "x" } });
  const proSystem = sent.body.messages[0].content;
  check("Code bekommt die Code-Persoenlichkeit",
    codeSystem.includes("You are Caracat Code") && !codeSystem.includes("You are Caracat Pro"));
  check("Pro bekommt die Pro-Persoenlichkeit",
    proSystem.includes("You are Caracat Pro") && !proSystem.includes("You are Caracat Code"));
}

// --- 4. der Denk-Modus -----------------------------------------------------
{
  await rpc("tools/call", { name: "ask_caracat_ai", arguments: { question: "x" } });
  const normal = sent.body;
  await rpc("tools/call", { name: "ask_caracat_ai", arguments: { question: "x", deep: true } });
  const deep = sent.body;

  check("normal: 2048 Token", normal.max_tokens === 2048, String(normal.max_tokens));
  check("deep: 8192 Token", deep.max_tokens === 8192, String(deep.max_tokens));
  check("deep fuegt die Anweisung hinzu",
    deep.messages[0].content.includes("work it through"));
  check("normal fuegt sie nicht hinzu",
    !normal.messages[0].content.includes("work it through"));
  check("deep bleibt bei EINER System-Nachricht",
    deep.messages.filter((m) => m.role === "system").length === 1,
    String(deep.messages.filter((m) => m.role === "system").length));
}

// --- 5. ohne Schluessel ----------------------------------------------------
{
  const { payload } = await rpc("tools/call",
    { name: "ask_caracat_pro", arguments: { question: "x" } }, { key: "" });
  check("ohne Schluessel wird nichts an den Anbieter geschickt", sent === null, String(sent?.url));
  check("und es wird gesagt, warum", /own token/i.test(toolText(payload)), toolText(payload).slice(0, 80));
  check("die Ablehnung ist als Fehler markiert", payload.result?.isError === true);
}

// --- 6. der Schluessel geht in den Header und nirgendwo sonst ---------------
{
  const { payload, text } = await rpc("tools/call",
    { name: "ask_caracat_ai", arguments: { question: "x" } });
  check("der Schluessel steht im ausgehenden Header", sentAuth === `Bearer ${KEY}`);
  check("der Schluessel steht NICHT im ausgehenden Rumpf",
    !JSON.stringify(sent.body).includes(KEY));
  check("und nicht in der Antwort an den Aufrufer", !text.includes(KEY));
  void payload;
}

// --- 7. ein Fehler des Anbieters verraet ihn auch nicht ---------------------
{
  reply = { status: 401, body: { error: `bad token ${KEY}` } };
  const { payload, text } = await rpc("tools/call",
    { name: "ask_caracat_ai", arguments: { question: "x" } });
  check("ein 401 wird in Worten erklaert",
    /Inference Providers/.test(toolText(payload)), toolText(payload).slice(0, 80));
  check("und der Schluessel steht nicht im Fehlertext", !text.includes(KEY));

  reply = { status: 402, body: { error: "no credit" } };
  const out = await rpc("tools/call", { name: "ask_caracat_pro", arguments: { question: "x" } });
  check("ein 402 sagt, dass das Guthaben leer ist",
    /credit/i.test(toolText(out.payload)), toolText(out.payload).slice(0, 60));

  reply = { ok: true, status: 200, body: { choices: [{ message: { content: "Eine Antwort." } }] } };
}

// --- 8. list_assistants braucht keinen Schluessel ---------------------------
{
  const { payload } = await rpc("tools/call",
    { name: "list_assistants", arguments: {} }, { key: "" });
  const text = toolText(payload);
  check("list_assistants geht ohne Schluessel", payload.result?.isError !== true, text.slice(0, 60));
  check("es ruft kein Modell auf", sent === null);
  check("es nennt alle drei Basismodelle",
    ["gpt-oss-20b", "Qwen3-Coder-Next", "DeepSeek-V3.1"].every((m) => text.includes(m)));
  check("und sagt, dass es keine Caracat-Gewichte gibt",
    /None of these are Caracat weights/i.test(text), text.slice(-120));
  check("und wer bezahlt", /billed to the Hugging Face token/i.test(text));
}

globalThis.fetch = realFetch;
rmSync(work, { recursive: true, force: true });

console.log();
if (problems.length) {
  console.log("FEHLGESCHLAGEN: " + problems.join("; "));
  process.exit(1);
}
console.log("alle Caracat-MCP-Pruefungen bestanden");
