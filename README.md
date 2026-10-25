# HomeRecover

Turns a paper discharge summary into a day-by-day recovery plan and warns the family early.
Built for Hack Build'26 (GDG on Campus, CIT Chennai), Healthcare track.

> HomeRecover never diagnoses. It only repeats the doctor's own red flags and tells the family when to call the doctor or emergency services.

## The problem

Patients go home with a dense paper summary and no follow-up. Families cannot tell a normal recovery from a warning sign. For example, swelling and fever begin on day 4 after surgery, and the family reaches the hospital late.

## What makes it different

| Feature | What it does |
|---|---|
| Trend-based early warning | Looks at the recovery across days. Pain 1 -> 2 -> 3 warns on day 3, instead of judging one check-in. |
| Shared family dose log | Everyone sees who gave which dose, so doses are not doubled or missed. |
| Nearest help at red-flag time | The alert shows the closest hospital, a one-tap call and an ambulance button. |
| Offline-first | The plan is cached on the phone, with an SMS check-in fallback. |

Similar projects exist (for example Discharge Buddy and CarePath AI). In our search, none combined trend tracking, a shared dose log and nearest-help routing.

## Status

| Part | Status |
|---|---|
| Trend rule engine (`backend/app/trend.py`) | Done, with unit tests |
| API wrapper (`backend/app/main.py`) | Written, not yet tested |
| PWA shell with offline caching (`frontend/`) | Scaffold only |
| Summary scan (AI to JSON) | Planned |
| Shared dose log | Planned |
| Nearest-help card (OpenStreetMap) | Planned |
| SMS check-in fallback | Planned |

## Architecture

```
Scan summary -> AI extracts plan (JSON) -> Daily check-in -> Trend rule engine -> Family alert + nearest help
```

AI only extracts data from the summary, and the family confirms it. Warnings come from transparent rules in `trend.py`.

## Run the tests

```bash
cd backend
python -m unittest discover -s tests -v
```

## Run the API

```bash
cd backend
pip install -r requirements.txt
uvicorn app.main:app --reload
```

Example request:

```bash
curl -X POST http://127.0.0.1:8000/trend \
  -H "Content-Type: application/json" \
  -d '{"checkins":[{"day":1,"pain":1},{"day":2,"pain":2},{"day":3,"pain":3}]}'
# {"status":"WARN","reasons":["Pain rising for 3 days (1 -> 2 -> 3)"]}
```

## Team

[Add team name and members]

## License

MIT
