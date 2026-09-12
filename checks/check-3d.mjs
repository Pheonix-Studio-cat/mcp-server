/**
 * Faehrt die 3D-Werkzeuge gegen einen gestubbten Hugging-Face-Hub.
 *
 * Dasselbe Muster wie `check-caracat.mjs`: der exportierte `fetch` des Workers
 * wird importiert und direkt aufgerufen, `globalThis.fetch` gestubbt. Nichts
 * wird deployt, keine GPU wird gemietet, nichts kostet Geld.
 *
 * Die Dinge, die am teuersten waeren, wenn sie falsch waeren -- und zwar in
 * dieser Reihenfolge:
 *
 *   1. **Der Job laeuft im falschen Namensraum.** Dann zahlt jemand anderes.
 *      Der Namensraum kommt aus `whoami-v2`, nie aus einem Parameter.
 *   2. **Der Schluessel landet an einer Stelle, an der er nicht hingehoert.**
 *      Er darf im Header stehen und in `secrets.HF_TOKEN` -- sonst nirgends.
 *      Nicht in `environment`, nicht im `command`, nicht in den `labels`, nicht
 *      in der Antwort an den Aufrufer.
 *   3. **Ein Parameter wird zu einem Befehl.** Das Kommando ist ein Array ohne
 *      Shell, aber ein Prompt, der mit `-` beginnt, waere im Skript ein
 *      Schalter -- und eine Skript-URL aus einem Parameter waere
 *      "fuehre beliebigen Code auf fremde Rechnung aus".
 *   4. **Eine unbegrenzte Maschine.** `flavor` ist eine feste Liste, und der
 *      Job hat ein Zeitlimit. Ohne beides kann ein Tippfehler teuer werden.
 *
 * Gegengeprueft wird in `counterproof.mjs`: jede dieser Zusicherungen wird dort
 * absichtlich gebrochen, und wenn die Pruefung das nicht merkt, ist sie keine.
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
const work = mkdtempSync(join(tmpdir(), "threed-check-"));
const bundle = join(work, "worker.mjs");
execFileSync(
  "node_modules/.bin/esbuild",
  ["src/index.ts", "--bundle", "--format=esm", "--platform=node",
   `--outfile=${bundle}`, "--log-level=error"],
  { stdio: "inherit" },
);
const worker = (await import(pathToFileURL(bundle).href)).default;

// --- der gestubbte Hub -----------------------------------------------------
const KEY = "not-a-real-token";
const NAMESPACE = "someone-else-entirely";
const JOB_ID = "abc123def4567890";

/** Alles, was der Worker nach draussen geschickt hat, in der Reihenfolge. */
let calls = [];

/** Was der Stub auf einen Pfad antwortet. Wird pro Block umgestellt. */
let whoamiReply = { status: 200, body: { name: NAMESPACE, type: "user" } };
let jobsReply = {
  status: 200,
  body: {
    id: JOB_ID,
    url: `https://huggingface.co/jobs/${NAMESPACE}/${JOB_ID}`,
    status: { stage: "RUNNING" },
  },
};

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
  const u = String(url);
  const call = {
    url: u,
    method: options.method ?? "GET",
    auth: options.headers?.Authorization ?? options.headers?.authorization ?? null,
    body: options.body ? JSON.parse(options.body) : null,
  };
  calls.push(call);

  const reply = u.includes("/api/whoami-v2") ? whoamiReply : jobsReply;
  return new Response(
    typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body),
    { status: reply.status, headers: { "content-type": "application/json" } },
  );
};

/** Eine JSON-RPC-Anfrage an /mcp, mit oder ohne Schluessel. */
async function rpc(method, params = {}, { key = KEY } = {}) {
  calls = [];
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
  const line = text.split("\n").find((l) => l.startsWith("data:"));
  const payload = JSON.parse(line ? line.slice(5).trim() : text);
  return { status: response.status, payload, text };
}

const toolText = (payload) =>
  (payload.result?.content ?? []).map((c) => c.text ?? "").join("\n");
const structured = (payload) => payload.result?.structuredContent ?? {};
const call = (name) => ({ name, arguments: {} });
/** Der POST, der den Job angelegt hat -- der einzige, der uns wirklich interessiert. */
const jobPost = () => calls.find((c) => c.method === "POST" && /\/api\/jobs\/[^/]+$/.test(c.url));

