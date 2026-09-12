/**
 * `3d-gen-1` ueber MCP: Text zu 3D-Mesh.
 *
 * ## Warum das anders funktioniert als die Caracat-Werkzeuge
 *
 * Die Caracat-Assistenten sind ein einziger HTTP-Aufruf an die Inference
 * Providers: Frage rein, Antwort raus. Fuer `3d-gen-1` geht das **nicht**, und
 * zwar aus zwei Gruenden, die beide nicht verhandelbar sind:
 *
 *   1. `text-to-3d` ist keine Aufgabe, die die Inference Providers bedienen.
 *      Ihre Liste kennt `text-to-image` und `text-to-video`, nicht dies.
 *   2. `Chinook416/3d-gen-1` ist eine **Kopie** von `MarcusLoren/MeshGPT-preview`
 *      -- dieselbe README, dieselbe `config.json`, dieselbe
 *      `mesh-transformer.bin`. Eine Kopie bedient kein Anbieter. Das ist im
 *      Caracat-Projekt bereits dreimal passiert und steht dort als Fehler Nr. 1.
 *
 * Es gibt also keinen Endpunkt, den man anfragen koennte. Wer dieses Modell
 * laufen lassen will, muss selbst eine Maschine dafuer mieten.
 *
 * ## Was dieser Server stattdessen tut
 *
 * Er startet einen **Hugging Face Job**: eine Maschine mit GPU, die ein Skript
 * ausfuehrt und danach wieder verschwindet. Das Skript liegt in
 * `Pheonix-Studio-cat/3d-ai-plugin` unter `jobs/generate_3d.py`, laedt das
 * Modell, erzeugt das Mesh und legt die `.obj`-Datei in einem Dataset-Repo ab.
 *
 * Die Werkzeuge hier starten diesen Job, fragen seinen Stand ab und brechen ihn
 * ab. Das Erzeugen selbst dauert Minuten, nicht Sekunden -- deshalb drei
 * Werkzeuge und nicht eines: ein MCP-Aufruf, der zehn Minuten offen haelt, ist
 * in jedem Client ein Timeout.
 *
 * ## Wer bezahlt
 *
 * **Der Aufrufer, auf seinem eigenen Hugging-Face-Guthaben.** Der Job laeuft in
 * seinem Namensraum (`whoami-v2` sagt, welcher das ist) und wird nach Sekunden
 * abgerechnet. Dieser Server haelt weiterhin **keinen eigenen Schluessel** --
 * dieselbe Entscheidung wie bei Caracat, und bei gemieteter GPU-Zeit noch
 * dringender: eine offene Brieftasche, die pro Minute zahlt, leert sich
 * schneller als eine, die pro Token zahlt.
 *
 * ## Der Unterschied zu `caracat.ts`, der auffallen muss
 *
 * Bei Caracat steht der Schluessel des Aufrufers **nur** im ausgehenden Header,
 * nie im Rumpf -- eine Pruefung haelt das fest. Hier geht er zusaetzlich als
 * `secrets.HF_TOKEN` in den Rumpf, weil der Container sonst nichts hochladen
 * koennte; das ist der einzige von Hugging Face vorgesehene Weg, einem Job ein
 * Geheimnis mitzugeben. Er geht dabei an **dieselbe** Gegenstelle, die ihn
 * ohnehin im Header sieht, und an keine andere.
 *
 * Die Pruefung ist deshalb nicht schwaecher, sondern anders: der Schluessel darf
 * in `secrets` stehen und **nirgendwo sonst** -- nicht in `environment`, nicht
 * im `command`, nicht in den `labels`, nicht in der Antwort an den Aufrufer.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";

/**
 * Die eine Adresse, mit der dieser Teil des Servers spricht. Konstante, kein
 * Parameter -- dieselbe Regel wie in `caracat.ts`, aus demselben Grund.
 */
const HF = "https://huggingface.co";

/**
 * Das Skript, das der Job ausfuehrt. Auch das eine Konstante: ein Parameter,
 * der eine Skript-URL aufnaehme, waere "fuehre beliebigen Code auf dem Konto des
 * Aufrufers aus" -- die teuerste Form eines offenen Proxys, die es gibt.
 *
 * `refs/heads/main` statt nur `main`, damit die Adresse eindeutig auf einen
 * Branch zeigt und nicht auf einen gleichnamigen Tag.
 */
