# Cyber Financial — CDR Home Loan Harvester

Server-side nightly harvest of Australian home-loan **Product Reference Data** from the
Consumer Data Right (CDR) Open Banking APIs. It runs with no browser CORS limits and full
national coverage, producing a single trimmed `products.json` that the
**Cyber Financial Home Loan Comparison Tool** reads instantly in its **Harvested feed** mode.

No npm dependencies. Requires **Node 18+** (uses global `fetch`).

## What it does

1. Calls the CDR register to discover every **banking** data-holder brand and its public base URI
   (falls back to a built-in list if the register is unreachable).
2. For each lender: `GET /banking/products`, keeps `RESIDENTIAL_MORTGAGES`, then
   `GET /banking/products/{id}` for each to read rates, fees, features and LVR tiers.
3. Parses each lending rate into a structured **offering**
   (`purpose`, `repayment`, `rtype`, fixed `term`, `rate`, `comp`, `lvrMin/Max`) —
   the same logic the front-end uses.
4. Writes `public/products.json` (consumed by the app) and `public/meta.json` (status summary).

## Run locally

```bash
node harvest.js              # full harvest -> ./public/products.json
LIMIT=5 node harvest.js      # first 5 lenders only (quick test)
OUT=docs node harvest.js     # write to ./docs instead of ./public
```

## Automate with GitHub Actions + Pages (recommended)

1. Create a repo and add these files. **Move the workflow to the repo root:**
   `harvest.yml` must live at `.github/workflows/harvest.yml` (it already is in this bundle).
2. In the repo: **Settings → Pages → Build and deployment → Source = GitHub Actions**.
3. The workflow runs nightly (17:00 UTC) and on demand (**Actions → Harvest CDR home-loan data → Run workflow**).
4. Your feed URL will be:

   ```
   https://<your-username>.github.io/<your-repo>/products.json
   ```

5. Open the comparison tool, switch **Source** to **Harvested feed**, paste that URL, and click **Load feed**.
   GitHub Pages serves `Access-Control-Allow-Origin: *`, so the page can read it from anywhere
   (including a local file).

## Output shape (`products.json`)

```jsonc
{
  "generatedAt": "2026-06-04T17:00:00.000Z",
  "lenderCount": 96,
  "productCount": 1840,
  "lenders": [{ "name": "...", "base": "...", "status": "ok", "productCount": 23 }],
  "products": [{
    "id": "…", "lender": "Commonwealth Bank", "name": "…", "description": "…",
    "lastUpdated": "2026-05-30", "applicationUri": "https://…", "basic": false,
    "offerings": [{ "purpose":"OWNER_OCCUPIED","repayment":"PRINCIPAL_AND_INTEREST",
                    "rtype":"fixed","term":"3yr","months":36,
                    "rate":0.0589,"comp":0.0612,"lvrMin":0,"lvrMax":80 }],
    "features": ["OFFSET","REDRAW"],
    "fees": [{ "name":"Annual fee","amount":"395","rate":null,"feeType":"PERIODIC" }]
  }]
}
```

## Tuning

- `LENDER_CONCURRENCY` / `DETAIL_CONCURRENCY` — politeness vs speed.
- `REQ_TIMEOUT_MS` — per-request abort timeout.
- A 40 ms pause sits between detail calls per worker to stay courteous to lenders.
- If the file grows large, consider splitting per-lender files plus an index, and have the
  app lazy-load. A single file is simplest and fine for the typical ~2,000 mortgage products.

## Notes & limitations

- `loanPurpose` and `repaymentType` are **optional** in the standard; where a lender omits them
  the field is `null` and the app falls back to name inference (include-over-hide).
- A few smaller lenders occasionally return malformed payloads or time out; those are skipped
  and recorded in `meta.json` with `status: "fail"`.
- Product data only — no consumer data is ever accessed (these are unauthenticated public APIs).

## Compliance reminder

Ranking products edges toward a "comparison service". If this becomes client-facing, ensure the
completeness/coverage representations and the "not financial advice" framing are watertight under
your AR obligations, and document the data source, refresh cadence and known gaps.
