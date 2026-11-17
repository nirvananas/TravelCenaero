# Frais de mission

A phone web app (PWA) for recording expenses during a work mission, as they happen.
It works offline, and Android can install it like a normal app.
When the mission is over, it generates:

| File | Content |
|---|---|
| `TAGUEMA_DELFT_19_05_2026_justificatifs.pdf` | one entry per expense: `(n) title`, date · amount · note, then the receipt photos; total at the end |
| `TAGUEMA_DELFT_19_05_2026.odt` | the Cenaero **Mission Request Form** (SUPBPM-F-003-06), filled in |

File names follow `LASTNAME_CITY_DD_MM_YYYY`, where the date is the departure date.

All data (missions, expenses, photos) stays **on the phone**, in the browser's IndexedDB.
Nothing is sent anywhere. No server, account or library is needed.

## Use

1. **Réglages (⚙)**: import an old filled-in Mission Request Form `.odt` once, for example
   `TAGUEMA_DELFT_19_05_2026.odt`. The app checks that it is the expected form version.
   It then fills the same form for every mission.
   Participant, project, mission type, position and general comments are kept as defaults for new missions.
   Without a form, only the PDF is generated.
2. **＋ Nouvelle mission**: enter the city and the departure date. The *Mission Request Form* section has every field of the form.
3. **＋ Dépense**: pick a title (quick buttons; *Repas midi/soir* are numbered automatically) and enter the amount.
   Use **📷 Photo** for the receipt, or **🖼 Galerie** for a screenshot of an e-ticket. Use ⟳ to rotate a photo.
   Use ↑ ↓ to reorder; the numbers (1), (2)… follow the list order.
4. **Générer les documents**: download both files, or share them (mail, Drive, KDE Connect…),
   then copy them to `~/Documents/Travels/`.

Expenses with no photo are marked "pas de justificatif" in the PDF; add a note to explain them.
PDF e-tickets: take a screenshot and add it from the gallery.

## Install on the phone

The app must be served over **HTTPS** so it can work offline and be installed. Any static host works.
Example with GitHub Pages:

```bash
git remote add origin git@github.com:<you>/frais-mission.git
git push -u origin main
# GitHub → Settings → Pages → Branch: main / root
```

Then open `https://<you>.github.io/frais-mission/` in Chrome on Android and choose ⋮ → *Install app*.

The repository holds no personal data and no copy of the Cenaero form; the form is imported on the phone.

For a quick try without hosting, run `python3 -m http.server 8000` and open `http://<pc-ip>:8000`
from the phone on the same Wi-Fi. Everything works except offline use and installation.

## Code

| File | Role |
|---|---|
| `app.js` | screens, phone storage (IndexedDB), photo processing (downscale to 2000 px, JPEG) |
| `pdf.js` | justificatifs PDF writer (A4, Helvetica, JPEG embedded as is) |
| `odt.js` | ZIP read/write, file naming, filling the Mission Request Form's controls |
| `sw.js` | offline first: opens from the copy stored on the phone; updates are fetched in the background and used from the next launch |

## Tests

```bash
node --test tests/                       # unit tests (form tests use ~/Documents/Travels/TAGUEMA_DELFT_19_05_2026.odt,
                                         #  or MISSION_FORM=<path>; skipped if absent)
python3 tests/smoke_server.py <form.odt> <out-dir> 8765 &
google-chrome --headless=new --user-data-dir=$(mktemp -d) http://localhost:8765/tests/smoke.html
                                         # drives the real app end to end; prints PASS/FAIL, saves the generated files
node tests/demo.mjs <form.odt> <out-dir> <photo.jpg>...   # builds both documents for a visual check
```
