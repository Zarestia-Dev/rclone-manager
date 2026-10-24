import { TestBed } from '@angular/core/testing';
import { expect, it } from 'vitest';
import { provideTranslateService } from '@ngx-translate/core';
import { PathService } from '../../infrastructure/platform/path.service';
import {
  mapConfigToFormProfile,
  mapFormToConfigProfile,
  ConfigToFormContext,
  FormToConfigContext,
  retargetProfilesRemote,
} from './profile-mapper.utils';
import { resolveOptionExamples } from './remote-config.utils';

describe('remote-config.utils', () => {
  let pathService: PathService;
  let ctx: ConfigToFormContext;
  let formCtx: FormToConfigContext;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideTranslateService(), PathService],
    });
    pathService = TestBed.inject(PathService);
    pathService.setRemoteNames(['myremote', 'otherremote']);
    ctx = {
      remoteName: 'myremote',
      existingRemotes: ['myremote', 'otherremote'],
      pathService,
    };
    formCtx = {
      remoteName: 'myremote',
      cleanData: (opts: Record<string, unknown>): Record<string, unknown> => ({ ...opts }),
      dynamicFields: [],
    };
  });

  describe('mapConfigToFormProfile', () => {
    describe('mount profile', () => {
      it('should default mountType to "mount" when omitted and mountPoint is a local path', () => {
        const config = {
          app: { autoStart: true },
          rclone: {
            fs: 'myremote:docs',
            mountPoint: '/mnt/media',
          },
        };

        const result = mapConfigToFormProfile('mount', config, ctx);

        expect((result['options'] as Record<string, unknown>)['mountType']).toBe('mount');
        expect(result['dest']).toEqual({
          type: 'local',
          path: '/mnt/media',
          remote: '',
        });
        expect(result['source']).toEqual({
          type: 'currentRemote',
          path: 'docs',
          remote: '',
        });
      });

      it('should resolve mountType to "saf" when mountPoint starts with saf://', () => {
        const config = {
          app: {},
          rclone: {
            fs: 'myremote:',
            mountPoint: 'saf://myremote',
          },
        };

        const result = mapConfigToFormProfile('mount', config, ctx);

        expect((result['options'] as Record<string, unknown>)['mountType']).toBe('saf');
        expect(result['dest']).toEqual({
          type: 'local',
          path: 'saf://myremote',
          remote: '',
        });
      });

      it('should preserve explicit mountType "saf"', () => {
        const config = {
          app: {},
          rclone: {
            fs: 'myremote:photos',
            mountPoint: 'saf://myremote',
            mountType: 'saf',
          },
        };

        const result = mapConfigToFormProfile('mount', config, ctx);

        expect((result['options'] as Record<string, unknown>)['mountType']).toBe('saf');
      });

      it('should preserve explicit mountType "cmount"', () => {
        const config = {
          app: {},
          rclone: {
            fs: 'myremote:data',
            mountPoint: 'X:',
            mountType: 'cmount',
          },
        };

        const result = mapConfigToFormProfile('mount', config, ctx);

        expect((result['options'] as Record<string, unknown>)['mountType']).toBe('cmount');
      });
    });

    describe('serve profile', () => {
      it('should default serve type to "http" when omitted', () => {
        const config = {
          app: {},
          rclone: {
            fs: 'myremote:public',
          },
        };

        const result = mapConfigToFormProfile('serve', config, ctx);

        expect((result['options'] as Record<string, unknown>)['type']).toBe('http');
        expect(result['source']).toEqual({
          type: 'currentRemote',
          path: 'public',
          remote: '',
        });
      });

      it('should preserve explicit serve type "webdav"', () => {
        const config = {
          app: {},
          rclone: {
            fs: 'myremote:',
            type: 'webdav',
          },
        };

        const result = mapConfigToFormProfile('serve', config, ctx);

        expect((result['options'] as Record<string, unknown>)['type']).toBe('webdav');
      });
    });

    describe('sync / copy / move profile', () => {
      it('should map source array and destination for sync', () => {
        const config = {
          app: { cronEnabled: true, cronExpression: '0 0 * * *' },
          rclone: {
            srcFs: ['myremote:folder1', '/local/folder2'],
            dstFs: 'otherremote:backup',
          },
        };

        const result = mapConfigToFormProfile('sync', config, ctx);

        expect(result['cronEnabled']).toBe(true);
        expect(result['cronExpression']).toBe('0 0 * * *');
        expect(result['source']).toEqual([
          { type: 'currentRemote', path: 'folder1', remote: '' },
          { type: 'local', path: '/local/folder2', remote: '' },
        ]);
        expect(result['dest']).toEqual({
          type: 'otherRemote:otherremote',
          path: 'backup',
          remote: 'otherremote',
        });
      });

      it('should map single source string for copy', () => {
        const config = {
          app: {},
          rclone: {
            srcFs: '/home/user/downloads',
            dstFs: 'myremote:downloads',
          },
        };

        const result = mapConfigToFormProfile('copy', config, ctx);

        expect(result['source']).toEqual([
          { type: 'local', path: '/home/user/downloads', remote: '' },
        ]);
        expect(result['dest']).toEqual({
          type: 'currentRemote',
          path: 'downloads',
          remote: '',
        });
      });
    });

    describe('bisync profile', () => {
      it('should map path1 to source and path2 to dest', () => {
        const config = {
          app: {},
          rclone: {
            path1: 'myremote:work',
            path2: '/local/work',
          },
        };

        const result = mapConfigToFormProfile('bisync', config, ctx);

        expect(result['source']).toEqual({
          type: 'currentRemote',
          path: 'work',
          remote: '',
        });
        expect(result['dest']).toEqual({
          type: 'local',
          path: '/local/work',
          remote: '',
        });
      });
    });
  });

  describe('mapFormToConfigProfile', () => {
    it('omits application defaults and restores them when reopening a serve profile', () => {
      const form = mapConfigToFormProfile('serve', { rclone: { fs: 'myremote:' } }, ctx);
      expect(form).toMatchObject({
        autoStart: false,
        cronEnabled: false,
        watchEnabled: false,
        watchDelay: 5,
        watchChangedOnly: false,
        vfsProfile: 'Default',
        filterProfile: 'Default',
        backendProfile: 'Default',
        runtimeRemoteProfile: 'Default',
      });
      const saved = mapFormToConfigProfile('serve', form, formCtx);
      expect(saved).toEqual({ app: {}, rclone: { fs: 'myremote:' } });
      expect(mapConfigToFormProfile('serve', saved, ctx)).toEqual(form);
    });

    it('retains automation overrides, zero delay and named profile links', () => {
      const app = {
        autoStart: true,
        cronEnabled: true,
        cronExpression: '0 0 * * *',
        watchEnabled: true,
        watchDelay: 0,
        watchChangedOnly: true,
        vfsProfile: 'Cached',
        filterProfile: 'Photos',
        backendProfile: 'Fast',
        runtimeRemoteProfile: 'Custom',
      };
      const form = mapConfigToFormProfile('serve', { app, rclone: { fs: 'myremote:' } }, ctx);
      expect(mapFormToConfigProfile('serve', form, formCtx)['app']).toEqual(app);
      expect(
        mapFormToConfigProfile('serve', { ...form, runtimeRemoteProfile: ' Custom ' }, formCtx)[
          'app'
        ]
      ).toEqual(app);
    });

    it.each([true, false])('discards legacy profile tray metadata (%s)', showOnTray => {
      for (const config of [
        { app: { showOnTray }, rclone: { fs: 'myremote:' } },
        { showOnTray, fs: 'myremote:' },
      ]) {
        const form = mapConfigToFormProfile('serve', config, ctx);
        expect(form['showOnTray']).toBeUndefined();
        expect(form['options']).toEqual({ type: 'http' });
        expect(mapFormToConfigProfile('serve', { ...form, showOnTray }, formCtx)).toEqual({
          app: {},
          rclone: { fs: 'myremote:' },
        });
      }
    });

    it('omits missing, null and empty application values without mutating the form', () => {
      const form = {
        autoStart: null,
        watchDelay: undefined,
        cronExpression: '',
        vfsProfile: '',
        runtimeRemoteProfile: ' ',
      };
      expect(mapFormToConfigProfile('serve', form, formCtx)['app']).toEqual({});
      expect(form).toEqual({
        autoStart: null,
        watchDelay: undefined,
        cronExpression: '',
        vfsProfile: '',
        runtimeRemoteProfile: ' ',
      });
      expect(mapFormToConfigProfile('serve', {}, formCtx)['app']).toEqual({});
    });

    it('should omit mountType when saving standard "mount" type', () => {
      const formValue = {
        autoStart: false,
        source: { type: 'currentRemote', path: 'movies', remote: '' },
        dest: { type: 'local', path: '/mnt/movies', remote: '' },
        options: {
          mountType: 'mount',
          read_only: true,
        },
      };

      const result = mapFormToConfigProfile('mount', formValue, formCtx);
      const rclone = result['rclone'] as Record<string, unknown>;

      expect(rclone['fs']).toBe('myremote:movies');
      expect(rclone['mountPoint']).toBe('/mnt/movies');
      expect(rclone['mountType']).toBeUndefined();
      expect(rclone['read_only']).toBe(true);
    });

    it('should retain mountType when saving "saf" type', () => {
      const formValue = {
        autoStart: true,
        source: { type: 'currentRemote', path: '', remote: '' },
        dest: { type: 'local', path: 'saf://myremote', remote: '' },
        options: {
          mountType: 'saf',
        },
      };

      const result = mapFormToConfigProfile('mount', formValue, formCtx);
      const rclone = result['rclone'] as Record<string, unknown>;

      expect(rclone['fs']).toBe('myremote:');
      expect(rclone['mountPoint']).toBe('saf://myremote');
      expect(rclone['mountType']).toBe('saf');
    });

    it('should serialize multi-source paths for sync', () => {
      const formValue = {
        source: [
          { type: 'local', path: '/home/user/docs', remote: '' },
          { type: 'otherRemote:cloud', path: 'files', remote: 'cloud' },
        ],
        dest: { type: 'currentRemote', path: 'backup', remote: '' },
        options: {
          delete_excluded: true,
        },
      };

      const result = mapFormToConfigProfile('sync', formValue, formCtx);
      const rclone = result['rclone'] as Record<string, unknown>;

      expect(rclone['srcFs']).toEqual(['/home/user/docs', 'cloud:files']);
      expect(rclone['dstFs']).toBe('myremote:backup');
      expect(rclone['delete_excluded']).toBe(true);
    });
  });

  describe('shared operation mapping', () => {
    it('converts legacy paths without leaking them into rclone options', () => {
      const form = mapConfigToFormProfile(
        'sync',
        {
          autoStart: true,
          source: ['myremote:photos'],
          dest: '/backup',
          transfers: 2,
        },
        ctx
      );
      expect(form['options']).toEqual({ transfers: 2 });
      expect(mapFormToConfigProfile('sync', form, formCtx)).toEqual({
        app: { autoStart: true },
        rclone: { srcFs: 'myremote:photos', dstFs: '/backup', transfers: 2 },
      });
    });

    it('preserves local mount sources instead of converting them into remote paths', () => {
      const form = mapConfigToFormProfile(
        'mount',
        {
          rclone: { srcFs: '/tmp/photos', mountPoint: '/mnt/photos' },
        },
        ctx
      );
      expect(form['source']).toEqual({ type: 'local', path: '/tmp/photos', remote: '' });
      expect(mapFormToConfigProfile('mount', form, formCtx)['rclone']).toEqual({
        fs: '/tmp/photos',
        mountPoint: '/mnt/photos',
      });
    });

    it('reads legacy operation blocks without mixing shared options into operation flags', () => {
      const form = mapConfigToFormProfile(
        'sync',
        {
          app: { autoStart: true },
          rclone: {
            sync: { srcFs: ['myremote:a', 'otherremote:b'], dstFs: '/tmp', dry_run: true },
            dry_run: false,
            vfs: { cache_mode: 'full' },
            remotes: { myremote: { region: 'eu' } },
          },
        },
        ctx
      );
      expect(form['options']).toEqual({ dry_run: false });
      expect(mapFormToConfigProfile('sync', form, formCtx)['rclone']).toEqual({
        srcFs: ['myremote:a', 'otherremote:b'],
        dstFs: '/tmp',
        dry_run: false,
      });
    });

    it('preserves multiple URLs and filenames, including punctuation, through both directions', () => {
      const original = {
        srcFs: ["https://example.com/a?x=1&y='two'", 'https://example.com/b'],
        dstFs: '/tmp/photos',
        filenames: ["a'b,c.jpg", 'b.jpg'],
        autoFilename: false,
      };
      const form = mapConfigToFormProfile('copyurl', { rclone: original }, ctx);
      expect(mapFormToConfigProfile('copyurl', form, formCtx)['rclone']).toEqual(original);
    });

    it('handles an empty source list without manufacturing a source', () => {
      const form = mapConfigToFormProfile('sync', { rclone: { srcFs: [], dstFs: '/tmp' } }, ctx);
      expect(form['source']).toEqual([]);
      expect(mapFormToConfigProfile('sync', form, formCtx)['rclone']).toEqual({
        srcFs: '',
        dstFs: '/tmp',
      });
    });
  });

  describe('resolveOptionExamples', () => {
    it('should return explicit examples when defined on option', () => {
      const opt = {
        Name: 'custom',
        FieldName: 'Custom',
        Help: '',
        Type: 'string',
        DefaultStr: '',
        Examples: [{ Value: 'custom_val', Help: 'Custom Help' }],
      };
      const examples = resolveOptionExamples(opt);
      expect(examples.length).toBe(1);
      expect(examples[0].Value).toBe('custom_val');
    });

    it('should provide default examples for Duration type', () => {
      const opt = {
        Name: 'timeout',
        FieldName: 'Timeout',
        Help: '',
        Type: 'Duration',
        DefaultStr: '1m',
      };
      const examples = resolveOptionExamples(opt);
      expect(examples.length).toBeGreaterThan(0);
      expect(examples.some(e => e.Value === '10s')).toBe(true);
      expect(examples.some(e => e.Value === '1h')).toBe(true);
    });

    it('should provide default examples for SizeSuffix type', () => {
      const opt = {
        Name: 'buffer_size',
        FieldName: 'BufferSize',
        Help: '',
        Type: 'SizeSuffix',
        DefaultStr: '16M',
      };
      const examples = resolveOptionExamples(opt);
      expect(examples.length).toBeGreaterThan(0);
      expect(examples.some(e => e.Value === '512k')).toBe(true);
      expect(examples.some(e => e.Value === '1G')).toBe(true);
    });

    it('should provide default examples for bandwidth options or BwTimetable type', () => {
      const opt = {
        Name: 'bwlimit',
        FieldName: 'Bwlimit',
        Help: '',
        Type: 'string',
        DefaultStr: '',
      };
      const examples = resolveOptionExamples(opt);
      expect(examples.length).toBeGreaterThan(0);
      expect(examples.some(e => e.Value === 'off')).toBe(true);
      expect(examples.some(e => e.Value === '10M:50M')).toBe(true);
    });

    it('should return empty array for null/undefined or options without type defaults', () => {
      expect(resolveOptionExamples(null)).toEqual([]);
      expect(resolveOptionExamples(undefined)).toEqual([]);
      expect(
        resolveOptionExamples({
          Name: 'random_key',
          FieldName: 'RandomKey',
          Help: '',
          Type: 'unknown',
          DefaultStr: '',
        })
      ).toEqual([]);
    });
  });

  describe('retargetProfilesRemote', () => {
    const retargetProfile = (
      profile: Record<string, unknown>,
      oldRemote: string,
      newRemote: string
    ): Record<string, unknown> =>
      retargetProfilesRemote({ syncConfigs: { Default: profile } }, oldRemote, newRemote)
        .syncConfigs.Default;
    it('should retarget mount profiles with rclone sub-object', () => {
      const profile = {
        app: { autoStart: true },
        rclone: {
          fs: 'gdrive:myfolder',
          mountPoint: '/mnt/data',
        },
      };

      const result = retargetProfile(profile, 'gdrive', 'gdrive-clone');

      expect((result['rclone'] as Record<string, unknown>)['fs']).toBe('gdrive-clone:myfolder');
      expect((result['rclone'] as Record<string, unknown>)['mountPoint']).toBe('/mnt/data');
    });

    it('should retarget multi-path array sources in sync/copy profiles', () => {
      const profile = {
        app: { autoStart: false },
        rclone: {
          srcFs: ['gdrive:photos', 'otherremote:backup', 'local:/data'],
          dstFs: 'gdrive:destination',
        },
      };

      const result = retargetProfile(profile, 'gdrive', 'gdrive-clone');
      const rclone = result['rclone'] as Record<string, unknown>;

      expect(rclone['srcFs']).toEqual(['gdrive-clone:photos', 'otherremote:backup', 'local:/data']);
      expect(rclone['dstFs']).toBe('gdrive-clone:destination');
    });

    it('should retarget bisync profiles path1 and path2', () => {
      const profile = {
        rclone: {
          path1: 'gdrive:folder1',
          path2: 'gdrive:folder2',
        },
      };

      const result = retargetProfile(profile, 'gdrive', 'gdrive-clone');
      const rclone = result['rclone'] as Record<string, unknown>;

      expect(rclone['path1']).toBe('gdrive-clone:folder1');
      expect(rclone['path2']).toBe('gdrive-clone:folder2');
    });

    it('should retarget scoped runtimeRemote profiles', () => {
      const profile = {
        gdrive: { chunk_size: '64M', upload_cutoff: '256M' },
      };

      const result = retargetProfilesRemote(
        { runtimeRemoteConfigs: { Default: profile } },
        'gdrive',
        'gdrive-clone'
      ).runtimeRemoteConfigs.Default;

      expect(result).toEqual({
        'gdrive-clone': { chunk_size: '64M', upload_cutoff: '256M' },
      });
    });

    it('should retarget flat path keys', () => {
      const profile = {
        fs: 'gdrive:root',
      };

      const result = retargetProfile(profile, 'gdrive', 'gdrive-clone');

      expect(result['fs']).toBe('gdrive-clone:root');
    });

    it('should return unmodified profile if oldRemote is not found or matches newRemote', () => {
      const profile = { rclone: { fs: 'other:path' } };
      expect(retargetProfile(profile, 'gdrive', 'gdrive-clone')).toEqual(profile);
      expect(retargetProfile(profile, 'gdrive', 'gdrive')).toEqual(profile);
    });

    it('should retarget all sections in RemoteSettings via retargetProfilesRemote', () => {
      type ProfileSection = Record<
        string,
        { app?: Record<string, unknown>; rclone?: Record<string, unknown> }
      >;
      const settings = {
        mountConfigs: {
          Default: {
            app: { autoStart: true },
            rclone: { fs: 'gdrive:media', mountPoint: '/media' },
          },
        } as ProfileSection,
        syncConfigs: {
          Backup: {
            app: { autoStart: false },
            rclone: { srcFs: ['gdrive:docs'], dstFs: '/local/backup' },
          },
        } as ProfileSection,
        runtimeRemoteConfigs: {
          gdrive: { gdrive: { chunk_size: '32M' } },
        },
      };

      const result = retargetProfilesRemote(settings, 'gdrive', 'gdrive-clone');

      expect(result.mountConfigs['Default']?.rclone?.['fs']).toBe('gdrive-clone:media');
      expect(result.syncConfigs['Backup']?.rclone?.['srcFs']).toEqual(['gdrive-clone:docs']);
      expect(result.runtimeRemoteConfigs['gdrive']).toEqual({
        'gdrive-clone': { chunk_size: '32M' },
      });
      expect(Object.keys(result.runtimeRemoteConfigs)).toEqual(['gdrive']);
    });

    it('preserves profile names and links while retargeting runtime scopes and paths', () => {
      const settings = {
        syncConfigs: {
          app: {
            app: { runtimeRemoteProfile: 'app' },
            rclone: {
              srcFs: ['app:photos', 'other:docs'],
              dstFs: '/backup',
              remotes: { app: { region: 'us' }, other: { region: 'eu' } },
            },
          },
        },
        runtimeRemoteConfigs: { app: { app: { region: 'us' }, other: { region: 'eu' } } },
      };
      const original = structuredClone(settings);
      const cloned = retargetProfilesRemote(settings, 'app', 'new-drive');
      expect(cloned.syncConfigs.app.app).toEqual({ runtimeRemoteProfile: 'app' });
      expect(cloned.syncConfigs.app.rclone.srcFs).toEqual(['new-drive:photos', 'other:docs']);
      expect(cloned.syncConfigs.app.rclone.remotes).toEqual({
        'new-drive': { region: 'us' },
        other: { region: 'eu' },
      });
      expect(cloned.runtimeRemoteConfigs.app).toEqual({
        'new-drive': { region: 'us' },
        other: { region: 'eu' },
      });
      expect(settings).toEqual(original);
    });
  });
});
