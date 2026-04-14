import { Type, TSchema } from '@sinclair/typebox';
import { fetch } from '@tak-ps/etl';
import ETL, { Event, SchemaType, handler as internal, local, InvocationType, DataFlowType } from '@tak-ps/etl';

const API_BASE = 'https://floodforecasting.googleapis.com/v1';
const ICONSET = 'bb4df0a6-ca8d-4ba8-bb9e-3deb97ff015e';

const SEVERITY_ORDER = ['NO_FLOODING', 'ABOVE_NORMAL', 'SEVERE', 'EXTREME'] as const;
type Severity = typeof SEVERITY_ORDER[number] | 'UNKNOWN';

const SEVERITY_ICONS: Record<string, string> = {
    'NO_FLOODING': `${ICONSET}:NaturalHazards/NH.01B.Flood.NoFlooding.png`,
    'ABOVE_NORMAL': `${ICONSET}:NaturalHazards/NH.01B.Flood.AboveNormal.png`,
    'SEVERE': `${ICONSET}:NaturalHazards/NH.01B.Flood.Severe.png`,
    'EXTREME': `${ICONSET}:NaturalHazards/NH.01B.Flood.Extreme.png`,
    'UNKNOWN': `${ICONSET}:NaturalHazards/NH.01B.Flood.Unknown.png`
};

const SEVERITY_COT_TYPE: Record<string, string> = {
    'NO_FLOODING': 'a-f-G-E-W-F',
    'ABOVE_NORMAL': 'a-f-G-E-W-F',
    'SEVERE': 'a-f-G-E-W-F',
    'EXTREME': 'a-f-G-E-W-F',
    'UNKNOWN': 'a-f-G-E-W-F'
};

const FLASH_FLOOD_FILL = '#FF8918';
const SIGNIFICANT_EVENT_FILL = '#FF0000';
const POLYGON_OPACITY = 0.4;