// --- 1. die Werkzeugliste --------------------------------------------------
{
  const { payload } = await rpc("tools/list");
  const tools = payload.result?.tools ?? [];
  const names = tools.map((t) => t.name).sort();

  check("die vier 3D-Werkzeuge sind da",
    ["list_3d_models", "generate_3d", "get_3d_job", "cancel_3d_job"]
      .every((n) => names.includes(n)), names.join(", "));
  check("die Caracat-Werkzeuge sind dabei geblieben",
    ["ask_caracat_ai", "ask_caracat_code", "ask_caracat_pro", "list_assistants"]
      .every((n) => names.includes(n)), names.join(", "));
  check("fetch_url ist immer noch weg", !names.includes("fetch_url"));

  // Der Namensraum kommt aus whoami, das Skript ist eine Konstante, das Modell
  // steht im Quelltext. Ein Parameter fuer eines davon waere jeweils ein
  // eigener Weg, fremdes Geld auszugeben oder fremden Code auszufuehren.
  const threeD = tools.filter((t) => /3d/.test(t.name));
  const params = threeD.flatMap((t) => Object.keys(t.inputSchema?.properties ?? {}));
  check("kein 3D-Werkzeug nimmt einen Namensraum entgegen",
    !params.some((p) => /namespace|owner|account|user/i.test(p)), params.join(", "));
  check("kein 3D-Werkzeug nimmt ein Skript oder eine Adresse entgegen",
    !params.some((p) => /script|url|host|endpoint|image|command/i.test(p)), params.join(", "));
  check("kein 3D-Werkzeug nimmt eine Modelladresse entgegen",
    !params.some((p) => /^model$/i.test(p)), params.join(", "));
}

// --- 2. list_3d_models braucht keinen Schluessel ---------------------------
{
  const { payload } = await rpc("tools/call", call("list_3d_models"), { key: "" });
  const text = toolText(payload);
  check("list_3d_models geht ohne Schluessel", payload.result?.isError !== true, text.slice(0, 60));
  check("es ruft nichts auf", calls.length === 0, String(calls.length));
  check("es nennt das Modell", text.includes("Chinook416/3d-gen-1"));
  // Der teuerste Fehler des Caracat-Projekts, hier zum vierten Mal: eine Kopie
  // unter dem eigenen Konto, die kein Anbieter bedient. Wer das Werkzeug
  // benutzt, soll es aus der Auskunft erfahren und nicht aus einem 404.
  check("und sagt, dass es eine Kopie ist",
    /copy of/i.test(text) && text.includes("MeshGPT-preview"), text.slice(0, 120));
  check("und dass kein Anbieter es bedient",
    structured(payload).served_by_inference_providers === false);
  check("und wer bezahlt", /your credit balance/i.test(text) || /YOUR credit/i.test(text));
  check("und was das Modell ueberhaupt kann",
    /chair/i.test(text) && /250 triangles/i.test(text));
}

// --- 3. ohne Schluessel wird nichts gestartet ------------------------------
for (const name of ["generate_3d", "get_3d_job", "cancel_3d_job"]) {
  const args = name === "generate_3d" ? { prompt: "chair" } : { job_id: JOB_ID };
  const { payload } = await rpc("tools/call", { name, arguments: args }, { key: "" });
  check(`${name} ohne Schluessel ruft nichts auf`, calls.length === 0, String(calls.length));
  check(`${name} ohne Schluessel sagt, warum`,
    /send your own/i.test(toolText(payload)), toolText(payload).slice(0, 60));
  check(`${name} ohne Schluessel ist als Fehler markiert`, payload.result?.isError === true);
}

// --- 4. der Job laeuft im Namensraum des Aufrufers -------------------------
{
  const { payload } = await rpc("tools/call",
    { name: "generate_3d", arguments: { prompt: "wooden chair" } });

  check("zuerst wird gefragt, wem der Schluessel gehoert",
    calls[0]?.url === "https://huggingface.co/api/whoami-v2", String(calls[0]?.url));
  const post = jobPost();
  check("dann wird der Job in genau diesem Namensraum angelegt",
    post?.url === `https://huggingface.co/api/jobs/${NAMESPACE}`, String(post?.url));
  check("und nirgendwo sonst",
    calls.every((c) => c.url.startsWith("https://huggingface.co/")),
    calls.map((c) => c.url).join(" "));
  check("der Aufrufer erfaehrt, auf wessen Rechnung das geht",
    structured(payload).billed_to === NAMESPACE, String(structured(payload).billed_to));
}

