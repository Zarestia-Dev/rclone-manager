import { PillTone } from './pill';
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

/** How an origin is shown: its name (a translation key), its icon and its colour role. */
export const ORIGIN_META: Readonly<
  Record<Origin, { labelKey: string; icon: string; tone: PillTone }>
> = {
  dashboard: { labelKey: 'alerts.origins.dashboard', icon: 'cloud', tone: 'dim' },
  automation: { labelKey: 'alerts.origins.automation', icon: 'clock', tone: 'orange' },
  filemanager: { labelKey: 'alerts.origins.filemanager', icon: 'folder', tone: 'accent' },
  startup: { labelKey: 'alerts.origins.startup', icon: 'bolt', tone: 'dim' },
  update: { labelKey: 'alerts.origins.update', icon: 'refresh', tone: 'dim' },
  internal: { labelKey: 'alerts.origins.internal', icon: 'gear', tone: 'dim' },
  workflow: { labelKey: 'alerts.origins.workflow', icon: 'workflow', tone: 'accent' },
  quickrun: { labelKey: 'alerts.origins.quickrun', icon: 'quick-run', tone: 'primary' },
};

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

/** The origin to name next to work; none when its Quick Run or workflow starter pill names it. */
export function shownOrigin(item: ExecutionScope): (typeof ORIGIN_META)[Origin] | null {
  return getStarterOrigin(item) ? null : ORIGIN_META[getExecutionOrigin(item)];
}

/** Dashboard profiles exclude executions owned by Quick Run or a workflow. */
export function isProfileScoped(item: ExecutionScope): boolean {
  const origin = getExecutionOrigin(item);
  return origin !== 'quickrun' && origin !== 'workflow';
}

/**
 * Whether an item shows under an origin filter chip. "Dashboard" is everything the profiles of a
 * remote own (see `isProfileScoped`): work started at startup, by an automation or from the file
 * manager belongs to its profile as much as work started by hand. Every other chip is its origin.
 */
export function matchesOriginFilter(item: ExecutionScope, filter: string): boolean {
  if (filter === 'all') return true;
  if (filter === 'dashboard') return isProfileScoped(item);
  return getExecutionOrigin(item) === filter;
}
