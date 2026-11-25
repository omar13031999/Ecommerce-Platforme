# Google Sheets and Meta Ads setup

## Google Sheets (orders import)

1. Google Cloud Console → create a project → enable **Google Sheets API**.
2. OAuth consent screen (internal or external) with scope
   `https://www.googleapis.com/auth/spreadsheets.readonly` (+ `openid email`).
3. Credentials → OAuth client ID (Web) with redirect URI `${APP_URL}/api/oauth/google/callback`.
4. Set `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`, restart.
5. *Paramètres → Intégrations → Connecter Google*, then *Nouvelle source*: paste the sheet URL, load the tabs, map
   the columns (required: order ID, customer name, phone, product), choose the options:
   * multi-product separator inside a cell (e.g. `|` → `Montre x2 | Sac`), or several rows per order ID;
   * whether the price column is a line total; date format.
6. *Tester* runs a dry run (no import). Enable automatic sync and its frequency.

Behaviour: orders are matched by `(source, sheet, external ID)` — re-syncs never duplicate. For existing orders only
customer fields are updated, and only while the order is still being confirmed; statuses, notes, assignments,
delivery data and cost snapshots are never overwritten. Row errors are listed in *Lignes en erreur*; failures trigger
exponential back-off and a notification.

## Meta Marketing API (advertising spend)

1. <https://developers.facebook.com> → create a *Business* app → add **Marketing API**.
2. Facebook Login → valid OAuth redirect URI `${APP_URL}/api/oauth/meta/callback`.
3. Set `META_APP_ID`, `META_APP_SECRET` (and optionally `META_GRAPH_VERSION`), restart.
4. Only `ads_read` is requested. For accounts you do not administer as an app developer/tester, Meta requires
   **App Review / Advanced Access** for `ads_read` — this is not automatic.
5. *Connecter Meta* → *Importer les comptes publicitaires* → in *Publicité*, set the **FX rate to DZD** for each
   account billed in USD/EUR (spend is not converted without it and a warning is shown), the start date, and
   activate the accounts.

Sync: daily ad-level insights (spend, impressions, reach, clicks, CPM, CPC, CTR, actions) in the account's own
timezone, re-reading the last 3 days on each run (Meta finalises spend late), upserted on (account, date, ad) so spend
is never duplicated. Long-lived tokens last ~60 days; on expiry the connection is marked *expired* and a reconnect is
requested.

Attribution: put Meta campaign / ad IDs (or UTM campaign) into the order sheet columns `meta_campaign_id` /
`meta_ad_id` to attribute spend to products precisely; otherwise map campaigns to products or let the estimate method
allocate the remaining spend.

## AI extraction of sheet rows (optional)

For sheets whose columns are inconsistent (phone in the name column, "wilaya - commune" in one cell, product and
price in free text), enable **Extraction intelligente par IA** in the source options.

* Each **new** row is sent whole (headers + values) to the Claude API (`claude-opus-5-5`, low effort, structured
  JSON output, server-side refusal fallback), in batches of 15 rows, at most 60 rows per sync — the rest is read on
  the next sync. Rows already imported are never re-sent (no repeated cost; confirmers own them).
* The product catalogue (reference | name) is sent with the instructions (prompt-cached) so products are mapped to
  catalogue references when they clearly match.
* Nothing is invented: absent values are null, the order is flagged *à vérifier* with the missing fields and the
  original row text.
* If the AI is unavailable (no key, invalid key, rate limit, error) the row falls back to the column mapping, or is
  imported raw for manual completion — an import never blocks.
* Requires `ANTHROPIC_API_KEY` (starts with `sk-ant-`) in the server environment. Cost is roughly a few tenths of a
  dinar to ~1 DA per order at current Claude API prices, depending on row length.
