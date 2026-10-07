import { Type, TSchema } from '@sinclair/typebox';
import { fetch } from '@tak-ps/etl';
import ETL, { Event, SchemaType, handler as internal, local, InvocationType, DataFlowType } from '@tak-ps/etl';

const API_BASE = 'https://floodforecasting.googleapis.com/v1';
const ICONSET = 'bb4df0a6-ca8d-4ba8-bb9e-3deb97ff015e';

const SEVERITY_ORDER = ['NO_FLOODING', 'ABOVE_NORMAL', 'SEVERE', 'EXTREME'] as const;
type Severity = typeof SEVERITY_ORDER[number] | 'UNKNOWN';

const FLOOD_ICON = `${ICONSET}:NaturalHazards/NH.01.Flood.png`;

const SEVERITY_COLORS: Record<string, string> = {
    'NO_FLOODING': '#00FF00',
    'ABOVE_NORMAL': '#FF7700',
    'SEVERE': '#FF0000',
    'EXTREME': '#7F007F',
    'UNKNOWN': '#777777'
};

const FLASH_FLOOD_FILL = '#FF7700';
const SIGNIFICANT_EVENT_FILL = '#FF0000';
const POLYGON_OPACITY = 0.4;
const PAGE_SIZE = 10000;
const LOWER_CONFIDENCE_OPACITY = 0.6;

// Lead-time tiers reflect the fact that forecast skill decreases the further out a prediction is.
// See: https://support.google.com/flood-hub/answer/15637389 and Google Research publications on
// reliable predictive horizon (typically ~4-7 days depending on gauge/basin type).
const LEAD_TIME_TIERS: Array<{ maxDays: number; label: string }> = [
    { maxDays: 2, label: 'Warning' },   // 0-2 days out: highest confidence
    { maxDays: 5, label: 'Watch' },     // 3-5 days out: moderate confidence
    { maxDays: Infinity, label: 'Outlook' } // 6+ days out: lowest confidence, indicative only
];

function leadTimeTier(issuedTime: string, targetTime: string): { days: number; label: string } {
    const issued = new Date(issuedTime).getTime();
    const target = new Date(targetTime).getTime();
    const days = Math.max(0, Math.round((target - issued) / 86400000));
    const tier = LEAD_TIME_TIERS.find(t => days <= t.maxDays) || LEAD_TIME_TIERS[LEAD_TIME_TIERS.length - 1];
    return { days, label: tier.label };
}

const Environment = Type.Object({
    'API_KEY': Type.String({
        description: 'Google Flood Forecasting API key'
    }),
    'REGION_CODE': Type.String({
        default: 'NZ',
        description: 'ISO 3166 alpha-2 country code for area search'
    }),
    'TIMEZONE': Type.String({
        default: 'Pacific/Auckland',
        description: 'IANA timezone name used for local time display alongside UTC in remarks/metadata (e.g. Pacific/Auckland, Australia/Sydney)'
    }),
    'INCLUDE_UNVERIFIED': Type.Boolean({
        default: false,
        description: 'Include lower-confidence (non-quality-verified) gauges'
    }),
    'HIDE_NORMAL': Type.Boolean({
        default: true,
        description: 'Hide gauges with NO FLOODING severity to reduce map clutter'
    }),
    'SHOW_BASIN_POLYGONS': Type.Boolean({
        default: false,
        description: 'Show notification polygons for elevated gauges, coloured by severity. WARNING: produces large payloads that may crash CloudTAK with many elevated gauges. Basin/catchment polygons from HydroBASINS are not available via the API.'
    }),
    'INCLUDE_FLASH_FLOODS': Type.Boolean({
        default: true,
        description: 'Poll for flash flood events and render polygons'
    }),
    'INCLUDE_SIGNIFICANT_EVENTS': Type.Boolean({
        default: true,
        description: 'Poll for significant high-impact events (area-wide flood events clustered from gauge discharge predictions exceeding danger thresholds, weighted by affected population/area) and render their impact polygons. Also cross-references covered gauges, tagging them [event] in callsign/remarks.'
    }),
    'FORECAST_DETAIL_THRESHOLD': Type.String({
        default: 'ABOVE_NORMAL',
        description: 'Minimum severity to fetch detailed forecast (NO_FLOODING, ABOVE_NORMAL, SEVERE, EXTREME)'
    }),
    'GAUGE_REFRESH_HOURS': Type.Number({
        default: 24,
        description: 'Hours between gauge discovery refreshes'
    }),
    'DEBUG': Type.Boolean({
        default: false,
        description: 'Log raw API responses'
    })
});

const OutputSchema = Type.Object({
    gaugeId: Type.String({ description: 'Unique gauge identifier (e.g. hybas_5120615530)' }),
    severity: Type.String({ description: 'Flood severity level (NO FLOODING, ABOVE NORMAL, SEVERE, EXTREME, UNKNOWN)' }),
    trend: Type.Optional(Type.String({ description: 'Forecast trend direction (RISE, FALL, STEADY)' })),
    source: Type.String({ description: 'Gauge data source (e.g. HYBAS)' }),
    qualityVerified: Type.Boolean({ description: 'Whether the gauge is quality-verified' }),
    leadTimeDays: Type.Optional(Type.Number({ description: 'Days between forecast issue time and the start of the forecast time range the headline severity refers to' })),
    leadTimeTier: Type.Optional(Type.String({ description: 'Confidence tier for the headline severity based on lead time: Warning (0-2d), Watch (3-5d), or Outlook (6+d). Forecast skill decreases at longer lead times.' })),
    issuedTimeUTC: Type.String({ description: 'Forecast issue time, raw ISO 8601 UTC' }),
    issuedTimeLocal: Type.String({ description: 'Forecast issue time, human-formatted local time (see TIMEZONE env var)' })
});

