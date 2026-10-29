import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideTranslateService } from '@ngx-translate/core';
import { BackendSecurityComponent } from './backend-security.component';
import { RclonePasswordService } from 'src/app/services/security/rclone-password.service';

describe('BackendSecurityComponent', () => {
  let fixture: ComponentFixture<BackendSecurityComponent>;
  let component: BackendSecurityComponent;
  let passwords: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(async () => {
    passwords = {
      hasStoredPassword: vi.fn().mockResolvedValue(false),
      isConfigEncrypted: vi.fn().mockResolvedValue(false),
      encryptConfig: vi.fn().mockResolvedValue(undefined),
      storePassword: vi.fn().mockResolvedValue(undefined),
      removeStoredPassword: vi.fn().mockResolvedValue(undefined),
      validatePassword: vi.fn().mockResolvedValue(undefined),
    };
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await TestBed.configureTestingModule({
      imports: [BackendSecurityComponent],
      providers: [
        provideTranslateService(),
        { provide: RclonePasswordService, useValue: passwords },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(BackendSecurityComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    await fixture.whenStable();
  });

  it('encrypts the config, keeps the password and refreshes the status', async () => {
    passwords['isConfigEncrypted'].mockResolvedValue(true);
    component.encryptForm.setValue({ newPassword: 'secret', confirmPassword: 'secret' });

    await component.submitEncrypt();

    expect(passwords['encryptConfig']).toHaveBeenCalledWith('secret');
    expect(passwords['storePassword']).toHaveBeenCalledWith('secret', { showSuccess: false });
    expect(component.isConfigEncrypted()).toBe(true);
    expect(component.encryptForm.value.newPassword).toBeFalsy();
    expect(component.encryptionLoading()).toBe(false);
  });

  it('does nothing while the form is invalid', async () => {
    component.encryptForm.setValue({ newPassword: 'secret', confirmPassword: 'other' });

    await component.submitEncrypt();

    expect(passwords['encryptConfig']).not.toHaveBeenCalled();
  });

  it('ends loading and keeps the form when an action fails', async () => {
    passwords['encryptConfig'].mockRejectedValue(new Error('denied'));
    component.encryptForm.setValue({ newPassword: 'secret', confirmPassword: 'secret' });

    await component.submitEncrypt();

    expect(component.encryptionLoading()).toBe(false);
    expect(component.encryptForm.value.newPassword).toBe('secret');
    expect(passwords['storePassword']).not.toHaveBeenCalled();
  });

  it('reloads the stored-password state even when removing it fails', async () => {
    passwords['removeStoredPassword'].mockRejectedValue(new Error('keychain locked'));
    passwords['hasStoredPassword'].mockClear();

    await component.removeStoredPassword();

    expect(passwords['hasStoredPassword']).toHaveBeenCalledOnce();
    expect(component.encryptionLoading()).toBe(false);
  });

  it('stores a keychain password after validating it and closes the input', async () => {
    component.showKeychainInput.set(true);
    component.keychainPassword.setValue('secret');

    await component.submitKeychainStore();

    expect(passwords['validatePassword']).toHaveBeenCalledWith('secret');
    expect(passwords['storePassword']).toHaveBeenCalledWith('secret');
    expect(component.showKeychainInput()).toBe(false);
    expect(component.keychainPassword.value).toBeNull();
  });
});
