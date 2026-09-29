# CoML Engine

A static site for finding links between daily inputs (tags, kratom dose, nutrients, food groups) and outcome metrics. No build step and no server needed.

## Run

- **Simplest:** open `index.html` in a browser and drop your CSV onto the page. The last CSV you loaded is kept in the browser's local storage.
- **Served:** run `python -m http.server 8765` in this folder and open http://localhost:8765. If the browser has no stored CSV yet, it loads `data.csv` from this folder automatically.

To update the data, drop the new export onto the page, or use **Load CSV**.

## Main view: Impact

Pick a metric to see two ranked lists: the tags that improve it and the tags that worsen it. Each tag shows the change it's linked to, the timing (same day or the day after), and how reliable the evidence is.

## Rankings

One list of every link to any metric, best first. Switch between **Positive** (makes the metric better) and **Negative** (makes it worse), and between tags, kratom, food groups and nutrients. Results are grouped by evidence strength (strong, moderate, weak, likely noise), and every link is listed, including tiny ones.

## How the analysis works

- **Tags:** each comma-separated item in `Input` is a tag. Tags are lowercased, and spellings can be merged under Data → Tag aliases.
- **Timing:** *Same day* compares a metric on days with the tag against days without it. *Day before* uses the tag from the previous calendar day.
- **Effect:** `d` is the difference in standard deviations. Colours are set per metric so that blue means better and red means worse (for example, lower RHR, RT, TtSS and Awake% count as better).
- **Adjust for:** controls for a time trend and/or the kratom dose (same day or day before), using OLS regression.
- **Rank-based:** repeats every test on ranks, which is more robust to outliers.
- **q-values:** false-discovery-rate correction (Benjamini–Hochberg) across every tag×metric test. With many tests, about 5% show p < 0.05 by chance, so q is the more reliable filter.
- **Columns:** roles are detected from the layout (groups between `Input` and `Caf`, nutrients from `Caf` to `Pol`, dose = `Kratom (g)`, metrics after it, `*Score` columns ignored). You can override them under Data → Columns.
