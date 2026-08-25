# CHANGELOG

## v1.0.8

- Fix gauge features mixing data from two different forecast issuances. `floodStatus` and `queryGaugeForecasts` advance independently, so pairing the status severity with whichever forecast issuance was newest could render an EXTREME headline above a forecast table whose peak sat below the warning threshold — after Google had revised that day's forecast downward. The forecast issuance is now selected by nearest `issuedTime` to the status, so severity, confidence tier and the forecast table all describe the same forecast run
- Add a note in remarks when the forecast table comes from a different issuance than the severity, for the small number of cases where the API does not return the exact issuance the status was derived from (3 of 215 elevated NZ gauges when measured)
- Fix `Thresholds`/`Forecast` remarks always labelling values as `m³/s`, regardless of the gauge model's actual `gaugeValueUnit`. Some gauges (e.g. those using agency-set water levels in India/Bangladesh/Brazil) report in meters, not discharge — the unit label is now derived from the API response

## v1.0.6

- Expose forecast confidence tiering in metadata: `leadTimeDays` and `leadTimeTier` (Warning/Watch/Outlook) are now available on gauge and basin features, and added to the output schema
- Show the headline severity's confidence tier in remarks (`Confidence: Watch (+4d lead time)`) and tag it in the gauge callsign (e.g. `[Watch]`)
- **Breaking:** simplify confidence handling to rely solely on lead-time tiering, which directly reflects Google's published model-skill data. Removes the multi-issuance confirmation mechanism added in v1.0.4/v1.0.5 — the `MIN_CONFIRMING_ISSUANCES` and `INCLUDE_PRELIMINARY_EVENTS` environment variables, the `confirmed` and `preliminary` metadata/schema fields, and the `(preliminary)` callsign/remarks labels and reduced polygon opacity. It duplicated what lead-time tiering already conveys, and had the least forecast history to work with at exactly the short lead times where alerts matter most
- Forecast fetching now retains only the latest issuance per gauge rather than all issuances in a 7-day window, reducing per-run memory use

## v1.0.5

- Add `INCLUDE_PRELIMINARY_EVENTS` environment variable (default `true`) to optionally suppress gauges/basin polygons whose elevated severity is still preliminary (not yet confirmed across `MIN_CONFIRMING_ISSUANCES` forecast issuances)
- Add `preliminary` field to the output schema and gauge/basin metadata, alongside the existing `confirmed` field
- Expand the `INCLUDE_SIGNIFICANT_EVENTS` description to explain what a significant event is and what the flag controls
- Checked all dependencies against latest available versions; already up to date (`typescript` remains pinned at 6.0.3 pending `typescript-eslint` TypeScript 7 support)

## v1.0.4

- Forecast confidence tiering: classify forecast days into Warning (0-2d), Watch (3-5d), and Outlook (6+d) lead-time tiers reflecting decreasing forecast skill at longer horizons
- Confirm elevated severity by checking agreement across multiple daily forecast issuances instead of a single forecast run, reducing false alerts from volatile long-lead-time spikes ("crying wolf")
- Mark unconfirmed/preliminary severity distinctly in callsign, remarks, and polygon fill opacity
- Render lower-confidence (non-quality-verified) gauges with reduced marker opacity to visually distinguish them on the map
- Cross-reference gauges already covered by a Significant Flood Event in remarks/callsign
- Surface predicted change bounds (`forecastChange.valueChange`) in remarks when available
- Normalize all surfaced timestamps: `metadata` now exposes separate `*UTC` (raw ISO 8601) and `*Local` (human-formatted, DST-aware) fields
- Add configurable `TIMEZONE` environment variable (IANA name, default `Pacific/Auckland`) for local time display in remarks/metadata, replacing the previous hardcoded NZ timezone
- Update dependencies to latest compatible versions

## v1.0.0

- Initial release
- River gauge monitoring with colour-coded severity icons
- 8-day forecast details for elevated gauges
- Flash flood event polygons
- Significant event polygons
- Gauge discovery with ephemeral caching
- Inundation map support (when available)
- Configurable region, quality filter, and forecast threshold
