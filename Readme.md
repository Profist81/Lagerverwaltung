# 6. README.md

# Lagerverwaltungs-App (PWA, offline, ohne externe Abhängigkeiten)

**Funktionen**
- Wareneingang **mit/ohne Zeichnung**
- **Mehrseitige** Lieferschein-Fotos (Kamera)
- **Buchungsstatus**: ungebucht ↔ eingebucht
- **Temporärer Lagerort** inkl. Foto
- **Drag & Drop** für Lagerbewegungen & **Teilmenge** (Prompt)
- **CSV-Export** (Semikolon) & **PDF-Export** (Browser-Druckansicht)
- **IndexedDB** (docs, docImages, locations, movements)
- **Admin-PIN** (SHA-256, lokal gespeichert)
- **Background-Sync** (Service Worker)
- **Live-Updates** über BroadcastChannel (Multi-Tab); optional **WebSocket-URL** (Settings)

## Start
1. Dateien in einen Ordner legen (z. B. auf einem lokalen Webserver).
2. `index.html` im Browser öffnen. Für PWA/Service-Worker **über http/https** bedienen (Datei-URL lädt SW nicht).
   - Minimal: `python -m http.server 8080` → http://localhost:8080
3. Oben rechts: ⚙️ **Einstellungen** → optional **WebSocket-URL** setzen, **Admin-PIN** festlegen.

## Nutzung
- **Wareneingang anlegen**:
  - Lieferant, LS-Nr., optional temporärer Lagerort.
  - **📷 Lieferschein-Fotos** (mehrfach möglich), **📷 Foto Lagerort**.
  - Positionen hinzufügen (Artikel-Nr., Menge). **📷 Scan** nutzt *BarcodeDetector* (Fallback: manuelle Eingabe).
  - **Speichern** → Eintrag erscheint unter „Offene Wareneingänge“.
- **Einbuchen**: Karte → **EINBUCHEN**.
- **Lagerbewegung**: Tab **Lager** → Position aus **Pool** auf **Lagerort** ziehen → Teilmenge eingeben.
- **Berichte**: Tab **Berichte** → Tabellen generieren → **PDF** via Druckdialog (keine externe Lib).
- **Admin**:
  - **Löschen** von Docs/Locations und **Verlauf leeren** erfordert Admin-PIN.

## Datenmodell (IndexedDB)
- `settings` `{k, v}` → `pinHash`, `wsUrl`
- `docs` `{id, createdAt, supplier, docNo, withDrawing, booked, tempLocation, tempLocPhotoId, items:[{id, articleNo, qty, leftQty}]}`
- `docImages` `{key, docId, seq, blob, kind:'doc'|'temp'}`
- `locations` `{id, name}`
- `movements` `{id, ts, articleNo, qty, from, to, user}`

## PWA
- **Service Worker**: Precache, Runtime-Cache, Background-Sync (`lager-sync`)
- **Manifest**: Daten-URLs als Icons (keine externen Dateien)

## Hinweise
- **Barcode-Scan** nutzt `BarcodeDetector` (Chrome/Edge). Fallback: Eingabedialog.
- **PDF-Export**: ohne Fremdlib via Browser-Druckansicht (Styles enthalten).
- **WebSocket**: optional. Wenn gesetzt, sendet/empfängt die App simple `{"type":"update"}`-Events.

## Lizenz
MIT
