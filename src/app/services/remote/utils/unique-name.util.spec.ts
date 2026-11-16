import { describe, expect, it } from 'vitest';
import { findCloneName, findUniqueName } from './unique-name.util';

describe('findUniqueName', () => {
  it('keeps a free name', () => {
    expect(findUniqueName('profile', ['other'])).toBe('profile');
  });

  it('numbers a taken name from 1 and skips numbers that are taken too', () => {
    expect(findUniqueName('profile', ['profile'])).toBe('profile-1');
    expect(findUniqueName('profile', ['profile', 'profile-1', 'profile-2'])).toBe('profile-3');
  });

  it('uses the separator it is given', () => {
    expect(findUniqueName('Run', ['Run'], ' ')).toBe('Run 1');
  });
});

describe('findCloneName', () => {
  it('names the copy after the original', () => {
    expect(findCloneName('drive', ['drive'])).toBe('drive-clone');
  });

  it('numbers a copy that already exists', () => {
    expect(findCloneName('drive', ['drive', 'drive-clone'])).toBe('drive-clone-1');
  });

  it('copies a copy under the name of the original instead of stacking suffixes', () => {
    expect(findCloneName('drive-clone', ['drive', 'drive-clone'])).toBe('drive-clone-1');
    expect(findCloneName('drive-clone-1', ['drive', 'drive-clone', 'drive-clone-1'])).toBe(
      'drive-clone-2'
    );
  });

  it('does not strip a number that belongs to the name', () => {
    expect(findCloneName('s3-backup', [])).toBe('s3-backup-clone');
    expect(findCloneName('gdrive2', [])).toBe('gdrive2-clone');
    expect(findCloneName('backup-2024', [])).toBe('backup-2024-clone');
  });

  it('falls back to a name when nothing is left of the original', () => {
    expect(findCloneName('', [])).toBe('remote-clone');
  });
});
