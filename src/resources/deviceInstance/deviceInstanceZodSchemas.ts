/**
 * Device Instance Zod validation schemas
 *
 * Write-side operations for device datasource instances ("Add Monitored
 * Instance") and their instance groups. Applies only to manual DataSources
 * (Active Discovery OFF), e.g. PingMulti-. Instance *reads* live in
 * lm_device_data.list_instances; this tool owns the mutations.
 */

import { z } from 'zod';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

// A single {name,value} custom property (instance-level property / ILP).
const CustomPropertySchema = z.object({
  name: z.string().describe('Property name'),
  value: z.string().describe('Property value')
});

// Batch execution controls, shared with the rest of the repo.
const BatchOptionsSchema = z.object({
  maxConcurrent: z.number().min(1).max(50).optional().describe('Max parallel API requests (default 5)'),
  continueOnError: z.boolean().optional().describe('If true, continue processing remaining items when one fails (default true)'),
  dryRun: z.boolean().optional().describe('If true, validate inputs without executing the operation')
}).describe('Options for controlling batch operation behavior');

// Datasource-target fields shared by every operation. Callers pass EITHER a
// numeric hdsId (fast path) OR deviceId + exact dataSourceName (resolve path).
const targetFields = {
  deviceId: z.number().describe('Device ID that owns the datasource (always required)'),
  hdsId: z.number().optional().describe('Numeric device-datasource id (the "id" from lm_device_data list_datasources). Fast path.'),
  dataSourceName: z.string().optional().describe('Exact dataSourceName (e.g. "PingMulti-", "HTTP_Page-") to resolve the hdsId. NOT dataSourceDisplayName. Used when hdsId is not supplied.')
};

// A single instance payload for create.
const InstanceCreateItemSchema = z.object({
  displayName: z.string().describe('Instance display name (required)'),
  wildValue: z.string().describe('Instance discriminator (required). For PingMulti- this is the ping target IP/DNS. Unique within an hdsId.'),
  wildValue2: z.string().optional().describe('Second discriminator for two-part instances'),
  groupId: z.number().optional().describe('Numeric instance-group id. Omit for the @default group. No name resolution or auto-create — use list_groups/create_group first.'),
  description: z.string().optional().describe('Instance description'),
  disableAlerting: z.boolean().optional().describe('Disable alerting for this instance'),
  stopMonitoring: z.boolean().optional().describe('Stop monitoring this instance'),
  customProperties: z.array(CustomPropertySchema).optional().describe('Instance-level properties [{name,value}]. Sent in the same create call.')
});

// create — batch array of instances (a single add is an array of one).
export const DeviceInstanceCreateArgsSchema = z.object({
  operation: z.literal('create').describe('The operation to perform'),
  ...targetFields,
  instances: z.array(InstanceCreateItemSchema).min(1).describe('Instances to create. A single add is an array of one; partial success reported per item.'),
  batchOptions: BatchOptionsSchema.optional()
}).strict();

// update — identify by instanceId OR wildValue, then apply mutable fields.
export const DeviceInstanceUpdateArgsSchema = z.object({
  operation: z.literal('update').describe('The operation to perform'),
  ...targetFields,
  instanceId: z.number().optional().describe('Numeric instance id (preferred identifier)'),
  wildValue: z.string().optional().describe('Instance wildValue — resolved to an id within the hdsId. Use when the id is unknown.'),
  displayName: z.string().optional().describe('New display name'),
  newWildValue: z.string().optional().describe('New wildValue (rename the discriminator)'),
  wildValue2: z.string().optional().describe('New second discriminator'),
  groupId: z.number().optional().describe('Move to this numeric instance-group id'),
  description: z.string().optional().describe('New description'),
  disableAlerting: z.boolean().optional().describe('Toggle alerting'),
  stopMonitoring: z.boolean().optional().describe('Toggle monitoring'),
  customProperties: z.array(CustomPropertySchema).optional().describe('Replace instance-level properties [{name,value}]')
}).strict();

// delete — single (instanceId | wildValue) or batch (instanceIds | wildValues).
export const DeviceInstanceDeleteArgsSchema = z.object({
  operation: z.literal('delete').describe('The operation to perform'),
  ...targetFields,
  instanceId: z.number().optional().describe('Numeric instance id to delete'),
  wildValue: z.string().optional().describe('wildValue of the instance to delete (resolved within the hdsId)'),
  instanceIds: z.array(z.number()).optional().describe('Batch: numeric instance ids to delete'),
  wildValues: z.array(z.string()).optional().describe('Batch: wildValues to delete (resolved within the hdsId)'),
  batchOptions: BatchOptionsSchema.optional()
}).strict();

// create_group
export const DeviceInstanceCreateGroupArgsSchema = z.object({
  operation: z.literal('create_group').describe('The operation to perform'),
  ...targetFields,
  name: z.string().describe('Instance group name (required)'),
  description: z.string().optional().describe('Instance group description')
}).strict();

