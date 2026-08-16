import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { of } from 'rxjs';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { QuickRunService } from './quick-run.service';
import { QuickRun, QuickRunInput } from '@app/types';
import { NotificationService } from '../ui/notification.service';
import { ModalService } from '../ui/modal.service';
import { JobManagementService } from '../operations/job-management.service';
import { MountManagementService } from '../operations/mount-management.service';
import { ServeManagementService } from '../operations/serve-management.service';
import { AutomationService } from '../operations/automation.service';
import { TranslateService } from '@ngx-translate/core';
import { BackendTranslationService } from '../i18n/backend-translation.service';
import { ApiClientService } from '../infrastructure/platform/api-client.service';
import { SseClientService } from '../infrastructure/platform/sse-client.service';

describe('QuickRunService', () => {
  let service: QuickRunService;
  let invokeSpy: ReturnType<typeof vi.fn>;
  let notificationSpy: {
    showSuccess: ReturnType<typeof vi.fn>;
    showError: ReturnType<typeof vi.fn>;
    showInfo: ReturnType<typeof vi.fn>;
  };
  let modalSpy: { openQuickRunEditor: ReturnType<typeof vi.fn> };

  const mockQuickRun: QuickRun = {
    id: 'qr-1',
    name: 'Backup Drive',
    description: 'Backs up local drive',
    operationType: 'sync',
    remoteName: 'drive:',
    config: {
      app: { autoStart: false },
      rclone: { srcFs: '/home/user/docs', dstFs: 'drive:backup' },
    },
    status: 'idle',
  };

  beforeEach(() => {
    notificationSpy = {
      showSuccess: vi.fn(),
      showError: vi.fn(),
      showInfo: vi.fn(),
    };
    modalSpy = {
      openQuickRunEditor: vi.fn(),
    };

    TestBed.configureTestingModule({
      providers: [
        QuickRunService,
        { provide: NotificationService, useValue: notificationSpy },
        { provide: ModalService, useValue: modalSpy },
        {
          provide: JobManagementService,
          useValue: { jobs: signal([]), refreshJobs: vi.fn() },
        },
        {
          provide: MountManagementService,
          useValue: { mountedRemotes: signal([]), getMountedRemotes: vi.fn() },
        },
        {
          provide: ServeManagementService,
          useValue: { runningServes: signal([]), refreshServes: vi.fn() },
        },
        {
          provide: AutomationService,
          useValue: {
            automations: signal([]),
            refreshAutomations: vi.fn().mockResolvedValue([]),
          },
        },
        {
          provide: TranslateService,
          useValue: { instant: vi.fn((k: string) => k), get: vi.fn(() => of('')) },
        },
        {
          provide: BackendTranslationService,
          useValue: { translateError: vi.fn((k: string) => k) },
        },
        {
          provide: ApiClientService,
          useValue: { invoke: vi.fn(), get: vi.fn(), post: vi.fn() },
        },
        {
          provide: SseClientService,
          useValue: { listen: vi.fn(() => of()) },
        },
      ],
    });

    service = TestBed.inject(QuickRunService);
    invokeSpy = vi.spyOn(
      service as unknown as { invokeCommand: (...args: unknown[]) => Promise<unknown> },
      'invokeCommand'
    ) as unknown as ReturnType<typeof vi.fn>;
  });

  it('should be created and start with default state', () => {
    expect(service).toBeTruthy();
    expect(service.quickRuns()).toEqual([]);
    expect(service.selectedId()).toBeNull();
    expect(service.isCreating()).toBe(false);
  });

  describe('selection', () => {
    it('should update selectedId and selected computed signal', async () => {
      invokeSpy.mockResolvedValue([mockQuickRun]);
      await service.refresh();

      service.select('qr-1');
      expect(service.selectedId()).toBe('qr-1');
      expect(service.isSelected('qr-1')).toBe(true);
      expect(service.selected()).toEqual(mockQuickRun);

      service.select(null);
      expect(service.selectedId()).toBeNull();
      expect(service.selected()).toBeNull();
    });
  });

  describe('editor lifecycle', () => {
    it('should open editor via modal service when no id provided', () => {
      service.openEditor();
      expect(modalSpy.openQuickRunEditor).toHaveBeenCalledWith({
        initialOpType: undefined,
        initialRemoteName: undefined,
      });
    });

    it('should open editor via modal service when a QuickRun is provided', () => {
      service.openEditor(mockQuickRun);
      expect(modalSpy.openQuickRunEditor).toHaveBeenCalledWith({
        quickRun: mockQuickRun,
        initialOpType: undefined,
        initialRemoteName: undefined,
      });
    });
  });

  describe('CRUD operations', () => {
    it('refresh should load quick runs from backend', async () => {
      invokeSpy.mockResolvedValue([mockQuickRun]);

      await service.refresh();

      expect(invokeSpy).toHaveBeenCalledWith('list_quick_runs');
      expect(service.quickRuns()).toEqual([mockQuickRun]);
    });

    it('save should handle create and update via backend', async () => {
      const input: QuickRunInput = {
        name: 'New Quick Run',
        operationType: 'copy',
        remoteName: 'drive:',
        config: { app: { autoStart: false }, rclone: {} },
      };

      invokeSpy.mockResolvedValue({
        ...input,
        id: 'qr-new',
        status: 'idle',
      });

      const result = await service.save(input);

      expect(invokeSpy).toHaveBeenCalledWith('create_quick_run', { quickRun: input });
      expect(result?.id).toBe('qr-new');
      expect(service.quickRuns().some(q => q.id === 'qr-new')).toBe(true);
    });

    it('remove should delete quick run from backend and store', async () => {
      invokeSpy.mockResolvedValue([mockQuickRun]);
      await service.refresh();

      invokeSpy.mockResolvedValue(undefined);
      await service.remove('qr-1');

      expect(invokeSpy).toHaveBeenCalledWith('delete_quick_run', { quickRunId: 'qr-1' });
      expect(service.quickRuns()).toEqual([]);
    });

    it('duplicate should open editor modal with unique -1 name and cloned config', async () => {
      invokeSpy.mockResolvedValue([mockQuickRun]);
      await service.refresh();

      service.duplicate('qr-1');

      expect(modalSpy.openQuickRunEditor).toHaveBeenCalledWith({
        cloneData: {
          name: 'Backup Drive-1',
          description: mockQuickRun.description,
          operationType: mockQuickRun.operationType,
          remoteName: mockQuickRun.remoteName,
          config: mockQuickRun.config,
        },
        initialOpType: 'sync',
        initialRemoteName: 'drive:',
      });
    });

    it('duplicate should increment number suffix for existing numbered names', async () => {
      const numberedQr: QuickRun = {
        ...mockQuickRun,
        id: 'qr-2',
        name: 'Backup Drive-1',
      };
      invokeSpy.mockResolvedValue([mockQuickRun, numberedQr]);
      await service.refresh();

      service.duplicate('qr-2');

      expect(modalSpy.openQuickRunEditor).toHaveBeenCalledWith({
        cloneData: {
          name: 'Backup Drive-2',
          description: mockQuickRun.description,
          operationType: mockQuickRun.operationType,
          remoteName: mockQuickRun.remoteName,
          config: mockQuickRun.config,
        },
        initialOpType: 'sync',
        initialRemoteName: 'drive:',
      });
    });
  });

  describe('execution', () => {
    it('start should invoke backend command start_quick_run', async () => {
      invokeSpy.mockResolvedValue([mockQuickRun]);
      await service.refresh();

      invokeSpy.mockResolvedValue({ jobId: 42 });

      const jobId = await service.start('qr-1');

      expect(invokeSpy).toHaveBeenCalledWith('start_quick_run', { quickRunId: 'qr-1' });
      expect(jobId).toBe(42);
      expect(service.runningIds().has('qr-1')).toBe(true);
    });

    it('stop should invoke backend command stop_quick_run', async () => {
      invokeSpy.mockResolvedValue([mockQuickRun]);
      await service.refresh();

      invokeSpy.mockResolvedValue(undefined);
      await service.stop('qr-1');

      expect(invokeSpy).toHaveBeenCalledWith('stop_quick_run', {
        quickRunId: 'qr-1',
      });
      expect(service.runningIds().has('qr-1')).toBe(false);
    });
  });
});
