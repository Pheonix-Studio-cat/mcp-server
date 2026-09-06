/**
 * Caracat ueber MCP.
 *
 * Drei Assistenten auf drei Basismodellen, als Werkzeuge, damit ein anderes
 * KI-System sie aufrufen kann: Claude, VS Code, der MCP-Inspector, jeder
 * Client. Caracat ist hier der Server.
 *
 * ## Wer bezahlt
 *
 * **Der Aufrufer, mit seinem eigenen Hugging-Face-Schluessel.** MCP ueber
 * Streamable HTTP ist gewoehnliches HTTP, also kommt der Authorization-Header
 * des Clients hier an und wird fuer den Aufruf an Hugging Face benutzt.
 *
 * Das ist keine Bequemlichkeitsentscheidung, sondern die einzige, die sich
 * halten laesst: eine oeffentliche MCP-Adresse, die bezahlte Modelle auf dem
 * Schluessel des Betreibers aufruft, ist eine offene Brieftasche. Wer die
 * Adresse kennt, gibt fremdes Geld aus.
 *
 * Daraus folgt angenehm viel:
 *
 * - **kein Geheimnis in diesem Worker** -- nichts, was auslaufen koennte;
 * - **kein Zaehler** und damit keine zweite Kopie des KV-Rennens, das im
 *   Website-Repo dokumentiert ist;
 * - die Adresse darf oeffentlich sein.
 *
 * ## Was hier nicht steht
 *
 * Kein Werkzeug, das eine Adresse entgegennimmt und abruft. Die Hosts sind
 * Konstanten. Ein Parameter, der einen Host aufnimmt, macht aus einem schmalen
 * Werkzeug einen offenen Proxy -- dieselbe Regel wie in `github.py` des
 * Modell-Repos, aus demselben Grund.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { PERSONAS } from "./personas.generated";

/** Die eine Adresse, an die dieser Server spricht. Konstante, kein Parameter. */
const ENDPOINT = "https://router.huggingface.co/v1/chat/completions";

/**
 * Die drei Assistenten.
 *
 * `model` ist jeweils das **Upstream**-Modell, nie eine Kopie davon unter dem
 * Konto dieses Projekts. Inference Providers bedienen das Original; eine Kopie
 * bedient niemand, und ein Aufruf darauf scheitert aus einem Grund, den man dem
 * Fehler nicht ansieht. Im Caracat-Projekt ist das dreimal passiert.
 */
const ASSISTANTS = {
  chat: {
    name: "Caracat AI",
    model: "openai/gpt-oss-20b",
    temperature: 0.6, // ein allgemeiner Assistent bei 0.2 antwortet wie ein Formular
    attribution: "Caracat AI is based on gpt-oss-20b by OpenAI.",
    licence: "Apache-2.0",
    persona: "chat",
    good_for: "everything: thinking, writing, planning, learning, deciding",
  },
  code: {
    name: "Caracat Code",
    model: "Qwen/Qwen3-Coder-Next",
    temperature: 0.2, // Code-Arbeit will das wahrscheinlichste naechste Token
    attribution: "Caracat Code is based on Qwen3-Coder-Next by Qwen.",
    licence: "Apache-2.0",
    persona: "code",
    good_for: "programming only -- it says so and stays there",
  },
  pro: {
    name: "Caracat Pro",
    model: "deepseek-ai/DeepSeek-V3.1",
    temperature: 0.6,
    attribution: "Caracat Pro is based on DeepSeek-V3.1 by DeepSeek.",
    licence: "MIT",
    persona: "pro",
    good_for:
      "the hard questions -- long reasoning, several constraints at once. " +
      "Far larger than the other two, and it costs accordingly",
  },
} as const;

type AssistantKey = keyof typeof ASSISTANTS;

/** Deckel fuer die ganze Antwort, Ueberlegen eingeschlossen. */
const ANSWER_TOKENS = 2048;
const DEEP_ANSWER_TOKENS = 8192;

/**
 * Eine Frage laenger als das ist keine Frage mehr, sondern ein Fass. Der
 * Aufrufer bezahlt zwar selbst, aber ein Werkzeug ohne Grenze laedt dazu ein,
 * versehentlich ein halbes Repository hineinzukippen.
 */
const MAX_QUESTION_CHARS = 24000;

