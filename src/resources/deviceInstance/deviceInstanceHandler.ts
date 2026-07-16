/**
 * Device Instance Resource Handler
 *
 * Write-side management of device datasource instances ("Add Monitored
 * Instance") and their instance groups, for manual DataSources (Active
 * Discovery OFF) such as PingMulti-.
 *
 * Operations:
 *  - create / update / delete            → monitored instances
 *  - list_groups / create_group / update_group → instance groups
 *
 * Instance *reads* live in lm_device_data.list_instances; this tool never
 * mutates device properties or AppliesTo — the caller guarantees the
 * DataSource already applies to the device.
 */

import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { ResourceHandler } from '../base/resourceHandler.js';
import { LogicMonitorClient } from '../../api/client.js';
import { SessionManager } from '../../session/sessionManager.js';
import { throwBatchFailure } from '../../utils/batchUtils.js';
import type {
  LMDeviceDatasource,
  LMDeviceDatasourceInstance,
  LMDeviceDatasourceInstanceGroup
} from '../../types/logicmonitor.js';
import type { OperationResult, OperationType } from '../../types/operations.js';
import {
  validateCreate,
  validateUpdate,
  validateDelete,
  validateCreateGroup,
  validateListGroups,
  validateUpdateGroup
} from './deviceInstanceZodSchemas.js';

type DeviceInstanceType = LMDeviceDatasourceInstance | LMDeviceDatasourceInstanceGroup;

/** Result of resolving a datasource target + running the AD guardrail. */
interface ResolvedTarget {
  deviceId: number;
  hdsId: number;
  datasource?: LMDeviceDatasource;
  warnings: string[];
}

export class DeviceInstanceHandler extends ResourceHandler<DeviceInstanceType> {
  constructor(
    client: LogicMonitorClient,
    sessionManager: SessionManager,
    sessionId?: string
  ) {
    super(
      {
        resourceType: 'deviceInstance',
        resourceName: 'deviceInstance',
        idField: 'id'
      },
      client,
      sessionManager,
      sessionId
    );
  }

  // ── Shared datasource resolution + Active Discovery guardrail ──────────

