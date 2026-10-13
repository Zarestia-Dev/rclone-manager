import { CommandOption, PREDEFINED_OPTIONS } from '@app/types';

export const INITIAL_COMMAND_OPTIONS: CommandOption[] = ((): CommandOption[] => {
  const obscure = PREDEFINED_OPTIONS.find(o => o.key === 'obscure');
  return obscure ? [{ ...obscure }] : [];
})();

export function syncNonInteractiveOption(
  options: CommandOption[],
  isInteractive: boolean
): CommandOption[] {
  const hasNonInteractive = options.some(o => o.key === 'nonInteractive');
  if (isInteractive && !hasNonInteractive)
    return [...options, { key: 'nonInteractive', value: true }];
  if (!isInteractive && hasNonInteractive) return options.filter(o => o.key !== 'nonInteractive');
  return options;
}
