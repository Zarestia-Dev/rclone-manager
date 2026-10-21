import { describe, expect, it } from 'vitest';
import { getProviderTier, getRemoteFeatureLabelKey } from './provider-metadata.utils';

describe('provider metadata', () => {
  it.each([
    ['Tier 1', 'p-primary'],
    ['Tier 2', 'p-yellow'],
    ['Tier 3', 'p-orange'],
    ['Tier 4', 'p-warn'],
    ['Tier 5', 'p-warn'],
  ])('resolves %s to its shared presentation', (label, colorClass) => {
    expect(getProviderTier(label)).toEqual({ label, colorClass });
  });

  it.each([
    undefined,
    null,
    '',
    'Tier 0',
    'Tier 6',
    'tier 1',
    'Tier 1 ',
    'constructor',
    '__proto__',
  ])('ignores missing or unrecognised tier %s', tier =>
    expect(getProviderTier(tier)).toBeUndefined()
  );

  it('shares feature labels between provider summaries and live remote information', () => {
    expect(getRemoteFeatureLabelKey('Copy')).toBe('wizards.remoteConfig.providerOverview.copy');
    expect(getRemoteFeatureLabelKey('WriteMetadata')).toBe(
      'wizards.remoteConfig.providerOverview.writeMetadata'
    );
    expect(getRemoteFeatureLabelKey('About')).toBe('fileBrowser.remoteAbout.featureLabels.about');
  });

  it.each(['', 'FutureFeature', 'constructor', '__proto__', 'toString'])(
    'leaves unknown feature %s available for the original-name fallback',
    feature => expect(getRemoteFeatureLabelKey(feature)).toBeUndefined()
  );
});
