# Frais de mission

A phone app (PWA) for recording expenses during a work mission, as they happen.
After a single first launch with internet, it works **without internet**.

For each mission it produces, automatically and kept up to date:

| File | Content |
|---|---|
| `TAGUEMA_DELFT_19_05_2026_justificatifs.pdf` | page 1: mission details and a summary table (n°, date, description, type, amount, total); then each expense `(n) title` with its receipts (photos or PDF pages) |
| `TAGUEMA_DELFT_19_05_2026_depenses.xlsx` | Replicon table: n°, Date Incurred, Description, Type, Bill Client, Type of mission, Amount, plus the total (formula) |
| `TAGUEMA_DELFT_19_05_2026.odt` | the Cenaero **Mission Request Form** (SUPBPM-F-003-06), filled in from the travel details |

File names follow `LASTNAME_CITY_DD_MM_YYYY`, where the date is the departure date. The numbers (1), (2)… are the same in the PDF and in the Excel.

All data (missions, expenses, receipts) stays **on the phone**. Nothing is sent anywhere.

## Use

1. **Installation (once, with internet).** Open https://nirvananas.github.io/TravelCenaero/ in Chrome, then ⋮ → *Install app*.
   Open it once while still online: it stores itself on the phone, including the receipt reader (about 7 MB).
   ⚙ *Réglages* shows "✓ Prête" when it is done.
2. **⚙ Réglages:** import an old filled-in Mission Request Form `.odt` once, for example `TAGUEMA_DELFT_19_05_2026.odt`.
   Participant, project, mission type, position and general comments become the defaults for new missions.
3. **＋ Nouvelle mission:** city and departure date. Under *Infos du voyage* go all the form fields
   (purpose, place, dates, trains, hotel, registration…). Under *Replicon* go the Type of mission and Bill Client.
4. **During the trip:**
   - **＋ Dépense → 📷 Photo** of the receipt, or **📄 Fichier / PDF** for a receipt saved on the phone.
   - **From Gmail or another app:** open the receipt (PDF or image) → *Partager* → **Frais**.
     The receipts land in *Justificatifs reçus*; choose the mission and tap *Une dépense par justificatif*.
   - The app **reads the receipt by itself**: amount, date and category (Train, Repas midi/soir, Hôtel, Taxi…).
     PDF receipts are read exactly from their text; photos are read by text recognition (OCR) on the phone.
     It fills only empty fields. **Check them**: the screen says "Lu automatiquement … à vérifier".
   - ⟳ rotates a photo; ↑ ↓ reorders expenses.
5. **Documents:** in the mission, the *Documents* section is always up to date. ⬇ downloads a file; *Partager* sends the files
   (mail, Drive, KDE Connect…). Copy them to `~/Documents/Travels/` on the PC.

Expenses without a receipt are marked "pas de justificatif"; add a note to explain why.

### Replicon types
Each expense gets a Replicon *Type* from its category: Train, Avion, Métro, Bus → "Avions, trains, métros";
everything else → "Avance". These are the two types seen on a real Replicon sheet. You can change the type per expense.
The mission's *Type of mission* is derived from the form: Training → "Formation", Conference → "Conférence",
Meeting → "Réunion". Only "Formation" has been seen in Replicon; check the other two and change them if needed.

## Updating the app on the phone

Push to `main`. GitHub Pages republishes within a minute. The phone picks up the new version in the background
and uses it from the next launch.

## Code

| File | Role |
|---|---|
| `app.js` | screens, phone storage (IndexedDB), photo and PDF processing, inbox of shared receipts |
| `receipt.js` | reading a receipt's text: amount, date, time, category; Replicon type |
| `pdf.js` | justificatifs PDF writer (A4, summary table, receipts; no library) |
| `xlsx.js` | Replicon Excel writer (no library) |
| `odt.js` | ZIP read/write, file naming, filling the Mission Request Form's controls |
| `sw.js` | offline first (opens from the phone's copy, updates in the background); receives shared receipts |
| `vendor/` | pdf.js and Tesseract (OCR), see [vendor/VERSIONS.md](vendor/VERSIONS.md) |

## Tests

```bash
node --test tests/                       # unit tests (form tests use ~/Documents/Travels/TAGUEMA_DELFT_19_05_2026.odt,
                                         #  or MISSION_FORM=<path>; skipped if absent)
python3 tests/smoke_server.py <form.odt> <out-dir> 8765 &
google-chrome --headless=new --user-data-dir=$(mktemp -d) http://localhost:8765/tests/smoke.html
                                         # drives the real app end to end, including OCR, PDF receipts and
                                         #  Share → Frais; prints PASS/FAIL and saves the generated files
node tests/demo.mjs <form.odt> <out-dir> <photo.jpg>...   # builds the three documents for a visual check
```