const SCRIPT =
  "https://raw.githubusercontent.com/Pheonix-Studio-cat/3d-ai-plugin/" +
  "refs/heads/main/jobs/generate_3d.py";

/**
 * Dieselbe Datei, nur zum Anschauen. Getrennt hingeschrieben statt aus `SCRIPT`
 * zusammengerechnet: eine Adresse, die aus einer anderen abgeleitet wird, ist
 * genau dann falsch, wenn sich eine von beiden aendert.
 */
const SCRIPT_SOURCE =
  "https://github.com/Pheonix-Studio-cat/3d-ai-plugin/blob/main/jobs/generate_3d.py";

/**
 * Das Image, in dem das Skript laeuft. `uv run <URL>` installiert die
 * Abhaengigkeiten aus dem PEP-723-Kopf des Skripts und fuehrt es aus; das ist
 * genau das, was `huggingface_hub.run_uv_job()` fuer eine Skript-URL baut.
 */
const UV_IMAGE = "ghcr.io/astral-sh/uv:python3.12-bookworm";

/** Das Modell, das dieser Server fahrt, und woher es kommt. */
const MODEL = {
  id: "Chinook416/3d-gen-1",
  upstream: "MarcusLoren/MeshGPT-preview",
  task: "text-to-3d",
  licence: "Apache-2.0",
  attribution:
    "3d-gen-1 is a copy of MeshGPT-preview by MarcusLoren, built on " +
    "meshgpt-pytorch by Phil Wang (lucidrains), after the MeshGPT paper " +
    "(arXiv:2311.15475).",
  trained_on:
    "4k models of at most 250 triangles, 800 text labels, per the model card. " +
    "Single everyday objects -- 'chair', 'table', 'lamp' -- are what it was " +
    "trained for; anything more complex is outside it.",
} as const;

/**
 * Die Maschinen, die gewaehlt werden duerfen -- eine feste Liste, keine freie
 * Zeichenkette.
 *
 * Hugging Face bietet bis hinauf zu acht H200. Die stehen hier nicht drin: der
 * Aufrufer bezahlt zwar selbst, aber ein Tippfehler in einem Werkzeug, das nach
 * Minuten abrechnet, soll hoechstens Kleingeld kosten und nicht ein Vielfaches.
 * Ein 184M-Parameter-Transformer braucht ohnehin keine H200.
 *
 * Die Preise stehen absichtlich nicht hier. Sie aendern sich, und eine Zahl im
 * Quelltext, die keiner nachfuehrt, ist eine Falschaussage mit Verfallsdatum.
 * Die Liste mit den aktuellen Preisen: https://huggingface.co/docs/hub/jobs-pricing
 */
const FLAVORS = ["cpu-basic", "t4-small", "t4-medium", "l4x1", "a10g-small"] as const;

/** Voreinstellung: die kleinste GPU. Die Modellkarte nennt 40 Dreiecke/s auf einer 3060. */
const DEFAULT_FLAVOR = "t4-small";

/**
 * Nach dieser Zeit bricht Hugging Face den Job ab. Ohne eigenen Wert waeren es
 * 30 Minuten. Zwanzig reichen fuer Installation, Modell-Download und ein paar
 * Objekte -- und begrenzen, was ein vergessener Job kosten kann.
 */
const TIMEOUT_SECONDS = 20 * 60;

/** Mehr als das ist kein Prompt fuer ein Modell mit 800 gelernten Bezeichnungen. */
const MAX_PROMPT_CHARS = 200;

/** Wie viele Objekte ein Lauf hoechstens erzeugt. */
const MAX_OBJECTS = 8;

/** Dorthin legt der Job die Ergebnisse, wenn der Aufrufer nichts anderes sagt. */
const DEFAULT_OUTPUT_REPO_NAME = "3d-gen-1-output";

/** Ein Repo-Bezeichner, nichts anderes. Kein Schraegstrich zu viel, kein `..`, kein Host. */
const REPO_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;

/** Eine Job-Kennung, wie Hugging Face sie vergibt: hexadezimal, sonst nichts. */
const JOB_ID = /^[A-Fa-f0-9]{8,64}$/;