const EphemeralSchema = Type.Object({
    gauges: Type.Optional(Type.Object({
        lastRefresh: Type.String(),
        items: Type.Record(Type.String(), Type.Object({
            lat: Type.Number(),
            lon: Type.Number(),
            source: Type.String(),
            qualityVerified: Type.Boolean()
        }))
    })),
    models: Type.Optional(Type.Record(Type.String(), Type.Object({
        warningLevel: Type.Number(),
        dangerLevel: Type.Number(),
        extremeDangerLevel: Type.Number(),
        gaugeValueUnit: Type.String()
    })))
});

interface ValueChange {
    lowerBound: number;
    upperBound: number;
}

interface ForecastChange {
    valueChange?: ValueChange;
    referenceTimeRange?: { start: string; end: string };
}

interface FloodStatus {
    gaugeId: string;
    issuedTime: string;
    forecastTimeRange?: { start: string; end: string };
    forecastChange?: ForecastChange;
    forecastTrend?: string;
    severity: Severity;
    source: string;
    gaugeLocation?: { latitude: number; longitude: number };
    qualityVerified: boolean;
    inundationMapSet?: { inundationMaps: Array<{ mapType: string; inundationMapLevels: Array<{ level: string; serializedPolygonId: string }> }> };
    serializedNotificationPolygonId?: string;
}

interface GaugeModel {
    gaugeId: string;
    thresholds: { warningLevel: number; dangerLevel: number; extremeDangerLevel: number };
    gaugeValueUnit: string;
}

interface GaugeInfo {
    gaugeId: string;
    gaugeLocation?: { latitude: number; longitude: number };
    source: string;
    qualityVerified: boolean;
}

interface ForecastRange {
    forecastStartTime: string;
    forecastEndTime: string;
    value: number;
}

interface ForecastIssuance {
    issuedTime: string;
    forecastRanges: ForecastRange[];
}

// A forecast range annotated with its derived severity and the lead-time confidence tier
// implied by how far ahead of the issue time it falls.
interface TieredForecastRange extends ForecastRange {
    severity: string;
    leadDays: number;
    leadLabel: string;
}

interface FlashFloodEvent {
    forecastIssueTime: string;
    forecastPeriodHours: number;
    affectedCountryCodes: string[];
    likelyAffectedPolygonId?: string;
    highlyLikelyAffectedPolygonId?: string;
    eventPolygonId?: string;
}

interface SignificantEvent {
    eventInterval?: { startTime: string; minimumEndTime?: string };
    affectedCountryCodes?: string[];
    affectedPopulation?: number;
    areaKm2?: number;
    eventPolygonId?: string;
    gaugeIds?: string[];
}

interface EphemeralState {
    gauges?: {
        lastRefresh: string;
        items: Record<string, { lat: number; lon: number; source: string; qualityVerified: boolean }>;
    };
    models?: Record<string, { warningLevel: number; dangerLevel: number; extremeDangerLevel: number; gaugeValueUnit: string }>;
}

type PolygonGeometry = { type: 'Polygon'; coordinates: number[][][] };

type Feature = {
    id: string;
    type: 'Feature';
    properties: Record<string, unknown>;
    geometry: { type: 'Point'; coordinates: number[] } | PolygonGeometry;
};

function severityIndex(s: string): number {
    const idx = SEVERITY_ORDER.indexOf(s as typeof SEVERITY_ORDER[number]);
    return idx >= 0 ? idx : -1;
}

function displaySeverity(s: string): string {
    return s.replace(/_/g, ' ');
}

// Maps GaugeValueUnit (https://developers.google.com/flood-forecasting/rest/v1/gaugeModels)
// to a display unit for thresholds/forecasts. Most gauges use discharge (m³/s), but some
// (e.g. gauges using agency-set water levels, common in India/Bangladesh/Brazil) use meters —
// hardcoding "m³/s" would mislabel those.
function displayGaugeValueUnit(unit: string): string {
    switch (unit) {
        case 'METERS': return 'm';
        case 'CUBIC_METERS_PER_SECOND': return 'm³/s';
        default: return unit;
    }
}

// TAK.NZ date/time normalization standard: local date/time components are derived via
// Intl.DateTimeFormat with an IANA timeZone (configurable via the TIMEZONE env var, default
// Pacific/Auckland) so daylight-saving transitions are handled automatically — never hardcode
// a fixed UTC offset, it will be wrong for at least part of the year in DST-observing zones.
const DEFAULT_TIMEZONE = 'Pacific/Auckland';

interface TimezoneFormatters {
    date: Intl.DateTimeFormat;
    time: Intl.DateTimeFormat;
    tzName: Intl.DateTimeFormat;
    isoDate: Intl.DateTimeFormat;
}

// Intl.DateTimeFormat construction is relatively expensive and the same timezone is used
// repeatedly across a single run, so formatters are built once per distinct timezone string.
const formatterCache = new Map<string, TimezoneFormatters>();

function buildFormatters(timezone: string): TimezoneFormatters {
    return {
        date: new Intl.DateTimeFormat('en-NZ', { timeZone: timezone, day: '2-digit', month: '2-digit', year: 'numeric' }),
        time: new Intl.DateTimeFormat('en-NZ', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false }),
        tzName: new Intl.DateTimeFormat('en-NZ', { timeZone: timezone, timeZoneName: 'short' }),
        // en-CA gives YYYY-MM-DD ordering, used for local calendar dates in the forecast table
        // (Google's forecast ranges are UTC-midnight-aligned, so the local calendar date can
        // differ from the UTC one depending on the configured timezone's offset).
        isoDate: new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' })
    };
}

