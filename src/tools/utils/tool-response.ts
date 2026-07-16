import type { BaseOperationArgs, OperationResult, OperationType } from '../../types/operations.js';
import { capitalizeFirst } from '../../utils/strings.js';

export interface ToolResponseConfig {
  resourceName: string;
  resourceTitle: string;
  sessionKeyOverrides?: string[];
  notes?: string[];
}

/** Threshold: lists/batches with this many items or fewer get full JSON payloads */
const COMPACT_THRESHOLD = 5;

/** Max sampled rows for time-series data */
const MAX_SAMPLED_ROWS = 50;

/** Key display fields per resource type for compact list views */
const LIST_SUMMARY_FIELDS: Record<string, string[]> = {
  device:          ['id', 'displayName', 'hostStatus'],
  deviceGroup:     ['id', 'name', 'parentId'],
  alert:           ['id', 'severity', 'monitorObjectName', 'resourceTemplateName'],
  website:         ['id', 'name', 'type', 'status'],
  websiteGroup:    ['id', 'name', 'parentId'],
  collector:       ['id', 'description', 'hostname', 'status'],
  collectorGroup:  ['id', 'name', 'numOfCollectors'],
  user:            ['id', 'username', 'email', 'status'],
  dashboard:       ['id', 'name', 'groupId'],
  deviceData:      ['id', 'dataSourceName', 'monitoringInstanceNumber'],
  deviceInstance:  ['id', 'name', 'description'],
  sdt:             ['id', 'type', 'sdtType', 'isEffective', 'comment'],
  opsnote:         ['id', 'note', 'createdBy', 'happenOnInSec'],
};

export function buildToolResponse<T>(
  args: BaseOperationArgs,
  result: OperationResult<T>,
  config: ToolResponseConfig
) {
  const summary = formatSummary(args.operation, result, config);
  const payload = buildPayload(args.operation, result, config);

  const content: Array<{ type: 'text'; text: string }> = [
    { type: 'text' as const, text: summary }
  ];

  if (payload) {
    content.push({ type: 'text' as const, text: payload });
  }

  return { content };
}

// ---------------------------------------------------------------------------
// Payload builder — operation-aware, size-aware
// ---------------------------------------------------------------------------

function buildPayload<T>(
  operation: OperationType,
  result: OperationResult<T>,
  config: ToolResponseConfig
): string | null {
  const cleaned = stripInternalFields(result);

  // Batch results (has summary with per-item results)
  if (cleaned.summary && cleaned.results) {
    return formatBatchPayload(cleaned, config);
  }

  // List results (has items array)
  if (cleaned.items && Array.isArray(cleaned.items)) {
    if (cleaned.items.length <= COMPACT_THRESHOLD) {
      return `Full LogicMonitor payload:\n${JSON.stringify(cleaned, null, 2)}`;
    }
    return formatListPayload(cleaned, config);
  }

  // Device data time-series (single item with dataPoints array)
  if (cleaned.data && config.resourceName === 'deviceData' && operation === 'get_data') {
    const data = cleaned.data as Record<string, unknown>;
    const dataPoints = data.dataPoints as Array<Record<string, unknown>> | undefined;
    if (dataPoints && dataPoints.length > MAX_SAMPLED_ROWS) {
      return formatDeviceDataPayload(cleaned);
    }
  }

  // Single-item results (get, create single, update single, delete)
  if (cleaned.data) {
    return `Full LogicMonitor payload:\n${JSON.stringify(cleaned, null, 2)}`;
  }

  // Fallback
  return `Full LogicMonitor payload:\n${JSON.stringify(cleaned, null, 2)}`;
}

// ---------------------------------------------------------------------------
// Strip internal fields (raw, meta, request) to reduce noise
// ---------------------------------------------------------------------------

function stripInternalFields<T>(result: OperationResult<T>): OperationResult<T> {
  const asRecord = result as unknown as Record<string, unknown>;
  const { raw: _raw, meta: _meta, request: _request, ...cleaned } = asRecord;

  // Also strip from nested batch results
  if (cleaned.results && Array.isArray(cleaned.results)) {
    cleaned.results = (cleaned.results as Array<Record<string, unknown>>).map(r => {
      const { raw: _rr, meta: _rm, diagnostics: _rd, ...itemCleaned } = r;
      return itemCleaned;
    });
  }

  return cleaned as unknown as OperationResult<T>;
}

