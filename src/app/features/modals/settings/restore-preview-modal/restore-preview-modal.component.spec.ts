import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { provideTranslateService } from '@ngx-translate/core';
import { BackupAnalysis, BackupContentsInfo } from '@app/types';
import { BackupRestoreService } from 'src/app/services/settings/backup-restore.service';
import { BackendTranslationService } from 'src/app/services/i18n/backend-translation.service';
import { RestorePreviewModalComponent } from './restore-preview-modal.component';

function create(
  contents?: Partial<BackupContentsInfo>,
  extras: { isEncrypted?: boolean; restoreSettings?: ReturnType<typeof vi.fn> } = {}
): RestorePreviewModalComponent {
  const analysis: BackupAnalysis = {
    isEncrypted: extras.isEncrypted ?? false,
    archiveType: 'zip',
    formatVersion: '1',
    contents: contents && {
      settings: true,
      backendConfig: true,
      rcloneConfig: false,
      remoteDefinitions: false,
      ...contents,
    },
  };
  TestBed.configureTestingModule({
    imports: [RestorePreviewModalComponent],
    providers: [
      provideTranslateService(),
      { provide: MatDialogRef, useValue: { close: (): void => undefined } },
      { provide: MAT_DIALOG_DATA, useValue: { backupPath: '/b.rcman', analysis } },
      {
        provide: BackupRestoreService,
        useValue: { restoreSettings: extras.restoreSettings ?? vi.fn() },
      },
      {
        provide: BackendTranslationService,
        useValue: {
          translateBackendMessage: (error: unknown): string => `translated:${String(error)}`,
        },
      },
    ],
  });
  return TestBed.createComponent(RestorePreviewModalComponent).componentInstance;
}

describe('RestorePreviewModalComponent', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('warns when remote settings are restored without any rclone definitions', () => {
    expect(create({ remoteCount: 2 }).missingRemoteDefinitions).toBe(true);
  });

  it('does not warn when the backup can recreate the remotes', () => {
    expect(create({ remoteCount: 2, remoteDefinitions: true }).missingRemoteDefinitions).toBe(
      false
    );
  });

  it('does not warn when the backup has no remote settings or no contents', () => {
    expect(create({ remoteCount: 0 }).missingRemoteDefinitions).toBe(false);
    TestBed.resetTestingModule();
    expect(create({}).missingRemoteDefinitions).toBe(false);
    TestBed.resetTestingModule();
    expect(create().missingRemoteDefinitions).toBe(false);
  });

  it('shows the backend message next to the password field when a restore fails', async () => {
    const restoreSettings = vi.fn().mockRejectedValue('backendErrors.backup.wrongPassword');
    const modal = create({}, { isEncrypted: true, restoreSettings });
    modal.onPasswordChange('wrong');

    await modal.verifyAndRestore();

    expect(modal.passwordError()).toBe('translated:backendErrors.backup.wrongPassword');
    expect(modal.isVerifying()).toBe(false);
  });

  it('requires a password for an encrypted backup before restoring', async () => {
    const restoreSettings = vi.fn();
    const modal = create({}, { isEncrypted: true, restoreSettings });

    await modal.verifyAndRestore();

    expect(restoreSettings).not.toHaveBeenCalled();
    expect(modal.passwordError()).not.toBeNull();
  });

  it('restores an unencrypted backup without a password', async () => {
    const restoreSettings = vi.fn().mockResolvedValue(undefined);
    const modal = create({}, { restoreSettings });

    await modal.verifyAndRestore();

    expect(restoreSettings).toHaveBeenCalledWith('/b.rcman', null, undefined);
    expect(modal.passwordError()).toBeNull();
  });
});
