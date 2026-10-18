export const ORIGINS = [
  'dashboard',
  'automation',
  'filemanager',
  'startup',
  'update',
  'internal',
  'flow',
  'quickrun',
] as const;

export type Origin = (typeof ORIGINS)[number];

export interface ExecutionScope {
  origin?: Origin;
  quick_run_id?: string;
  workflow_id?: string;
}

/** Execution ownership takes precedence over the source that launched it. */
export function getExecutionOrigin(item: ExecutionScope): Origin {
  if (item.workflow_id || item.origin === 'flow') return 'flow';
  if (item.quick_run_id || item.origin === 'quickrun') return 'quickrun';
  return item.origin ?? 'dashboard';
}

/** Dashboard profiles exclude executions owned by Quick Run or a workflow. */
export function isProfileScoped(item: ExecutionScope): boolean {
  const origin = getExecutionOrigin(item);
  return origin !== 'quickrun' && origin !== 'flow';
}