/**
 * Der Schluessel des Aufrufers aus dem Authorization-Header.
 *
 * Dieselbe Funktion wie in `caracat.ts`, absichtlich dort importiert statt hier
 * nachgebaut: zwei Kopien einer Schluessel-Lesefunktion driften, und die, die
 * driftet, ist die mit der Luecke.
 */
import { readCallerKey } from "./caracat";

/** Die Standardantwort, wenn kein Schluessel mitkam. */
function noKey() {
  return {
    isError: true as const,
    content: [
      {
        type: "text" as const,
        text:
          "This server holds no Hugging Face token of its own, on purpose. " +
          "Generating a mesh rents a GPU by the second, and it is rented on " +
          "the account whose token arrives here -- so send your own, as an " +
          "Authorization: Bearer header. It needs write access to your " +
          "namespace, and the account needs a positive credit balance " +
          "(https://huggingface.co/settings/billing).",
      },
    ],
  };
}

/** Aus einem Fehler eine Antwort machen, ohne je den Schluessel mitzunehmen. */
function failed(error: unknown) {
  return {
    isError: true as const,
    content: [
      { type: "text" as const, text: error instanceof Error ? error.message : String(error) },
    ],
  };
}

/**
 * Der Namensraum des Aufrufers.
 *
 * Der Job wird dort angelegt und dort abgerechnet. Ihn erfragen statt ihn sich
 * sagen zu lassen ist wichtig: ein Parameter dafuer hiesse, dass ein Aufrufer
 * einen Job im Namensraum eines anderen starten koennte -- er wuerde zwar am
 * fehlenden Schreibrecht scheitern, aber ein Werkzeug soll nicht erst an der
 * Gegenstelle scheitern, wenn es gar nicht erst fragen kann.
 */
async function whoami(callerKey: string): Promise<string> {
  const response = await fetch(`${HF}/api/whoami-v2`, {
    headers: { Authorization: `Bearer ${callerKey}` },
  });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        "Hugging Face refused the token. Running Jobs needs a token with " +
          "write access to your namespace.",
      );
    }
    throw new Error(`Hugging Face did not say who the token belongs to (${response.status}).`);
  }
  const payload = (await response.json()) as { name?: string };
  const name = payload.name ?? "";
  if (!name) throw new Error("Hugging Face answered without a namespace name.");
  return name;
}

/** Ein Fehler der Jobs-API, in Worten statt in Statuscodes. */
async function jobsError(response: Response, what: string): Promise<Error> {
  let detail = "";
  try {
    // Der Rumpf kann den Schluessel nicht enthalten: er stand im Header und in
    // `secrets`, und Hugging Face spiegelt `secrets` nicht zurueck. Trotzdem
    // gekuerzt -- eine Fehlermeldung ist kein Protokoll.
    detail = (await response.text()).slice(0, 300);
  } catch {
    /* der Rumpf ist verzichtbar */
  }
  if (response.status === 401 || response.status === 403) {
    return new Error(
      "Hugging Face refused the token. Running Jobs needs write access to " +
        "your own namespace.",
    );
  }
  if (response.status === 402) {
    return new Error(
      "That Hugging Face account has no credit left. Jobs are pay-as-you-go " +
        "and need a positive balance: https://huggingface.co/settings/billing",
    );
  }
  if (response.status === 404) {
    return new Error(`${what}: Hugging Face does not know that job (404).`);
  }
  return new Error(`${what} failed (${response.status}).${detail ? " " + detail : ""}`);
}

/** Ein Name, den man in einer Job-Liste wiedererkennt. */
function jobName(prompt: string): string {
  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return `3d-gen-1-${slug || "mesh"}`;
}

/** Der Dateiname, unter dem das Ergebnis landet. */
function outputPath(prompt: string): string {
  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  // Doppelpunkte weg: sie sind in einem Repo-Pfad erlaubt, aber auf Windows
  // nicht in einem Dateinamen, und die .obj will jemand herunterladen.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");
  return `generated/${stamp}-${slug || "mesh"}.obj`;
}