// --- 5. der Schluessel: im Header und in secrets, sonst nirgends -----------
{
  const { text } = await rpc("tools/call",
    { name: "generate_3d", arguments: { prompt: "chair" } });
  const post = jobPost();

  check("der Schluessel steht im ausgehenden Header", post?.auth === `Bearer ${KEY}`);
  check("der Schluessel steht in secrets.HF_TOKEN", post?.body?.secrets?.HF_TOKEN === KEY);
  // Der Unterschied zu caracat.ts, der begruendet gehoert: dort darf der
  // Schluessel gar nicht in den Rumpf. Hier muss er es, weil der Container
  // sonst nichts hochladen kann -- aber nur an diese eine Stelle.
  check("der Schluessel steht NICHT in environment",
    !JSON.stringify(post?.body?.environment ?? {}).includes(KEY),
    JSON.stringify(post?.body?.environment ?? {}));
  check("der Schluessel steht NICHT im command",
    !JSON.stringify(post?.body?.command ?? []).includes(KEY));
  check("der Schluessel steht NICHT in den labels",
    !JSON.stringify(post?.body?.labels ?? {}).includes(KEY));
  check("und nirgendwo sonst im Rumpf ausser secrets", (() => {
    const { secrets, ...rest } = post?.body ?? {};
    return !JSON.stringify(rest).includes(KEY);
  })());
  check("und nicht in der Antwort an den Aufrufer", !text.includes(KEY));
}

// --- 6. was der Job tatsaechlich ausfuehrt ---------------------------------
{
  await rpc("tools/call",
    { name: "generate_3d", arguments: { prompt: "ladder", temperature: 0.4 } });
  const body = jobPost()?.body ?? {};
  const command = body.command ?? [];

  check("das Kommando ist `uv run <Skript>`",
    command[0] === "uv" && command[1] === "run", command.slice(0, 2).join(" "));
  check("das Skript ist die Konstante aus dem Quelltext",
    command[2] ===
      "https://raw.githubusercontent.com/Pheonix-Studio-cat/3d-ai-plugin/" +
      "refs/heads/main/jobs/generate_3d.py", String(command[2]));
  check("das Image ist das UV-Image",
    body.dockerImage === "ghcr.io/astral-sh/uv:python3.12-bookworm", String(body.dockerImage));
  check("das Modell steht im Kommando, nicht in einem Parameter",
    command[command.indexOf("--model") + 1] === "Chinook416/3d-gen-1");
  check("der Prompt kommt beim Skript an",
    command[command.indexOf("--prompt") + 1] === "ladder");
  check("die Temperatur wird durchgereicht",
    command[command.indexOf("--temperature") + 1] === "0.4");
  check("das Ziel liegt im Namensraum des Aufrufers",
    command[command.indexOf("--output-repo") + 1] === `${NAMESPACE}/3d-gen-1-output`,
    String(command[command.indexOf("--output-repo") + 1]));
  check("das Kommando ist ein Array, keine Zeichenkette",
    Array.isArray(command) && command.every((c) => typeof c === "string"));
  check("keine Shell dazwischen",
    !command.some((c) => /^(sh|bash|-c)$/.test(c)), command.join(" "));

  // Die Gegenprobe hat hier eine Luecke gefunden: die Zusicherung oben lief
  // nur gegen einen Aufruf ohne optionale Parameter und war deshalb gruen,
  // obwohl das Skript aus `output_repo` haette kommen koennen. Ein Bruch, den
  // nur ein bestimmter Aufruf zeigt, wird von einer Pruefung, die diesen
  // Aufruf nie macht, nicht bewiesen -- sondern nur nicht gesehen.
  //
  // Also: mit jedem Parameter besetzt, und die ausfuehrbaren Stellen des
  // Kommandos duerfen keinen davon enthalten.
  const FILLED = {
    prompt: "unmistakable-prompt-value",
    temperature: 0.7,
    flavor: "l4x1",
    output_repo: "unmistakable-owner/unmistakable-repo",
  };
  await rpc("tools/call", { name: "generate_3d", arguments: FILLED });
  const full = jobPost()?.body ?? {};
  const cmd = full.command ?? [];

  check("auch mit allen Parametern bleibt `uv run` das Kommando",
    cmd[0] === "uv" && cmd[1] === "run", cmd.slice(0, 2).join(" "));
  check("auch mit allen Parametern ist das Skript die Konstante",
    cmd[2] ===
      "https://raw.githubusercontent.com/Pheonix-Studio-cat/3d-ai-plugin/" +
      "refs/heads/main/jobs/generate_3d.py", String(cmd[2]));
  check("auch mit allen Parametern ist das Image die Konstante",
    full.dockerImage === "ghcr.io/astral-sh/uv:python3.12-bookworm",
    String(full.dockerImage));
  // Die drei ausfuehrbaren Stellen -- Programm, Unterbefehl, Skript. Was ein
  // Aufrufer schickt, gehoert hinter sie, nie in sie.
  check("kein Parameterwert steht an einer ausfuehrbaren Stelle",
    !cmd.slice(0, 3).some((slot) =>
      Object.values(FILLED).some((value) => String(slot).includes(String(value)))),
    cmd.slice(0, 3).join(" "));
  check("und die Parameter kommen trotzdem an",
    cmd.includes(FILLED.prompt) && cmd.includes(FILLED.output_repo));
}