// ---------------------------------------------------------------------------
// Compact list view — key fields as text table
// ---------------------------------------------------------------------------

function formatListPayload<T>(
  result: OperationResult<T>,
  config: ToolResponseConfig
): string {
  const items = result.items as Array<Record<string, unknown>>;
  const fields = LIST_SUMMARY_FIELDS[config.resourceName]
    ?? inferKeyFields(items[0]);

  const lines: string[] = [];
  lines.push(`Items (${items.length}${result.total && result.total > items.length ? ` of ${result.total}` : ''}):`);

  // Header
  lines.push(`| ${fields.join(' | ')} |`);

  // Rows
  for (const item of items) {
    const values = fields.map(f => formatCellValue(item[f]));
    lines.push(`| ${values.join(' | ')} |`);
  }

  // Session access hint
  const capitalized = capitalizeFirst(config.resourceName);
  lines.push('');
  lines.push(`Full item details available via: lm_session get key="last${capitalized}List" fields="<fieldNames>" or index=N for a specific item.`);

  return lines.join('\n');
}

function inferKeyFields(item: Record<string, unknown> | undefined): string[] {
  if (!item) return ['id'];
  const keys = Object.keys(item);
  // Always include id first, then pick the first 2 other fields
  const idFields = keys.filter(k => k === 'id');
  const otherFields = keys.filter(k => k !== 'id').slice(0, 2);
  return [...idFields, ...otherFields];
}

function formatCellValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

// ---------------------------------------------------------------------------
// Device data time-series — stats + sampled rows
// ---------------------------------------------------------------------------