/** `list_3d_models` -- die Auskunft, die keinen Schluessel braucht. */
function registerList(server: McpServer) {
  server.registerTool(
    "list_3d_models",
    {
      description:
        "What the 3d-gen-1 text-to-3D model is, where it comes from, what it " +
        "can and cannot generate, and how running it is billed. Needs no key: " +
        "it calls nothing.",
      // Kein inputSchema -- das Werkzeug nimmt nichts entgegen. Ein leeres
      // Objekt faellt hier zwischen die beiden Ueberladungen des SDK.
    },
    async () => {
      const text = [
        `${MODEL.id} — ${MODEL.task}, ${MODEL.licence}`,
        "",
        MODEL.attribution,
        "",
        `Trained on: ${MODEL.trained_on}`,
        "",
        "How it runs: no inference provider serves text-to-3d, and this repo is",
        `a copy of ${MODEL.upstream} rather than a card, which no provider serves`,
        "either. So generate_3d does not call an endpoint: it starts a Hugging",
        "Face Job — a rented GPU that runs a script and shuts down — in YOUR",
        "namespace, on YOUR credit balance, billed by the second. This server",
        "holds no token and pays for nothing.",
        "",
        "The script the Job runs is public:",
        SCRIPT_SOURCE,
      ].join("\n");

      return {
        structuredContent: {
          model: MODEL.id,
          upstream: MODEL.upstream,
          task: MODEL.task,
          licence: MODEL.licence,
          attribution: MODEL.attribution,
          trained_on: MODEL.trained_on,
          served_by_inference_providers: false,
          runs_as: "huggingface-job",
          script: SCRIPT,
          image: UV_IMAGE,
          flavors: FLAVORS,
          default_flavor: DEFAULT_FLAVOR,
          billing:
            "Every generate_3d call rents a GPU on the caller's own Hugging " +
            "Face account. This server holds no token.",
          weights:
            `These are not new weights: ${MODEL.id} is a copy of ` +
            `${MODEL.upstream}, byte for byte.`,
        },
        content: [{ type: "text", text }],
      };
    },
  );
}

