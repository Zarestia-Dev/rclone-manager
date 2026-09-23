import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideTranslateService, TranslateService } from '@ngx-translate/core';
import { MAT_BOTTOM_SHEET_DATA, MatBottomSheetRef } from '@angular/material/bottom-sheet';
import { signal } from '@angular/core';

import { RepairSheetComponent } from './repair-sheet.component';
import { RepairService } from 'src/app/services/operations/repair.service';
import { AppSettingsService } from 'src/app/services/settings/app-settings.service';
import { RclonePasswordService } from 'src/app/services/security/rclone-password.service';
import { BackendService } from 'src/app/services/infrastructure/system/backend.service';
import { SystemInfoService } from 'src/app/services/infrastructure/system/system-info.service';
import { BackendTranslationService } from 'src/app/services/i18n/backend-translation.service';
import { ModalService } from 'src/app/services/ui/modal.service';
import { RepairData } from '@app/types';

describe('RepairSheetComponent', () => {
  let component: RepairSheetComponent;
  let fixture: ComponentFixture<RepairSheetComponent>;
  let sheetRefMock: { dismiss: ReturnType<typeof vi.fn> };
  let repairServiceMock: Partial<RepairService>;
  let appSettingsServiceMock: Partial<AppSettingsService>;
  let passwordServiceMock: Partial<RclonePasswordService>;
  let backendServiceMock: Partial<BackendService>;
  let modalServiceMock: Partial<ModalService>;
  let systemInfoServiceMock: Partial<SystemInfoService>;
  let backendTranslationMock: Partial<BackendTranslationService>;

  const defaultRepairData: RepairData = {
    type: 'rclone_port',
    port: 51900,
    portError: 'Port 51900 could not be bound',
  };

  const createComponent = async (data: RepairData = defaultRepairData): Promise<void> => {
    await TestBed.resetTestingModule();

    sheetRefMock = {
      dismiss: vi.fn(),
    };

    repairServiceMock = {
      rcloneProgress: signal(null),
      mountPluginProgress: signal(null),
      getRepairButtonIcon: vi.fn().mockImplementation((type: string) => {
        if (type === 'rclone_port') return 'server';
        return 'wrench';
      }),
      getRepairDetails: vi.fn().mockReturnValue([
        {
          icon: 'circle-info',
          labelKey: 'repairSheet.details.issueLabel',
          valueKey: 'repairSheet.details.rclonePort.issue',
        },
        {
          icon: 'rotate-right',
          labelKey: 'repairSheet.details.actionLabel',
          valueKey: 'repairSheet.details.rclonePort.action',
        },
      ]),
      getRepairTitleKey: vi.fn().mockReturnValue('repairSheet.titles.portInUse'),
      getRepairMessageKey: vi.fn().mockReturnValue('repairSheet.messages.portInUse'),
      getRepairButtonTextKey: vi.fn().mockReturnValue('repairSheet.actions.changePort'),
      getRepairProgressTextKey: vi.fn().mockReturnValue('repairSheet.progress.restartingEngine'),
      executeRepair: vi.fn().mockResolvedValue(undefined),
      repairRclonePath: vi.fn().mockResolvedValue('success'),
      cancelRcloneRepair: vi.fn().mockResolvedValue(undefined),
      repairMountPlugin: vi.fn().mockResolvedValue('success'),
      cancelMountPluginRepair: vi.fn().mockResolvedValue(undefined),
      findNextAvailablePort: vi.fn().mockResolvedValue(51901),
      checkPortAvailable: vi.fn().mockResolvedValue(true),
      repairRclonePort: vi.fn().mockResolvedValue(undefined),
      isCancellationError: vi.fn().mockReturnValue(false),
    };

    appSettingsServiceMock = {
      saveSetting: vi.fn().mockResolvedValue(undefined),
    };

    passwordServiceMock = {
      validatePassword: vi.fn().mockResolvedValue(true),
      storePassword: vi.fn().mockResolvedValue(undefined),
      setConfigPasswordEnv: vi.fn().mockResolvedValue(undefined),
    };

    backendServiceMock = {
      isLocalBackend: signal(true),
      updateLocalBackendConfigPath: vi.fn().mockResolvedValue(undefined),
      updateLocalBackendPort: vi.fn().mockResolvedValue(undefined),
    };

    modalServiceMock = {
      openBackend: vi.fn(),
    };

    systemInfoServiceMock = {
      minRcloneVersion: signal('1.68.0'),
    };

    backendTranslationMock = {
      translateBackendMessage: vi.fn().mockImplementation((msg: unknown) => String(msg)),
    };

    await TestBed.configureTestingModule({
      imports: [RepairSheetComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideTranslateService(),
        { provide: MAT_BOTTOM_SHEET_DATA, useValue: data },
        { provide: MatBottomSheetRef, useValue: sheetRefMock },
        { provide: RepairService, useValue: repairServiceMock },
        { provide: AppSettingsService, useValue: appSettingsServiceMock },
        { provide: RclonePasswordService, useValue: passwordServiceMock },
        { provide: BackendService, useValue: backendServiceMock },
        { provide: ModalService, useValue: modalServiceMock },
        { provide: SystemInfoService, useValue: systemInfoServiceMock },
        { provide: BackendTranslationService, useValue: backendTranslationMock },
      ],
    }).compileComponents();

    const translate = TestBed.inject(TranslateService);
    translate.use('en');

    fixture = TestBed.createComponent(RepairSheetComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  };

  it('should create the component for rclone_port repair', async () => {
    await createComponent();
    expect(component).toBeTruthy();
    expect(component.isRclonePortRepair()).toBe(true);
    expect(component.selectedPort()).toBe(51900);
    expect(component.portTestResult()).toBe('occupied');
  });

  describe('Port repair logic', () => {
    beforeEach(async () => {
      await createComponent();
    });

    it('should validate port numbers correctly', () => {
      expect(component.portInputError()).toBe('');

      // Invalid port < 1024
      component.selectedPort.set(80);
      expect(component.portInputError()).toBe('repairSheet.portConfig.invalidPort');

      // Invalid port > 65535
      component.selectedPort.set(70000);
      expect(component.portInputError()).toBe('repairSheet.portConfig.invalidPort');

      // Valid port
      component.selectedPort.set(51901);
      expect(component.portInputError()).toBe('');
    });

    it('should not allow repair when port is occupied or invalid', () => {
      // Initially port is 51900 and result is 'occupied'
      expect(component.canRepair()).toBe(false);

      // Port is changed to 51901 and status becomes untested -> canRepair becomes true
      component.selectedPort.set(51901);
      component.portTestResult.set('untested');
      expect(component.canRepair()).toBe(true);

      // Port has validation error
      component.selectedPort.set(0);
      expect(component.canRepair()).toBe(false);
    });

    it('should test port availability and update portTestResult', async () => {
      component.selectedPort.set(51902);
      await component.testPort();

      expect(repairServiceMock.checkPortAvailable).toHaveBeenCalledWith(51902);
      expect(component.portTestResult()).toBe('available');

      // Test occupied port
      (repairServiceMock.checkPortAvailable as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        false
      );
      await component.testPort();
      expect(component.portTestResult()).toBe('occupied');
    });

    it('should suggest next available port', async () => {
      (repairServiceMock.findNextAvailablePort as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        51905
      );
      await component.suggestNextPort();

      expect(repairServiceMock.findNextAvailablePort).toHaveBeenCalledWith(51901);
      expect(component.selectedPort()).toBe(51905);
      expect(component.portTestResult()).toBe('available');
    });

    it('should handle onPortChange event', () => {
      const mockEvent = {
        target: { value: '51905' },
      } as unknown as Event;

      component.onPortChange(mockEvent);
      expect(component.selectedPort()).toBe(51905);
      expect(component.portTestResult()).toBe('untested');

      // If changed back to the failing port 51900
      const failedPortEvent = {
        target: { value: '51900' },
      } as unknown as Event;
      component.onPortChange(failedPortEvent);
      expect(component.selectedPort()).toBe(51900);
      expect(component.portTestResult()).toBe('occupied');
    });

    it('should execute port repair and dismiss sheet on success', async () => {
      vi.useFakeTimers();
      component.selectedPort.set(51901);
      component.portTestResult.set('available');

      await component.repair();

      expect(repairServiceMock.repairRclonePort).toHaveBeenCalledWith(51901);
      vi.advanceTimersByTime(1000);
      expect(sheetRefMock.dismiss).toHaveBeenCalledWith('success');
      vi.useRealTimers();
    });

    it('should handle port repair failure gracefully', async () => {
      (repairServiceMock.repairRclonePort as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('Port binding failed')
      );
      component.selectedPort.set(51901);
      component.portTestResult.set('available');

      await component.repair();

      expect(component.installing()).toBe(false);
      expect(sheetRefMock.dismiss).not.toHaveBeenCalled();
      expect(component.displayMessage()).toContain('Port binding failed');
    });
  });

  describe('Password repair logic', () => {
    beforeEach(async () => {
      await createComponent({
        type: 'rclone_password',
      });
    });

    it('should initialize for rclone_password repair', () => {
      expect(component.requiresPassword()).toBe(true);
      expect(component.canSubmitPassword()).toBe(false);
    });

    it('should submit password and dismiss on valid input', async () => {
      vi.useFakeTimers();
      component.password.set('my-secret-password');
      component.storePassword.set(true);

      await component.submitPassword();

      expect(passwordServiceMock.validatePassword).toHaveBeenCalledWith('my-secret-password');
      expect(passwordServiceMock.storePassword).toHaveBeenCalledWith('my-secret-password');
      vi.advanceTimersByTime(1000);
      expect(sheetRefMock.dismiss).toHaveBeenCalledWith({
        password: 'my-secret-password',
        stored: true,
      });
      vi.useRealTimers();
    });

    it('should set error message when password validation fails', async () => {
      (passwordServiceMock.validatePassword as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('invalid password')
      );
      component.password.set('wrong-password');

      await component.submitPassword();

      expect(component.hasPasswordError()).toBe(true);
      expect(component.passwordErrorMessage()).toBeTruthy();
    });
  });

  describe('Binary repair logic', () => {
    beforeEach(async () => {
      await createComponent({
        type: 'rclone_binary',
      });
    });

    it('should initialize for rclone_binary repair and support toggling advanced install options', () => {
      expect(component.isRcloneBinaryRepair()).toBe(true);
      expect(component.showAdvanced()).toBe(false);

      component.toggleInstallOptions();
      expect(component.showAdvanced()).toBe(true);
      expect(component.currentMode()).toBe('install');

      component.toggleInstallOptions();
      expect(component.showAdvanced()).toBe(false);
      expect(component.currentMode()).toBe('standard');
    });

    it('should cancel in-progress binary repair', async () => {
      component.installing.set(true);
      await component.cancelRepair();

      expect(repairServiceMock.cancelRcloneRepair).toHaveBeenCalled();
      expect(component.installing()).toBe(false);
    });
  });

  describe('Auth repair logic', () => {
    it('should execute standard repair for local rclone_auth', async () => {
      await createComponent({
        type: 'rclone_auth',
        isRemote: false,
      });

      expect(component.isRemoteAuthRepair()).toBe(false);
      await component.repair();

      expect(repairServiceMock.executeRepair).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'rclone_auth' })
      );
      expect(modalServiceMock.openBackend).not.toHaveBeenCalled();
    });

    it('should dismiss sheet and open backend modal for remote rclone_auth', async () => {
      await createComponent({
        type: 'rclone_auth',
        isRemote: true,
      });

      expect(component.isRemoteAuthRepair()).toBe(true);
      expect(component.repairButtonIcon()).toBe('lock');

      await component.repair();

      expect(sheetRefMock.dismiss).toHaveBeenCalled();
      expect(modalServiceMock.openBackend).toHaveBeenCalled();
      expect(repairServiceMock.executeRepair).not.toHaveBeenCalled();
    });
  });
});
