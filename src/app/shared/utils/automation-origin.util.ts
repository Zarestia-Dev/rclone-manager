import { Automation } from '@app/types';

/**
 * Whether an automation belongs under an origin filter chip. Profile automations carry no
 * `source` of their own, so "dashboard" is everything that is not a Quick Run or a workflow.
 */
export function matchesOriginFilter(automation: Automation, filter: string): boolean {
  const source = automation.args?.source;
  switch (filter) {
    case 'all':
      return true;
    case 'dashboard':
    case 'automation':
      return source !== 'quickrun' && source !== 'workflow';
    default:
      return source === filter;
  }
}