/** `generate_3d` -- startet den Job und kommt sofort zurueck. */
function registerGenerate(server: McpServer, request: Request | undefined) {
  server.registerTool(
    "generate_3d",
    {
      description:
        "Generate a 3D mesh (.obj) from a short text prompt with 3d-gen-1. " +
        "Starts a Hugging Face Job on YOUR account and returns immediately " +
        "with a job id — generating takes minutes, so poll get_3d_job for the " +
        "result. Rents a GPU by the second, billed to the Hugging Face token " +
        "you send as a Bearer token; this server holds no key of its own. " +
        "The model knows single everyday objects ('chair', 'table', 'lamp'); " +
        "complex scenes are outside what it was trained on.",
      inputSchema: {
        prompt: z
          .string()
          .min(1)
          .max(MAX_PROMPT_CHARS)
          .describe(
            "What to generate. One object, named plainly — 'chair', 'wooden " +
              "table', 'ladder'. Several objects: separate them with commas.",
          ),
        temperature: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("0 is the model card's own example and the steadiest. Higher varies more. Default 0."),
        flavor: z
          .enum(FLAVORS)
          .optional()
          .describe(
            `Which machine to rent. Default ${DEFAULT_FLAVOR}. cpu-basic works ` +
              "but the model card puts CPU at roughly a quarter of GPU speed.",
          ),
        output_repo: z
          .string()
          .optional()
          .describe(
            "Dataset repo for the .obj, as owner/name. Defaults to " +
              `<your-namespace>/${DEFAULT_OUTPUT_REPO_NAME}, created private if ` +
              "it does not exist.",
          ),
      },
    },
    async ({ prompt, temperature, flavor, output_repo }) => {
      const callerKey = readCallerKey(request);
      if (!callerKey) return noKey();

      // Ein Prompt, der mit `-` beginnt, wuerde in der Kommandozeile des Jobs
      // als Schalter gelesen. Es gibt keine Shell dazwischen -- das Kommando ist
      // ein Array -- aber argparse im Skript sieht nur die Zeichenkette.
      const cleaned = prompt.trim();
      if (cleaned.startsWith("-")) {
        return failed(new Error("A prompt cannot start with '-': the job would read it as a flag."));
      }
      if (/[\u0000-\u001f\u007f]/.test(cleaned)) {
        return failed(new Error("A prompt cannot contain control characters."));
      }
      const objects = cleaned.split(",").map((o) => o.trim()).filter(Boolean);
      if (objects.length === 0) return failed(new Error("The prompt is empty."));
      if (objects.length > MAX_OBJECTS) {
        return failed(
          new Error(`At most ${MAX_OBJECTS} objects per run; that prompt names ${objects.length}.`),
        );
      }

      if (output_repo !== undefined && !REPO_ID.test(output_repo)) {
        return failed(
          new Error("output_repo has to look like owner/name — a repo id, not a URL or a path."),
        );
      }

      try {
        const namespace = await whoami(callerKey);
        const repo = output_repo ?? `${namespace}/${DEFAULT_OUTPUT_REPO_NAME}`;
        const path = outputPath(cleaned);

        // Genau das Kommando, das `huggingface_hub.run_uv_job()` fuer eine
        // Skript-URL baut: `uv run <url> <args>`. Ein Array, keine Shell --
        // die Argumente koennen sich nicht zu einem Befehl zusammensetzen.
        const command = [
          "uv",
          "run",
          SCRIPT,
          "--model",
          MODEL.id,
          "--prompt",
          cleaned,
          "--temperature",
          String(temperature ?? 0),
          "--output-repo",
          repo,
          "--output-path",
          path,
        ];

        const response = await fetch(`${HF}/api/jobs/${namespace}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${callerKey}`,
          },
          body: JSON.stringify({
            command,
            arguments: [],
            // Leer, und das ist Absicht: der Schluessel gehoert nach `secrets`,
            // damit Hugging Face ihn als Geheimnis behandelt und nicht in
            // Job-Uebersichten anzeigt.
            environment: {},
            secrets: { HF_TOKEN: callerKey },
            flavor: flavor ?? DEFAULT_FLAVOR,
            timeoutSeconds: TIMEOUT_SECONDS,
            labels: { name: jobName(cleaned) },
            dockerImage: UV_IMAGE,
          }),
        });

        if (!response.ok) throw await jobsError(response, "Starting the job");

        const job = (await response.json()) as {
          id?: string;
          url?: string;
          status?: { stage?: string };
        };
        if (!job.id) throw new Error("Hugging Face started something, but returned no job id.");

        const resultUrl = `${HF}/datasets/${repo}/resolve/main/${path}`;

        return {
          structuredContent: {
            job_id: job.id,
            job_url: job.url ?? `${HF}/jobs/${namespace}/${job.id}`,
            stage: job.status?.stage ?? "unknown",
            namespace,
            model: MODEL.id,
            prompt: cleaned,
            objects,
            flavor: flavor ?? DEFAULT_FLAVOR,
            output_repo: repo,
            output_path: path,
            result_url: resultUrl,
            billed_to: namespace,
            attribution: MODEL.attribution,
          },
          content: [
            {
              type: "text",
              text: [
                `Started job ${job.id} on ${flavor ?? DEFAULT_FLAVOR}, in your namespace (${namespace}).`,
                `It is rented by the second and billed to that account.`,
                "",
                `Watch it:   ${job.url ?? `${HF}/jobs/${namespace}/${job.id}`}`,
                `Poll it:    get_3d_job with job_id ${job.id}`,
                `Result at:  ${resultUrl}`,
                "",
                "Expect minutes, not seconds: the job installs meshgpt-pytorch,",
                "downloads the weights and only then generates.",
                "",
                "---",
                MODEL.attribution,
              ].join("\n"),
            },
          ],
        };
      } catch (error) {
        return failed(error);
      }
    },
  );
}

