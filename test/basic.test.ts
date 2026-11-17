import test from 'node:test';
import assert from 'node:assert';
import { SchemaType, DataFlowType, InvocationType, StaticCapabilities, PERMISSIONS } from '@tak-ps/etl';

// task.ts calls Task.init() at module scope which requires an ETL environment,
// so these must be set before the dynamic import below
process.env.ETL_API = process.env.ETL_API || 'http://localhost:5001';
process.env.ETL_LAYER = process.env.ETL_LAYER || '1';
process.env.ETL_TOKEN = process.env.ETL_TOKEN || 'etl.test-token';

const { default: Task } = await import('../task.js');

test('Task static config', () => {
    assert.equal(Task.name, 'etl-floodhub');
    assert.deepEqual(Task.flow, [DataFlowType.Incoming]);
    assert.deepEqual(Task.invocation, [InvocationType.Schedule]);
});

test('Incoming Input schema', async () => {
    const task = await Task.init();
    const schema = await task.schema(SchemaType.Input, DataFlowType.Incoming);

    assert.equal(schema.type, 'object');
    for (const key of [
        'API_KEY',
        'REGION_CODE',
        'TIMEZONE',
        'INCLUDE_UNVERIFIED',
        'HIDE_NORMAL',
        'SHOW_BASIN_POLYGONS',
        'INCLUDE_FLASH_FLOODS',
        'INCLUDE_SIGNIFICANT_EVENTS',
        'FORECAST_DETAIL_THRESHOLD',
        'GAUGE_REFRESH_HOURS',
        'DEBUG'
    ]) {
        assert.ok(schema.properties[key], `Env schema missing property: ${key}`);
    }

    assert.equal(schema.properties.REGION_CODE.type, 'string');
    assert.equal(schema.properties.REGION_CODE.default, 'NZ');
    assert.equal(schema.properties.TIMEZONE.type, 'string');
    assert.equal(schema.properties.TIMEZONE.default, 'Pacific/Auckland');
    assert.equal(schema.properties.INCLUDE_UNVERIFIED.type, 'boolean');
    assert.equal(schema.properties.INCLUDE_UNVERIFIED.default, false);
    assert.equal(schema.properties.HIDE_NORMAL.type, 'boolean');
    assert.equal(schema.properties.HIDE_NORMAL.default, true);
    assert.equal(schema.properties.SHOW_BASIN_POLYGONS.type, 'boolean');
    assert.equal(schema.properties.SHOW_BASIN_POLYGONS.default, false);
    assert.equal(schema.properties.INCLUDE_FLASH_FLOODS.type, 'boolean');
    assert.equal(schema.properties.INCLUDE_FLASH_FLOODS.default, true);
    assert.equal(schema.properties.INCLUDE_SIGNIFICANT_EVENTS.type, 'boolean');
    assert.equal(schema.properties.INCLUDE_SIGNIFICANT_EVENTS.default, true);
    assert.equal(schema.properties.FORECAST_DETAIL_THRESHOLD.type, 'string');
    assert.equal(schema.properties.FORECAST_DETAIL_THRESHOLD.default, 'ABOVE_NORMAL');
    assert.equal(schema.properties.GAUGE_REFRESH_HOURS.type, 'number');
    assert.equal(schema.properties.GAUGE_REFRESH_HOURS.default, 24);
    assert.equal(schema.properties.DEBUG.type, 'boolean');
    assert.equal(schema.properties.DEBUG.default, false);
});

test('Incoming Output schema', async () => {
    const task = await Task.init();
    const schema = await task.schema(SchemaType.Output, DataFlowType.Incoming);

    assert.equal(schema.type, 'object');
    for (const key of [
        'gaugeId',
        'severity',
        'trend',
        'source',
        'qualityVerified',
        'leadTimeDays',
        'leadTimeTier',
        'issuedTimeUTC',
        'issuedTimeLocal'
    ]) {
        assert.ok(schema.properties[key], `Output schema missing property: ${key}`);
    }

    assert.equal(schema.properties.qualityVerified.type, 'boolean');
});

test('Outgoing flow is not provided', async () => {
    const task = await Task.init();
    const schema = await task.schema(SchemaType.Input, DataFlowType.Outgoing);

    assert.deepEqual(schema.properties, {});
});

