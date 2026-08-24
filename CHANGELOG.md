# CHANGELOG

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
