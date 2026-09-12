import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import { registerCaracatTools } from "./caracat";
import { registerThreeDTools } from "./threed";

/**
 * Baut fuer jeden Request eine frische McpServer-Instanz.
 *
 * Wichtig: Hier die Factory uebergeben, nicht eine globale Instanz --
 * der Handler ist stateless und erwartet pro Request einen eigenen Server.
 */
function createServer(request?: Request) {
  const server = new McpServer({
    name: "my-mcp-server",
    version: "1.0.0",
  });

  // Die Caracat-Assistenten. Sie brauchen die urspruengliche HTTP-Anfrage,
  // weil der Hugging-Face-Schluessel des Aufrufers in deren
  // Authorization-Header steht -- dieser Server haelt keinen eigenen.
  registerCaracatTools(server, request);

  // `3d-gen-1`: Text zu 3D-Mesh. Dieselbe Bezahl-Regel wie oben, aus demselben
  // Grund -- nur teurer, weil hier eine GPU nach Sekunden gemietet wird statt
  // Token abgerechnet zu werden. Auch diese Werkzeuge brauchen die
  // urspruengliche Anfrage, weil der Schluessel des Aufrufers darin steht.
  registerThreeDTools(server, request);

  // --- Tool 1: einfachster Fall, ein optionaler String-Parameter -----------
  server.registerTool(
    "greet",
    {
      description: "Gibt eine Begruessung zurueck.",
      inputSchema: {
        name: z.string().optional().describe("Name der begruesst werden soll"),
      },
    },
    async ({ name }) => ({
      content: [{ type: "text", text: `Hallo, ${name ?? "Welt"}!` }],
    }),
  );

  // --- Tool 2: mehrere Parameter + structuredContent ----------------------
  server.registerTool(
    "add",
    {
      description: "Addiert zwei Zahlen.",
      inputSchema: {
        a: z.number().describe("Erster Summand"),
        b: z.number().describe("Zweiter Summand"),
      },
    },
    async ({ a, b }) => {
      const sum = a + b;
      return {
        structuredContent: { a, b, sum },
        content: [{ type: "text", text: String(sum) }],
      };
    },
  );

  // --- Tool 3: Zeitzonen, ohne externen Aufruf ----------------------------
  server.registerTool(
    "get_time",
    {
      description:
        "Aktuelle Uhrzeit, optional in einer bestimmten IANA-Zeitzone (z.B. Europe/Zurich).",
      inputSchema: {
        timezone: z
          .string()
          .optional()
          .describe("IANA-Zeitzone, Standard: UTC"),
      },
    },
    async ({ timezone }) => {
      const tz = timezone ?? "UTC";
      try {
        const now = new Date();
        const formatted = new Intl.DateTimeFormat("de-CH", {
          dateStyle: "full",
          timeStyle: "long",
          timeZone: tz,
        }).format(now);
        return {
          structuredContent: { timezone: tz, iso: now.toISOString(), formatted },
          content: [{ type: "text", text: formatted }],
        };
      } catch {
        return {
          isError: true,
          content: [
            { type: "text", text: `Unbekannte Zeitzone: ${tz}` },
          ],
        };
      }
    },
  );

  // --- Tool 4 gab es hier einmal: fetch_url -----------------------------
  //
  // Es lud jede URL, die man ihm gab, ohne Authentifizierung. Solange dieser
  // Worker nicht deployt war, war das eine Uebung. Seit dem 2026-09-07 ist er
  // unter einer oeffentlichen Adresse erreichbar, und damit war es ein offener
  // Proxy: wer die Adresse kennt, laesst dieses Konto beliebige Seiten abrufen
  // -- interne Adressen und Metadaten-Endpunkte eingeschlossen -- mit der IP
  // und auf die Rechnung des Betreibers.
  //
  // Entfernt, nicht eingeschraenkt. Eine Erlaubnisliste waere denkbar, aber
  // sie waere eine Liste, die jemand pflegen muss; kein Werkzeug ist die
  // kleinere Angriffsflaeche.
  //
  // Falls so etwas je zurueckkommt: die Hosts gehoeren als Konstanten in den
  // Code, nie als Parameter. Dieselbe Regel wie fuer die GitHub-Hosts im
  // Modell-Repo, aus demselben Grund.

  return server;
}

// Die Factory bekommt pro Anfrage einen Kontext, in dem die urspruengliche
// HTTP-Anfrage steckt. Genau darueber kommt der Schluessel des Aufrufers zu
// den Caracat-Werkzeugen.
const mcpHandler = createMcpHandler((ctx) => createServer(ctx.requestInfo));

export default {
  fetch(request: Request, env: unknown, ctx: ExecutionContext) {
    const url = new URL(request.url);

    // Kleine Landingpage, damit der Worker im Browser nicht leer wirkt.
    if (url.pathname === "/") {
      return new Response(
        `my-mcp-server laeuft.\n\nMCP-Endpoint: ${url.origin}/mcp\n`,
        { headers: { "content-type": "text/plain; charset=utf-8" } },
      );
    }

    return mcpHandler(request, env, ctx);
  },
};
