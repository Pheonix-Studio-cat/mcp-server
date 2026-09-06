# my-mcp-server

Ein remote MCP-Server auf Cloudflare Workers. Nach dem Deploy bekommst du eine
oeffentliche Adresse wie

```
https://my-mcp-server.<dein-subdomain>.workers.dev/mcp
```

die du in Claude, VS Code, im MCP Inspector oder in jedem anderen MCP-Client
eintragen kannst.

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
