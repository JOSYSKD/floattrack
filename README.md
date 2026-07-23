# floatTRACK

**▶ App öffnen: https://josyskd.github.io/floattrack/**

GPS-Tracker für eigene Singletrails: Trail abfahren = Trail gespeichert, Spots mit Fotos
auf der Karte, Rundenzeiten gegen die eigene Bestzeit und ein Speed-Diagramm über die
ganze Fahrt mit markiertem Höchst- und Tiefpunkt.

Alles läuft im Browser, alle Daten bleiben auf dem Gerät (IndexedDB). Kein Konto, kein Server.

## Starten

```fish
cd ~/floattrack
python3 -m http.server 8899
```

Dann `http://localhost:8899` öffnen. **Wichtig:** GPS gibt der Browser nur über
`http://localhost` oder **HTTPS** frei – vom Handy aus also nur über eine
HTTPS-Adresse (z.B. GitHub Pages), nicht über `file://` oder die lokale IP.

Zum Ausprobieren ohne echte Fahrt: `?demo=1` anhängen oder ⚙ → *Demo-Trail erzeugen*.

## Die drei Fahr-Modi

| Modus | Was passiert |
|---|---|
| **Freie Fahrt** | zeichnet einfach auf: Tempo, Ø, Strecke, Zeit, Höhenmeter, Speed-Diagramm |
| **Trail scannen** | dieselbe Aufzeichnung, am Ende wird daraus ein benannter Trail |
| **Trail fahren** | Uhr startet automatisch, sobald du in den Startradius des Trails fährst, und stoppt am Ziel – Runde wird gegen die Bestzeit verglichen |

Bei einem Rundkurs (Start ≈ Ziel) läuft die nächste Runde nahtlos weiter.
Radius und GPS-Mindestgenauigkeit sind unter ⚙ einstellbar.

## Spots

* Während der Fahrt: **Spot hier** – nimmt die aktuelle Position.
* Auf der Karte: **lange drücken** – Spot an dieser Stelle.
* Jeder Spot: Art (Sprung, Drop, Anlieger, Aussicht, Gefahr, Start, Sonstiges), Notiz und
  Fotos direkt aus der Kamera. Liegt er nah an einem Trail, wird er ihm automatisch zugeordnet.

## Auswertung

Jede Fahrt hat Karte, Kennzahlen, **Speed-Diagramm** (umschaltbar Zeit ↔ Strecke, mit
MAX/MIN-Markierung, Ø-Linie und Tooltip, der die Stelle auf der Karte zeigt),
Höhenprofil und Kilometer-Splits als Tabelle. Export als **GPX**, komplettes Backup als JSON.

## Handy sperren?

Nicht sperren – bei gesperrtem Bildschirm stoppt das Betriebssystem GPS für Web-Apps
(das kann keine Website umgehen). Stattdessen während der Fahrt den **🌙-Knopf** drücken:
Der Bildschirm wird schwarz (nur eine ganz dunkle Anzeige läuft mit), die Aufzeichnung
läuft normal weiter. **2× tippen** weckt die App wieder auf.

## Aufs Handy

Über HTTPS aufrufen → Browser-Menü → *Zum Startbildschirm hinzufügen*. Läuft dann als
eigene App im Vollbild, funktioniert auch offline (Kartenkacheln werden zwischengespeichert),
und das Display bleibt während der Aufzeichnung an.

## Dateien

```
index.html      Aufbau der Oberfläche
style.css       Design (dunkel/hell)
js/app.js       Screens, Karten, Trails, Spots, Detailansichten
js/tracker.js   GPS-Aufzeichnung, Filter, Rundenerkennung, Absturzsicherung
js/geo.js       Geo-Mathematik, Statistik, Formate, GPX
js/chart.js     Speed-Diagramm, Höhenprofil, Live-Sparkline
js/store.js     IndexedDB, Einstellungen, Fotoverarbeitung
sw.js           Service Worker (offline)
vendor/         Leaflet 1.9.4 (lokal, kein CDN nötig)
```

Karten: © OpenStreetMap-Mitwirkende, © CARTO, Satellit © Esri.
