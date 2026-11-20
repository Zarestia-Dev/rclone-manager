import { describe, expect, it } from 'vitest';
import { mapFormToConfigProfile } from './profile-mapper.utils';

describe('mapFormToConfigProfile path mapping', () => {
  it('maps multiple local and remote sources without service dependencies', () => {
    const result = mapFormToConfigProfile(
      'copy',
      {
        source: [
          { type: 'local', path: '/home/user/Arşiv 2026' },
          { type: 'currentRemote', path: 'photos/#1' },
          { type: 'otherRemote:backup', path: 'shared files' },
        ],
        dest: { type: 'otherRemote:archive', path: 'backup' },
      },
      { remoteName: 'drive' }
    );

    expect(result['rclone']).toEqual({
      srcFs: ['/home/user/Arşiv 2026', 'drive:photos/#1', 'backup:shared files'],
      dstFs: 'archive:backup',
    });
  });

  it.each([null, [], ''])('handles empty sources %j', source => {
    const result = mapFormToConfigProfile('sync', { source }, { remoteName: 'drive' });
    expect(result['rclone']).toEqual({ srcFs: '' });
  });

  it('preserves filesystem strings and Windows local paths', () => {
    const result = mapFormToConfigProfile(
      'move',
      { source: 'drive:folder', dest: { type: 'local', path: 'C:\\Backup\\data' } },
      { remoteName: 'drive' }
    );
    expect(result['rclone']).toEqual({ srcFs: 'drive:folder', dstFs: 'C:\\Backup\\data' });
  });
});