// --- 7. die Maschine ist begrenzt und laeuft nicht ewig --------------------
{
  await rpc("tools/call", { name: "generate_3d", arguments: { prompt: "chair" } });
  const body = jobPost()?.body ?? {};
  check("ohne Angabe die kleinste GPU", body.flavor === "t4-small", String(body.flavor));
  check("der Job hat ein Zeitlimit",
    typeof body.timeoutSeconds === "number" && body.timeoutSeconds > 0 &&
    body.timeoutSeconds <= 30 * 60, String(body.timeoutSeconds));

  await rpc("tools/call",
    { name: "generate_3d", arguments: { prompt: "chair", flavor: "cpu-basic" } });
  check("eine erlaubte Maschine geht durch", jobPost()?.body?.flavor === "cpu-basic");

  // Die grossen Maschinen stehen nicht in der Liste. Das ist kein
  // Sicherheitsproblem -- der Aufrufer zahlt selbst -- sondern eine Bremse
  // gegen den Tippfehler, der das Zwanzigfache kostet.
  const { payload } = await rpc("tools/call",
    { name: "generate_3d", arguments: { prompt: "chair", flavor: "a100x8" } });
  check("eine H200-Farm wird abgelehnt",
    payload.result?.isError === true || payload.error !== undefined);
  check("und dabei wird nichts gestartet", jobPost() === undefined);
}

// --- 8. was ein Parameter nicht werden darf --------------------------------
{
  // argparse im Skript sieht nur Zeichenketten: ein Prompt, der mit `-`
  // beginnt, waere dort ein Schalter und koennte ein anderes Ziel setzen.
  const dash = await rpc("tools/call",
    { name: "generate_3d", arguments: { prompt: "--output-repo attacker/loot" } });
  check("ein Prompt, der wie ein Schalter aussieht, wird abgelehnt",
    dash.payload.result?.isError === true, toolText(dash.payload).slice(0, 60));
  check("und dabei wird nichts gestartet", jobPost() === undefined);

  const bad = await rpc("tools/call",
    { name: "generate_3d", arguments: { prompt: "chair", output_repo: "https://evil.test/x" } });
  check("ein output_repo, das eine Adresse ist, wird abgelehnt",
    bad.payload.result?.isError === true, toolText(bad.payload).slice(0, 60));
  check("und dabei wird nichts gestartet", jobPost() === undefined);

  const trav = await rpc("tools/call",
    { name: "generate_3d", arguments: { prompt: "chair", output_repo: "a/../../b" } });
  check("ein output_repo mit .. wird abgelehnt", trav.payload.result?.isError === true);

  const job = await rpc("tools/call",
    { name: "get_3d_job", arguments: { job_id: "../../api/whoami-v2" } });
  check("eine Job-Kennung, die ein Pfad ist, wird abgelehnt",
    job.payload.result?.isError === true, toolText(job.payload).slice(0, 60));
  check("und dabei wird der Hub nicht angefasst",
    !calls.some((c) => c.url.includes("whoami")) || calls.length === 0);
}

