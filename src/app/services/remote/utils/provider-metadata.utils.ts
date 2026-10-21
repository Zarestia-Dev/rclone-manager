const TIER_COLORS = {
  'Tier 1': 'p-primary',
  'Tier 2': 'p-yellow',
  'Tier 3': 'p-orange',
  'Tier 4': 'p-warn',
  'Tier 5': 'p-warn',
} as const;

export function getProviderTier(
  tier: string | null | undefined
): { label: string; colorClass: string } | undefined {
  if (!tier || !Object.hasOwn(TIER_COLORS, tier)) return undefined;
  return { label: tier, colorClass: TIER_COLORS[tier as keyof typeof TIER_COLORS] };
}

export const REMOTE_FEATURE_LABEL_KEYS = {
  Copy: 'wizards.remoteConfig.providerOverview.copy',
  Move: 'wizards.remoteConfig.providerOverview.move',
  PublicLink: 'wizards.remoteConfig.providerOverview.publicLink',
  CanHaveEmptyDirectories: 'wizards.remoteConfig.providerOverview.emptyDirectories',
  CaseInsensitive: 'wizards.remoteConfig.providerOverview.caseInsensitive',
  DuplicateFiles: 'wizards.remoteConfig.providerOverview.duplicateFiles',
  ReadMetadata: 'wizards.remoteConfig.providerOverview.readMetadata',
  WriteMetadata: 'wizards.remoteConfig.providerOverview.writeMetadata',
  About: 'fileBrowser.remoteAbout.featureLabels.about',
  BucketBased: 'fileBrowser.remoteAbout.featureLabels.bucketBased',
  BucketBasedRootOK: 'fileBrowser.remoteAbout.featureLabels.bucketRoot',
  Purge: 'fileBrowser.remoteAbout.featureLabels.purge',
  DirMove: 'fileBrowser.remoteAbout.featureLabels.dirMove',
  CleanUp: 'fileBrowser.remoteAbout.featureLabels.cleanUp',
  ListR: 'fileBrowser.remoteAbout.featureLabels.listR',
  ListP: 'fileBrowser.remoteAbout.featureLabels.listP',
  PutStream: 'fileBrowser.remoteAbout.featureLabels.putStream',
  OpenChunkWriter: 'fileBrowser.remoteAbout.featureLabels.openChunkWriter',
  OpenWriterAt: 'fileBrowser.remoteAbout.featureLabels.openWriterAt',
  ReadMimeType: 'fileBrowser.remoteAbout.featureLabels.readMimeType',
  WriteMimeType: 'fileBrowser.remoteAbout.featureLabels.writeMimeType',
  ChangeNotify: 'fileBrowser.remoteAbout.featureLabels.changeNotify',
  SetTier: 'fileBrowser.remoteAbout.featureLabels.setTier',
  GetTier: 'fileBrowser.remoteAbout.featureLabels.getTier',
  Overlay: 'fileBrowser.remoteAbout.featureLabels.overlay',
} as const;

export const PROVIDER_SUMMARY_FEATURES = [
  'Copy',
  'Move',
  'PublicLink',
  'CanHaveEmptyDirectories',
  'CaseInsensitive',
  'DuplicateFiles',
  'ReadMetadata',
  'WriteMetadata',
] as const satisfies readonly (keyof typeof REMOTE_FEATURE_LABEL_KEYS)[];

export function getRemoteFeatureLabelKey(feature: string): string | undefined {
  return Object.hasOwn(REMOTE_FEATURE_LABEL_KEYS, feature)
    ? REMOTE_FEATURE_LABEL_KEYS[feature as keyof typeof REMOTE_FEATURE_LABEL_KEYS]
    : undefined;
}
