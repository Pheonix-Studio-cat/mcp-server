# my-mcp-server

Ein remote MCP-Server auf Cloudflare Workers. Nach dem Deploy bekommst du eine
oeffentliche Adresse wie

```
https://my-mcp-server.<dein-subdomain>.workers.dev/mcp
```

die du in Claude, VS Code, im MCP Inspector oder in jedem anderen MCP-Client
eintragen kannst.

## Caracat

Dieser Server stellt die drei Caracat-Assistenten als Werkzeuge bereit, damit
ein anderes KI-System sie aufrufen kann.

| Werkzeug | Modell | Wofuer |
| --- | --- | --- |
| `list_assistants` | — | Namen, Basismodelle, Zuschreibung. Braucht keinen Schluessel |
| `ask_caracat_ai` | `openai/gpt-oss-20b` | alles: denken, schreiben, planen, lernen, entscheiden |
| `ask_caracat_code` | `Qwen/Qwen3-Coder-Next` | nur Programmierung |
| `ask_caracat_pro` | `deepseek-ai/DeepSeek-V3.1` | die schweren Fragen — und entsprechend teurer |

Jedes `ask_*` nimmt `question` und optional `deep` (mehr Platz zum Ausholen,
kostet mehr). Es gibt keinen Gespraechsverlauf: jede Frage steht fuer sich.

### Der Schluessel kommt vom Aufrufer

**Dieser Server haelt keinen eigenen Hugging-Face-Schluessel.** Jeder Aufruf
wird auf den Token abgerechnet, den der Client als `Authorization: Bearer`
mitschickt.

Der Grund steht in `SECURITY.md`: eine oeffentliche Adresse, die bezahlte
Modelle auf dem Guthaben des Betreibers aufruft, ist eine offene Brieftasche.
Ein kostenloses Hugging-Face-Konto reicht fuer die beiden kleineren
Assistenten.

In einem Client sieht das etwa so aus:

```json
{
  "mcpServers": {
    "caracat": {
      "url": "https://my-mcp-server.<dein-subdomain>.workers.dev/mcp",
      "headers": { "Authorization": "Bearer hf_..." }
    }
  }
}
```

### Die Persoenlichkeiten

Die drei System-Prompts liegen **nicht** in diesem Repo, sondern in `prompts/`
des Modell-Repos — eine Quelle, keine Kopie, die driftet. `npm run deploy` holt
sie vorher (`scripts/fetch-personas.mjs`) und **bricht ab**, wenn eine fehlt:
ein Server ohne sie waere kein Caracat, sondern ein nackter Modellaufruf.

### Pruefen ohne zu deployen

```bash
npm run typecheck
npm run check              # 42 Pruefungen gegen den echten Handler
node checks/counterproof.mjs   # bricht ihn absichtlich, sieben Mal
```

Beides ohne Netz zum Anbieter: Hugging Face wird gestubbt, nichts kostet Geld.

## Stack

| Baustein | Zweck |
| --- | --- |
| `agents` (`createMcpHandler`) | Streamable-HTTP-Transport, stateless |
| `@modelcontextprotocol/server` | MCP SDK v2 (`McpServer`, `registerTool`) |
| `zod` | Schema und Validierung der Tool-Parameter |
| `wrangler` | lokale Entwicklung und Deploy |

## Setup

```bash
npm install
npx wrangler login      # einmalig, oeffnet den Browser
```

## Lokal entwickeln

```bash
npm run dev
```

Der Server laeuft dann auf `http://localhost:8787`, der MCP-Endpoint ist
`http://localhost:8787/mcp`.

Schnelltest ohne Client:

```bash
curl -s -X POST http://localhost:8787/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

Interaktiv mit dem offiziellen Inspector:

```bash
npx @modelcontextprotocol/inspector@latest
# dort http://localhost:8787/mcp eintragen und "Connect" waehlen
```

## Deployen

```bash
npm run deploy
```

Wrangler gibt am Ende die URL aus. Der MCP-Endpoint ist diese URL plus `/mcp`.

Den Namen des Workers (und damit den ersten Teil der URL) aenderst du in
`wrangler.jsonc` unter `name`.

## In einem Client eintragen

Clients mit Unterstuetzung fuer remote MCP tragen die URL direkt ein. Fuer
Clients, die nur lokale Server koennen, gibt es den `mcp-remote`-Proxy:

```json
{
  "mcpServers": {
    "my-mcp-server": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote@latest",
        "https://my-mcp-server.<dein-subdomain>.workers.dev/mcp"
      ]
    }
  }
}
```

## Enthaltene Tools

Vier Beispiel-Tools, die die ueblichen Muster zeigen:

| Tool | Zeigt |
| --- | --- |
| `greet` | ein optionaler Parameter, einfachster Fall |
| `add` | mehrere Pflichtparameter und `structuredContent` |
| `get_time` | Logik ohne externen Aufruf plus Fehlerpfad ueber `isError` |
| `fetch_url` | echter ausgehender `fetch` mit try/catch und Kuerzung |

## Eigene Tools ergaenzen

Alles passiert in `src/index.ts` in `createServer()`:

```ts
server.registerTool(
  "mein_tool",
  {
    description: "Was das Tool tut. Das liest das Modell.",
    inputSchema: {
      wert: z.string().describe("Wofuer der Parameter gut ist"),
    },
  },
  async ({ wert }) => ({
    content: [{ type: "text", text: `Ergebnis: ${wert}` }],
  }),
);
```

Zwei Dinge sind wichtig:

- `createServer` wird pro Request aufgerufen. Keine globale Server-Instanz
  bauen und keinen fertigen Server an `createMcpHandler` uebergeben, sondern
  die Factory selbst.
- `description` und `.describe()` sind kein Kommentar, sondern das, woran das
  Modell erkennt, wann und wie es das Tool aufruft. Praezise formulieren.

Bei Fehlern nicht werfen, sondern `isError: true` mit einer verstaendlichen
Meldung zurueckgeben. Dann kann das Modell darauf reagieren.

## Bindings (KV, D1, R2)

Der Server laeuft bewusst ohne Bindings, damit `npm run deploy` sofort
durchlaeuft. Wenn du Zustand brauchst, zum Beispiel KV:

```bash
npx wrangler kv namespace create NOTES
```

Die ausgegebene ID in `wrangler.jsonc` eintragen (der Block ist dort schon
auskommentiert vorbereitet), dann `npx wrangler types` laufen lassen und
`env.NOTES` in den Tools verwenden.

## Authentifizierung

Der Server ist oeffentlich erreichbar. Wer die URL kennt, kann die Tools
aufrufen. Solange die Tools nur harmlose Dinge tun, ist das fuer den Anfang in
Ordnung. Sobald es um eigene Daten geht, brauchst du Auth. Zwei Wege:

- **Cloudflare Access** vor den Worker schalten, kein Code noetig.
- **OAuth im Worker** mit `@cloudflare/workers-oauth-provider`, braucht
  zusaetzlich einen KV-Namespace.

## Kosten

Der Workers-Free-Plan deckt 100'000 Requests pro Tag ab. Zum Ausprobieren und
fuer den privaten Gebrauch reicht das.