/** `get_3d_job` -- wo steht der Job, und wo liegt das Ergebnis. */
function registerStatus(server: McpServer, request: Request | undefined) {
  server.registerTool(
    "get_3d_job",
    {
      description:
        "How a generate_3d job is doing, and where its .obj is once it is " +
        "done. Reads your own Hugging Face namespace with the Bearer token " +
        "you send; costs nothing.",
      inputSchema: {
        job_id: z.string().min(1).describe("The job id generate_3d returned."),
      },
    },
    async ({ job_id }) => {
      const callerKey = readCallerKey(request);
      if (!callerKey) return noKey();
      if (!JOB_ID.test(job_id)) {
        return failed(new Error("That is not a job id — they are hexadecimal."));
      }

      try {
        const namespace = await whoami(callerKey);
        const response = await fetch(`${HF}/api/jobs/${namespace}/${job_id}`, {
          headers: { Authorization: `Bearer ${callerKey}` },
        });
        if (!response.ok) throw await jobsError(response, "Reading the job");

        const job = (await response.json()) as {
          id?: string;
          url?: string;
          command?: string[];
          status?: { stage?: string; message?: string | null };
        };
        const stage = job.status?.stage ?? "unknown";

        // Wohin das Skript geschrieben hat, steht in seinem eigenen Kommando.
        // Das ist die einzige Quelle, die nicht driften kann: dieser Server
        // haelt keinen Zustand, und er soll auch keinen halten.
        const command = job.command ?? [];
        const argOf = (flag: string) => {
          const i = command.indexOf(flag);
          return i >= 0 && i + 1 < command.length ? command[i + 1] : "";
        };
        const repo = argOf("--output-repo");
        const path = argOf("--output-path");
        const resultUrl = repo && path ? `${HF}/datasets/${repo}/resolve/main/${path}` : "";

        const done = stage === "COMPLETED";
        const lines = [`Job ${job_id}: ${stage}.`];
        if (job.status?.message) lines.push(job.status.message);
        if (done && resultUrl) {
          lines.push("", `The mesh: ${resultUrl}`);
        } else if (done) {
          lines.push("", "Finished, but the job did not record where it wrote.");
        } else if (stage === "ERROR") {
          lines.push(
            "",
            `The logs say why: ${job.url ?? `${HF}/jobs/${namespace}/${job_id}`}`,
          );
        } else {
          lines.push("", "Still working. Ask again in a minute.");
        }

        return {
          structuredContent: {
            job_id,
            stage,
            done,
            message: job.status?.message ?? null,
            job_url: job.url ?? `${HF}/jobs/${namespace}/${job_id}`,
            output_repo: repo || null,
            output_path: path || null,
            result_url: done && resultUrl ? resultUrl : null,
          },
          content: [{ type: "text", text: lines.join("\n") }],
        };
      } catch (error) {
        return failed(error);
      }
    },
  );
}

/** `cancel_3d_job` -- das Werkzeug, das Geld spart. */
function registerCancel(server: McpServer, request: Request | undefined) {
  server.registerTool(
    "cancel_3d_job",
    {
      description:
        "Stop a generate_3d job that is still running. A job rents its " +
        "machine until it finishes or times out, so cancelling a job you no " +
        "longer want is the one call here that saves money.",
      inputSchema: {
        job_id: z.string().min(1).describe("The job id generate_3d returned."),
      },
    },
    async ({ job_id }) => {
      const callerKey = readCallerKey(request);
      if (!callerKey) return noKey();
      if (!JOB_ID.test(job_id)) {
        return failed(new Error("That is not a job id — they are hexadecimal."));
      }

      try {
        const namespace = await whoami(callerKey);
        const response = await fetch(`${HF}/api/jobs/${namespace}/${job_id}/cancel`, {
          method: "POST",
          headers: { Authorization: `Bearer ${callerKey}` },
        });
        if (!response.ok) throw await jobsError(response, "Cancelling the job");

        return {
          structuredContent: { job_id, cancelled: true },
          content: [{ type: "text", text: `Job ${job_id} cancelled. The machine is released.` }],
        };
      } catch (error) {
        return failed(error);
      }
    },
  );
}

/**
 * Haengt die 3D-Werkzeuge an einen McpServer.
 *
 * `request` ist die urspruengliche HTTP-Anfrage (`ctx.requestInfo`). Sie kann
 * fehlen -- ueber stdio gibt es keine -- und dann fehlt auch der Schluessel;
 * die Werkzeuge sagen das dann in Worten.
 */
export function registerThreeDTools(server: McpServer, request: Request | undefined) {
  registerList(server);
  registerGenerate(server, request);
  registerStatus(server, request);
  registerCancel(server, request);
}

/** Nur fuer die Pruefungen -- damit sie nicht ihre eigene Kopie der Tabelle halten. */
export const THREED_MODEL = MODEL;
export const THREED_HOST = HF;
export const THREED_SCRIPT = SCRIPT;
export const THREED_IMAGE = UV_IMAGE;
export const THREED_FLAVORS = FLAVORS;