/**
 * Wird nur bei `deep` mitgeschickt, und nur fuer diese eine Anfrage -- die
 * Persoenlichkeitsdateien werden nicht angefasst.
 *
 * Derselbe Text wie in der Website und in ihrer Function. Dreifach vorhanden,
 * weil es kein Modul gibt, das alle drei laden: die Function laeuft auf
 * Cloudflare Pages, dieser Worker anderswo, die Seite im Browser. Aendert sich
 * einer, aendern sich alle.
 */
const DEEP_INSTRUCTION = [
  "For this answer, work it through rather than answering from the first",
  "thing that comes to mind:",
  "",
  "- Say what the question is actually asking, if that is not obvious.",
  "- Name the assumptions you are making, especially the ones you cannot check.",
  "- Where there is more than one reasonable approach, weigh them rather than",
  "  picking silently.",
  "- Say plainly which parts you are confident about and which you are not.",
  "",
  "Take the space you need. Do not pad -- length is not thoroughness.",
].join("\n");

/**
 * Den Schluessel aus dem Authorization-Header des Aufrufers lesen.
 *
 * Er wird nie protokolliert, nie in eine Antwort geschrieben und nie in eine
 * Fehlermeldung aufgenommen. Die einzige Stelle, an der er auftaucht, ist der
 * ausgehende Header.
 */
export function readCallerKey(request: Request | undefined): string {
  const header = request?.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : "";
}

/** Die Persoenlichkeit, gefolgt von der Unterhaltung. */
function outgoing(assistant: (typeof ASSISTANTS)[AssistantKey], question: string, deep: boolean) {
  const persona = PERSONAS[assistant.persona] ?? "";
  // In eine einzige System-Nachricht gefaltet statt als zweite angehaengt:
  // die meisten OpenAI-kompatiblen Endpunkte nehmen mehrere, nicht alle, und
  // die, die es nicht tun, scheitern auf verwirrende Weise.
  const system = deep && persona ? `${persona}\n\n${DEEP_INSTRUCTION}` : deep ? DEEP_INSTRUCTION : persona;

  const messages: Array<{ role: string; content: string }> = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: question });
  return messages;
}

