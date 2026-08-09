import { TestBed } from '@angular/core/testing';
import { QuickRunService } from './quick-run.service';
import { QuickRun, QuickRunInput } from '@app/types';
import { NotificationService } from '../ui/notification.service';

describe('QuickRunService', () => {
  let service: QuickRunService;
  let invokeSpy: jasmine.Spy;
  let notificationSpy: jasmine.SpyObj<NotificationService>;

  const mockQuickRun: QuickRun = {
    id: 'qr-1',
    name: 'Backup Drive',
    description: 'Backs up local drive',
    operationType: 'sync',
    remoteName: 'drive:',
    config: {
      app: {},
      rclone: { srcFs: '/home/user/docs', dstFs: 'drive:backup' },
    },
    status: 'idle',
  };

  beforeEach(() => {
    notificationSpy = jasmine.createSpyObj('NotificationService', [
      'showSuccess',
      'showError',
      'showInfo',
    ]);

    TestBed.configureTestingModule({
      providers: [QuickRunService, { provide: NotificationService, useValue: notificationSpy }],
    });

    service = TestBed.inject(QuickRunService);
    invokeSpy = spyOn(service as unknown as { invokeCommand: jasmine.Spy }, 'invokeCommand');
  });

  it('should be created and start with default state', () => {
    expect(service).toBeTruthy();
    expect(service.quickRuns()).toEqual([]);
    expect(service.selectedId()).toBeNull();
    expect(service.isCreating()).toBeFalse();
    expect(service.editingId()).toBeNull();
  });

  describe('selection', () => {
    it('should update selectedId and selected computed signal', async () => {
      invokeSpy.and.resolveTo([mockQuickRun]);
      await service.refresh();

      service.select('qr-1');
      expect(service.selectedId()).toBe('qr-1');
      expect(service.isSelected('qr-1')).toBeTrue();
      expect(service.selected()).toEqual(mockQuickRun);

      service.select(null);
      expect(service.selectedId()).toBeNull();
      expect(service.selected()).toBeNull();
    });
  });

  describe('editor lifecycle', () => {
    it('should open editor in create mode when no id provided', () => {
      service.openEditor();
      expect(service.isCreating()).toBeTrue();
      expect(service.editingId()).toBeNull();
      expect(service.isEditorOpen()).toBeTrue();
    });

    it('should open editor in edit mode when a QuickRun is provided', () => {
      service.openEditor(mockQuickRun);
      expect(service.isCreating()).toBeFalse();
      expect(service.editingId()).toBe('qr-1');
      expect(service.isEditorOpen()).toBeTrue();
    });

    it('should close editor', () => {
      service.openEditor();
      service.closeEditor();
      expect(service.isCreating()).toBeFalse();
      expect(service.editingId()).toBeNull();
      expect(service.isEditorOpen()).toBeFalse();
    });
  });

  describe('CRUD operations', () => {
    it('refresh should load quick runs from backend', async () => {
      invokeSpy.and.resolveTo([mockQuickRun]);

      await service.refresh();

      expect(invokeSpy).toHaveBeenCalledWith('list_quick_runs');
      expect(service.quickRuns()).toEqual([mockQuickRun]);
    });

    it('save should handle create and update via backend', async () => {
      const input: QuickRunInput = {
        name: 'New Quick Run',
        operationType: 'copy',
        remoteName: 'drive:',
        config: { app: {}, rclone: {} },
      };

      invokeSpy.and.resolveTo({
        ...input,
        id: 'qr-new',
        status: 'idle',
      });

      const result = await service.save(input);

      expect(invokeSpy).toHaveBeenCalledWith('create_quick_run', { quickRun: input });
      expect(result?.id).toBe('qr-new');
      expect(service.quickRuns().some(q => q.id === 'qr-new')).toBeTrue();
      expect(service.isEditorOpen()).toBeFalse();
    });

    it('remove should delete quick run from backend and store', async () => {
      invokeSpy.and.resolveTo([mockQuickRun]);
      await service.refresh();

      invokeSpy.and.resolveTo(undefined);
      await service.remove('qr-1');

      expect(invokeSpy).toHaveBeenCalledWith('delete_quick_run', { quickRunId: 'qr-1' });
      expect(service.quickRuns()).toEqual([]);
    });

    it('duplicate should create a copy with (copy) suffix', async () => {
      invokeSpy.and.resolveTo([mockQuickRun]);
      await service.refresh();

      invokeSpy.and.callFake((cmd: string, args?: Record<string, unknown>) => {
        if (cmd === 'create_quick_run') {
          const quickRun = args?.['quickRun'] as QuickRunInput;
          return Promise.resolve({
            ...quickRun,
            id: 'qr-copy',
            status: 'idle',
          });
        }
        return Promise.resolve(null);
      });

      const copy = await service.duplicate('qr-1');

      expect(copy?.name).toBe('Backup Drive (copy)');
    });
  });

  describe('execution', () => {
    it('start should invoke backend command start_quick_run', async () => {
      invokeSpy.and.resolveTo([mockQuickRun]);
      await service.refresh();

      invokeSpy.and.resolveTo({ jobId: 42 });

      const jobId = await service.start('qr-1');

      expect(invokeSpy).toHaveBeenCalledWith('start_quick_run', { quickRunId: 'qr-1' });
      expect(jobId).toBe(42);
      expect(service.runningIds().has('qr-1')).toBeTrue();
    });

    it('stop should invoke backend command stop_quick_run', async () => {
      invokeSpy.and.resolveTo([mockQuickRun]);
      await service.refresh();

      invokeSpy.and.resolveTo(undefined);
      await service.stop('qr-1');

      expect(invokeSpy).toHaveBeenCalledWith('stop_quick_run', {
        quickRunId: 'qr-1',
      });
      expect(service.runningIds().has('qr-1')).toBeFalse();
    });
  });
});
