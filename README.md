# my-mcp-server

Ein remote MCP-Server auf Cloudflare Workers. Nach dem Deploy bekommst du eine
oeffentliche Adresse wie

```
https://my-mcp-server.<dein-subdomain>.workers.dev/mcp
```

die du in Claude, VS Code, im MCP Inspector oder in jedem anderen MCP-Client
eintragen kannst.

Der Server stellt zwei Dinge bereit, die nichts miteinander zu tun haben ausser
der Adresse: die **drei Caracat-Assistenten** und den **Videoeditor**.

| | braucht einen Schluessel | ruft nach aussen |
| --- | --- | --- |
| Caracat | ja, den des Aufrufers | Hugging Face |
| Videoeditor | nein | nichts |

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
npm run check                  # beide Pruefsaetze
npm run check:caracat          # 42 Pruefungen gegen den echten Handler
npm run check:editor           # 46 Pruefungen der Videoeditor-Werkzeuge
node checks/counterproof.mjs   # bricht ihn absichtlich, sieben Mal
```

Beides ohne Netz zum Anbieter: Hugging Face wird gestubbt, nichts kostet Geld.

Die Editor-Pruefungen brauchen ueberhaupt kein Netz, und eine davon prueft
genau das: `fetch` wird gezaehlt und muss am Ende bei **null** stehen. Ein
Werkzeug, das unbemerkt anfinge, irgendwohin zu sprechen, waere eine Rechnung
und ein Datenabfluss zugleich.

Zwei weitere Pruefungen sind es wert, genannt zu werden, weil sie die
unangenehmsten Fehler abdecken: dass der Plan **im Link** derselbe ist wie der
in der Antwort (beides sieht sonst richtig aus, nur nicht zusammen), und dass
der Link auf **genau eine** Adresse zeigt und das die des Editors ist.

## Der Videoeditor

Der Editor selbst liegt in
[`cut-video-connector`](https://github.com/Pheonix-Studio-cat/cut-video-connector)
und laeuft vollstaendig im Browser. Was er nicht kann, ist: sich sagen lassen,
was geschnitten werden soll. Dafuer sind diese Werkzeuge da.

| Werkzeug | Wofuer |
| --- | --- |
| `video_editor` | die Adresse des Editors, was er kann und was er **nicht** kann |
| `build_cut_plan` | aus "nimm Sekunde 10 bis 20 raus" einen Schnittplan und einen Link bauen |
| `check_cut_plan` | einen Plan pruefen und sagen, was er tut -- plus frischen Link |
| `cut_plan_format` | das Format, ausgeschrieben, mit Beispiel |

**Keiner davon braucht einen Schluessel, und keiner ruft irgendetwas auf.** Es
ist Rechnen auf einem JSON-Objekt. Durch diesen Worker laeuft **nie ein
einziges Bild** -- geschnitten wird auf dem Geraet des Menschen, im Browser.

Der Ablauf:

1. Das Modell fragt, wie lang das Video ist und wo die interessanten Stellen
   liegen. Alles in Sekunden der **Originaldatei**.
2. `build_cut_plan` mit dem, was weg soll und was wegradiert werden soll.
3. Der Mensch bekommt den Link, oeffnet ihn, waehlt dieselbe Datei -- und der
   Schnitt ist schon da, zum Nachsehen, Nachbessern und Exportieren.

Dass es ein Link ist und keine Datei, ist kein Zufall: der Projektinhaber
arbeitet vom iPad und hat keine Kommandozeile. Was ein Terminal braeuchte, muss
etwas werden, das man antippt.

### Zwei Regeln, an denen die meisten Plaene scheitern

**Zeiten sind Sekunden der Originaldatei, nie Bildnummern.** Eine Bildnummer
bedeutet ohne Bildrate nichts, und Handyaufnahmen haben oft gar keine feste.

**Maskenkoordinaten sind Bruchteile des Bildes (0..1), nie Pixel.** Ein Plan,
der gegen eine kleine Vorschau gebaut wurde, muss auf dem 4K-Original dasselbe
bedeuten -- und ein Plan aus einem Werkzeugaufruf wurde geschrieben, ohne die
Datei je gesehen zu haben. Pixel sind der haeufigste Fehler, und `check_cut_plan`
sagt genau das, wenn er auftritt.

### Eine Kopie, die driften kann

`edl.js` im Editor-Repo ist die **massgebliche** Fassung des Formats. Die
Pruefung in `src/editor.ts` ist eine zweite Kopie, und eine zweite Kopie kann
auseinanderlaufen. Zwei Dinge machen das harmlos: in jedem Plan stehen `format`
und `version`, ein Unterschied faellt also auf statt missverstanden zu werden;
und jeder Plan wird im Editor **noch einmal** geprueft, bevor ein einziges Bild
angefasst wird. Ein Plan, den dieser Worker falsch gebaut hat, scheitert dort
laut -- nicht leise im Export.

(Dieselbe Doppelung, aus demselben Grund, wie `DEEP_INSTRUCTION` in
`caracat.ts`: es gibt kein Modul, das ein Cloudflare Worker und eine statische
Seite auf GitHub Pages beide laden koennen.)

### Was bewusst fehlt

**Kein Werkzeug, das einen ffmpeg-Befehl ausgibt.** Es waere naheliegend und es
gibt zwei Gruende dagegen: der Projektinhaber hat keine Kommandozeile, in der
er ihn ausfuehren koennte, und ein Befehl, der einen Dateinamen aus einem
Parameter in eine Shell-Zeile setzt, ist eine Einladung zur Befehlsinjektion --
auch wenn hier nur Text zurueckgegeben wird. Dieselbe Regel wie beim
entfernten `fetch_url` weiter unten: kein Werkzeug ist die kleinere
Angriffsflaeche.

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

Ein viertes Beispiel, `fetch_url`, gab es hier einmal. Es ist am 2026-09-07
entfernt worden, als der Worker unter einer oeffentlichen Adresse erreichbar
wurde — siehe `SECURITY.md`. Wenn du ein Werkzeug mit echtem ausgehendem
`fetch` als Vorlage brauchst: die Caracat-Werkzeuge in `src/caracat.ts` sind
eins, nur mit fest verdrahteter Adresse statt einer aus dem Parameter.

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
