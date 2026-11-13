import { HasStarter } from './starter';

export const ORIGINS = [
  'dashboard',
  'automation',
  'filemanager',
  'startup',
  'update',
  'internal',
  'workflow',
  'quickrun',
] as const;

export type Origin = (typeof ORIGINS)[number];

export interface ExecutionScope extends HasStarter {
  origin?: Origin;
}

/** The origin a workflow node or Quick Run implies; undefined for anything else. */
export function getStarterOrigin(item: ExecutionScope): Origin | undefined {
  const starter = item.starter;
  switch (starter?.kind) {
    case 'workflow':
      return 'workflow';
    case 'quick_run':
      return starter.workflow ? 'workflow' : 'quickrun';
    case 'profile':
    case undefined:
      return undefined;
  }
}

/** Execution ownership takes precedence over the source that launched it. */
export function getExecutionOrigin(item: ExecutionScope): Origin {
  return getStarterOrigin(item) ?? item.origin ?? 'dashboard';
}

/** Dashboard profiles exclude executions owned by Quick Run or a workflow. */
export function isProfileScoped(item: ExecutionScope): boolean {
  const origin = getExecutionOrigin(item);
  return origin !== 'quickrun' && origin !== 'workflow';
}
