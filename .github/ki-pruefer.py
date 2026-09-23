#!/usr/bin/env python3
"""Macht aus den Befunden eines Sprachmodells Issues -- ohne Flut.

Der Auftrag war: „bei jedem Fehler ein neues Issue". Wörtlich genommen
entsteht daraus **eine Lawine**, und zwar aus drei Gründen, die alle nichts
mit dem Code zu tun haben:

1. **Derselbe Code gibt dieselbe Antwort.** Läuft der Prüfer zweimal über
   unveränderten Code, findet er zweimal dasselbe.
2. **Ein Sprachmodell findet immer etwas.** Gefragt „was ist hier falsch",
   antwortet es auch dort, wo nichts falsch ist.
3. **Und es formuliert jedes Mal anders.** Das ist der Grund, an dem die
   erste Fassung gescheitert ist.

## Was nicht funktioniert hat, und warum das hier steht

Die erste Fassung erkannte einen Befund an einem Fingerabdruck aus Datei und
Titel wieder. Beim zweiten Lauf nannte das Modell denselben Befund einmal
„Nicht-String-Felder des Modells verursachen einen Absturz" und einmal
„Nicht-stringartige Felder führen später zum Absturz". Zwei Fingerabdrücke,
zwei Issues -- innerhalb einer Stunde.

Der naheliegende Ausweg war eine **Ähnlichkeit** zwischen den Titeln. Bevor
ich ihn eingebaut habe, habe ich die Schwelle an den echten Fällen gemessen:

| | Ähnlichkeit |
| --- | --- |
| echte Dubletten | 0.59, 0.89 |
| wirklich verschiedene Befunde | 0.26, 0.33, **0.86**, **0.90** |

**Die Bereiche überlappen vollständig.** „Fehlende Null-Prüfung in
`lade_datei`" und „... in `speichere_datei`" sind zu 86 % ähnlich und
trotzdem zwei verschiedene Fehler. Es gibt keine Schwelle, die das trennt.
Die Heuristik ist deshalb **nicht** eingebaut -- sie hätte gut ausgesehen und
mal zu viel, mal zu wenig zusammengeworfen.

## Was stattdessen

**Ein Issue pro Datei, nicht pro Befund.** Alle Befunde zu einer Datei stehen
in einem Issue, und jeder Lauf schreibt dessen Text neu.

Damit ist die Wiedererkennung keine Schätzung mehr, sondern exakt: der
Dateipfad ist der Schlüssel. Wie das Modell formuliert, spielt keine Rolle
mehr, weil der Text ohnehin ersetzt wird. Ein behobener Fehler verschwindet
beim nächsten Lauf von selbst, und findet ein Lauf in einer Datei gar nichts
mehr, wird ihr Issue **geschlossen**.

Der Preis ist gröber: ein Issue kann mehrere Befunde tragen. Das ist es wert.
Genauigkeit, die eine Lawine erzeugt, ist keine.

## Die übrigen Schranken

* **Obergrenze** -- höchstens `GRENZE` neu angelegte Issues pro Lauf.
* **Kennzeichnung** -- in jedem Issue steht, dass ein Sprachmodell die
  Befunde gemeldet hat und **niemand sie geprüft** hat. Ein unbestätigter
  Befund, der aussieht wie ein bestätigter, ist schlimmer als keiner.
* **Nur `hoch` und `mittel`** -- Geschmack gehört nicht in ein Issue, das
  jemand abarbeiten soll.

Geschlossen wird nur, was **dieser Lauf angesehen hat**. Bei einem Push sind
das nur die geänderten Dateien; die Issues aller anderen bleiben, wo sie
sind. Sonst löschte jeder Push die halbe Liste.

Keine Abhängigkeiten: Standardbibliothek, wie alles hier.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request

# Hoechstens so viele **neu angelegte** Issues pro Lauf. Bestehende werden
# immer aktualisiert -- das kann keine Flut ausloesen, weil die Zahl der
# Issues dabei gleich bleibt.
GRENZE = 5

# Nur das hier wird gemeldet. „niedrig" ist Geschmack, und Geschmack gehoert
# nicht in ein Issue, das jemand abarbeiten soll.
GEMELDET = ("hoch", "mittel")

MARKE = "ki-pruefer-datei"
ETIKETT = "ki-befund"


class Unbrauchbar(Exception):
    """Die Antwort des Modells liess sich nicht auswerten.

    Ausdruecklich **kein** „dann eben null Befunde": eine unlesbare Antwort
    ist etwas anderes als eine leere. Wer beides gleich behandelt, baut einen
    Bot, der bei jedem Modellschluckauf „alles in Ordnung" meldet.
    """


def befunde_aus_text(text: str) -> list[dict]:
    """Zieht die Liste der Befunde aus der Antwort des Modells."""
    if not text or not text.strip():
        raise Unbrauchbar("die Antwort war leer")

    roh = text.strip()
    block = re.search(r"```(?:json)?\s*(.+?)```", roh, re.DOTALL)
    if block:
        roh = block.group(1).strip()
    else:
        auf, zu = roh.find("["), roh.rfind("]")
        if auf == -1 or zu == -1 or zu < auf:
            raise Unbrauchbar("in der Antwort steht keine JSON-Liste")
        roh = roh[auf : zu + 1]

    try:
        daten = json.loads(roh)
    except json.JSONDecodeError as fehler:
        raise Unbrauchbar(f"die Antwort ist kein gueltiges JSON: {fehler}") from fehler

    if not isinstance(daten, list):
        raise Unbrauchbar("die Antwort ist keine Liste")

    sauber = []
    for eintrag in daten:
        if not isinstance(eintrag, dict):
            raise Unbrauchbar("ein Eintrag in der Liste ist kein Objekt")
        fehlt = [
            f
            for f in ("titel", "datei", "schwere", "begruendung")
            if not eintrag.get(f)
        ]
        if fehlt:
            raise Unbrauchbar(f"einem Befund fehlen Felder: {', '.join(fehlt)}")
        # Ein Modell liefert auch schon mal eine Zahl, wo Text stehen soll.
        # Ohne diese Pruefung stuerzt erst spaeter etwas ab, an einer Stelle,
        # die nichts mit der Ursache zu tun hat. Vom Pruefer selbst gefunden.
        for feld in ("titel", "datei", "schwere", "begruendung"):
            if not isinstance(eintrag[feld], str):
                raise Unbrauchbar(
                    f"das Feld {feld!r} ist kein Text, sondern "
                    f"{type(eintrag[feld]).__name__}"
                )
        if eintrag["schwere"] not in ("hoch", "mittel", "niedrig"):
            raise Unbrauchbar(f"unbekannte Schwere: {eintrag['schwere']!r}")
        sauber.append(eintrag)
    return sauber


def nach_dateien(befunde: list[dict]) -> dict[str, list[dict]]:
    """Gruppiert nach Datei -- der Schluessel, an dem wiedererkannt wird.

    Nur `hoch` und `mittel`. Und innerhalb einer Datei wird nach Schwere
    sortiert, damit im Issue oben steht, was oben stehen soll.
    """
    heraus: dict[str, list[dict]] = {}
    for befund in befunde:
        if befund["schwere"] not in GEMELDET:
            continue
        heraus.setdefault(befund["datei"].strip(), []).append(befund)
    for liste in heraus.values():
        liste.sort(key=lambda b: GEMELDET.index(b["schwere"]))
    return heraus


def marke_von(datei: str) -> str:
    return f"<!-- {MARKE}: {datei} -->"


def titel_von(datei: str) -> str:
    return f"[KI] Befunde in {datei}"


def dateien_aus_issues(issues: list[dict]) -> dict[str, dict]:
    """Welche Datei gehoert zu welchem offenen Issue?

    Gelesen wird die Marke im Text, nicht der Titel: Titel aendern Menschen,
    Marken nicht.
    """
    muster = re.compile(rf"<!--\s*{re.escape(MARKE)}:\s*(.+?)\s*-->")
    heraus: dict[str, dict] = {}
    for issue in issues:
        treffer = muster.search(issue.get("body") or "")
        if treffer:
            heraus[treffer.group(1)] = issue
    return heraus


def plan(
    gefunden: dict[str, list[dict]],
    bestehend: dict[str, dict],
    angesehen: list[str],
) -> tuple[list[str], list[str], list[str], int]:
    """Was ist zu tun? (neu anlegen, aktualisieren, schliessen, zurueckgehalten)

    `angesehen` sind die Dateien, die **dieser Lauf** gelesen hat. Nur deren
    Issues duerfen geschlossen werden -- bei einem Push sind das wenige, und
    alle anderen Issues gehen den Lauf nichts an. Ohne diese Einschraenkung
    raeumte jeder Push die halbe Liste ab.
    """
    anlegen = sorted(d for d in gefunden if d not in bestehend)
    aktualisieren = sorted(d for d in gefunden if d in bestehend)
    gesehen = set(angesehen)
    schliessen = sorted(d for d in bestehend if d in gesehen and d not in gefunden)
    zurueck = max(0, len(anlegen) - GRENZE)
    return anlegen[:GRENZE], aktualisieren, schliessen, zurueck


def issue_text(datei: str, befunde: list[dict], repo: str, lauf: str) -> str:
    teile = [
        "> ⚠️ **Von einem Sprachmodell gemeldet. Niemand hat das geprüft.**",
        "> Ein Modell, das nach Fehlern gefragt wird, findet auch dort welche,",
        "> wo keine sind. Bevor hier etwas geändert wird: nachsehen, ob der",
        "> Befund stimmt. Stimmt er nicht, schliessen — das ist ein gültiges",
        "> Ergebnis.",
        "",
        f"**Datei:** `{datei}`",
        "",
        "Dieses Issue wird bei jedem Lauf **neu geschrieben**. Was behoben ist,",
        "verschwindet von selbst; ist gar nichts mehr zu finden, schliesst es sich.",
        "Eigene Notizen gehören deshalb in einen Kommentar, nicht in diesen Text.",
        "",
    ]
    for nummer, befund in enumerate(befunde, 1):
        zeile = befund.get("zeile")
        ort = f" (Zeile {zeile})" if zeile else ""
        teile += [
            f"## {nummer}. {befund['titel']}{ort}",
            "",
            f"**Schwere laut Modell:** {befund['schwere']}",
            "",
            befund["begruendung"],
            "",
        ]
    teile += [
        "---",
        "",
        f"KI-Prüfer in `{repo}`. [Der Lauf]({lauf})",
        "",
        marke_von(datei),
        "",
    ]
    return "\n".join(teile)


# --- Alles ab hier redet mit GitHub. Darueber nichts, damit es pruefbar bleibt.


def _anfrage(
    pfad: str, token: str, daten: dict | None = None, verfahren: str = ""
) -> object:
    ziel = f"https://api.github.com{pfad}"
    leib = json.dumps(daten).encode() if daten is not None else None
    art = verfahren or ("POST" if daten else "GET")
    bitte = urllib.request.Request(ziel, data=leib, method=art)
    bitte.add_header("Authorization", f"Bearer {token}")
    bitte.add_header("Accept", "application/vnd.github+json")
    if daten is not None:
        bitte.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(bitte, timeout=30) as antwort:
        return json.loads(antwort.read().decode())


def offene_issues(repo: str, token: str) -> list[dict]:
    gesammelt: list[dict] = []
    seite = 1
    while True:
        teil = _anfrage(
            f"/repos/{repo}/issues?state=open&labels={ETIKETT}&per_page=100&page={seite}",
            token,
        )
        if not isinstance(teil, list) or not teil:
            break
        gesammelt.extend(teil)
        if len(teil) < 100:
            break
        seite += 1
        if seite > 20:
            # Nicht stillschweigend abschneiden: ab hier gaelte jede Datei
            # dahinter als neu, und der Bot legte Dubletten an.
            print(
                "::warning::Mehr als 2000 offene KI-Issues -- "
                "ab hier ist die Wiedererkennung blind."
            )
            break
    return gesammelt


def main() -> int:
    zerleger = argparse.ArgumentParser(
        description="Befunde eines Modells zu Issues machen."
    )
    zerleger.add_argument(
        "--antwort", required=True, help="Datei mit der Antwort des Modells"
    )
    zerleger.add_argument(
        "--angesehen",
        required=True,
        help="Datei mit den gelesenen Pfaden, einer pro Zeile",
    )
    zerleger.add_argument("--repo", required=True, help="owner/name")
    zerleger.add_argument("--lauf", default="", help="URL des Actions-Laufs")
    zerleger.add_argument(
        "--trocken", action="store_true", help="nur sagen, nichts anlegen"
    )
    werte = zerleger.parse_args()

    token = os.environ.get("GITHUB_TOKEN", "")
    if not token and not werte.trocken:
        print("::error::GITHUB_TOKEN fehlt.")
        return 2

    with open(werte.antwort, encoding="utf-8") as datei:
        text = datei.read()
    with open(werte.angesehen, encoding="utf-8") as datei:
        angesehen = [z.strip() for z in datei if z.strip()]

    try:
        befunde = befunde_aus_text(text)
    except Unbrauchbar as fehler:
        # Exit 2, nicht 1: „konnte nichts feststellen" ist nicht dasselbe wie
        # „nichts gefunden". Dieselbe Regel wie bei der Gegenprobe.
        print(f"::error::Die Antwort des Modells war nicht auswertbar -- {fehler}")
        print("--- was dastand ---")
        print(text[:2000])
        return 2

    gefunden = nach_dateien(befunde)
    bestehend = (
        {} if werte.trocken else dateien_aus_issues(offene_issues(werte.repo, token))
    )
    anlegen, aktualisieren, schliessen, zurueck = plan(gefunden, bestehend, angesehen)

    print(
        f"{len(befunde)} Befund(e) in {len(gefunden)} Datei(en). "
        f"{len(angesehen)} Datei(en) angesehen."
    )
    if zurueck:
        print(
            f"::warning::{zurueck} Datei(en) zurueckgehalten -- "
            f"hoechstens {GRENZE} neue Issues pro Lauf."
        )

    for datei in anlegen:
        leib = issue_text(datei, gefunden[datei], werte.repo, werte.lauf)
        if werte.trocken:
            print(
                f"[trocken] neues Issue fuer {datei} ({len(gefunden[datei])} Befund(e))"
            )
            continue
        antwort = _anfrage(
            f"/repos/{werte.repo}/issues",
            token,
            {"title": titel_von(datei), "body": leib, "labels": [ETIKETT]},
        )
        print(
            "Angelegt: "
            f"{antwort.get('html_url', '?') if isinstance(antwort, dict) else '?'}"
        )

    for datei in aktualisieren:
        leib = issue_text(datei, gefunden[datei], werte.repo, werte.lauf)
        if werte.trocken:
            print(f"[trocken] Issue fuer {datei} neu schreiben")
            continue
        nummer = bestehend[datei]["number"]
        _anfrage(
            f"/repos/{werte.repo}/issues/{nummer}",
            token,
            {"body": leib},
            verfahren="PATCH",
        )
        print(f"Aktualisiert: #{nummer} ({datei})")

    for datei in schliessen:
        if werte.trocken:
            print(f"[trocken] Issue fuer {datei} schliessen -- nichts mehr gefunden")
            continue
        nummer = bestehend[datei]["number"]
        _anfrage(
            f"/repos/{werte.repo}/issues/{nummer}/comments",
            token,
            {
                "body": (
                    "In dieser Datei findet der Prüfer nichts mehr. Wird geschlossen."
                )
            },
        )
        _anfrage(
            f"/repos/{werte.repo}/issues/{nummer}",
            token,
            {"state": "closed"},
            verfahren="PATCH",
        )
        print(f"Geschlossen: #{nummer} ({datei}) -- nichts mehr gefunden")

    print(
        f"{len(anlegen)} neu, {len(aktualisieren)} aktualisiert, "
        f"{len(schliessen)} geschlossen."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
