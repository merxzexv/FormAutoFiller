# Form Auto-Filler

Automate Google Form submissions with weighted response distributions, real-time progress tracking, and dual CSV export.

## What It Does

Parses a public Google Form, lets you define percentage weights for each option, then bulk-submits responses according to those weights. Results are exportable as both raw response data and statistical summaries.

---

## Workflow

1. **Paste URL** — Enter a public Google Form link (no sign-in required).
2. **Choose Strategy** — Pick how to initialize weights:
   - **Random Fill** — Random percentages summing to 100% per question.
   - **Weight Fill** — Equal split across all options (e.g. 4 options → 25% each).
3. **Configure Distribution** — Fine-tune percentages per option. Each question's options must sum to exactly 100%.
4. **Set Responses** — Enter the number of submissions to generate.
5. **Run & Export** — Watch live progress, then download:
   - `responses.csv` — raw per-submission data
   - `statistics.csv` — option counts and percentages per question

---

## Features

- **Dual Parser** — Extracts form structure via embedded JSON (`FB_PUBLIC_LOAD_DATA_`) with Selenium/BS4 fallback
- **Supported Question Types** — Multiple Choice, Checkboxes, Dropdowns, Linear Scales
- **Live Progress** — NDJSON streaming with real-time success/fail counter
- **Validation** — Blocks automation if any question's percentages don't sum to 100
- **4-Step Wizard UI** — Sliding screen transitions; fully responsive across all device sizes
- **Bootstrap Icons** — Clean icon-based navigation (back chevron, help button)

---

## Tech Stack

| Layer | Tools |
|---|---|
| Backend | Python, Flask, Requests |
| Parsing | BeautifulSoup4, Selenium, Webdriver Manager |
| Frontend | Vanilla JS, CSS (dark theme), Bootstrap Icons |
| Data | CSV export, NDJSON streaming |

---

## Disclaimer

For educational and testing purposes only. Use only on forms you own or have explicit permission to test. Misuse to manipulate surveys or violate platform terms is prohibited.