function formatDeviceDataPayload<T>(result: OperationResult<T>): string {
  const data = result.data as Record<string, unknown>;
  const dataPoints = data.dataPoints as Array<Record<string, unknown>> | undefined;

  if (!dataPoints || dataPoints.length === 0) {
    return `Full LogicMonitor payload:\n${JSON.stringify(result, null, 2)}`;
  }

  const lines: string[] = [];
  const totalPoints = dataPoints.length;

  // Context info
  if (data.deviceName) lines.push(`Device: ${data.deviceName} (${data.deviceId})`);
  if (data.datasourceName) lines.push(`Datasource: ${data.datasourceName} (${data.datasourceId})`);
  if (data.instanceName) lines.push(`Instance: ${data.instanceName} (${data.instanceId})`);
  lines.push(`Data points: ${totalPoints} total`);
  lines.push('');

  // Extract metric names (all keys except timestamp fields)
  const metricNames = Object.keys(dataPoints[0]).filter(
    k => k !== 'timestampEpoch' && k !== 'timestampUTC' && k !== 'timestamp'
  );

  // Compute summary statistics per metric
  if (metricNames.length > 0) {
    lines.push('Summary statistics:');
    lines.push(`| Metric | Min | Max | Avg | Latest |`);

    for (const metric of metricNames) {
      const values = dataPoints
        .map(dp => dp[metric])
        .filter((v): v is number => typeof v === 'number' && !isNaN(v));

      if (values.length === 0) continue;

      const min = Math.min(...values).toFixed(2);
      const max = Math.max(...values).toFixed(2);
      const avg = (values.reduce((s, v) => s + v, 0) / values.length).toFixed(2);
      const latest = values[values.length - 1].toFixed(2);

      lines.push(`| ${metric} | ${min} | ${max} | ${avg} | ${latest} |`);
    }
    lines.push('');
  }

  // Sample data points at regular intervals
  const sampleInterval = Math.max(1, Math.ceil(totalPoints / MAX_SAMPLED_ROWS));
  const sampledPoints = dataPoints.filter((_, i) => i % sampleInterval === 0);

  const timestampKey = 'timestampUTC' in dataPoints[0] ? 'timestampUTC' : 'timestampEpoch';
  const displayFields = [timestampKey, ...metricNames];

  lines.push(`Sampled data (${sampledPoints.length} of ${totalPoints} points, every ${sampleInterval} intervals):`);
  lines.push(`| ${displayFields.join(' | ')} |`);

  for (const dp of sampledPoints) {
    const values = displayFields.map(f => formatCellValue(dp[f]));
    lines.push(`| ${values.join(' | ')} |`);
  }

  lines.push('');
  lines.push(`Full ${totalPoints}-point dataset stored in session. Retrieve with: lm_session get key="lastDeviceData" limit=N for more data points.`);

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Batch results — summary + failures only for large batches
// ---------------------------------------------------------------------------

function formatBatchPayload<T>(
  result: OperationResult<T>,
  config: ToolResponseConfig
): string {
  const results = result.results as Array<Record<string, unknown>> | undefined;
  if (!results || results.length <= COMPACT_THRESHOLD) {
    return `Full LogicMonitor payload:\n${JSON.stringify(result, null, 2)}`;
  }

  const lines: string[] = [];
  const failed = results.filter(r => !r.success);

  if (failed.length > 0) {
    lines.push(`Failed items (${failed.length}):`);
    lines.push('| index | id | error |');
    for (const item of failed) {
      const id = (item.data as Record<string, unknown>)?.id ?? item.index ?? '?';
      lines.push(`| ${item.index} | ${id} | ${item.error || 'Unknown error'} |`);
    }
    lines.push('');
  }

  const capitalized = capitalizeFirst(config.resourceName);
  lines.push(`Full per-item results stored in session. Retrieve with: lm_session get key="lastUpdated${capitalized}s" fields="id,displayName" or index=N.`);

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Summary text (unchanged logic, extracted for clarity)
// ---------------------------------------------------------------------------

function formatSummary<T>(
  operation: OperationType,
  result: OperationResult<T>,
  config: ToolResponseConfig
) {
  const lines: string[] = [];
  const status = result.success ? 'succeeded' : 'completed';
  lines.push(`${config.resourceTitle} ${operation} ${status}.`);

  const effect = describeEffect(result);
  if (effect) {
    lines.push(effect);
  }

  const sessionKeys = getSessionKeys(operation, result, config);
  if (sessionKeys.length > 0) {
    lines.push(`Session keys ready: ${sessionKeys.join(', ')}.`);
    lines.push('Reuse them via lm_session get or applyToPrevious to avoid duplicate queries.');
  }

  if (config.notes?.length) {
    lines.push(...config.notes);
  }

  if (lines.length === 1) {
    lines.push('See payload below for details.');
  }

  return lines.join('\n');
}

function describeEffect<T>(result: OperationResult<T>) {
  if (Array.isArray(result.items) && typeof result.total === 'number') {
    if (result.items.length < result.total) {
      return `Returned ${result.items.length} of ${result.total} total items.`;
    }
    return `Returned ${result.items.length} items.`;
  }
  if (Array.isArray(result.items)) {
    return `Returned ${result.items.length} items.`;
  }
  if (typeof result.total === 'number') {
    return `Total items reported: ${result.total}.`;
  }
  if (result.summary) {
    return `Batch summary: ${result.summary.succeeded}/${result.summary.total} succeeded.`;
  }
  if (result.data) {
    return 'Single resource payload stored in session.';
  }
  return undefined;
}

function getSessionKeys<T>(
  operation: OperationType,
  result: OperationResult<T>,
  config: ToolResponseConfig
) {
  if (Array.isArray(config.sessionKeyOverrides)) {
    return config.sessionKeyOverrides;
  }
  if (config.resourceName === 'session') {
    return [];
  }
  return deriveDefaultSessionKeys(operation, result, config.resourceName);
}

function deriveDefaultSessionKeys<T>(
  operation: OperationType,
  result: OperationResult<T>,
  resourceName: string
) {
  const keys: string[] = [];
  const capitalized = capitalizeFirst(resourceName);

  if (operation === 'list' && Array.isArray(result.items) && result.items.length > 0) {
    keys.push(`session.last${capitalized}List`, `session.last${capitalized}ListIds`);
  }

  if (operation === 'get' && result.data) {
    keys.push(`session.last${capitalized}`, `session.last${capitalized}Id`);
  }

  if (operation === 'create') {
    if (result.data) {
      keys.push(`session.lastCreated${capitalized}`, `session.last${capitalized}`);
    } else if (Array.isArray(result.items) && result.items.length > 0) {
      keys.push(`session.lastCreated${capitalized}s`);
    }
  }

  if (operation === 'update') {
    if (result.data) {
      keys.push(`session.lastUpdated${capitalized}`, `session.last${capitalized}`);
    } else if (Array.isArray(result.items) && result.items.length > 0) {
      keys.push(`session.lastUpdated${capitalized}s`);
    }
  }

  if (operation === 'delete' && result.data) {
    keys.push(`session.lastDeleted${capitalized}Id`);
  }

  return keys;
}
