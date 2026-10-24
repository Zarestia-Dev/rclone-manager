import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { VaultLockScreenComponent } from './vault-lock-screen.component';
import { VaultService } from '../../../services/security/vault.service';
import { TranslateService, TranslatePipe } from '@ngx-translate/core';
import { Pipe, PipeTransform } from '@angular/core';

import { WindowService } from '../../../services/ui/window.service';
import { UiStateService } from '../../../services/ui/state/ui-state.service';
import { WindowControlsComponent } from '../../../shared/components/window-controls/window-controls.component';
import { AppLifecycleService } from '../../../services/infrastructure/system/app-lifecycle.service';
import { MatIconTestingModule } from '@angular/material/icon/testing';

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

  const windowMock = {
    isMaximized: signal(false),
    minimize: vi.fn(),
    maximize: vi.fn(),
    close: vi.fn(),
  };
  const lifecycleMock = {
    lockedExitRequested: signal(false),
    isQuitting: signal(false),
    cancelLockedExit: vi.fn(),
    confirmLockedExit: vi.fn().mockResolvedValue(undefined),
  };
  let nativeDescriptor: PropertyDescriptor | undefined;
  let motionQuery: MediaQueryList;
  let resizeCallback: ResizeObserverCallback;
  const disconnect = vi.fn();

  beforeEach(async () => {
    nativeDescriptor = Object.getOwnPropertyDescriptor(window, '__TAURI_INTERNALS__');
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    vi.stubGlobal('__TAURI_OS_PLUGIN_INTERNALS__', { platform: 'linux' });
    windowMock.isMaximized.set(false);
    lifecycleMock.lockedExitRequested.set(false);
    lifecycleMock.isQuitting.set(false);
    lifecycleMock.confirmLockedExit.mockReset().mockResolvedValue(undefined);
    lifecycleMock.cancelLockedExit.mockClear();
    motionQuery = {
      matches: false,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as MediaQueryList;
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => motionQuery)
    );
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          resizeCallback = callback;
        }
        observe = vi.fn();
        disconnect = disconnect;
      }
    );
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
      imports: [VaultLockScreenComponent, MatIconTestingModule],
      providers: [
        { provide: WindowService, useValue: windowMock },
        { provide: AppLifecycleService, useValue: lifecycleMock },
        { provide: UiStateService, useValue: { platform: 'linux' } },
        { provide: VaultService, useValue: vaultServiceMock },
        { provide: TranslateService, useValue: translateMock },
        { provide: BackendTranslationService, useValue: backendTranslationMock },
      ],
    })
      .overrideComponent(VaultLockScreenComponent, {
        remove: { imports: [TranslatePipe] },
        add: { imports: [MockTranslatePipe] },
      })
      .overrideComponent(WindowControlsComponent, {
        remove: { imports: [TranslatePipe] },
        add: { imports: [MockTranslatePipe] },
      })
      .compileComponents();

    fixture = TestBed.createComponent(VaultLockScreenComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
    if (nativeDescriptor) Object.defineProperty(window, '__TAURI_INTERNALS__', nativeDescriptor);
    else Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('should keep the card stationary while preserving background pointer movement', () => {
    let frame!: FrameRequestCallback;
    const request = vi.fn((callback: FrameRequestCallback) => {
      frame = callback;
      return 7;
    });
    const cancel = vi.fn();
    vi.stubGlobal('requestAnimationFrame', request);
    vi.stubGlobal('cancelAnimationFrame', cancel);
    const host = fixture.nativeElement as HTMLElement;
    vi.spyOn(host, 'getBoundingClientRect').mockReturnValue({
      left: 10,
      top: 20,
      width: 200,
      height: 100,
    } as DOMRect);
    component.onPointerMove({ pointerType: 'mouse', clientX: 110, clientY: 70 } as PointerEvent);
    component.onPointerMove({ pointerType: 'mouse', clientX: 210, clientY: 120 } as PointerEvent);
    expect(request).toHaveBeenCalledTimes(1);
    frame(0);
    expect(host.style.length).toBe(0);
    expect(host.querySelector<HTMLElement>('.hud-background')?.style.transform).toContain(
      'rotateY(3deg)'
    );
    expect(host.querySelector<HTMLElement>('.hud-panel-plane')?.style.transform).toBe('');
    component.onPointerMove({ pointerType: 'mouse', clientX: 0, clientY: 0 } as PointerEvent);
    component.onPointerLeave();
    expect(cancel).toHaveBeenCalledWith(7);
    expect(host.querySelector<HTMLElement>('.hud-background')?.style.transform).toBe('');
    expect(host.querySelector<HTMLElement>('.hud-panel-plane')?.style.transform).toBe('');
  });

  it('should ignore touch input and reduced-motion mouse input', () => {
    const request = vi.fn();
    vi.stubGlobal('requestAnimationFrame', request);
    component.onPointerMove({ pointerType: 'touch', clientX: 20, clientY: 20 } as PointerEvent);
    Object.defineProperty(motionQuery, 'matches', { value: true });
    component.onPointerMove({ pointerType: 'mouse', clientX: 20, clientY: 20 } as PointerEvent);
    expect(request).not.toHaveBeenCalled();
  });

  it('should rebuild aligned cells on resize and remove motion when the preference changes', () => {
    const background = fixture.nativeElement.querySelector('.hud-background') as HTMLElement;
    Object.defineProperties(background, {
      clientWidth: { value: 800 },
      clientHeight: { value: 600 },
    });
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      maskSize: '42px 73px',
    } as CSSStyleDeclaration);
    resizeCallback([], {} as ResizeObserver);
    expect(component.waveCells().length).toBeGreaterThan(0);
    const cells = component.waveCells();
    fixture.detectChanges();
    const viewports = fixture.nativeElement.querySelectorAll(
      '.hex-wave-cell'
    ) as NodeListOf<SVGElement>;
    expect(viewports.length).toBe(cells.length);
    expect(viewports[0].getAttribute('viewBox')).toBe('-34 -42 68 84');
    expect(Number(viewports[0].getAttribute('width'))).toBeCloseTo(51);
    expect(viewports[0].querySelector('.hex-wave-trace')).not.toBeNull();
    resizeCallback([], {} as ResizeObserver);
    expect(component.waveCells()).toBe(cells);
    expect(component.waveScale().x).toBe(0.75);
    Object.defineProperty(motionQuery, 'matches', { value: true });
    const listener = vi.mocked(motionQuery.addEventListener).mock.calls[0][1] as () => void;
    listener();
    expect(component.waveCells()).toEqual([]);
    fixture.destroy();
    expect(disconnect).toHaveBeenCalled();
    expect(motionQuery.removeEventListener).toHaveBeenCalledWith('change', listener);
  });

  it('should pause effects while hidden', () => {
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));
    fixture.detectChanges();
    expect(component.effectsPaused()).toBe(true);
    expect(fixture.nativeElement.querySelector('.effects-paused')).not.toBeNull();
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(component.effectsPaused()).toBe(false);
  });

  it('preserves a pending exit when the lock screen is destroyed', () => {
    lifecycleMock.lockedExitRequested.set(true);
    fixture.destroy();
    expect(lifecycleMock.cancelLockedExit).not.toHaveBeenCalled();
  });

  it('should preserve the running wave when authorization fails', async () => {
    const background = fixture.nativeElement.querySelector('.hud-background') as HTMLElement;
    Object.defineProperties(background, {
      clientWidth: { value: 800 },
      clientHeight: { value: 600 },
    });
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      maskSize: '42px 73px',
    } as CSSStyleDeclaration);
    resizeCallback([], {} as ResizeObserver);
    fixture.detectChanges();
    const cells = component.waveCells();
    const trace = fixture.nativeElement.querySelector('.hex-wave-trace');
    vaultServiceMock.unlockVault.mockRejectedValueOnce(new Error('Wrong password'));
    component.passwordControl.setValue('wrong');
    await component.submitUnlock();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.denied')).not.toBeNull();
    expect(component.effectsPaused()).toBe(false);
    expect(component.waveCells()).toBe(cells);
    expect(fixture.nativeElement.querySelector('.hex-wave-trace')).toBe(trace);
    expect(fixture.nativeElement.querySelector('.effects-paused')).toBeNull();
  });

  it('uses the WebKit mask size and ignores unavailable texture dimensions', () => {
    const background = fixture.nativeElement.querySelector('.hud-background') as HTMLElement;
    Object.defineProperties(background, {
      clientWidth: { value: 800 },
      clientHeight: { value: 600 },
    });
    const style = vi.spyOn(window, 'getComputedStyle');
    style.mockReturnValue({
      maskSize: '',
      getPropertyValue: vi.fn(() => '42px   73px'),
    } as unknown as CSSStyleDeclaration);
    resizeCallback([], {} as ResizeObserver);
    expect(component.waveCells().length).toBeGreaterThan(0);
    expect(component.waveScale().x).toBe(0.75);
    style.mockReturnValue({ maskSize: 'auto' } as CSSStyleDeclaration);
    resizeCallback([], {} as ResizeObserver);
    expect(component.waveCells()).toEqual([]);
    expect(Number.isFinite(component.waveScale().y)).toBe(true);
  });

  it('offers only the existing desktop window controls in the title bar', () => {
    const screen = fixture.nativeElement as HTMLElement;
    const header = screen.querySelector('.vault-window-bar');
    expect(header?.getAttribute('data-tauri-drag-region')).not.toBeNull();
    const controls = header?.querySelectorAll('app-window-controls button');
    expect(controls?.length).toBe(3);
    (controls?.[0] as HTMLButtonElement).click();
    (controls?.[1] as HTMLButtonElement).click();
    (controls?.[2] as HTMLButtonElement).click();
    expect(windowMock.minimize).toHaveBeenCalled();
    expect(windowMock.maximize).toHaveBeenCalled();
    expect(windowMock.close).toHaveBeenCalled();
    expect(header?.querySelectorAll('button').length).toBe(3);
  });

  it.each(['web', 'mobile'])('hides native controls and ignores exit calls on %s', async mode => {
    fixture.destroy();
    if (mode === 'web') Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
    else vi.stubGlobal('__TAURI_OS_PLUGIN_INTERNALS__', { platform: 'android' });
    fixture = TestBed.createComponent(VaultLockScreenComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.vault-window-bar')).toBeNull();
    await component.confirmExit();
    expect(lifecycleMock.confirmLockedExit).not.toHaveBeenCalled();
  });

  it('shows pending exit confirmation inside the locked screen and reports shutdown errors', async () => {
    lifecycleMock.lockedExitRequested.set(true);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[role="alertdialog"]')).not.toBeNull();
    lifecycleMock.confirmLockedExit.mockRejectedValueOnce(new Error('Cannot shut down'));
    await component.confirmExit();
    expect(component.errorMessage()).toBe('Cannot shut down');
  });

  it('blocks unlocking while exit confirmation or shutdown is in progress', async () => {
    component.passwordControl.setValue('password');
    lifecycleMock.lockedExitRequested.set(true);
    fixture.detectChanges();
    expect(
      (fixture.nativeElement.querySelector('form') as HTMLFormElement).hasAttribute('inert')
    ).toBe(true);
    await component.submitUnlock();
    lifecycleMock.lockedExitRequested.set(false);
    lifecycleMock.isQuitting.set(true);
    await component.submitUnlock();
    expect(vaultServiceMock.unlockVault).not.toHaveBeenCalled();
  });

  it('should create the component', () => {
    expect(component).toBeTruthy();
    expect(component.showPassword()).toBe(false);
  });

  it('should describe the password field with the current authorization state', () => {
    const screen = fixture.nativeElement as HTMLElement;
    expect(screen.querySelector('#vault-status')?.textContent).toContain(
      'vault.lockScreen.awaitingAuthorization'
    );
    expect(screen.querySelector('input')?.getAttribute('aria-describedby')).toBe('vault-status');
  });

  it('should show authorization progress and prevent duplicate submissions', async () => {
    component.passwordControl.setValue('password');
    vaultServiceMock.isBusy.set(true);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('#vault-status').textContent).toContain(
      'vault.lockScreen.authorizing'
    );
    expect(fixture.nativeElement.querySelector('.unlock-button').disabled).toBe(true);
    await component.submitUnlock();
    expect(vaultServiceMock.unlockVault).not.toHaveBeenCalled();
  });

  it('should keep the ready state when an empty password is submitted', async () => {
    await component.submitUnlock();
    expect(vaultServiceMock.unlockVault).not.toHaveBeenCalled();
    expect(component.passwordControl.touched).toBe(true);
    expect(component.errorMessage()).toBeNull();
  });

  it('should display translated backend errors as text in the status line', async () => {
    vaultServiceMock.unlockVault.mockRejectedValueOnce('backend error');
    const message = 'Yanlış parola <script>alert(1)</script> & tekrar deneyin';
    backendTranslationMock.translateBackendMessage.mockReturnValueOnce(message);
    component.passwordControl.setValue('wrong');
    await component.submitUnlock();
    fixture.detectChanges();
    const status = fixture.nativeElement.querySelector('#vault-status') as HTMLElement;
    expect(status.textContent).toContain(message);
    expect(status.classList.contains('status-error')).toBe(true);
    expect(status.querySelector('script')).toBeNull();
  });

  it('should use the translated fallback when the backend supplies no message', async () => {
    vaultServiceMock.unlockVault.mockRejectedValueOnce(null);
    backendTranslationMock.translateBackendMessage.mockReturnValueOnce('');
    component.passwordControl.setValue('wrong');
    await component.submitUnlock();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('#vault-status').textContent).toContain(
      'vault.errors.unlockFailed'
    );
  });

  it('should clear the previous error when authorization is retried', async () => {
    component.errorMessage.set('Previous error');
    component.passwordControl.setValue('correct');
    let finishUnlock!: () => void;
    vaultServiceMock.unlockVault.mockImplementationOnce(() => {
      vaultServiceMock.isBusy.set(true);
      return new Promise<void>(resolve => {
        finishUnlock = resolve;
      });
    });
    const pending = component.submitUnlock();
    fixture.detectChanges();
    const status = fixture.nativeElement.querySelector('#vault-status') as HTMLElement;
    expect(status.textContent).toContain('vault.lockScreen.authorizing');
    expect(status.classList.contains('status-error')).toBe(false);
    finishUnlock();
    await pending;
    vaultServiceMock.isBusy.set(false);
    fixture.detectChanges();
    expect(status.textContent).toContain('vault.lockScreen.awaitingAuthorization');
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