// --- 9. den Stand abfragen -------------------------------------------------
{
  const REPO = `${NAMESPACE}/3d-gen-1-output`;
  const PATH = "generated/2026-09-12T10-00-00-000-chair.obj";
  jobsReply = {
    status: 200,
    body: {
      id: JOB_ID,
      url: `https://huggingface.co/jobs/${NAMESPACE}/${JOB_ID}`,
      command: ["uv", "run", "script.py", "--output-repo", REPO, "--output-path", PATH],
      status: { stage: "COMPLETED", message: null },
    },
  };

  const { payload } = await rpc("tools/call", { name: "get_3d_job", arguments: { job_id: JOB_ID } });
  const s = structured(payload);
  check("ein fertiger Job wird als fertig gemeldet", s.done === true && s.stage === "COMPLETED");
  check("und die .obj-Adresse wird genannt",
    s.result_url === `https://huggingface.co/datasets/${REPO}/resolve/main/${PATH}`,
    String(s.result_url));
  check("die Adresse wird aus dem Job gelesen, nicht geraten",
    calls.some((c) => c.url === `https://huggingface.co/api/jobs/${NAMESPACE}/${JOB_ID}`));

  jobsReply.body.status = { stage: "RUNNING", message: null };
  const running = await rpc("tools/call", { name: "get_3d_job", arguments: { job_id: JOB_ID } });
  check("ein laufender Job liefert noch keine Adresse",
    structured(running.payload).result_url === null);
  check("und sagt, dass man noch warten muss",
    /Still working/i.test(toolText(running.payload)));

  jobsReply.body.status = { stage: "ERROR", message: "it broke" };
  const broken = await rpc("tools/call", { name: "get_3d_job", arguments: { job_id: JOB_ID } });
  check("ein gescheiterter Job verweist auf die Protokolle",
    /logs/i.test(toolText(broken.payload)), toolText(broken.payload).slice(0, 80));
}

// --- 10. abbrechen ---------------------------------------------------------
{
  jobsReply = { status: 200, body: { id: JOB_ID, status: { stage: "CANCELED" } } };
  const { payload } = await rpc("tools/call", { name: "cancel_3d_job", arguments: { job_id: JOB_ID } });
  const posted = calls.find((c) => c.method === "POST");
  check("abbrechen geht an den Abbruch-Endpunkt",
    posted?.url === `https://huggingface.co/api/jobs/${NAMESPACE}/${JOB_ID}/cancel`,
    String(posted?.url));
  check("und wird bestaetigt", structured(payload).cancelled === true);
}

// --- 11. Fehler des Hubs, in Worten ---------------------------------------
{
  whoamiReply = { status: 401, body: { error: `bad token ${KEY}` } };
  const { payload, text } = await rpc("tools/call",
    { name: "generate_3d", arguments: { prompt: "chair" } });
  check("ein 401 wird erklaert", /refused the token/i.test(toolText(payload)),
    toolText(payload).slice(0, 60));
  check("und der Schluessel steht nicht im Fehlertext", !text.includes(KEY));
  check("und es wurde nichts gestartet", jobPost() === undefined);

  whoamiReply = { status: 200, body: { name: NAMESPACE } };
  jobsReply = { status: 402, body: { error: "no credit" } };
  const broke = await rpc("tools/call", { name: "generate_3d", arguments: { prompt: "chair" } });
  check("ein 402 sagt, dass das Guthaben leer ist",
    /credit/i.test(toolText(broke.payload)), toolText(broke.payload).slice(0, 80));
  check("und wo man es auflaedt", /settings\/billing/.test(toolText(broke.payload)));
}

// --- 12. die Zuschreibung faehrt mit --------------------------------------
{
  whoamiReply = { status: 200, body: { name: NAMESPACE } };
  jobsReply = {
    status: 200,
    body: { id: JOB_ID, url: "https://huggingface.co/jobs/x/y", status: { stage: "RUNNING" } },
  };
  const { payload } = await rpc("tools/call",
    { name: "generate_3d", arguments: { prompt: "chair" } });
  // Regel eins des Projekts: die Zuschreibung ist nie weg. Bei einem Modell,
  // das eine Kopie eines fremden ist, ist sie nicht Hoeflichkeit, sondern die
  // Bedingung der Lizenz.
  check("das Ergebnis nennt, von wem das Modell stammt",
    /MeshGPT-preview by MarcusLoren/.test(toolText(payload)), toolText(payload).slice(-100));
  check("und dass es nicht unsere Gewichte sind",
    /copy of/i.test(structured(payload).attribution ?? ""));
}

globalThis.fetch = realFetch;
rmSync(work, { recursive: true, force: true });

console.log();
if (problems.length) {
  console.log("FEHLGESCHLAGEN: " + problems.join("; "));
  process.exit(1);
}
console.log("alle 3D-MCP-Pruefungen bestanden");
