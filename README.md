# ETL-FloodHub

<p align='center'>Google Flood Hub riverine flood forecasting data for TAK</p>

## Data Source

| Data Provider | API Endpoint | Content |
|---|---|---|
| Google Flood Forecasting | `https://floodforecasting.googleapis.com/v1/` | Riverine flood status, forecasts, flash floods, significant events |

### API Endpoints Used

| Endpoint | Method | Purpose |
|---|---|---|
| `floodStatus:searchLatestFloodStatusByArea` | POST | Current severity per gauge (primary polling target) |
| `gauges:searchGaugesByArea` | POST | Discover all gauges in a region (startup/periodic refresh) |
| `gaugeModels:batchGet` | GET | Thresholds for warning/danger/extreme levels |
| `gauges:queryGaugeForecasts` | GET | 8-day daily forecast values per gauge |
| `flashFloods:search` | POST | Active flash flood events with polygons |
| `significantEvents:search` | POST | High-impact flood events with affected population |
| `serializedPolygons/{id}` | GET | KML polygons for flash flood / inundation areas |

### API Key

The API uses a public Google API key (no OAuth required). The same key is used by the [FloodHub web UI](https://sites.research.google/floods/l/-41.5/174/6).

## Model Background

The forecasting system is described in [Nearing et al. (2024) "Global prediction of extreme floods in ungauged watersheds"](https://www.nature.com/articles/s41586-024-07145-1), published in Nature.

- Uses LSTM neural networks (encoder-decoder architecture) trained on 5,680 streamflow gauges globally
- Ingests 365 days of meteorological history (ECMWF forecasts, ERA5-Land reanalysis, NOAA/NASA precipitation, HydroATLAS basin attributes) — no real-time streamflow data required
- Produces 7-day forecast horizon, updated ~daily
- **Southwest Pacific (includes NZ) has the highest accuracy** of any region (F1=0.46), with the largest improvement over the previous state-of-the-art (Copernicus GloFAS)
- 5-day lead time forecasts match the reliability of GloFAS nowcasts (0-day)
- Works in ungauged basins — the HYBAS virtual gauges have no physical sensor; forecasts are purely model-driven

### Accuracy Caveats

- `qualityVerified: false` gauges are genuinely lower confidence — accuracy varies by location, basin size, and climate
- Thresholds (warning/danger/extreme) for HYBAS stations are model-derived, not from physical gauge measurements
- Forecast reliability degrades with lead time — days 1-2 are most reliable, days 6-7 less so
- The model performs better in humid climates and smaller basins (favourable for NZ)

## Severity Model

The API provides a pre-computed `severity` field per gauge based on forecast values vs. model thresholds:

| Severity | Meaning | Colour | CoT Mapping |
|---|---|---|---|
| `NO_FLOODING` | Below warning level | 🟢 Green (#00FF00) | Normal |
| `ABOVE_NORMAL` | Above warning, below danger | 🟠 Orange (#FF7700) | Warning |
| `SEVERE` | Above danger, below extreme | 🔴 Red (#FF0000) | Danger |
| `EXTREME` | Above extreme danger level | 🟣 Purple (#7F007F) | Extreme |
| `UNKNOWN` | Insufficient data | ⚪ Grey (#777777) | Unknown |

Each gauge model defines three thresholds in cubic metres per second (m³/s):
- `warningLevel` → triggers ABOVE_NORMAL
- `dangerLevel` → triggers SEVERE
- `extremeDangerLevel` → triggers EXTREME

## Features

### Core — River Gauge Monitoring
- Poll `floodStatus:searchLatestFloodStatusByArea` on schedule (default 120s, configurable)
- Place each gauge as a colour-coded CoT point icon on the map
- Configurable: quality-verified gauges only (default) or include all lower-confidence gauges
- Configurable: region by country code (e.g. `NZ`) or custom bounding box
- Callsign shows gauge ID, severity, trend, and forecast value
- Remarks include thresholds, forecast time range, and trend direction

### Forecast Details
- Fetch 8-day forecast timeseries via `gauges:queryGaugeForecasts` for gauges at or above a configurable severity threshold (default: ABOVE_NORMAL)
- Include daily forecast values in remarks so operators can see the trajectory
- Show how current/peak forecast compares to warning/danger/extreme thresholds

### Flash Flood Events
- Poll `flashFloods:search` for active flash flood events in the configured region
- Fetch KML polygons via `serializedPolygons` and render as CoT polygon features
- Separate CoT type for flash floods vs. riverine gauge points

### Significant Events
- Poll `significantEvents:search` for high-impact events
- Include affected population estimate and area (km²) in remarks
- Render event polygon on map with associated gauge points

### Gauge Discovery (Startup + Periodic Refresh)
- On first run, call `gauges:searchGaugesByArea` to discover all gauges in the region
- Cache gauge metadata and refresh periodically (default: every 24h, configurable)
- Fetch `gaugeModels:batchGet` for thresholds alongside gauge discovery
- Store in ephemeral state to avoid redundant API calls

## Configuration

| Setting | Default | Description |
|---|---|---|
| `API_KEY` | — | Google Flood Forecasting API key (required) |
| `REGION_CODE` | `NZ` | ISO 3166 alpha-2 country code for area search. Leave empty to use BBOX instead. |
| `BBOX` | _(empty)_ | Custom bounding box as `minLat,minLon,maxLat,maxLon`. Overrides REGION_CODE when set. |
| `INCLUDE_UNVERIFIED` | `false` | Include lower-confidence (non-quality-verified) gauges |
| `INCLUDE_FLASH_FLOODS` | `true` | Poll for flash flood events and render polygons |
| `INCLUDE_SIGNIFICANT_EVENTS` | `true` | Poll for significant high-impact events |
| `FORECAST_DETAIL_THRESHOLD` | `ABOVE_NORMAL` | Minimum severity to fetch detailed 8-day forecast (NO_FLOODING, ABOVE_NORMAL, SEVERE, EXTREME) |
| `GAUGE_REFRESH_HOURS` | `24` | Hours between gauge discovery refreshes |
| `DEBUG` | `false` | Log raw API responses |

## CoT Mapping

### Gauge Points

| Field | Value |
|---|---|
| CoT type | `a-f-G-E-W-F` (atom-fact-Geopoint-Event-Weather-Flood) |
| CoT UID | `floodhub-{gaugeId}` |
| Callsign | `Flood Gauge: {gaugeId} — {severity} ({trend})` |
| Icon | Colour-coded flood icon per severity level |
| Stale | Forecast end time from `forecastTimeRange.end` |

### Flash Flood Polygons

| Field | Value |
|---|---|
| CoT type | `a-f-G-E-W-F-F` (flash flood) |
| CoT UID | `floodhub-flash-{polygonId}` |
| Geometry | Polygon from KML via `serializedPolygons` |
| Fill colour | Orange (#FF7700) with 40% opacity |

### Significant Event Polygons

| Field | Value |
|---|---|
| CoT type | `a-f-G-E-W-F-S` (significant event) |
| CoT UID | `floodhub-event-{polygonId}` |
| Geometry | Polygon from KML via `serializedPolygons` |
| Fill colour | Red (#FF0000) with 40% opacity |

### Icon Colour Mapping

Custom iconset icons for each severity level:

| Severity | Icon | Colour |
|---|---|---|
| NO_FLOODING | `NaturalHazards/NH.01B.Flood.NoFlooding.png` | Green (#00FF00) |
| ABOVE_NORMAL | `NaturalHazards/NH.01B.Flood.AboveNormal.png` | Orange (#FF7700) |
| SEVERE | `NaturalHazards/NH.01B.Flood.Severe.png` | Red (#FF0000) |
| EXTREME | `NaturalHazards/NH.01B.Flood.Extreme.png` | Purple (#7F007F) |
| UNKNOWN | `NaturalHazards/NH.01B.Flood.Unknown.png` | Grey (#777777) |

> **Note**: These icons need to be created and added to the TAK-NZ iconset. As a fallback, use the existing `NaturalHazards/NH.01.Flood.png` icon with CoT colour overrides.

## Remarks Format

```
Flood Gauge: hybas_5120086640
Severity: ABOVE_NORMAL
Trend: FALL
Source: HYBAS
Quality: Lower-confidence

Thresholds (m³/s):
  Warning: 62.8
  Danger: 80.4
  Extreme: 109.3

Forecast (m³/s):
  2026-04-13: 65.3 ← ABOVE_NORMAL
  2026-04-14: 64.1 ← ABOVE_NORMAL
  2026-04-15: 62.6
  2026-04-16: 61.2
  2026-04-17: 60.4
  2026-04-18: 60.1
  2026-04-19: 63.3 ← ABOVE_NORMAL

Forecast issued: 2026-04-13T20:33:15Z
```

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                    ETL Schedule                      │
│                  (every 120s)                        │
└──────────────────────┬──────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────┐
│              Gauge Discovery Cache                   │
│  (searchGaugesByArea + batchGetGaugeModels)          │
│  Refreshed every GAUGE_REFRESH_HOURS                 │
│  Stored in ephemeral state                           │
└──────────────────────┬──────────────────────────────┘
                       │
          ┌────────────┼────────────┐
          ▼            ▼            ▼
   ┌────────────┐ ┌──────────┐ ┌──────────────┐
   │ Flood      │ │ Flash    │ │ Significant  │
   │ Status     │ │ Floods   │ │ Events       │
   │ (gauges)   │ │ (search) │ │ (search)     │
   └─────┬──────┘ └────┬─────┘ └──────┬───────┘
         │              │              │
         │    ┌─────────┴──────┐       │
         │    ▼                ▼       │
         │  ┌──────────┐  ┌────────┐   │
         │  │ Polygons │  │Polygons│   │
         │  │ (KML)    │  │ (KML)  │   │
         │  └────┬─────┘  └───┬────┘   │
         │       │            │        │
         ▼       ▼            ▼        ▼
   ┌─────────────────────────────────────────┐
   │  Fetch forecasts for elevated gauges    │
   │  (queryGaugeForecasts)                  │
   └──────────────────┬──────────────────────┘
                      │
                      ▼
   ┌─────────────────────────────────────────┐
   │         Build FeatureCollection         │
   │  • Gauge points (colour-coded)          │
   │  • Flash flood polygons + center points │
   │  • Significant event polygons           │
   └──────────────────┬──────────────────────┘
                      │
                      ▼
   ┌─────────────────────────────────────────┐
   │            submit(fc)                   │
   └─────────────────────────────────────────┘
```

## API Rate Limiting

The Google Flood Forecasting API has generous limits but we should be efficient:

- **Flood status**: 1 call per poll (returns all gauges in region) — primary polling target
- **Flash floods**: 1 call per poll (returns all events in region)
- **Significant events**: 1 call per poll (global, filter client-side)
- **Gauge discovery + models**: Only on startup and periodic refresh (batched)
- **Forecasts**: Only for gauges at/above threshold severity (batched, max 500 per call)
- **Polygons**: Only when flash floods or significant events are active

At 120s polling interval, this is ~3 API calls per cycle under normal conditions (no active flooding). During active events, polygon fetches add a few more calls.

Note: Google updates forecasts approximately once per day, so polling more frequently than ~60s provides no new data — it only ensures the ETL picks up changes promptly. The default 120s interval is a reasonable balance.

## Ephemeral State

```typescript
{
  gauges: {
    lastRefresh: string,           // ISO timestamp of last gauge discovery
    items: Record<string, {        // keyed by gaugeId
      location: { lat: number, lon: number },
      source: string,
      qualityVerified: boolean,
      hasModel: boolean
    }>
  },
  models: Record<string, {        // keyed by gaugeId
    warningLevel: number,
    dangerLevel: number,
    extremeDangerLevel: number,
    gaugeValueUnit: string
  }>
}
```

## Example Data

### NZ Coverage (as of April 2026)

| Metric | Count |
|---|---|
| Quality-verified gauges | 21 |
| All gauges (incl. unverified) | 1,180 |
| Active flash flood events | 3 (typical) |
| Forecast horizon | 8 days |
| Forecast update frequency | ~daily |

### Example API Response — Flood Status

```json
{
  "gaugeId": "hybas_5120086640",
  "issuedTime": "2026-04-13T20:33:15.075318Z",
  "forecastTimeRange": {
    "start": "2026-04-18T00:00:00Z",
    "end": "2026-04-19T00:00:00Z"
  },
  "forecastTrend": "FALL",
  "severity": "ABOVE_NORMAL",
  "source": "HYBAS",
  "gaugeLocation": {
    "latitude": -37.748,
    "longitude": 176.415
  },
  "qualityVerified": false
}
```

### Example API Response — Gauge Model (Thresholds)

```json
{
  "gaugeId": "hybas_5120086640",
  "thresholds": {
    "warningLevel": 62.76,
    "dangerLevel": 80.36,
    "extremeDangerLevel": 109.29
  },
  "gaugeValueUnit": "CUBIC_METERS_PER_SECOND",
  "qualityVerified": false
}
```

![Google FloodHub flood forecasting data](docs/etl-floodhub.png)

## Deployment

Deployment into the CloudTAK environment for ETL tasks is done via automatic releases to the TAK.NZ AWS environment.

Github actions will build and push docker releases on every version tag which can then be automatically configured via the
CloudTAK API.

### GitHub Actions Setup

The workflow uses GitHub variables and secrets to make it reusable across different ETL repositories.

#### Organization Variables (recommended)
- `DEMO_STACK_NAME`: Name of the demo stack (default: "Demo")
- `PROD_STACK_NAME`: Name of the production stack (default: "Prod")

#### Organization Secrets (recommended)
- `DEMO_AWS_ACCOUNT_ID`: AWS account ID for demo environment
- `DEMO_AWS_REGION`: AWS region for demo environment
- `DEMO_AWS_ROLE_ARN`: IAM role ARN for demo environment
- `PROD_AWS_ACCOUNT_ID`: AWS account ID for production environment
- `PROD_AWS_REGION`: AWS region for production environment
- `PROD_AWS_ROLE_ARN`: IAM role ARN for production environment

#### Repository Variables
- `ETL_NAME`: Name of the ETL (default: repository name)

#### Repository Secrets (alternative to organization secrets)
- `AWS_ACCOUNT_ID`: AWS account ID for the environment
- `AWS_REGION`: AWS region for the environment
- `AWS_ROLE_ARN`: IAM role ARN for the environment

These variables and secrets can be set in the GitHub organization or repository settings under Settings > Secrets and variables.

### Manual Deployment

For manual deployment you can use the `scripts/etl/deploy-etl.sh` script from the [CloudTAK](https://github.com/TAK-NZ/CloudTAK/) repo.
As an example: 
```
../CloudTAK/scripts/etl/deploy-etl.sh Demo v1.0.0 --profile tak-nz-demo
```

### CloudTAK Configuration

When registering this ETL as a task in CloudTAK:

- Use the `<repo-name>.png` file in the main folder of this repository as the Task Logo
- Use the raw GitHub URL of this README.md file as the Task Markdown Readme URL

This will ensure proper visual identification and documentation for the task in the CloudTAK interface.

## Development

TAK.NZ provided Lambda ETLs are currently all written in [NodeJS](https://nodejs.org/en) through the use of a AWS Lambda optimized
Docker container. Documentation for the Dockerfile can be found in the [AWS Help Center](https://docs.aws.amazon.com/lambda/latest/dg/images-create.html)

```sh
npm install
```

Set the necessary environment variables to communicate with a local ETL server.
When the ETL is deployed the `ETL_API` and `ETL_LAYER` variables will be provided by the Lambda Environment

```bash
export ETL_API="http://localhost:5001"
export ETL_LAYER="19"
export API_KEY="your-google-flood-api-key"
export REGION_CODE="NZ"
export INCLUDE_UNVERIFIED="false"
```

To run the task, ensure the local [CloudTAK](https://github.com/TAK-NZ/CloudTAK/) server is running and then run with typescript runtime
or build to JS and run natively with node

```
ts-node task.ts
```

```
npm run build
node dist/task.js
```

### Configuration Examples

```bash
# New Zealand — verified gauges only (21 gauges)
export REGION_CODE="NZ"
export INCLUDE_UNVERIFIED="false"

# New Zealand — all gauges (1,180 gauges)
export REGION_CODE="NZ"
export INCLUDE_UNVERIFIED="true"

# Bangladesh (high flood risk country)
export REGION_CODE="BD"

# Custom bounding box (South Island NZ)
export BBOX="-47.3,166.3,-40.5,174.5"
export REGION_CODE=""

# Only show forecasts for severe+ events
export FORECAST_DETAIL_THRESHOLD="SEVERE"
```

## Inundation Probability Maps

The API schema defines an `inundationMapSet` field on each `FloodStatus` response, supporting two map types:

| Map Type | Levels | Meaning |
|---|---|---|
| `PROBABILITY` | HIGH / MEDIUM / LOW | Nested polygons of flooding probability (high ⊂ medium ⊂ low) |
| `DEPTH` | HIGH / MEDIUM / LOW | Nested polygons of flood depth per location (same nesting) |

Each level has a `serializedPolygonId` that can be fetched as KML via the `serializedPolygons` endpoint.

The FloodHub web UI shows per-gauge support as:
- **"Sometimes"** — inundation maps are generated during active flooding (e.g. `hybas_5120623440`)
- **"Not supported"** — no inundation maps available for this gauge (e.g. `hybas_5120086640`)

**Current status**: As of April 2026, zero gauges globally return inundation data — including 189 SEVERE gauges in Turkey, 284 SEVERE/EXTREME in the USA, and 310 elevated in Brazil. This appears to be a computationally expensive product that Google generates only for select gauges during significant flood events. The ETL should check for `inundationMapSet` on every poll and render the polygons when they appear, but operators should not expect them to be consistently available.

When present, the ETL will render inundation maps as nested semi-transparent polygons:
- HIGH probability/depth → red fill (40% opacity)
- MEDIUM → orange fill (40% opacity)
- LOW → yellow fill (40% opacity)

## Basin Polygons

The HydroBASINS catchment polygons visible in the FloodHub web UI are **not available** through this API. The `serializedPolygons` endpoint only returns polygons for:
- Flash flood event areas (likely/highly-likely affected zones)
- Inundation maps (only during active flooding at supported gauges)
- Significant event areas

To display basin boundaries, the [HydroBASINS dataset](https://www.hydrosheds.org/products/hydrobasins) from HydroSHEDS could be sourced separately and matched by the `hybas_` gauge ID prefix. This is out of scope for the initial implementation.

## License

TAK.NZ is distributed under [AGPL-3.0-only](LICENSE)  
Copyright (C) 2025 - Christian Elsen, Team Awareness Kit New Zealand (TAK.NZ)
