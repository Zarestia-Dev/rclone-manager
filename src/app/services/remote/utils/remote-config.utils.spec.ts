import { TestBed } from '@angular/core/testing';
import { provideTranslateService } from '@ngx-translate/core';
import { PathService } from '../../infrastructure/platform/path.service';
import {
  mapConfigToFormProfile,
  mapFormToConfigProfile,
  ConfigToFormContext,
  FormToConfigContext,
  resolveOptionExamples,
} from './remote-config.utils';

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
      pathService,
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
});
