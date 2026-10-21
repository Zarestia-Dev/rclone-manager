import { describe, expect, it } from 'vitest';
import { RcConfigOption, TEMPLATE_CATEGORIES } from '@app/types';
import {
  getConfigCategories,
  isProviderReady,
  matchesProviderRule,
  resolveProviderField,
} from './config-metadata.utils';

const field = (name: string, extra: Partial<RcConfigOption> = {}): RcConfigOption => ({
  Name: name,
  FieldName: name,
  Type: 'string',
  Help: '',
  DefaultStr: '',
  ...extra,
});

describe('configuration metadata', () => {
  it('derives linked sections from operation capabilities', () => {
    expect(getConfigCategories('mount')).toEqual(['mount', 'vfs', 'filter', 'backend']);
    expect(getConfigCategories('sync')).toEqual(['sync', 'filter', 'backend']);
    expect(getConfigCategories('vfs')).toEqual(['vfs']);
    expect(getConfigCategories('remote')).toEqual(['remote']);
    expect(getConfigCategories('runtimeRemote')).toEqual([]);
    expect(getConfigCategories(null)).toEqual(TEMPLATE_CATEGORIES);
  });

  it('selects an explicit provider or the metadata discriminator', () => {
    const explicit = field('provider', { Examples: [{ Value: 'aws', Help: '' }] });
    expect(resolveProviderField([explicit])).toBe(explicit);
    const discriminator = field('vendor', { Examples: [{ Value: 'custom', Help: '' }] });
    expect(resolveProviderField([discriminator, field('token', { Provider: 'custom' })])).toBe(
      discriminator
    );
    expect(
      resolveProviderField([field('region', { Examples: [{ Value: 'eu', Help: '' }] })])
    ).toBeNull();
    expect(resolveProviderField([])).toBeNull();
  });

  it.each([
    [undefined, undefined, true],
    ['aws, other', 'other', true],
    ['aws', undefined, false],
    ['!aws, other', 'custom', true],
    ['!aws, other', 'aws', false],
  ] as const)('matches provider rule %s for %s', (rule, provider, expected) => {
    expect(matchesProviderRule(rule, provider)).toBe(expected);
  });
  it('requires a type and any provider discriminator before rendering fields', () => {
    const provider = field('provider');
    expect(isProviderReady('', null, null)).toBe(false);
    expect(isProviderReady('drive', null, null)).toBe(true);
    expect(isProviderReady('s3', provider, '')).toBe(false);
    expect(isProviderReady('s3', provider, 'aws')).toBe(true);
  });
});