// list_groups
export const DeviceInstanceListGroupsArgsSchema = z.object({
  operation: z.literal('list_groups').describe('The operation to perform'),
  ...targetFields,
  filter: z.string().optional().describe('LM filter expression, e.g. "name:prod"'),
  size: z.number().min(1).max(1000).optional().describe('Items per page (default 50, max 1000)'),
  offset: z.number().min(0).optional().describe('Number of items to skip for pagination (default 0)'),
  fields: z.string().optional().describe('Comma-separated fields to return, e.g. "id,name"'),
  autoPaginate: z.boolean().optional().describe('When true, fetch all pages automatically')
}).strict();

// update_group
export const DeviceInstanceUpdateGroupArgsSchema = z.object({
  operation: z.literal('update_group').describe('The operation to perform'),
  ...targetFields,
  groupId: z.number().describe('Numeric instance-group id to update (required)'),
  name: z.string().optional().describe('New group name'),
  description: z.string().optional().describe('New group description')
}).strict();

// Discriminated union across all operations.
export const DeviceInstanceOperationArgsSchema = z.discriminatedUnion('operation', [
  DeviceInstanceCreateArgsSchema,
  DeviceInstanceUpdateArgsSchema,
  DeviceInstanceDeleteArgsSchema,
  DeviceInstanceCreateGroupArgsSchema,
  DeviceInstanceListGroupsArgsSchema,
  DeviceInstanceUpdateGroupArgsSchema
]);

// Type exports
export type DeviceInstanceCreateArgs = z.infer<typeof DeviceInstanceCreateArgsSchema>;
export type DeviceInstanceUpdateArgs = z.infer<typeof DeviceInstanceUpdateArgsSchema>;
export type DeviceInstanceDeleteArgs = z.infer<typeof DeviceInstanceDeleteArgsSchema>;
export type DeviceInstanceCreateGroupArgs = z.infer<typeof DeviceInstanceCreateGroupArgsSchema>;
export type DeviceInstanceListGroupsArgs = z.infer<typeof DeviceInstanceListGroupsArgsSchema>;
export type DeviceInstanceUpdateGroupArgs = z.infer<typeof DeviceInstanceUpdateGroupArgsSchema>;
export type DeviceInstanceOperationArgs = z.infer<typeof DeviceInstanceOperationArgsSchema>;

// ── Validation helpers ─────────────────────────────────────────────────

function formatIssues(error: z.ZodError): never {
  throw new McpError(
    ErrorCode.InvalidParams,
    `Validation error: ${error.issues.map(e => `${String(e.path.join('.'))}: ${e.message}`).join(', ')}`
  );
}

/** Require that a datasource target is resolvable (hdsId OR dataSourceName). */
function requireTarget(args: { hdsId?: number; dataSourceName?: string }): void {
  if (args.hdsId === undefined && !args.dataSourceName) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'Provide either hdsId (numeric device-datasource id) or dataSourceName (exact) to identify the datasource.'
    );
  }
}

export function validateCreate(args: unknown) {
  const result = DeviceInstanceCreateArgsSchema.safeParse(args);
  if (!result.success) formatIssues(result.error);
  requireTarget(result.data);
  return result.data;
}

export function validateUpdate(args: unknown) {
  const result = DeviceInstanceUpdateArgsSchema.safeParse(args);
  if (!result.success) formatIssues(result.error);
  requireTarget(result.data);
  if (result.data.instanceId === undefined && !result.data.wildValue) {
    throw new McpError(ErrorCode.InvalidParams, 'update requires instanceId or wildValue to identify the instance.');
  }
  return result.data;
}

export function validateDelete(args: unknown) {
  const result = DeviceInstanceDeleteArgsSchema.safeParse(args);
  if (!result.success) formatIssues(result.error);
  requireTarget(result.data);
  const { instanceId, wildValue, instanceIds, wildValues } = result.data;
  if (instanceId === undefined && !wildValue && !instanceIds?.length && !wildValues?.length) {
    throw new McpError(ErrorCode.InvalidParams, 'delete requires instanceId, wildValue, instanceIds, or wildValues.');
  }
  return result.data;
}

export function validateCreateGroup(args: unknown) {
  const result = DeviceInstanceCreateGroupArgsSchema.safeParse(args);
  if (!result.success) formatIssues(result.error);
  requireTarget(result.data);
  return result.data;
}

export function validateListGroups(args: unknown) {
  const result = DeviceInstanceListGroupsArgsSchema.safeParse(args);
  if (!result.success) formatIssues(result.error);
  requireTarget(result.data);
  return result.data;
}

export function validateUpdateGroup(args: unknown) {
  const result = DeviceInstanceUpdateGroupArgsSchema.safeParse(args);
  if (!result.success) formatIssues(result.error);
  requireTarget(result.data);
  return result.data;
}