/** Ein Aufruf, eine Antwort. Kein Streaming -- ein Werkzeug gibt ein Ergebnis. */
async function ask(
  key: AssistantKey,
  question: string,
  deep: boolean,
  callerKey: string,
): Promise<string> {
  const assistant = ASSISTANTS[key];

  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${callerKey}`,
    },
    body: JSON.stringify({
      model: assistant.model,
      messages: outgoing(assistant, question, deep),
      stream: false,
      temperature: assistant.temperature,
      max_tokens: deep ? DEEP_ANSWER_TOKENS : ANSWER_TOKENS,
    }),
  });

  if (!response.ok) {
    // Der Text des Anbieters wird gekuerzt weitergegeben, damit ein Aufrufer
    // etwas zum Nachschauen hat. Der Schluessel steht nicht darin -- er stand
    // im Header, nicht im Rumpf.
    let detail = "";
    try {
      detail = (await response.text()).slice(0, 300);
    } catch {
      /* der Rumpf ist verzichtbar */
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        "Hugging Face refused the key. A token needs the Inference Providers " +
          "permission, and the provider has to be enabled on that account.",
      );
    }
    if (response.status === 402) {
      throw new Error("That Hugging Face account is out of inference credit.");
    }
    throw new Error(`The provider refused the request (${response.status}).${detail ? " " + detail : ""}`);
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const answer = payload.choices?.[0]?.message?.content ?? "";
  if (!answer.trim()) throw new Error("The model returned nothing.");
  return answer;
}

/**
 * Die Zuschreibung faehrt mit jeder Antwort mit.
 *
 * Regel eins des Projekts: sie ist nie weg. Auf einer Seite steht sie im Kopf,
 * hier gehoert sie in das Ergebnis -- ein Werkzeug hat keinen Kopf, und eine
 * Antwort, die durch drei Systeme weitergereicht wird, verliert sonst unterwegs,
 * von wem das Modell stammt.
 */
function withAttribution(assistant: (typeof ASSISTANTS)[AssistantKey], answer: string): string {
  return `${answer}\n\n---\n${assistant.attribution}`;
}

/** Registriert `ask_caracat_ai`, `ask_caracat_code`, `ask_caracat_pro`. */
function registerAsk(server: McpServer, key: AssistantKey, request: Request | undefined) {
  const assistant = ASSISTANTS[key];

  server.registerTool(
    `ask_caracat_${key === "chat" ? "ai" : key}`,
    {
      description:
        `Ask ${assistant.name}, ${assistant.attribution.replace(/^.*? is /, "")} ` +
        `Good for: ${assistant.good_for}. ` +
        "Billed to the Hugging Face token you send as a Bearer token -- this " +
        "server holds no key of its own.",
      inputSchema: {
        question: z
          .string()
          .min(1)
          .max(MAX_QUESTION_CHARS)
          .describe("What to ask. Include the context it needs; there is no conversation history."),
        deep: z
          .boolean()
          .optional()
          .describe(
            "Work it through: a higher answer ceiling and an instruction to " +
              "name assumptions and weigh alternatives. Costs more.",
          ),
      },
    },
    async ({ question, deep }) => {
      const callerKey = readCallerKey(request);
      if (!callerKey) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                "This server has no Hugging Face key of its own, on purpose: a " +
                "public address spending someone else's credit is an open wallet. " +
                "Send your own token as an Authorization: Bearer header. A free " +
                "account is enough for the two smaller assistants.",
            },
          ],
        };
      }

      try {
        const answer = await ask(key, question, deep === true, callerKey);
        return {
          structuredContent: {
            assistant: assistant.name,
            base_model: assistant.model,
            attribution: assistant.attribution,
            deep: deep === true,
          },
          content: [{ type: "text", text: withAttribution(assistant, answer) }],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            { type: "text", text: error instanceof Error ? error.message : String(error) },
          ],
        };
      }
    },
  );
}

/** Registriert `list_assistants` -- die einzige Auskunft ohne Schluessel. */
function registerList(server: McpServer) {
  server.registerTool(
    "list_assistants",
    {
      description:
        "The Caracat assistants, their base models and what each is for. " +
        "Needs no key: it calls no model.",
      // Kein inputSchema: das Werkzeug nimmt nichts entgegen. Ein leeres
      // Objekt hier faellt zwischen die beiden Ueberladungen des SDK und
      // erzeugt einen Typfehler, der nichts mit der Sache zu tun hat.
    },
    async () => {
      const rows = (Object.keys(ASSISTANTS) as AssistantKey[]).map((key) => {
        const a = ASSISTANTS[key];
        return {
          tool: `ask_caracat_${key === "chat" ? "ai" : key}`,
          name: a.name,
          base_model: a.model,
          base_model_licence: a.licence,
          attribution: a.attribution,
          good_for: a.good_for,
        };
      });

      const text = rows
        .map(
          (r) =>
            `${r.name} (${r.tool})\n  base model: ${r.base_model} — ${r.base_model_licence}\n` +
            `  ${r.attribution}\n  for: ${r.good_for}`,
        )
        .join("\n\n");

      return {
        structuredContent: {
          assistants: rows,
          billing:
            "Every ask_* tool is billed to the Hugging Face token the caller " +
            "sends. This server holds no key.",
          weights:
            "None of these are Caracat weights. Each assistant is a personality " +
            "and an interface over someone else's model.",
        },
        content: [
          {
            type: "text",
            text:
              `${text}\n\n---\nNone of these are Caracat weights: each is a personality ` +
              `over someone else's model. Every ask_* tool is billed to the Hugging ` +
              `Face token you send.`,
          },
        ],
      };
    },
  );
}

/**
 * Haengt die Caracat-Werkzeuge an einen McpServer.
 *
 * `request` ist die urspruengliche HTTP-Anfrage, die das SDK der Factory
 * mitgibt (`ctx.requestInfo`). Sie kann fehlen -- ueber stdio gibt es keine --
 * und dann fehlt auch der Schluessel; die ask_*-Werkzeuge sagen das dann in
 * Worten, statt an einer undefinierten Stelle zu scheitern.
 */
export function registerCaracatTools(server: McpServer, request: Request | undefined) {
  registerList(server);
  for (const key of Object.keys(ASSISTANTS) as AssistantKey[]) {
    registerAsk(server, key, request);
  }
}

/** Nur fuer die Pruefungen -- damit sie nicht ihre eigene Kopie der Tabelle halten. */
export const CARACAT_ASSISTANTS = ASSISTANTS;
export const CARACAT_ENDPOINT = ENDPOINT;
