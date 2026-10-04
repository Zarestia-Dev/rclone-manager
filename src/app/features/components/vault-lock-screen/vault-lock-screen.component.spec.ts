import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { VaultLockScreenComponent } from './vault-lock-screen.component';
import { VaultService } from '../../../services/security/vault.service';
import { TranslateService, TranslatePipe } from '@ngx-translate/core';
import { Pipe, PipeTransform } from '@angular/core';

@Pipe({ name: 'translate' })
class MockTranslatePipe implements PipeTransform {
  transform(key: string): string {
    return key;
  }
}

import { BackendTranslationService } from '../../../services/i18n/backend-translation.service';

describe('VaultLockScreenComponent', () => {
  let component: VaultLockScreenComponent;
  let fixture: ComponentFixture<VaultLockScreenComponent>;
  let vaultServiceMock: {
    isBusy: ReturnType<typeof signal<boolean>>;
    unlockVault: ReturnType<typeof vi.fn>;
  };
  let translateMock: {
    instant: ReturnType<typeof vi.fn>;
  };
  let backendTranslationMock: {
    translateBackendMessage: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    vaultServiceMock = {
      isBusy: signal(false),
      unlockVault: vi.fn().mockResolvedValue(undefined),
    };
    translateMock = {
      instant: vi.fn((key: string) => key),
    };
    backendTranslationMock = {
      translateBackendMessage: vi.fn((err: unknown) =>
        err instanceof Error ? err.message : String(err)
      ),
    };

    await TestBed.configureTestingModule({
      imports: [VaultLockScreenComponent],
      providers: [
        { provide: VaultService, useValue: vaultServiceMock },
        { provide: TranslateService, useValue: translateMock },
        { provide: BackendTranslationService, useValue: backendTranslationMock },
      ],
    })
      .overrideComponent(VaultLockScreenComponent, {
        remove: { imports: [TranslatePipe] },
        add: { imports: [MockTranslatePipe] },
      })
      .compileComponents();

    fixture = TestBed.createComponent(VaultLockScreenComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create the component', () => {
    expect(component).toBeTruthy();
    expect(component.showPassword()).toBe(false);
  });

  it('should toggle password visibility', () => {
    component.togglePasswordVisibility();
    expect(component.showPassword()).toBe(true);
    component.togglePasswordVisibility();
    expect(component.showPassword()).toBe(false);
  });

  it('should submit unlock with valid password', async () => {
    component.passwordControl.setValue('master_pass');
    await component.submitUnlock();
    expect(vaultServiceMock.unlockVault).toHaveBeenCalledWith('master_pass');
  });

  it('should prevent default event action on submit', async () => {
    const mockEvent = { preventDefault: vi.fn() } as unknown as Event;
    component.passwordControl.setValue('master_pass');
    await component.submitUnlock(mockEvent);
    expect(mockEvent.preventDefault).toHaveBeenCalled();
    expect(vaultServiceMock.unlockVault).toHaveBeenCalledWith('master_pass');
  });

  it('should show error message if unlock fails', async () => {
    vaultServiceMock.unlockVault.mockRejectedValueOnce(new Error('Invalid password'));
    component.passwordControl.setValue('wrong_pass');
    await component.submitUnlock();
    expect(component.errorMessage()).toBe('Invalid password');
  });
});
