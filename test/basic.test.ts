import test from 'node:test';
import assert from 'node:assert';
import { SchemaType, DataFlowType, InvocationType, StaticCapabilities, isValidPermission } from '@tak-ps/etl';

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
        assert.ok(isValidPermission(permission.resource), `Invalid permission: ${permission.resource}`);
    }
    assert.equal(doc.invocations.incoming?.schedule?.default.schedule, 'rate(2 minutes)');
});