const Environment = Type.Object({
    API_KEY: Type.String({
        description: 'Google Flood Forecasting API key'
    }),
    REGION_CODE: Type.String({
        default: 'NZ',
        description: 'ISO 3166 alpha-2 country code for area search. Leave empty to use BBOX instead.'
    }),
    BBOX: Type.String({
        default: '',
        description: 'Custom bounding box as minLat,minLon,maxLat,maxLon. Overrides REGION_CODE when set.'
    }),
    INCLUDE_UNVERIFIED: Type.Boolean({
        default: false,
        description: 'Include lower-confidence (non-quality-verified) gauges'
    }),
    INCLUDE_FLASH_FLOODS: Type.Boolean({
        default: true,
        description: 'Poll for flash flood events and render polygons'
    }),
    INCLUDE_SIGNIFICANT_EVENTS: Type.Boolean({
        default: true,
        description: 'Poll for significant high-impact events'
    }),
    FORECAST_DETAIL_THRESHOLD: Type.String({
        default: 'ABOVE_NORMAL',
        description: 'Minimum severity to fetch detailed 8-day forecast (NO_FLOODING, ABOVE_NORMAL, SEVERE, EXTREME)'
    }),
    GAUGE_REFRESH_HOURS: Type.Number({
        default: 24,
        description: 'Hours between gauge discovery refreshes'
    }),
    DEBUG: Type.Boolean({
        default: false,
        description: 'Log raw API responses'
    })
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

interface FloodStatus {
    gaugeId: string;
    issuedTime: string;
    forecastTimeRange?: { start: string; end: string };
    forecastTrend?: string;
    severity: Severity;
    source: string;
    gaugeLocation: { latitude: number; longitude: number };
    qualityVerified: boolean;
    inundationMapSet?: InundationMapSet;
}

interface InundationMapSet {
    inundationMaps: Array<{
        mapType: string;
        inundationMapLevels: Array<{
            level: string;
            serializedPolygonId: string;
        }>;
    }>;
}

interface GaugeModel {
    gaugeId: string;
    thresholds: { warningLevel: number; dangerLevel: number; extremeDangerLevel: number };
    gaugeValueUnit: string;
    qualityVerified: boolean;
}

interface GaugeInfo {
    gaugeId: string;
    gaugeLocation: { latitude: number; longitude: number };
    source: string;
    qualityVerified: boolean;
}

interface ForecastPoint {
    forecastTime: string;
    value: number;
}

interface FlashFloodEvent {
    id: string;
    startTime: string;
    endTime?: string;
    likelyAffectedArea?: { serializedPolygonId: string };
    highlyLikelyAffectedArea?: { serializedPolygonId: string };
    location?: { latitude: number; longitude: number };
}

interface SignificantEvent {
    id: string;
    title: string;
    startTime: string;
    endTime?: string;
    affectedPopulation?: number;
    affectedAreaKm2?: number;
    serializedPolygonId?: string;
    location?: { latitude: number; longitude: number };
    gaugeIds?: string[];
}

interface EphemeralState {
    gauges?: {
        lastRefresh: string;
        items: Record<string, { lat: number; lon: number; source: string; qualityVerified: boolean }>;
    };
    models?: Record<string, { warningLevel: number; dangerLevel: number; extremeDangerLevel: number; gaugeValueUnit: string }>;
}

type Feature = {
    id: string;
    type: 'Feature';
    properties: Record<string, unknown>;
    geometry: { type: 'Point'; coordinates: number[] } | { type: 'Polygon'; coordinates: number[][][] };
};

function severityIndex(s: string): number {
    const idx = SEVERITY_ORDER.indexOf(s as typeof SEVERITY_ORDER[number]);
    return idx >= 0 ? idx : -1;
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
            return Type.Object({});
        }
        return Type.Object({});
    }

    private buildAreaBody(env: { REGION_CODE: string; BBOX: string }): object {
        if (env.BBOX) {
            const [minLat, minLon, maxLat, maxLon] = env.BBOX.split(',').map(Number);
            return { boundingBox: { north: maxLat, south: minLat, east: maxLon, west: minLon } };
        }
        return { regionCode: env.REGION_CODE };
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

    private async refreshGauges(env: { REGION_CODE: string; BBOX: string; API_KEY: string; DEBUG: boolean }): Promise<{
        items: Record<string, { lat: number; lon: number; source: string; qualityVerified: boolean }>;
        models: Record<string, { warningLevel: number; dangerLevel: number; extremeDangerLevel: number; gaugeValueUnit: string }>;
    }> {
        const body = this.buildAreaBody(env);
        const data = await this.apiPost('gauges:searchGaugesByArea', body, env.API_KEY, env.DEBUG) as { gauges?: GaugeInfo[] };
        const gauges = data.gauges || [];
        console.log(`Discovered ${gauges.length} gauges`);

        const items: Record<string, { lat: number; lon: number; source: string; qualityVerified: boolean }> = {};
        const gaugeIds: string[] = [];
        for (const g of gauges) {
            if (!g.gaugeLocation) {
                console.warn(`Gauge ${g.gaugeId} has no location, skipping`);
                continue;
            }
            items[g.gaugeId] = {
                lat: g.gaugeLocation.latitude,
                lon: g.gaugeLocation.longitude,
                source: g.source,
                qualityVerified: g.qualityVerified
            };
            gaugeIds.push(g.gaugeId);
        }

        // Batch fetch gauge models (thresholds)
        const models: Record<string, { warningLevel: number; dangerLevel: number; extremeDangerLevel: number; gaugeValueUnit: string }> = {};
        const batchSize = 500;
        for (let i = 0; i < gaugeIds.length; i += batchSize) {
            const batch = gaugeIds.slice(i, i + batchSize);
            const ids = batch.map(id => `ids=${encodeURIComponent(id)}`).join('&');
            try {
                const modelData = await this.apiGet(`gaugeModels:batchGet?${ids}`, env.API_KEY, env.DEBUG) as { gaugeModels?: GaugeModel[] };
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

    private async fetchForecasts(gaugeId: string, apiKey: string, debug: boolean): Promise<ForecastPoint[]> {
        try {
            const data = await this.apiGet(`gauges/${encodeURIComponent(gaugeId)}:queryGaugeForecasts`, apiKey, debug) as {
                forecasts?: Array<{ forecastTime: string; value: number }>;
            };
            return data.forecasts || [];
        } catch (err) {
            console.warn(`Failed to fetch forecast for ${gaugeId}:`, err);
            return [];
        }
    }

    private async fetchFlashFloods(env: { REGION_CODE: string; BBOX: string; API_KEY: string; DEBUG: boolean }): Promise<FlashFloodEvent[]> {
        try {
            const body = this.buildAreaBody(env);
            const data = await this.apiPost('flashFloods:search', body, env.API_KEY, env.DEBUG) as { flashFloods?: FlashFloodEvent[] };
            return data.flashFloods || [];
        } catch (err) {
            console.warn('Failed to fetch flash floods:', err);
            return [];
        }
    }

    private async fetchSignificantEvents(apiKey: string, debug: boolean): Promise<SignificantEvent[]> {
        try {
            const data = await this.apiPost('significantEvents:search', {}, apiKey, debug) as { significantEvents?: SignificantEvent[] };
            return data.significantEvents || [];
        } catch (err) {
            console.warn('Failed to fetch significant events:', err);
            return [];
        }
    }

    private async fetchPolygonKml(polygonId: string, apiKey: string, debug: boolean): Promise<number[][][] | null> {
        try {
            const data = await this.apiGet(`serializedPolygons/${encodeURIComponent(polygonId)}`, apiKey, debug) as { kml?: string };
            if (!data.kml) return null;
            return this.parseKmlPolygon(data.kml);
        } catch (err) {
            console.warn(`Failed to fetch polygon ${polygonId}:`, err);
            return null;
        }
    }

    private parseKmlPolygon(kml: string): number[][][] | null {
        const coordsMatch = kml.match(/<coordinates>([\s\S]*?)<\/coordinates>/);
        if (!coordsMatch) return null;

        const points: number[][] = [];
        const pairs = coordsMatch[1].trim().split(/\s+/);
        for (const pair of pairs) {
            const parts = pair.split(',');
            if (parts.length >= 2) {
                const lon = parseFloat(parts[0]);
                const lat = parseFloat(parts[1]);
                if (!isNaN(lon) && !isNaN(lat)) points.push([lon, lat]);
            }
        }
        if (points.length < 3) return null;

        // Ensure closed
        if (points[0][0] !== points[points.length - 1][0] || points[0][1] !== points[points.length - 1][1]) {
            points.push([...points[0]]);
        }
        return [points];
    }

    private buildGaugeRemarks(
        status: FloodStatus,
        model: { warningLevel: number; dangerLevel: number; extremeDangerLevel: number; gaugeValueUnit: string } | undefined,
        forecasts: ForecastPoint[]
    ): string {
        const lines: string[] = [
            `Flood Gauge: ${status.gaugeId}`,
            `Severity: ${status.severity}`,
            ...(status.forecastTrend ? [`Trend: ${status.forecastTrend}`] : []),
            `Source: ${status.source}`,
            `Quality: ${status.qualityVerified ? 'Verified' : 'Lower-confidence'}`
        ];

        if (model) {
            lines.push('', 'Thresholds (m³/s):');
            lines.push(`  Warning: ${model.warningLevel.toFixed(1)}`);
            lines.push(`  Danger: ${model.dangerLevel.toFixed(1)}`);
            lines.push(`  Extreme: ${model.extremeDangerLevel.toFixed(1)}`);
        }

        if (forecasts.length > 0 && model) {
            lines.push('', 'Forecast (m³/s):');
            for (const f of forecasts) {
                const date = f.forecastTime.split('T')[0];
                const sev = classifySeverity(f.value, model);
                lines.push(`  ${date}: ${f.value.toFixed(1)}${sev ? ` ← ${sev}` : ''}`);
            }
        }

        lines.push('', `Forecast issued: ${status.issuedTime}`);
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
            const { items, models } = await this.refreshGauges(env);
            ephemeral.gauges = { lastRefresh: now.toISOString(), items };
            ephemeral.models = models;
            await this.setEphemeral(ephemeral);
        }

        const gaugeCache = ephemeral.gauges?.items || {};
        const modelCache = ephemeral.models || {};

        // Fetch flood status (primary polling target)
        const areaBody = this.buildAreaBody(env);
        const statusData = await this.apiPost('floodStatus:searchLatestFloodStatusByArea', areaBody, env.API_KEY, env.DEBUG) as {
            floodStatuses?: FloodStatus[];
        };
        const statuses = statusData.floodStatuses || [];
        console.log(`Fetched ${statuses.length} flood statuses`);

        // Filter by quality if configured
        const filtered = env.INCLUDE_UNVERIFIED ? statuses : statuses.filter(s => s.qualityVerified);
        console.log(`Processing ${filtered.length} gauges (${env.INCLUDE_UNVERIFIED ? 'all' : 'verified only'})`);

        // Determine which gauges need detailed forecasts
        const thresholdIdx = severityIndex(env.FORECAST_DETAIL_THRESHOLD);
        const forecastGaugeIds = filtered
            .filter(s => severityIndex(s.severity) >= thresholdIdx && thresholdIdx >= 0)
            .map(s => s.gaugeId);

        // Batch fetch forecasts for elevated gauges
        const forecastMap = new Map<string, ForecastPoint[]>();
        for (const gaugeId of forecastGaugeIds) {
            const forecasts = await this.fetchForecasts(gaugeId, env.API_KEY, env.DEBUG);
            if (forecasts.length > 0) forecastMap.set(gaugeId, forecasts);
        }
        if (forecastGaugeIds.length > 0) {
            console.log(`Fetched forecasts for ${forecastMap.size}/${forecastGaugeIds.length} elevated gauges`);
        }

        // Check for inundation maps on each status
        for (const status of filtered) {
            if (status.inundationMapSet?.inundationMaps) {
                for (const map of status.inundationMapSet.inundationMaps) {
                    for (const level of map.inundationMapLevels || []) {
                        const coords = await this.fetchPolygonKml(level.serializedPolygonId, env.API_KEY, env.DEBUG);
                        if (!coords) continue;
                        const fillColor = level.level === 'HIGH' ? '#FF0000' : level.level === 'MEDIUM' ? '#FF8918' : '#FFFF00';
                        features.push({
                            id: `floodhub-inundation-${status.gaugeId}-${map.mapType}-${level.level}`,
                            type: 'Feature',
                            properties: {
                                callsign: `Inundation: ${status.gaugeId} — ${map.mapType} ${level.level}`,
                                type: 'a-f-G-E-W-F',
                                stroke: fillColor,
                                'stroke-opacity': POLYGON_OPACITY,
                                'stroke-width': 2,
                                'stroke-style': 'solid',
                                'fill-opacity': POLYGON_OPACITY,
                                fill: fillColor
                            },
                            geometry: { type: 'Polygon', coordinates: coords }
                        });
                    }
                }
            }
        }

        // Build gauge point features
        for (const status of filtered) {
            if (!status.gaugeLocation) {
                console.warn(`Flood status for ${status.gaugeId} has no location, skipping`);
                continue;
            }
            const model = modelCache[status.gaugeId];
            const forecasts = forecastMap.get(status.gaugeId) || [];
            const remarks = this.buildGaugeRemarks(status, model, forecasts);
            const trendStr = status.forecastTrend ? ` (${status.forecastTrend})` : '';

            features.push({
                id: `floodhub-${status.gaugeId}`,
                type: 'Feature',
                properties: {
                    callsign: `Flood Gauge: ${status.gaugeId} — ${status.severity}${trendStr}`,
                    type: SEVERITY_COT_TYPE[status.severity] || 'a-f-G-E-W-F',
                    icon: SEVERITY_ICONS[status.severity] || SEVERITY_ICONS['UNKNOWN'],
                    time: status.issuedTime,
                    start: status.issuedTime,
                    stale: status.forecastTimeRange?.end || new Date(Date.now() + 24 * 3600000).toISOString(),
                    remarks,
                    metadata: {
                        gaugeId: status.gaugeId,
                        severity: status.severity,
                        trend: status.forecastTrend,
                        source: status.source,
                        qualityVerified: status.qualityVerified,
                        issuedTime: status.issuedTime
                    }
                },
                geometry: {
                    type: 'Point',
                    coordinates: [status.gaugeLocation.longitude, status.gaugeLocation.latitude]
                }
            });
        }

        // Flash floods
        if (env.INCLUDE_FLASH_FLOODS) {
            const flashFloods = await this.fetchFlashFloods(env);
            console.log(`Fetched ${flashFloods.length} flash flood events`);

            for (const ff of flashFloods) {
                const polygonId = ff.highlyLikelyAffectedArea?.serializedPolygonId || ff.likelyAffectedArea?.serializedPolygonId;
                if (polygonId) {
                    const coords = await this.fetchPolygonKml(polygonId, env.API_KEY, env.DEBUG);
                    if (coords) {
                        features.push({
                            id: `floodhub-flash-${polygonId}`,
                            type: 'Feature',
                            properties: {
                                callsign: `Flash Flood Event: ${ff.id}`,
                                type: 'a-f-G-E-W-F-F',
                                stroke: FLASH_FLOOD_FILL,
                                'stroke-opacity': POLYGON_OPACITY,
                                'stroke-width': 2,
                                'stroke-style': 'solid',
                                'fill-opacity': POLYGON_OPACITY,
                                fill: FLASH_FLOOD_FILL,
                                remarks: [
                                    `Flash Flood Event: ${ff.id}`,
                                    `Start: ${ff.startTime}`,
                                    ...(ff.endTime ? [`End: ${ff.endTime}`] : [])
                                ].join('\n')
                            },
                            geometry: { type: 'Polygon', coordinates: coords }
                        });
                    }
                }
            }
        }

        // Significant events
        if (env.INCLUDE_SIGNIFICANT_EVENTS) {
            const events = await this.fetchSignificantEvents(env.API_KEY, env.DEBUG);
            // Filter to configured region by checking if event has gauges in our cache
            const regionEvents = events.filter(e => {
                if (!e.gaugeIds || e.gaugeIds.length === 0) return true;
                return e.gaugeIds.some(id => gaugeCache[id]);
            });
            console.log(`Fetched ${events.length} significant events, ${regionEvents.length} relevant to region`);

            for (const evt of regionEvents) {
                if (evt.serializedPolygonId) {
                    const coords = await this.fetchPolygonKml(evt.serializedPolygonId, env.API_KEY, env.DEBUG);
                    if (coords) {
                        features.push({
                            id: `floodhub-event-${evt.serializedPolygonId}`,
                            type: 'Feature',
                            properties: {
                                callsign: `Significant Event: ${evt.title || evt.id}`,
                                type: 'a-f-G-E-W-F-S',
                                stroke: SIGNIFICANT_EVENT_FILL,
                                'stroke-opacity': POLYGON_OPACITY,
                                'stroke-width': 2,
                                'stroke-style': 'solid',
                                'fill-opacity': POLYGON_OPACITY,
                                fill: SIGNIFICANT_EVENT_FILL,
                                remarks: [
                                    `Significant Event: ${evt.title || evt.id}`,
                                    `Start: ${evt.startTime}`,
                                    ...(evt.endTime ? [`End: ${evt.endTime}`] : []),
                                    ...(evt.affectedPopulation ? [`Affected Population: ${evt.affectedPopulation.toLocaleString()}`] : []),
                                    ...(evt.affectedAreaKm2 ? [`Affected Area: ${evt.affectedAreaKm2.toFixed(1)} km²`] : [])
                                ].join('\n')
                            },
                            geometry: { type: 'Polygon', coordinates: coords }
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