  /**
   * Resolve the target device-datasource (hdsId) from either a numeric hdsId
   * (fast path) or deviceId + exact dataSourceName (resolve path), then enforce
   * the Active Discovery guardrail. Always fetches the datasource object — even
   * on the fast path — so the guardrail runs regardless of how the caller
   * addressed the datasource (one GET is cheap insurance).
   */
  private async resolveTarget(args: {
    deviceId: number;
    hdsId?: number;
    dataSourceName?: string;
  }): Promise<ResolvedTarget> {
    const { deviceId, hdsId, dataSourceName } = args;
    let datasource: LMDeviceDatasource | undefined;
    let resolvedHdsId: number | undefined = hdsId;

    if (hdsId !== undefined) {
      // Fast path: still fetch the datasource to run the guardrail.
      try {
        const res = await this.client.getDeviceDatasource(deviceId, hdsId);
        datasource = res.data;
      } catch {
        // Guardrail data unavailable — proceed without it rather than blocking.
      }
    } else if (dataSourceName) {
      // Resolve path: exact dataSourceName match (NOT dataSourceDisplayName).
      const list = await this.client.listDeviceDatasources(deviceId, { autoPaginate: true });
      const matches = list.items.filter(ds => ds.dataSourceName === dataSourceName);
      if (matches.length === 0) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `No datasource named "${dataSourceName}" is applied to device ${deviceId}. ` +
          `Confirm the DataSource applies to the device (via lm_device) and that you passed the exact dataSourceName ` +
          `(e.g. "PingMulti-"), not the display name.`
        );
      }
      datasource = matches[0];
      resolvedHdsId = datasource.id;
    }

    if (resolvedHdsId === undefined) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Could not resolve a device-datasource id (hdsId). Provide hdsId or a valid dataSourceName.'
      );
    }

    const warnings: string[] = [];
    if (datasource) {
      // Hard guardrail: instances of an AD-managed datasource cannot be mutated via API.
      if (datasource.autoDiscovery === true) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `DataSource "${datasource.dataSourceName ?? resolvedHdsId}" on device ${deviceId} has Active Discovery ` +
          `enabled (autoDiscovery:true). Its instances are managed automatically and cannot be created, updated, ` +
          `or deleted via the API.`
        );
      }
      // Soft guardrail: single-instance datasource — proceed but warn.
      if (datasource.isMultiple === false) {
        warnings.push(
          `DataSource "${datasource.dataSourceName ?? resolvedHdsId}" is not a multi-instance datasource ` +
          `(isMultiple:false); adding instances may not behave as expected.`
        );
      }
    }

    return { deviceId, hdsId: resolvedHdsId, datasource, warnings };
  }

  /**
   * Resolve a wildValue to a numeric instance id within an hdsId.
   * wildValue is unique within a device-datasource.
   */
  private async resolveInstanceId(deviceId: number, hdsId: number, wildValue: string): Promise<number> {
    const list = await this.client.listDeviceDatasourceInstances(deviceId, hdsId, { autoPaginate: true });
    const match = list.items.find(i => i.wildValue === wildValue);
    if (!match) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `No instance with wildValue "${wildValue}" found under device ${deviceId} datasource ${hdsId}.`
      );
    }
    return match.id;
  }

  // ── Custom operation routing (group ops) ───────────────────────────────

  protected override async handleCustomOperation(
    operation: string,
    args: unknown
  ): Promise<OperationResult<DeviceInstanceType> | null> {
    switch (operation) {
      case 'list_groups':
        return this.handleListGroups(args);
      case 'create_group':
        return this.handleCreateGroup(args);
      case 'update_group':
        return this.handleUpdateGroup(args);
      default:
        return null;
    }
  }

  // ── Instance create ─────────────────────────────────────────────────────

  protected async handleCreate(args: unknown): Promise<OperationResult<DeviceInstanceType>> {
    const validated = validateCreate(args);
    const target = await this.resolveTarget(validated);
    const { instances, batchOptions } = validated;

    const batchResult = await this.processBatch(
      instances,
      async (item) => this.client.createDeviceDatasourceInstance(target.deviceId, target.hdsId, item),
      {
        maxConcurrent: batchOptions?.maxConcurrent || 5,
        continueOnError: batchOptions?.continueOnError ?? true,
        retryOnRateLimit: true
      }
    );

    const normalized = this.normalizeBatchResults(batchResult as never);

    // Single add (array of one) → surface the created instance directly.
    if (instances.length === 1) {
      const entry = normalized[0];
      if (!entry || !entry.success || !entry.data) {
        throwBatchFailure('Instance create', batchResult.results[0] as never);
      }
      const created = entry.data as LMDeviceDatasourceInstance;
      const result: OperationResult<DeviceInstanceType> = {
        success: true,
        data: created,
        raw: entry.raw ?? created,
        meta: entry.meta ?? undefined,
        request: this.withWarnings({ deviceId: target.deviceId, hdsId: target.hdsId }, target)
      };
      this.recordAndStore('create', result);
      return result;
    }

    // Batch add → per-item results.
    const result: OperationResult<DeviceInstanceType> = {
      success: batchResult.success,
      items: this.extractSuccessfulItems(normalized as never) as DeviceInstanceType[],
      summary: batchResult.summary,
      request: this.withWarnings({ batch: true, deviceId: target.deviceId, hdsId: target.hdsId, batchOptions }, target),
      results: normalized as never
    };
    this.recordAndStore('create', result);
    return result;
  }

  // ── Instance update ───────────────────────────────────────────────────

  protected async handleUpdate(args: unknown): Promise<OperationResult<DeviceInstanceType>> {
    const validated = validateUpdate(args);
    const target = await this.resolveTarget(validated);

    // validateUpdate guarantees instanceId or wildValue is present.
    const instanceId = validated.instanceId
      ?? await this.resolveInstanceId(target.deviceId, target.hdsId, validated.wildValue as string);

    const payload = this.buildInstanceUpdatePayload(validated);
    if (Object.keys(payload).length === 0) {
      throw new McpError(ErrorCode.InvalidParams, 'update requires at least one field to change.');
    }

    const apiResult = await this.client.updateDeviceDatasourceInstance(
      target.deviceId, target.hdsId, instanceId, payload
    );

    const result: OperationResult<DeviceInstanceType> = {
      success: true,
      data: apiResult.data,
      raw: apiResult.raw,
      meta: apiResult.meta,
      request: this.withWarnings({ deviceId: target.deviceId, hdsId: target.hdsId, instanceId }, target)
    };
    this.recordAndStore('update', result);
    return result;
  }

  // ── Instance delete ───────────────────────────────────────────────────

  protected async handleDelete(args: unknown): Promise<OperationResult<DeviceInstanceType>> {
    const validated = validateDelete(args);
    const target = await this.resolveTarget(validated);

    // Gather target instance ids from single or batch identifiers.
    const ids: number[] = [];
    if (validated.instanceId !== undefined) ids.push(validated.instanceId);
    if (validated.wildValue) ids.push(await this.resolveInstanceId(target.deviceId, target.hdsId, validated.wildValue));
    if (validated.instanceIds?.length) ids.push(...validated.instanceIds);
    if (validated.wildValues?.length) {
      for (const wv of validated.wildValues) {
        ids.push(await this.resolveInstanceId(target.deviceId, target.hdsId, wv));
      }
    }

    // Single delete → direct call.
    if (ids.length === 1) {
      const apiResult = await this.client.deleteDeviceDatasourceInstance(target.deviceId, target.hdsId, ids[0]);
      const result: OperationResult<DeviceInstanceType> = {
        success: true,
        data: { id: ids[0] } as LMDeviceDatasourceInstance,
        raw: apiResult.raw,
        meta: apiResult.meta,
        request: this.withWarnings({ deviceId: target.deviceId, hdsId: target.hdsId, instanceId: ids[0] }, target)
      };
      this.recordAndStore('delete', result);
      return result;
    }

    // Batch delete → N calls via processBatch.
    const batchOptions = validated.batchOptions;
    const batchResult = await this.processBatch(
      ids.map(id => ({ id })),
      async ({ id }) => this.client.deleteDeviceDatasourceInstance(target.deviceId, target.hdsId, id),
      {
        maxConcurrent: batchOptions?.maxConcurrent || 5,
        continueOnError: batchOptions?.continueOnError ?? true,
        retryOnRateLimit: true
      }
    );

    const normalized = this.normalizeBatchResults(batchResult as never);
    const result: OperationResult<DeviceInstanceType> = {
      success: batchResult.success,
      summary: batchResult.summary,
      request: this.withWarnings({ batch: true, deviceId: target.deviceId, hdsId: target.hdsId, instanceIds: ids, batchOptions }, target),
      results: normalized as never
    };
    this.recordAndStore('delete', result);
    return result;
  }

  // ── Instance group operations ─────────────────────────────────────────

  private async handleListGroups(args: unknown): Promise<OperationResult<DeviceInstanceType>> {
    const validated = validateListGroups(args);
    const target = await this.resolveTarget(validated);
    const { filter, size, offset, autoPaginate, fields } = validated;

    const apiResult = await this.client.listDeviceDatasourceInstanceGroups(target.deviceId, target.hdsId, {
      filter, size, offset, autoPaginate, fields
    });

    const result: OperationResult<DeviceInstanceType> = {
      success: true,
      total: apiResult.total,
      items: apiResult.items as DeviceInstanceType[],
      request: this.withWarnings({ deviceId: target.deviceId, hdsId: target.hdsId, filter, size, offset, fields }, target),
      meta: apiResult.meta,
      raw: apiResult.raw
    };
    this.recordAndStore('list_groups', result);
    return result;
  }

  private async handleCreateGroup(args: unknown): Promise<OperationResult<DeviceInstanceType>> {
    const validated = validateCreateGroup(args);
    const target = await this.resolveTarget(validated);

    const apiResult = await this.client.createDeviceDatasourceInstanceGroup(target.deviceId, target.hdsId, {
      name: validated.name,
      description: validated.description
    });

    const result: OperationResult<DeviceInstanceType> = {
      success: true,
      data: apiResult.data,
      raw: apiResult.raw,
      meta: apiResult.meta,
      request: this.withWarnings({ deviceId: target.deviceId, hdsId: target.hdsId }, target)
    };
    this.recordAndStore('create_group', result);
    return result;
  }

  private async handleUpdateGroup(args: unknown): Promise<OperationResult<DeviceInstanceType>> {
    const validated = validateUpdateGroup(args);
    const target = await this.resolveTarget(validated);

    const payload: Record<string, unknown> = {};
    if (validated.name !== undefined) payload.name = validated.name;
    if (validated.description !== undefined) payload.description = validated.description;
    if (Object.keys(payload).length === 0) {
      throw new McpError(ErrorCode.InvalidParams, 'update_group requires name or description to change.');
    }

    const apiResult = await this.client.updateDeviceDatasourceInstanceGroup(
      target.deviceId, target.hdsId, validated.groupId, payload
    );

    const result: OperationResult<DeviceInstanceType> = {
      success: true,
      data: apiResult.data,
      raw: apiResult.raw,
      meta: apiResult.meta,
      request: this.withWarnings({ deviceId: target.deviceId, hdsId: target.hdsId, groupId: validated.groupId }, target)
    };
    this.recordAndStore('update_group', result);
    return result;
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  /** Build a PATCH payload from update args, only including defined fields. */
  private buildInstanceUpdatePayload(input: {
    displayName?: string;
    newWildValue?: string;
    wildValue2?: string;
    groupId?: number;
    description?: string;
    disableAlerting?: boolean;
    stopMonitoring?: boolean;
    customProperties?: Array<{ name: string; value: string }>;
  }): Record<string, unknown> {
    const payload: Record<string, unknown> = {};
    if (input.displayName !== undefined) payload.displayName = input.displayName;
    if (input.newWildValue !== undefined) payload.wildValue = input.newWildValue;
    if (input.wildValue2 !== undefined) payload.wildValue2 = input.wildValue2;
    if (input.groupId !== undefined) payload.groupId = input.groupId;
    if (input.description !== undefined) payload.description = input.description;
    if (input.disableAlerting !== undefined) payload.disableAlerting = input.disableAlerting;
    if (input.stopMonitoring !== undefined) payload.stopMonitoring = input.stopMonitoring;
    if (Array.isArray(input.customProperties)) payload.customProperties = input.customProperties;
    return payload;
  }

  /** Attach any guardrail warnings to the request echo. */
  private withWarnings(request: Record<string, unknown>, target: ResolvedTarget): Record<string, unknown> {
    if (target.warnings.length > 0) {
      return { ...request, warnings: target.warnings };
    }
    return request;
  }

  /**
   * Map custom group operations onto standard session-storage buckets so
   * session keys populate consistently.
   */
  protected override storeInSession(operation: OperationType | string, result: OperationResult<DeviceInstanceType>): void {
    const operationMap: Record<string, OperationType> = {
      list_groups: 'list',
      create_group: 'create',
      update_group: 'update'
    };
    const standardOp = operationMap[operation] || (operation as OperationType);
    super.storeInSession(standardOp, result);
  }

  // ── Unused standard CRUD entry points ─────────────────────────────────

  protected async handleList(): Promise<OperationResult<DeviceInstanceType>> {
    throw new McpError(
      ErrorCode.MethodNotFound,
      'Use lm_device_data list_instances to read instances, or list_groups to read instance groups.'
    );
  }

  protected async handleGet(): Promise<OperationResult<DeviceInstanceType>> {
    throw new McpError(
      ErrorCode.MethodNotFound,
      'Use lm_device_data list_instances to read instances.'
    );
  }
}