// Returns cached formatters for the given IANA timezone, falling back to DEFAULT_TIMEZONE (and
// warning once) if the configured value is not a recognized timezone name.
function getFormatters(timezone: string): TimezoneFormatters {
    const cached = formatterCache.get(timezone);
    if (cached) return cached;

    let formatters: TimezoneFormatters;
    try {
        formatters = buildFormatters(timezone);
    } catch (err) {
        console.warn(`Invalid TIMEZONE "${timezone}", falling back to ${DEFAULT_TIMEZONE}:`, err);
        formatters = timezone === DEFAULT_TIMEZONE ? buildFormatters('UTC') : getFormatters(DEFAULT_TIMEZONE);
    }

    formatterCache.set(timezone, formatters);
    return formatters;
}

// Relative time using floor (not round) so an event doesn't jump to the next unit a few
// seconds after crossing into it (e.g. "1 hour ago" a moment after the event happened).
function formatRelativeAgo(diffMs: number): string {
    const absMs = Math.abs(diffMs);
    const suffix = diffMs >= 0 ? 'ago' : 'from now';
    const minutes = Math.floor(absMs / 60000);
    const hours = Math.floor(absMs / 3600000);
    const days = Math.floor(absMs / 86400000);
    if (absMs < 3600000) return `${minutes} minute${minutes === 1 ? '' : 's'} ${suffix}`;
    if (absMs < 86400000) return `${hours} hour${hours === 1 ? '' : 's'} ${suffix}`;
    return `${days} day${days === 1 ? '' : 's'} ${suffix}`;
}

// Formats a raw ISO 8601 UTC timestamp into configured-timezone local time:
// "DD/MM/YYYY, HH:mm <TZ abbreviation> (<relative>)".
function formatTimeLocal(isoTime: string, timezone: string): string {
    const date = new Date(isoTime);
    if (isNaN(date.getTime())) return isoTime;

    const { date: dateFmt, time: timeFmt, tzName: tzNameFmt } = getFormatters(timezone);
    const tzName = tzNameFmt.formatToParts(date).find(p => p.type === 'timeZoneName')?.value || timezone;
    const ago = formatRelativeAgo(Date.now() - date.getTime());

    return `${dateFmt.format(date)}, ${timeFmt.format(date)} ${tzName} (${ago})`;
}

// Converts a raw ISO 8601 UTC timestamp to its configured-timezone calendar date (YYYY-MM-DD),
// so date-only display (e.g. the forecast table) reflects the day it falls on locally, not UTC.
function toLocalDate(isoTime: string, timezone: string): string {
    const date = new Date(isoTime);
    if (isNaN(date.getTime())) return isoTime;
    return getFormatters(timezone).isoDate.format(date);
}

// Returns the standard two "Time (UTC) / Time (Local)" remarks lines for a raw ISO 8601 timestamp.
// timeUTC is passed through unmodified (no 'Z' substitution) to stay strictly ISO 8601 parseable.
function formatTimeLines(isoTime: string, timezone: string): string[] {
    return [
        `Time (UTC): ${isoTime}`,
        `Time (Local): ${formatTimeLocal(isoTime, timezone)}`
    ];
}

function classifySeverity(value: number, model: { warningLevel: number; dangerLevel: number; extremeDangerLevel: number }): string {
    if (value >= model.extremeDangerLevel) return 'EXTREME';
    if (value >= model.dangerLevel) return 'SEVERE';
    if (value >= model.warningLevel) return 'ABOVE_NORMAL';
    return '';
}

export default class Task extends ETL {
    static name = 'etl-floodhub';
    static flow = [DataFlowType.Incoming];
    static invocation = [InvocationType.Schedule];

    async schema(type: SchemaType = SchemaType.Input, flow: DataFlowType = DataFlowType.Incoming): Promise<TSchema> {
        if (flow === DataFlowType.Incoming) {
            if (type === SchemaType.Input) return Environment;
            return OutputSchema;
        }
        return Type.Object({});
    }

