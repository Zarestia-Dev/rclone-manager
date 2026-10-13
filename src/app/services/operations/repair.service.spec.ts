import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { TranslateService } from '@ngx-translate/core';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RepairService } from './repair.service';
import { BackendService } from '../infrastructure/system/backend.service';
import { InstallationService } from '../settings/installation.service';
import { RepairData } from '@app/types';

describe('RepairService', () => {
  let service: RepairService;
  let backendServiceMock: Partial<BackendService>;
  let installationServiceMock: Partial<InstallationService>;

  beforeEach(() => {
    backendServiceMock = {
      updateLocalBackendPort: vi.fn().mockResolvedValue(undefined),
    };
    installationServiceMock = {
      installRclone: vi.fn().mockResolvedValue('success'),
      cancelRcloneInstall: vi.fn().mockResolvedValue(undefined),
      installMountPlugin: vi.fn().mockResolvedValue('success'),
      cancelMountPluginInstall: vi.fn().mockResolvedValue(undefined),
      isCancellationError: vi.fn().mockReturnValue(false),
    };

    TestBed.configureTestingModule({
      providers: [
        RepairService,
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: BackendService, useValue: backendServiceMock },
        { provide: InstallationService, useValue: installationServiceMock },
        { provide: TranslateService, useValue: { instant: (k: string): string => k } },
      ],
    });
    service = TestBed.inject(RepairService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  it('should return correct UI keys for rclone_port repair', () => {
    expect(service.getRepairTitleKey('rclone_port')).toBe('repairSheet.titles.portInUse');
    expect(service.getRepairMessageKey('rclone_port')).toBe('repairSheet.messages.portInUse');
    expect(service.getRepairButtonTextKey('rclone_port')).toBe('repairSheet.actions.changePort');
    expect(service.getRepairButtonIcon('rclone_port')).toBe('server');

    const details = service.getRepairDetails('rclone_port');
    expect(details).toHaveLength(2);
    expect(details?.[0].valueKey).toBe('repairSheet.details.rclonePort.issue');
    expect(details?.[1].icon).toBe('rotate-right');
    expect(details?.[1].valueKey).toBe('repairSheet.details.rclonePort.action');
  });

  it('should execute rclone_port repair by calling updateLocalBackendPort', async () => {
    const repairData: RepairData = {
      type: 'rclone_port',
      port: 51901,
    };

    await service.executeRepair(repairData);
    expect(backendServiceMock.updateLocalBackendPort).toHaveBeenCalledWith(51901);
  });

  it('should return correct UI keys for rclone_auth repair based on isRemote flag', () => {
    // Local backend
    expect(service.getRepairTitleKey('rclone_auth', false)).toBe('repairSheet.titles.authRequired');
    expect(service.getRepairMessageKey('rclone_auth', false)).toBe(
      'repairSheet.messages.authRequired'
    );
    expect(service.getRepairButtonTextKey('rclone_auth', false)).toBe(
      'repairSheet.actions.restartEngine'
    );
    expect(service.getRepairButtonIcon('rclone_auth', false)).toBe('skull');
    const localDetails = service.getRepairDetails('rclone_auth', false);
    expect(localDetails?.[1].icon).toBe('skull');
    expect(localDetails?.[1].valueKey).toBe('repairSheet.details.rcloneAuth.action');

    // Remote backend
    expect(service.getRepairTitleKey('rclone_auth', true)).toBe('repairSheet.titles.authRequired');
    expect(service.getRepairMessageKey('rclone_auth', true)).toBe(
      'repairSheet.messages.remoteAuthRequired'
    );
    expect(service.getRepairButtonTextKey('rclone_auth', true)).toBe(
      'repairSheet.actions.configureBackend'
    );
    expect(service.getRepairButtonIcon('rclone_auth', true)).toBe('lock');
    const remoteDetails = service.getRepairDetails('rclone_auth', true);
    expect(remoteDetails?.[1].icon).toBe('lock');
    expect(remoteDetails?.[1].valueKey).toBe('repairSheet.details.rcloneAuthRemote.action');
  });

  it('should handle findNextAvailablePort fallback when not in Tauri', async () => {
    // In test environment, isTauri is false
    const nextPort = await service.findNextAvailablePort(51900);
    expect(nextPort).toBe(51901);
  });

  it('should handle checkPortAvailable fallback when not in Tauri', async () => {
    const isAvailable = await service.checkPortAvailable(51900);
    expect(isAvailable).toBe(true);
  });
});
