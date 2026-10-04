import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { provideTranslateService } from '@ngx-translate/core';
import { MatDialogRef } from '@angular/material/dialog';
import { VaultModalComponent } from './vault-modal.component';
import { VaultService } from 'src/app/services/security/vault.service';

describe('VaultModalComponent', () => {
  let component: VaultModalComponent;
  let fixture: ComponentFixture<VaultModalComponent>;
  let vaultServiceMock: {
    isVaultEnabled: ReturnType<typeof signal<boolean>>;
    isVaultLocked: ReturnType<typeof signal<boolean>>;
    lockTimeoutSecs: ReturnType<typeof signal<number | null>>;
    isBusy: ReturnType<typeof signal<boolean>>;
    checkVaultStatus: ReturnType<typeof vi.fn>;
    enableVault: ReturnType<typeof vi.fn>;
    disableVault: ReturnType<typeof vi.fn>;
    changeVaultPassword: ReturnType<typeof vi.fn>;
    setVaultLockTimeout: ReturnType<typeof vi.fn>;
    lockVault: ReturnType<typeof vi.fn>;
  };
  let dialogRefMock: {
    close: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    vaultServiceMock = {
      isVaultEnabled: signal(false),
      isVaultLocked: signal(false),
      lockTimeoutSecs: signal<number | null>(300),
      isBusy: signal(false),
      checkVaultStatus: vi.fn().mockResolvedValue(undefined),
      enableVault: vi.fn().mockResolvedValue(undefined),
      disableVault: vi.fn().mockResolvedValue(undefined),
      changeVaultPassword: vi.fn().mockResolvedValue(undefined),
      setVaultLockTimeout: vi.fn().mockResolvedValue(undefined),
      lockVault: vi.fn().mockResolvedValue(undefined),
    };

    dialogRefMock = {
      close: vi.fn(),
    };

    await TestBed.configureTestingModule({
      imports: [VaultModalComponent],
      providers: [
        provideTranslateService(),
        { provide: VaultService, useValue: vaultServiceMock },
        { provide: MatDialogRef, useValue: dialogRefMock },
      ],
    })
      .overrideComponent(VaultModalComponent, {
        set: {
          template: '<div></div>',
        },
      })
      .compileComponents();

    fixture = TestBed.createComponent(VaultModalComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create the component and check vault status', () => {
    expect(component).toBeTruthy();
    expect(vaultServiceMock.checkVaultStatus).toHaveBeenCalled();
  });

  it('should close dialog when close() is called', () => {
    component.close();
    expect(dialogRefMock.close).toHaveBeenCalled();
  });

  it('should enable vault when enableForm is valid', async () => {
    component.enableForm.patchValue({
      password: 'new_secret_password',
      confirmPassword: 'new_secret_password',
      timeoutSecs: 900,
    });

    await component.submitEnableVault();

    expect(vaultServiceMock.enableVault).toHaveBeenCalledWith('new_secret_password', 900);
  });

  it('should not enable vault when passwords mismatch', async () => {
    component.enableForm.patchValue({
      password: 'new_secret_password',
      confirmPassword: 'different_password',
      timeoutSecs: 900,
    });

    await component.submitEnableVault();

    expect(vaultServiceMock.enableVault).not.toHaveBeenCalled();
  });

  it('should change password when form is valid', async () => {
    component.changePasswordForm.patchValue({
      currentPassword: 'current_pass',
      newPassword: 'new_secret_pass',
      confirmPassword: 'new_secret_pass',
    });

    await component.submitChangePassword();

    expect(vaultServiceMock.changeVaultPassword).toHaveBeenCalledWith(
      'current_pass',
      'new_secret_pass'
    );
  });

  it('should disable vault with confirmed password', async () => {
    component.disableForm.patchValue({
      password: 'master_password',
    });

    await component.submitDisableVault();

    expect(vaultServiceMock.disableVault).toHaveBeenCalledWith('master_password');
  });

  it('should update auto-lock timeout', async () => {
    await component.onTimeoutChange(1800);
    expect(vaultServiceMock.setVaultLockTimeout).toHaveBeenCalledWith(1800);
  });

  it('should lock vault and close dialog on lockNow()', async () => {
    await component.lockNow();
    expect(vaultServiceMock.lockVault).toHaveBeenCalled();
    expect(dialogRefMock.close).toHaveBeenCalled();
  });
});