    private async apiGet(path: string, apiKey: string, debug: boolean): Promise<unknown> {
        const url = `${API_BASE}/${path}${path.includes('?') ? '&' : '?'}key=${apiKey}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`API GET ${path}: ${res.status} ${res.statusText}`);
        const data = await res.json();
        if (debug) console.log(`DEBUG GET ${path}:`, JSON.stringify(data).slice(0, 500));
        return data;
    }

    private async apiPost(path: string, body: object, apiKey: string, debug: boolean): Promise<unknown> {
        const url = `${API_BASE}/${path}?key=${apiKey}`;
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        if (!res.ok) throw new Error(`API POST ${path}: ${res.status} ${res.statusText}`);
        const data = await res.json();
        if (debug) console.log(`DEBUG POST ${path}:`, JSON.stringify(data).slice(0, 500));
        return data;
    }

    private async paginatedPost<T>(path: string, baseBody: object, apiKey: string, debug: boolean, resultKey: string): Promise<T[]> {
        const results: T[] = [];
        let pageToken: string | undefined;
        do {
            const body = { ...baseBody, pageSize: PAGE_SIZE, ...(pageToken ? { pageToken } : {}) };
            const data = await this.apiPost(path, body, apiKey, debug) as Record<string, unknown>;
            const items = (data[resultKey] || []) as T[];
            results.push(...items);
            pageToken = data.nextPageToken as string | undefined;
        } while (pageToken);
        return results;
    }

    private async refreshGauges(env: { REGION_CODE: string; INCLUDE_UNVERIFIED: boolean; API_KEY: string; DEBUG: boolean }): Promise<{
        items: Record<string, { lat: number; lon: number; source: string; qualityVerified: boolean }>;
        models: Record<string, { warningLevel: number; dangerLevel: number; extremeDangerLevel: number; gaugeValueUnit: string }>;
    }> {
        const body = { regionCode: env.REGION_CODE, includeNonQualityVerified: env.INCLUDE_UNVERIFIED };
        const gauges = await this.paginatedPost<GaugeInfo>('gauges:searchGaugesByArea', body, env.API_KEY, env.DEBUG, 'gauges');
        console.log(`Discovered ${gauges.length} gauges`);

        const items: Record<string, { lat: number; lon: number; source: string; qualityVerified: boolean }> = {};
        const gaugeIds: string[] = [];
        for (const g of gauges) {
            // gaugeLocation may be absent on discovery — we'll get it from flood status
            if (g.gaugeLocation) {
                items[g.gaugeId] = {
                    lat: g.gaugeLocation.latitude,
                    lon: g.gaugeLocation.longitude,
                    source: g.source,
                    qualityVerified: g.qualityVerified
                };
            }
            gaugeIds.push(g.gaugeId);
        }

        // Batch fetch gauge models using names=gaugeModels/{id} format
        const models: Record<string, { warningLevel: number; dangerLevel: number; extremeDangerLevel: number; gaugeValueUnit: string }> = {};
        const batchSize = 50;
        for (let i = 0; i < gaugeIds.length; i += batchSize) {
            const batch = gaugeIds.slice(i, i + batchSize);
            const names = batch.map(id => `names=gaugeModels/${encodeURIComponent(id)}`).join('&');
            try {
                const modelData = await this.apiGet(`gaugeModels:batchGet?${names}`, env.API_KEY, env.DEBUG) as { gaugeModels?: GaugeModel[] };
                for (const m of modelData.gaugeModels || []) {
                    models[m.gaugeId] = {
                        warningLevel: m.thresholds.warningLevel,
                        dangerLevel: m.thresholds.dangerLevel,
                        extremeDangerLevel: m.thresholds.extremeDangerLevel,
                        gaugeValueUnit: m.gaugeValueUnit
                    };
                }
            } catch (err) {
                console.warn(`Failed to fetch gauge models batch ${i}:`, err);
            }
        }
        console.log(`Fetched ${Object.keys(models).length} gauge models`);

        return { items, models };
    }

    // Fetches forecast issuances for each of the given gauges, sorted ascending by issuedTime.
    // All issuances in the lookback window are retained (not just the newest) because
    // floodStatus lags behind queryGaugeForecasts: the severity we render is derived from a
    // specific issuance, and we must pair it with that same issuance's numbers rather than
    // whichever happens to be newest. See selectMatchingIssuance.
    private async fetchForecasts(gaugeIds: string[], apiKey: string, debug: boolean): Promise<Map<string, ForecastIssuance[]>> {
        const result = new Map<string, ForecastIssuance[]>();
        if (gaugeIds.length === 0) return result;

        const now = new Date();
        const lastWeek = new Date(now.getTime() - 7 * 86400000);
        const tomorrow = new Date(now.getTime() + 86400000);

        const batchSize = 500;
        for (let i = 0; i < gaugeIds.length; i += batchSize) {
            const batch = gaugeIds.slice(i, i + batchSize);
            const params = new URLSearchParams();
            for (const id of batch) params.append('gaugeIds', id);
            params.set('issuedTimeStart', lastWeek.toISOString().split('T')[0]);
            params.set('issuedTimeEnd', tomorrow.toISOString().split('T')[0]);

            try {
                const data = await this.apiGet(`gauges:queryGaugeForecasts?${params.toString()}`, apiKey, debug) as {
                    forecasts?: Record<string, { forecasts: ForecastIssuance[] }>;
                };
                if (data.forecasts) {
                    for (const [gaugeId, gaugeForecasts] of Object.entries(data.forecasts)) {
                        const issuances = (gaugeForecasts.forecasts || [])
                            .filter(f => f.forecastRanges?.length)
                            .sort((a, b) => (a.issuedTime || '').localeCompare(b.issuedTime || ''));
                        if (issuances.length) result.set(gaugeId, issuances);
                    }
                }
            } catch (err) {
                console.warn(`Failed to fetch forecasts batch ${i}:`, err);
            }
        }
        return result;
    }

    // Picks the forecast issuance that a given flood status was derived from, so severity, the
    // confidence tier and the forecast table all describe one forecast run.
    //
    // This matters because floodStatus:searchLatestFloodStatusByArea and
    // gauges:queryGaugeForecasts advance independently. Taking whichever forecast issuance is
    // newest can pair an older status severity with revised numbers, producing self-contradictory
    // output — e.g. an EXTREME headline above a table whose peak sits below the warning
    // threshold, because Google revised that day's forecast down between the two issuances.
    //
    // Selection is by nearest issuedTime. In practice status.issuedTime matches a forecast
    // issuedTime exactly (212/215 elevated NZ gauges when this was measured), and nearest
    // resolves to that exact issuance. When no exact match exists the status was derived from an
    // issuance the API does not return, and the temporally closest one is the best available
    // stand-in — notably better than clamping to "not newer", which can reach back many hours to
    // an unrelated issuance and reintroduce the contradiction it was meant to prevent.
    private selectMatchingIssuance(issuances: ForecastIssuance[], statusIssuedTime: string): ForecastIssuance | undefined {
        if (!issuances.length) return undefined;

        const target = Date.parse(statusIssuedTime);
        if (isNaN(target)) return issuances[issuances.length - 1];

        return issuances.reduce((best, candidate) =>
            Math.abs(Date.parse(candidate.issuedTime) - target) < Math.abs(Date.parse(best.issuedTime) - target)
                ? candidate
                : best
        );
    }

    // Annotates each forecast range in an issuance with its derived severity and the lead-time
    // confidence tier implied by how far ahead of the issue time it falls. Google's published
    // model-skill data shows forecast reliability decreasing with lead time, so the tier is what
    // conveys how much weight a given forecast day deserves.
    private buildTieredForecasts(
        issuance: ForecastIssuance | undefined,
        model: { warningLevel: number; dangerLevel: number; extremeDangerLevel: number }
    ): TieredForecastRange[] {
        if (!issuance) return [];

        return issuance.forecastRanges.map(range => {
            const severity = classifySeverity(range.value, model);
            const { days, label } = leadTimeTier(issuance.issuedTime, range.forecastStartTime || range.forecastEndTime);
            return { ...range, severity, leadDays: days, leadLabel: label };
        });
    }

    private async fetchFlashFloods(apiKey: string, debug: boolean): Promise<FlashFloodEvent[]> {
        try {
            return await this.paginatedPost<FlashFloodEvent>('flashFloods:search', {}, apiKey, debug, 'flashFloods');
        } catch (err) {
            console.warn('Failed to fetch flash floods:', err);
            return [];
        }
    }

    private async fetchSignificantEvents(apiKey: string, debug: boolean): Promise<SignificantEvent[]> {
        try {
            return await this.paginatedPost<SignificantEvent>('significantEvents:search', {}, apiKey, debug, 'significantEvents');
        } catch (err) {
            console.warn('Failed to fetch significant events:', err);
            return [];
        }
    }

    private async fetchPolygons(polygonId: string, apiKey: string, debug: boolean): Promise<PolygonGeometry[]> {
        try {
            const data = await this.apiGet(`serializedPolygons/${encodeURIComponent(polygonId)}`, apiKey, debug) as { kml?: string };
            if (!data.kml) return [];
            const parsed = this.parseKmlPolygons(data.kml);
            if (!parsed) return [];
            if (parsed.type === 'Polygon') return [parsed];
            return parsed.coordinates.map(c => ({ type: 'Polygon' as const, coordinates: c }));
        } catch (err) {
            console.warn(`Failed to fetch polygon ${polygonId}:`, err);
            return [];
        }
    }

    private parseCoordinateString(coordStr: string): number[][] {
        const points: number[][] = [];
        const pairs = coordStr.trim().split(/\s+/);
        for (const pair of pairs) {
            const parts = pair.split(',');
            if (parts.length >= 2) {
                const lon = parseFloat(parts[0]);
                const lat = parseFloat(parts[1]);
                if (!isNaN(lon) && !isNaN(lat)) points.push([lon, lat]);
            }
        }
        if (points.length >= 3 && (points[0][0] !== points[points.length - 1][0] || points[0][1] !== points[points.length - 1][1])) {
            points.push([...points[0]]);
        }
        return points;
    }

    private parseKmlPolygons(kml: string): { type: 'Polygon'; coordinates: number[][][] } | { type: 'MultiPolygon'; coordinates: number[][][][] } | null {
        // Extract all <Polygon> elements with their outer/inner boundaries
        const polygonRegex = /<Polygon>[\s\S]*?<outerBoundaryIs>[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>[\s\S]*?<\/outerBoundaryIs>([\s\S]*?)<\/Polygon>/g;
        const allPolygons: number[][][][] = [];

        let match;
        while ((match = polygonRegex.exec(kml)) !== null) {
            const outerRing = this.parseCoordinateString(match[1]);
            if (outerRing.length < 3) continue;

            const rings: number[][][] = [outerRing];

            // Extract inner boundaries (holes)
            const innerRegex = /<innerBoundaryIs>[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>[\s\S]*?<\/innerBoundaryIs>/g;
            let innerMatch;
            while ((innerMatch = innerRegex.exec(match[2])) !== null) {
                const innerRing = this.parseCoordinateString(innerMatch[1]);
                if (innerRing.length >= 3) rings.push(innerRing);
            }

            allPolygons.push(rings);
        }

        if (allPolygons.length === 0) {
            // Fallback: try simple <coordinates> extraction
            const coordsMatch = kml.match(/<coordinates>([\s\S]*?)<\/coordinates>/);
            if (!coordsMatch) return null;
            const points = this.parseCoordinateString(coordsMatch[1]);
            if (points.length < 3) return null;
            return { type: 'Polygon', coordinates: [points] };
        }

        if (allPolygons.length === 1) {
            return { type: 'Polygon', coordinates: allPolygons[0] };
        }

        return { type: 'MultiPolygon', coordinates: allPolygons };
    }

    private buildGaugeRemarks(
        status: FloodStatus,
        model: { warningLevel: number; dangerLevel: number; extremeDangerLevel: number; gaugeValueUnit: string } | undefined,
        tieredForecasts: TieredForecastRange[],
        headlineLeadTime: { days: number; label: string } | undefined,
        coveredBySignificantEvent: boolean,
        timezone: string,
        forecastIssuedTime: string | undefined
    ): string {
        const lines: string[] = [
            `Flood Gauge: ${status.gaugeId}`,
            `Severity: ${displaySeverity(status.severity)}`,
            ...(headlineLeadTime ? [`Confidence: ${headlineLeadTime.label} (+${headlineLeadTime.days}d lead time)`] : []),
            ...(status.forecastTrend ? [`Trend: ${status.forecastTrend}`] : []),
            `Source: ${status.source}`,
            `Quality: ${status.qualityVerified ? 'Verified' : 'Lower-confidence'}`
        ];

        if (coveredBySignificantEvent) {
            lines.push('Note: gauge is also covered by a Significant Flood Event (see event polygon for area-wide impact)');
        }

        if (status.forecastChange?.valueChange) {
            const { lowerBound, upperBound } = status.forecastChange.valueChange;
            const sign = (n: number) => (n >= 0 ? '+' : '');
            lines.push(`Predicted change: ${sign(lowerBound)}${lowerBound}m to ${sign(upperBound)}${upperBound}m`);
        }

        if (model) {
            const unit = displayGaugeValueUnit(model.gaugeValueUnit);
            lines.push('', `Thresholds (${unit}):`);
            lines.push(`  Warning: ${model.warningLevel.toFixed(1)}`);
            lines.push(`  Danger: ${model.dangerLevel.toFixed(1)}`);
            lines.push(`  Extreme: ${model.extremeDangerLevel.toFixed(1)}`);
        }

        if (tieredForecasts.length > 0 && model) {
            lines.push('', `Forecast (${displayGaugeValueUnit(model.gaugeValueUnit)}):`);
            // Normally the table comes from the same issuance the severity was derived from. If
            // the API did not return that issuance we fall back to the nearest one, so surface
            // that rather than letting the numbers silently disagree with the headline severity.
            if (forecastIssuedTime && forecastIssuedTime !== status.issuedTime) {
                lines.push(`  Note: from a different forecast issuance (${forecastIssuedTime})`);
            }
            for (const f of tieredForecasts) {
                const targetTime = f.forecastStartTime || f.forecastEndTime;
                const date = targetTime ? toLocalDate(targetTime, timezone) : 'Unknown';
                const sevLabel = f.severity ? ` ← ${displaySeverity(f.severity)}` : '';
                lines.push(`  ${date} local (${f.leadLabel}, +${f.leadDays}d): ${f.value.toFixed(1)}${sevLabel}`);
            }
        }

        lines.push('', 'Forecast issued:', ...formatTimeLines(status.issuedTime, timezone));
        return lines.join('\n');
    }

    async control(): Promise<void> {
        const env = await this.env(Environment);
        const features: Feature[] = [];

        // Load ephemeral state for gauge cache
        let ephemeral: EphemeralState = {};
        try {
            ephemeral = await this.ephemeral(EphemeralSchema) as EphemeralState;
        } catch {
            console.warn('Ephemeral state invalid, starting fresh');
        }

        // Refresh gauge discovery if needed
        const now = new Date();
        const needsRefresh = !ephemeral.gauges?.lastRefresh ||
            (now.getTime() - new Date(ephemeral.gauges.lastRefresh).getTime()) > env.GAUGE_REFRESH_HOURS * 3600000;

        if (needsRefresh) {
            console.log('Refreshing gauge discovery...');
            try {
                const { items, models } = await this.refreshGauges(env);
                ephemeral.gauges = { lastRefresh: now.toISOString(), items };
                ephemeral.models = models;
                await this.setEphemeral(ephemeral);
            } catch (err) {
                console.warn('Gauge discovery failed (non-fatal):', err);
            }
        }

        const gaugeCache = ephemeral.gauges?.items || {};
        const modelCache = ephemeral.models || {};

        // Fetch flood status with pagination and includeNonQualityVerified
        const statusBody = {
            regionCode: env.REGION_CODE,
            includeNonQualityVerified: env.INCLUDE_UNVERIFIED
        };
        const statuses = await this.paginatedPost<FloodStatus>(
            'floodStatus:searchLatestFloodStatusByArea', statusBody, env.API_KEY, env.DEBUG, 'floodStatuses'
        );
        console.log(`Fetched ${statuses.length} flood statuses`);

        // Update gauge cache with locations from flood status (gauge discovery may not have them)
        for (const s of statuses) {
            if (s.gaugeLocation && !gaugeCache[s.gaugeId]) {
                gaugeCache[s.gaugeId] = {
                    lat: s.gaugeLocation.latitude,
                    lon: s.gaugeLocation.longitude,
                    source: s.source,
                    qualityVerified: s.qualityVerified
                };
            }
        }

        // Determine which gauges need detailed forecasts
        const thresholdIdx = severityIndex(env.FORECAST_DETAIL_THRESHOLD);
        const forecastGaugeIds = statuses
            .filter(s => severityIndex(s.severity) >= thresholdIdx && thresholdIdx >= 0)
            .map(s => s.gaugeId);

        // Batch fetch forecasts for elevated gauges. Each gauge maps to all issuances found in
        // the lookback window (not just the latest) so severity can be confirmed against Google's
        // own forecast reissuance history rather than state we'd otherwise have to persist ourselves.
        const forecastMap = await this.fetchForecasts(forecastGaugeIds, env.API_KEY, env.DEBUG);
        if (forecastGaugeIds.length > 0) {
            console.log(`Fetched forecasts for ${forecastMap.size}/${forecastGaugeIds.length} elevated gauges`);
        }

        // Fetch significant events up front (global endpoint, filter client-side) so gauge
        // rendering below can de-emphasize gauges already covered by an area-wide event —
        // Google's own guidance is that event-based alerting is more reliable than single-gauge
        // alerting for the most severe cases (see support.google.com/flood-hub/answer/16364605).
        let regionEvents: SignificantEvent[] = [];
        const gaugeIdsInSignificantEvents = new Set<string>();
        if (env.INCLUDE_SIGNIFICANT_EVENTS) {
            const allEvents = await this.fetchSignificantEvents(env.API_KEY, env.DEBUG);
            regionEvents = allEvents.filter(e => e.affectedCountryCodes?.includes(env.REGION_CODE));
            console.log(`Fetched ${allEvents.length} significant events, ${regionEvents.length} in region`);
            for (const evt of regionEvents) {
                for (const gid of evt.gaugeIds || []) gaugeIdsInSignificantEvents.add(gid);
            }
        }

        // Check for inundation maps
        for (const status of statuses) {
            if (status.inundationMapSet?.inundationMaps) {
                for (const map of status.inundationMapSet.inundationMaps) {
                    for (const level of map.inundationMapLevels || []) {
                        const polys = await this.fetchPolygons(level.serializedPolygonId, env.API_KEY, env.DEBUG);
                        const fillColor = level.level === 'HIGH' ? '#FF0000' : level.level === 'MEDIUM' ? '#FF8918' : '#FFFF00';
                        for (let pi = 0; pi < polys.length; pi++) {
                            features.push({
                                id: `floodhub-inundation-${status.gaugeId}-${map.mapType}-${level.level}-${pi}`,
                                type: 'Feature',
                                properties: {
                                    callsign: `Inundation: ${status.gaugeId} — ${map.mapType} ${level.level}`,
                                    type: 'a-f-X-i-m-f',
                                    stroke: fillColor, 'stroke-opacity': POLYGON_OPACITY, 'stroke-width': 2, 'stroke-style': 'solid',
                                    'fill-opacity': POLYGON_OPACITY, fill: fillColor,
                                    metadata: {
                                        type: 'inundation',
                                        gaugeId: status.gaugeId,
                                        mapType: map.mapType,
                                        level: level.level
                                    }
                                },
                                geometry: polys[pi]
                            });
                        }
                    }
                }
            }
        }

        // Render basin/notification polygons for elevated gauges
        if (env.SHOW_BASIN_POLYGONS) {
            let basinCount = 0;
            for (const status of statuses) {
                if (status.severity === 'NO_FLOODING' || status.severity === 'UNKNOWN') continue;
                if (!status.serializedNotificationPolygonId) continue;
                const polys = await this.fetchPolygons(status.serializedNotificationPolygonId, env.API_KEY, env.DEBUG);
                const color = SEVERITY_COLORS[status.severity] || SEVERITY_COLORS['UNKNOWN'];
                const model = modelCache[status.gaugeId];
                const matchedIssuance = this.selectMatchingIssuance(forecastMap.get(status.gaugeId) || [], status.issuedTime);
                const tieredForecasts = model
                    ? this.buildTieredForecasts(matchedIssuance, model)
                    : [];
                const coveredBySignificantEvent = gaugeIdsInSignificantEvents.has(status.gaugeId);
                const headlineLeadTime = status.forecastTimeRange?.start
                    ? leadTimeTier(status.issuedTime, status.forecastTimeRange.start)
                    : undefined;
                for (let pi = 0; pi < polys.length; pi++) {
                    features.push({
                        id: `floodhub-basin-${status.gaugeId}-${pi}`,
                        type: 'Feature',
                        properties: {
                            callsign: `Flood Basin: ${displaySeverity(status.severity)}`,
                            type: 'a-f-X-i-m-f',
                            stroke: color, 'stroke-opacity': POLYGON_OPACITY, 'stroke-width': 2, 'stroke-style': 'solid',
                            'fill-opacity': POLYGON_OPACITY, fill: color,
                            remarks: this.buildGaugeRemarks(
                                status, model, tieredForecasts, headlineLeadTime, coveredBySignificantEvent, env.TIMEZONE,
                                matchedIssuance?.issuedTime
                            ),
                            metadata: {
                                severity: status.severity,
                                gaugeId: status.gaugeId,
                                trend: status.forecastTrend,
                                source: status.source,
                                issuedTimeUTC: status.issuedTime,
                                issuedTimeLocal: formatTimeLocal(status.issuedTime, env.TIMEZONE),
                                leadTimeDays: headlineLeadTime?.days, leadTimeTier: headlineLeadTime?.label
                            }
                        },
                        geometry: polys[pi]
                    });
                }
                basinCount++;
            }
            if (basinCount > 0) console.log(`Rendered basin polygons for ${basinCount} elevated gauges`);
        }

        // Build gauge point features
        for (const status of statuses) {
            if (!status.gaugeLocation) continue;
            if (env.HIDE_NORMAL && status.severity === 'NO_FLOODING') continue;
            const model = modelCache[status.gaugeId];
            const matchedIssuance = this.selectMatchingIssuance(forecastMap.get(status.gaugeId) || [], status.issuedTime);
            const tieredForecasts = model
                ? this.buildTieredForecasts(matchedIssuance, model)
                : [];
            const coveredBySignificantEvent = gaugeIdsInSignificantEvents.has(status.gaugeId);
            const headlineLeadTime = status.forecastTimeRange?.start
                ? leadTimeTier(status.issuedTime, status.forecastTimeRange.start)
                : undefined;
            const remarks = this.buildGaugeRemarks(
                status, model, tieredForecasts, headlineLeadTime, coveredBySignificantEvent, env.TIMEZONE,
                matchedIssuance?.issuedTime
            );
            const trendStr = status.forecastTrend ? ` (${status.forecastTrend})` : '';
            const tierStr = headlineLeadTime ? ` [${headlineLeadTime.label}]` : '';
            const eventStr = coveredBySignificantEvent ? ' [event]' : '';

            features.push({
                id: `floodhub-${status.gaugeId}`,
                type: 'Feature',
                properties: {
                    callsign: `Flood Gauge — ${displaySeverity(status.severity)}${trendStr}${tierStr}${eventStr}`,
                    type: 'a-f-X-i-m-f',
                    icon: FLOOD_ICON,
                    'marker-color': SEVERITY_COLORS[status.severity] || SEVERITY_COLORS['UNKNOWN'],
                    // Lower-confidence (non-quality-verified) gauges are rendered more transparent
                    // to visually distinguish them from higher-confidence gauges on the map.
                    'marker-opacity': status.qualityVerified ? 1 : LOWER_CONFIDENCE_OPACITY,
                    time: status.issuedTime,
                    start: status.issuedTime,
                    stale: status.forecastTimeRange?.end || new Date(Date.now() + 24 * 3600000).toISOString(),
                    remarks,
                    metadata: {
                        gaugeId: status.gaugeId, severity: status.severity, trend: status.forecastTrend,
                        source: status.source, qualityVerified: status.qualityVerified,
                        issuedTimeUTC: status.issuedTime, issuedTimeLocal: formatTimeLocal(status.issuedTime, env.TIMEZONE),
                        coveredBySignificantEvent,
                        leadTimeDays: headlineLeadTime?.days, leadTimeTier: headlineLeadTime?.label
                    }
                },
                geometry: {
                    type: 'Point',
                    coordinates: [status.gaugeLocation.longitude, status.gaugeLocation.latitude]
                }
            });
        }

        // Flash floods (global endpoint, filter client-side)
        if (env.INCLUDE_FLASH_FLOODS) {
            const allFlashFloods = await this.fetchFlashFloods(env.API_KEY, env.DEBUG);
            const flashFloods = allFlashFloods.filter(ff => ff.affectedCountryCodes?.includes(env.REGION_CODE));
            console.log(`Fetched ${allFlashFloods.length} flash flood events, ${flashFloods.length} in region`);

            for (const ff of flashFloods) {
                const polygonId = ff.highlyLikelyAffectedPolygonId || ff.likelyAffectedPolygonId || ff.eventPolygonId;
                if (!polygonId) continue;
                const polys = await this.fetchPolygons(polygonId, env.API_KEY, env.DEBUG);
                for (let pi = 0; pi < polys.length; pi++) {
                    features.push({
                        id: `floodhub-flash-${polygonId}-${pi}`,
                        type: 'Feature',
                        properties: {
                            callsign: `Flash Flood: ${ff.affectedCountryCodes?.join(', ') || 'Unknown'}`,
                            type: 'a-f-X-i-m-f',
                            stroke: FLASH_FLOOD_FILL, 'stroke-opacity': POLYGON_OPACITY, 'stroke-width': 2, 'stroke-style': 'solid',
                            'fill-opacity': POLYGON_OPACITY, fill: FLASH_FLOOD_FILL,
                            remarks: [
                                'Flash Flood Event',
                                `Countries: ${ff.affectedCountryCodes?.join(', ') || 'Unknown'}`,
                                'Forecast issued:',
                                ...formatTimeLines(ff.forecastIssueTime, env.TIMEZONE),
                                `Forecast period: ${ff.forecastPeriodHours}h`
                            ].join('\n'),
                            metadata: {
                                type: 'flash_flood',
                                countries: ff.affectedCountryCodes || [],
                                forecastIssueTimeUTC: ff.forecastIssueTime,
                                forecastIssueTimeLocal: formatTimeLocal(ff.forecastIssueTime, env.TIMEZONE),
                                forecastPeriodHours: ff.forecastPeriodHours
                            }
                        },
                        geometry: polys[pi]
                    });
                }
            }
        }

        // Significant events (already fetched above so gauge rendering could cross-reference them)
        if (env.INCLUDE_SIGNIFICANT_EVENTS) {
            for (const evt of regionEvents) {
                const countries = evt.affectedCountryCodes?.join(', ') || 'Unknown';
                const remarkLines = [
                    'Significant Flood Event',
                    `Countries: ${countries}`,
                    ...(evt.eventInterval?.startTime ? ['Start:', ...formatTimeLines(evt.eventInterval.startTime, env.TIMEZONE)] : []),
                    ...(evt.eventInterval?.minimumEndTime ? ['Min end:', ...formatTimeLines(evt.eventInterval.minimumEndTime, env.TIMEZONE)] : []),
                    ...(evt.affectedPopulation ? [`Affected Population: ${evt.affectedPopulation.toLocaleString()}`] : []),
                    ...(evt.areaKm2 ? [`Affected Area: ${evt.areaKm2.toFixed(1)} km²`] : []),
                    ...(evt.gaugeIds?.length ? [`Gauges: ${evt.gaugeIds.length}`] : [])
                ];

                // Render event polygon if available
                if (evt.eventPolygonId) {
                    const polys = await this.fetchPolygons(evt.eventPolygonId, env.API_KEY, env.DEBUG);
                    for (let pi = 0; pi < polys.length; pi++) {
                        features.push({
                            id: `floodhub-event-${evt.eventPolygonId}-${pi}`,
                            type: 'Feature',
                            properties: {
                                callsign: `Significant Flood Event: ${countries}`,
                                type: 'a-f-X-i-m-f',
                                stroke: SIGNIFICANT_EVENT_FILL, 'stroke-opacity': POLYGON_OPACITY, 'stroke-width': 2, 'stroke-style': 'solid',
                                'fill-opacity': POLYGON_OPACITY, fill: SIGNIFICANT_EVENT_FILL,
                                remarks: remarkLines.join('\n'),
                                metadata: {
                                    type: 'significant_event',
                                    countries: evt.affectedCountryCodes || [],
                                    startTimeUTC: evt.eventInterval?.startTime,
                                    startTimeLocal: evt.eventInterval?.startTime ? formatTimeLocal(evt.eventInterval.startTime, env.TIMEZONE) : undefined,
                                    minimumEndTimeUTC: evt.eventInterval?.minimumEndTime,
                                    minimumEndTimeLocal: evt.eventInterval?.minimumEndTime ? formatTimeLocal(evt.eventInterval.minimumEndTime, env.TIMEZONE) : undefined,
                                    affectedPopulation: evt.affectedPopulation,
                                    areaKm2: evt.areaKm2
                                }
                            },
                            geometry: polys[pi]
                        });
                    }
                }
            }
        }

        const fc = { type: 'FeatureCollection' as const, features };
        console.log(`ok - generated ${features.length} FloodHub features`);
        await this.submit(fc);
    }
}

await local(await Task.init(import.meta.url), import.meta.url);
export async function handler(event: Event = {}) {
    return await internal(await Task.init(import.meta.url), event);
}