test('capabilities.json is a valid manifest matching the task', async () => {
    const doc = await StaticCapabilities.read(new URL('../capabilities.json', import.meta.url).pathname);

    assert.equal(doc.name, 'Google Flood Hub');
    assert.ok(doc.permissions.length > 0);
    for (const permission of doc.permissions) {
        // Resources are expressed as <permission>:<level>, where <level> may be a wildcard
        const [name, level] = permission.resource.split(':');
        assert.ok(PERMISSIONS[name], `Unknown permission: ${permission.resource}`);
        assert.ok(level === '*' || PERMISSIONS[name].includes(level), `Unknown permission level: ${permission.resource}`);
    }
    assert.equal(doc.invocations.incoming?.schedule?.default.schedule, 'rate(2 minutes)');
});

const {
    HIDDEN_MARKER_PROPERTIES, POLYGON_DEFAULT_STALE_MS, polygonStale, flashFloodEnd, polygonCentroid, centerFeature
} = await import('../task.js');
const { CoTParser } = await import('@tak-ps/node-cot');

const NOW = Date.parse('2030-01-01T00:00:00Z');
const RING = [[170, -43], [172, -43], [172, -45], [170, -45], [170, -43]];

test('polygonStale uses a future end time', () => {
    assert.equal(polygonStale('2030-01-02T00:00:00Z', NOW), '2030-01-02T00:00:00.000Z');
});

test('polygonStale falls back to 24h without a usable future end time', () => {
    const fallback = new Date(NOW + POLYGON_DEFAULT_STALE_MS).toISOString();
    assert.equal(polygonStale(undefined, NOW), fallback);
    assert.equal(polygonStale('not a date', NOW), fallback);
    assert.equal(polygonStale('2029-12-31T00:00:00Z', NOW), fallback, 'a past end would be dropped as stale');
});

test('flashFloodEnd adds the forecast period to the issue time', () => {
    assert.equal(flashFloodEnd('2030-01-01T00:00:00Z', 24), '2030-01-02T00:00:00.000Z');
    assert.equal(flashFloodEnd('garbage', 24), undefined);
    assert.equal(flashFloodEnd('2030-01-01T00:00:00Z', NaN), undefined);
});

test('polygonCentroid of a square is its middle', () => {
    assert.deepEqual(polygonCentroid([RING]).map((n) => Math.round(n * 1e6) / 1e6), [171, -44]);
});

test('centerFeature is an icon point carrying the polygon details', () => {
    const polygon = {
        id: 'floodhub-flash-x-0',
        type: 'Feature' as const,
        properties: { callsign: 'Flash Flood', type: 'a-f-X-i-m-f', remarks: 'r', metadata: { a: 1 }, stale: '2030-01-02T00:00:00.000Z' },
        geometry: { type: 'Polygon' as const, coordinates: [RING] }
    };
    const center = centerFeature(polygon, 'set:flood.png', '#FF7700');
    assert.equal(center.id, 'floodhub-flash-x-0-center');
    assert.equal(center.geometry.type, 'Point');
    assert.equal(center.properties.icon, 'set:flood.png');
    assert.equal(center.properties['marker-color'], '#FF7700');
    assert.equal(center.properties.remarks, 'r');
    assert.equal(center.properties.stale, polygon.properties.stale);
});

test('Polygon marker converts to an invisible, expiring marker with a polyline', async () => {
    const stale = polygonStale(undefined, Date.now());
    const cot = await CoTParser.from_geojson({
        id: 'floodhub-basin-g-0',
        type: 'Feature',
        properties: {
            callsign: 'Flood Basin', type: 'a-f-X-i-m-f', stale, ...HIDDEN_MARKER_PROPERTIES,
            stroke: '#ff0000', 'stroke-opacity': 0.4, fill: '#ff0000', 'fill-opacity': 0.4
        },
        geometry: { type: 'Polygon', coordinates: [RING] }
    } as never);
    const event = cot.raw.event;

    // A u-d-f drawing would never expire in ATAK
    assert.equal(event._attributes.type, 'a-f-X-i-m-f');
    assert.equal(event._attributes.stale, stale);
    assert.ok(event.detail.shape?.polyline, 'detail.shape.polyline is set');

    // A usericon makes ATAK delete the polygon; alpha 0 hides the "?" marker
    assert.equal(event.detail.usericon, undefined);
    const argb = Number(event.detail.color?._attributes?.argb);
    assert.ok(Number.isFinite(argb));
    assert.equal((argb >>> 24) & 0xff, 0);
});
