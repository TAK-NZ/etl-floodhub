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
        description: 'Poll for significant high-impact events'
    }),
    'FORECAST_DETAIL_THRESHOLD': Type.String({
        default: 'ABOVE_NORMAL',
        description: 'Minimum severity to fetch detailed forecast (NO_FLOODING, ABOVE_NORMAL, SEVERE, EXTREME)'
    }),
    'GAUGE_REFRESH_HOURS': Type.Number({
        default: 24,
        description: 'Hours between gauge discovery refreshes'
    }),
    'MIN_CONFIRMING_ISSUANCES': Type.Number({
        default: 2,
        description: 'Minimum number of daily forecast issuances that must agree a threshold will be exceeded on a given date before it is treated as confirmed rather than preliminary. Helps avoid alerting on a single volatile forecast update, especially at longer lead times.'
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
    issuedTimeUTC: Type.String({ description: 'Forecast issue time, raw ISO 8601 UTC' }),
    issuedTimeLocal: Type.String({ description: 'Forecast issue time, human-formatted NZ local time' })
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

// A forecast range for a target date, annotated with how many of the most recent daily
// issuances agreed that a threshold-exceeding value would occur on that date.
interface ConfirmedForecastRange extends ForecastRange {
    severity: string;
    leadDays: number;
    leadLabel: string;
    agreeingIssuances: number;
    confirmed: boolean;
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

// TAK.NZ date/time normalization standard: NZ date/time components are derived via
// Intl.DateTimeFormat with timeZone: 'Pacific/Auckland' so NZST/NZDT transitions are handled
// automatically (never hardcode a +12/+13 offset — it will be wrong for half the year).
const NZ_DATE_FORMAT = new Intl.DateTimeFormat('en-NZ', {
    timeZone: 'Pacific/Auckland',
    day: '2-digit', month: '2-digit', year: 'numeric'
});
const NZ_TIME_FORMAT = new Intl.DateTimeFormat('en-NZ', {
    timeZone: 'Pacific/Auckland',
    hour: '2-digit', minute: '2-digit', hour12: false
});
const NZ_TZ_NAME_FORMAT = new Intl.DateTimeFormat('en-NZ', {
    timeZone: 'Pacific/Auckland',
    timeZoneName: 'short'
});

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

// Formats a raw ISO 8601 UTC timestamp into NZ local time: "DD/MM/YYYY, HH:mm <TZ> (<relative>)".
function formatTimeLocal(isoTime: string): string {
    const date = new Date(isoTime);
    if (isNaN(date.getTime())) return isoTime;

    const tzName = NZ_TZ_NAME_FORMAT.formatToParts(date).find(p => p.type === 'timeZoneName')?.value || 'NZT';
    const ago = formatRelativeAgo(Date.now() - date.getTime());

    return `${NZ_DATE_FORMAT.format(date)}, ${NZ_TIME_FORMAT.format(date)} ${tzName} (${ago})`;
}

// Returns the standard two "Time (UTC) / Time (NZ)" remarks lines for a raw ISO 8601 timestamp.
// timeUTC is passed through unmodified (no 'Z' substitution) to stay strictly ISO 8601 parseable.
function formatTimeLines(isoTime: string): string[] {
    return [
        `Time (UTC): ${isoTime}`,
        `Time (NZ): ${formatTimeLocal(isoTime)}`
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

    // Fetches forecasts for the given gauges. Returns ALL issuances found within the lookback
    // window (not just the latest), sorted ascending by issuedTime. Google reissues forecasts
    // daily, so retaining prior issuances lets us check whether multiple issuances agree on a
    // given future date before treating that prediction as confirmed (see buildConfirmedForecast).
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

    // Builds a confidence-annotated forecast table for the latest issuance, using prior
    // issuances (Google reissues forecasts daily) as a substitute for our own state history.
    // A target date's severity is only "confirmed" once at least `minConfirming` of the most
    // recent issuances independently agree that severity (or worse) will occur on that date.
    // This directly targets the "crying wolf" problem: a single volatile long-lead-time forecast
    // spike won't be presented with full confidence until it holds up across multiple daily runs.
    private buildConfirmedForecasts(
        issuances: ForecastIssuance[],
        model: { warningLevel: number; dangerLevel: number; extremeDangerLevel: number },
        minConfirming: number
    ): ConfirmedForecastRange[] {
        if (issuances.length === 0) return [];
        const latest = issuances[issuances.length - 1];
        const priorIssuances = issuances.slice(0, -1);

        return latest.forecastRanges.map(range => {
            const targetDate = (range.forecastStartTime || range.forecastEndTime || '').split('T')[0];
            const severity = classifySeverity(range.value, model);
            const severityIdx = severityIndex(severity || 'NO_FLOODING');
            const { days, label } = leadTimeTier(latest.issuedTime, range.forecastStartTime || range.forecastEndTime);

            // Nothing elevated forecasted for this date — trivially "confirmed" (no alert to overhype).
            if (!severity) {
                return { ...range, severity, leadDays: days, leadLabel: label, agreeingIssuances: 1, confirmed: true };
            }

            let agreeingIssuances = 1; // the latest issuance itself
            for (const prior of priorIssuances) {
                const match = prior.forecastRanges.find(r =>
                    (r.forecastStartTime || r.forecastEndTime || '').split('T')[0] === targetDate
                );
                if (!match) continue;
                const priorSeverity = classifySeverity(match.value, model);
                if (severityIndex(priorSeverity || 'NO_FLOODING') >= severityIdx) agreeingIssuances++;
            }

            return {
                ...range,
                severity,
                leadDays: days,
                leadLabel: label,
                agreeingIssuances,
                confirmed: agreeingIssuances >= minConfirming
            };
        });
    }

    // Determines whether the gauge's current headline severity is backed by a confirmed
    // (multi-issuance-agreed) forecast entry, or whether it rests on a still-preliminary one.
    // Gauges with no detailed forecast fetched (below FORECAST_DETAIL_THRESHOLD) have nothing to
    // second-guess against, so they're treated as confirmed — there's no elevated claim to hedge.
    private isSeverityConfirmed(status: FloodStatus, confirmedForecasts: ConfirmedForecastRange[]): boolean {
        if (confirmedForecasts.length === 0) return true;
        const statusIdx = severityIndex(status.severity);
        const supportingEntries = confirmedForecasts.filter(f => severityIndex(f.severity || 'NO_FLOODING') >= statusIdx);
        if (supportingEntries.length === 0) return true;
        return supportingEntries.some(f => f.confirmed);
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
        confirmedForecasts: ConfirmedForecastRange[],
        isConfirmed: boolean,
        minConfirming: number,
        coveredBySignificantEvent: boolean
    ): string {
        const lines: string[] = [
            `Flood Gauge: ${status.gaugeId}`,
            `Severity: ${displaySeverity(status.severity)}${isConfirmed ? '' : ' (preliminary — pending confirmation)'}`,
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
            lines.push('', 'Thresholds (m³/s):');
            lines.push(`  Warning: ${model.warningLevel.toFixed(1)}`);
            lines.push(`  Danger: ${model.dangerLevel.toFixed(1)}`);
            lines.push(`  Extreme: ${model.extremeDangerLevel.toFixed(1)}`);
        }

        if (confirmedForecasts.length > 0 && model) {
            lines.push('', 'Forecast (m³/s):');
            for (const f of confirmedForecasts) {
                const date = (f.forecastStartTime || f.forecastEndTime || '').split('T')[0] || 'Unknown';
                const sevLabel = f.severity ? ` ← ${displaySeverity(f.severity)}` : '';
                const confidenceLabel = !f.severity
                    ? ''
                    : f.confirmed
                        ? ' [confirmed]'
                        : ` [preliminary, ${f.agreeingIssuances}/${minConfirming} issuances]`;
                lines.push(`  ${date} (${f.leadLabel}, +${f.leadDays}d): ${f.value.toFixed(1)}${sevLabel}${confidenceLabel}`);
            }
        }

        lines.push('', 'Forecast issued:', ...formatTimeLines(status.issuedTime));
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
                const confirmedForecasts = model
                    ? this.buildConfirmedForecasts(forecastMap.get(status.gaugeId) || [], model, env.MIN_CONFIRMING_ISSUANCES)
                    : [];
                const isConfirmed = this.isSeverityConfirmed(status, confirmedForecasts);
                const coveredBySignificantEvent = gaugeIdsInSignificantEvents.has(status.gaugeId);
                for (let pi = 0; pi < polys.length; pi++) {
                    features.push({
                        id: `floodhub-basin-${status.gaugeId}-${pi}`,
                        type: 'Feature',
                        properties: {
                            callsign: `Flood Basin: ${displaySeverity(status.severity)}${isConfirmed ? '' : ' (preliminary)'}`,
                            type: 'a-f-X-i-m-f',
                            stroke: color, 'stroke-opacity': POLYGON_OPACITY, 'stroke-width': 2, 'stroke-style': 'solid',
                            'fill-opacity': isConfirmed ? POLYGON_OPACITY : POLYGON_OPACITY * 0.6, fill: color,
                            remarks: this.buildGaugeRemarks(
                                status, model, confirmedForecasts, isConfirmed, env.MIN_CONFIRMING_ISSUANCES, coveredBySignificantEvent
                            ),
                            metadata: {
                                severity: status.severity,
                                gaugeId: status.gaugeId,
                                trend: status.forecastTrend,
                                source: status.source,
                                issuedTimeUTC: status.issuedTime,
                                issuedTimeLocal: formatTimeLocal(status.issuedTime),
                                confirmed: isConfirmed
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
            const confirmedForecasts = model
                ? this.buildConfirmedForecasts(forecastMap.get(status.gaugeId) || [], model, env.MIN_CONFIRMING_ISSUANCES)
                : [];
            const isConfirmed = this.isSeverityConfirmed(status, confirmedForecasts);
            const coveredBySignificantEvent = gaugeIdsInSignificantEvents.has(status.gaugeId);
            const remarks = this.buildGaugeRemarks(
                status, model, confirmedForecasts, isConfirmed, env.MIN_CONFIRMING_ISSUANCES, coveredBySignificantEvent
            );
            const trendStr = status.forecastTrend ? ` (${status.forecastTrend})` : '';
            const preliminaryStr = isConfirmed ? '' : ' (preliminary)';
            const eventStr = coveredBySignificantEvent ? ' [event]' : '';

            features.push({
                id: `floodhub-${status.gaugeId}`,
                type: 'Feature',
                properties: {
                    callsign: `Flood Gauge — ${displaySeverity(status.severity)}${trendStr}${preliminaryStr}${eventStr}`,
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
                        issuedTimeUTC: status.issuedTime, issuedTimeLocal: formatTimeLocal(status.issuedTime),
                        confirmed: isConfirmed, coveredBySignificantEvent
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
                                ...formatTimeLines(ff.forecastIssueTime),
                                `Forecast period: ${ff.forecastPeriodHours}h`
                            ].join('\n'),
                            metadata: {
                                type: 'flash_flood',
                                countries: ff.affectedCountryCodes || [],
                                forecastIssueTimeUTC: ff.forecastIssueTime,
                                forecastIssueTimeLocal: formatTimeLocal(ff.forecastIssueTime),
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
                    ...(evt.eventInterval?.startTime ? ['Start:', ...formatTimeLines(evt.eventInterval.startTime)] : []),
                    ...(evt.eventInterval?.minimumEndTime ? ['Min end:', ...formatTimeLines(evt.eventInterval.minimumEndTime)] : []),
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
                                    startTimeLocal: evt.eventInterval?.startTime ? formatTimeLocal(evt.eventInterval.startTime) : undefined,
                                    minimumEndTimeUTC: evt.eventInterval?.minimumEndTime,
                                    minimumEndTimeLocal: evt.eventInterval?.minimumEndTime ? formatTimeLocal(evt.eventInterval.minimumEndTime) : undefined,
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

await local(new Task(import.meta.url), import.meta.url);
export async function handler(event: Event = {}) {
    return await internal(new Task(import.meta.url), event);
}
