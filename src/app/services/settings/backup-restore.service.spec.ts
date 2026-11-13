import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TranslateService } from '@ngx-translate/core';
import { BackupRestoreService } from './backup-restore.service';
import { ApiClientService } from '../infrastructure/platform/api-client.service';
import { NotificationService } from '../ui/notification.service';
import { BackendTranslationService } from '../i18n/backend-translation.service';
import { FileSystemService } from '../operations/file-system.service';
import { ExportType } from '@app/types';

describe('BackupRestoreService', () => {
  let service: BackupRestoreService;
  let invoke: ReturnType<typeof vi.fn>;
  let selectFile: ReturnType<typeof vi.fn>;
  let notifications: {
    showSuccess: ReturnType<typeof vi.fn>;
    showError: ReturnType<typeof vi.fn>;
    confirmModal: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    invoke = vi.fn();
    selectFile = vi.fn().mockResolvedValue('/backups/a.rcman');
    notifications = { showSuccess: vi.fn(), showError: vi.fn(), confirmModal: vi.fn() };
    TestBed.configureTestingModule({
      providers: [
        BackupRestoreService,
        { provide: ApiClientService, useValue: { invoke } },
        { provide: NotificationService, useValue: notifications },
        { provide: TranslateService, useValue: { instant: (key: string): string => key } },
        {
          provide: BackendTranslationService,
          useValue: {
            translateBackendMessage: (error: unknown): string => `translated:${String(error)}`,
          },
        },
        { provide: FileSystemService, useValue: { selectFile } },
      ],
    });
    service = TestBed.inject(BackupRestoreService);
  });

  it('sends the export request without a separate secrets flag', async () => {
    invoke.mockResolvedValue('done');
    await service.backupSettings('/out', ExportType.All, 'pw', '', null, ['default']);

    expect(invoke).toHaveBeenCalledWith('backup_settings', {
      backupDir: '/out',
      exportType: ExportType.All,
      password: 'pw',
      remoteName: '',
      userNote: null,
      includeProfiles: ['default'],
    });
  });

  it('sends only the restore arguments the backend accepts', async () => {
    invoke.mockResolvedValue('done');
    await service.restoreSettings('/b.rcman', 'pw', 'work');

    expect(invoke).toHaveBeenCalledWith('restore_settings', {
      backupPath: '/b.rcman',
      password: 'pw',
      restoreProfile: 'work',
    });
  });

  it('reports a failed analysis once and returns null', async () => {
    invoke.mockRejectedValue('backendErrors.backup.invalidArchive');

    expect(await service.selectAndAnalyzeBackup()).toBeNull();

    expect(notifications.confirmModal).toHaveBeenCalledTimes(1);
    expect(notifications.confirmModal.mock.calls[0][1]).toBe(
      'translated:backendErrors.backup.invalidArchive'
    );
    expect(notifications.showError).not.toHaveBeenCalled();
  });

  it('returns the path and analysis of a readable backup', async () => {
    const analysis = { isEncrypted: false };
    invoke.mockResolvedValue(analysis);

    expect(await service.selectAndAnalyzeBackup()).toEqual({
      path: '/backups/a.rcman',
      analysis,
    });
    expect(notifications.confirmModal).not.toHaveBeenCalled();
  });

  it('returns null without a message when no file is chosen or selection is cancelled', async () => {
    selectFile.mockResolvedValueOnce(null);
    expect(await service.selectAndAnalyzeBackup()).toBeNull();

    selectFile.mockRejectedValueOnce(new Error('File selection cancelled'));
    expect(await service.selectAndAnalyzeBackup()).toBeNull();

    expect(invoke).not.toHaveBeenCalled();
    expect(notifications.showError).not.toHaveBeenCalled();
  });

  it('reports a file picker failure as an analysis error', async () => {
    selectFile.mockRejectedValueOnce(new Error('dialog crashed'));

    expect(await service.selectAndAnalyzeBackup()).toBeNull();

    expect(notifications.showError).toHaveBeenCalledWith('backup.analyzeFailed');
  });
});
