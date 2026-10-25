# HomeRecover

Turns a paper discharge summary into a daily recovery plan, and warns the family early when recovery is going the wrong way.
Built for Hack Build'26 (GDG on Campus, CIT Chennai), Healthcare track.

> HomeRecover never diagnoses. It only repeats the doctor's own warning signs and tells the family when to call the doctor or emergency services (112, ambulance 108).

## The problem

Patients go home with a dense paper summary and no follow-up. Families cannot tell a normal recovery from a warning sign. For example, swelling and fever begin on day 4 after surgery, and the family reaches the hospital late.

## What it does

| Feature | How it works |
|---|---|
| Plan from the discharge summary | Photo or pasted text is read by AI into medicines, times and warning limits. The family reviews and edits every field before saving. Manual entry always works. |
| Trend-based early warning | Daily check-in (pain, temperature, wound). Pain 1, 2, 3 on three days in a row warns on day 3, instead of judging one answer. Fever or pain at the doctor's own limit is a red flag. |
| Recovery chart | Pain and temperature by day with the doctor's limits drawn on the chart. |
| Shared family dose log | Everyone sees who gave which dose. If two relatives log the same dose while offline, both entries are kept and a warning shows. |
| Help when it matters | One-tap calls to the doctor, 112 and 108, the doctor's warning signs, and the nearest hospitals and clinics from OpenStreetMap. |
| Works offline | The app and the last plan are cached on the phone. Records made offline sync when the connection returns. |
| English, Tamil, Hindi | Interface, warnings and read-aloud. Tamil and Hindi text should be reviewed by a native speaker before real use. |

## Run it (no installs)

You need Python 3.9+ only. There are no packages to install.

```bash
cd backend
python -m app.server --port 8000
```

Open http://localhost:8000.

Optional, to let AI read a photographed or pasted summary:

```bash
export ANTHROPIC_API_KEY=your-key        # Windows PowerShell: $env:ANTHROPIC_API_KEY="your-key"
export ANTHROPIC_MODEL=claude-sonnet-5-5 # optional, this is the default
```

Without a key everything else works, and the plan can be entered by hand.

### Trying it on a phone

Offline mode (service worker), location and install-to-home-screen only work on **https** or **localhost**. Plain `http://192.168.x.x` opens the app but without those features. Easiest options for a demo:

- Deploy it (below), or
- Use a tunnel such as `cloudflared tunnel --url http://localhost:8000` and open the https link it prints.

### Deploy

Any host that runs Python works (Render, Railway, PythonAnywhere). Start command:

```bash
cd backend && python -m app.server --host 0.0.0.0
```

The host's `PORT` variable is used automatically. The database is one SQLite file (`HOMERECOVER_DB` sets its path). On free hosts the disk may reset on redeploy, so records can be lost.

## Tests

```bash
cd backend && python -m unittest discover -s tests -v    # API, storage, AI-answer cleaning, trend rules
cd frontend && npm test                                  # trend rules, translations, two phones syncing against the real server
```

The trend rules exist twice (Python and JavaScript, so the phone works offline). Both run the same cases from `shared/trend_cases.json`, so they cannot drift apart.

## How the warnings work

All in `backend/app/trend.py` and `frontend/js/trend.js`, plain if/else rules, no AI:

| Finding | Rule | Level |
|---|---|---|
| Fever at the limit | Latest temperature is at or above the doctor's limit | Red flag |
| Wound discharge | Latest check-in reports discharge | Red flag |
| Pain at the limit | Latest pain is at or above the doctor's limit | Red flag |
| Pain rising | Pain goes up on 3 consecutive days, by at least 2 points in total | Warning |
| Fever rising | Temperature rose and is within 1°F of the limit | Warning |

If the summary does not contain a limit, the app uses 100.4°F and 8/10, and highlights the field so the family confirms it with the doctor.

## Project layout

```
backend/app/trend.py     trend rules
backend/app/extract.py   AI reading of the summary + cleaning of its answer
backend/app/db.py        SQLite storage (append-only records)
backend/app/server.py    JSON API and static file server (standard library only)
frontend/                the web app (no build step): index.html, js/, sw.js
shared/trend_cases.json  test cases shared by Python and JavaScript
```

## Known limits

- Not tested live in this repo's CI: reading a summary with the AI (needs your API key and internet) and the nearest-hospital lookup (needs internet and location permission).
- The family code is the only protection for a shared family's data. Anyone with the code can read and add records. Do not store real patient data on a public server without adding sign-in.
- Temperatures are in °F only for now.
- SMS check-ins and a health-worker view are planned, not built.
- This is a hackathon prototype, not a medical device.

## Team

TEAM- PHOENIX

## License

MIT
