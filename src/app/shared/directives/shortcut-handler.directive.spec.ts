import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Component } from '@angular/core';
import { provideTranslateService } from '@ngx-translate/core';
import { MatDialog } from '@angular/material/dialog';
import { ShortcutHandlerDirective } from './shortcut-handler.directive';
import { MountManagementService } from 'src/app/services/operations/mount-management.service';
import { ServeManagementService } from 'src/app/services/operations/serve-management.service';
import { NautilusService } from 'src/app/services/ui/nautilus.service';
import { WindowService } from 'src/app/services/ui/window.service';
import { BackupRestoreUiService } from 'src/app/services/settings/backup-restore-ui.service';
import { OnboardingStateService } from 'src/app/services/ui/state/onboarding-state.service';
import { NotificationService } from 'src/app/services/ui/notification.service';
import { ModalService } from 'src/app/services/ui/modal.service';
import { FlowOverlayService } from 'src/app/services/ui/flow-overlay.service';

@Component({
  imports: [ShortcutHandlerDirective],
  template: `<div appShortcutHandler></div>`,
})
class TestHostComponent {}

describe('ShortcutHandlerDirective', () => {
  let fixture: ComponentFixture<TestHostComponent>;
  let modalServiceSpy: { openKeyboardShortcuts: ReturnType<typeof vi.fn> };
  let windowServiceSpy: { quitApplication: ReturnType<typeof vi.fn> };
  let nautilusServiceSpy: {
    toggleNautilusOverlay: ReturnType<typeof vi.fn>;
    isBrowserOverlayOpen: ReturnType<typeof vi.fn>;
  };
  let flowOverlayServiceSpy: {
    isFlowOverlayOpen: ReturnType<typeof vi.fn>;
    toggleFlowOverlay: ReturnType<typeof vi.fn>;
  };
  let matDialogSpy: { openDialogs: unknown[] };
  let onboardingStateServiceSpy: { isOnboardingActive: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    modalServiceSpy = { openKeyboardShortcuts: vi.fn() };
    windowServiceSpy = { quitApplication: vi.fn().mockResolvedValue(undefined) };
    nautilusServiceSpy = {
      toggleNautilusOverlay: vi.fn(),
      isBrowserOverlayOpen: vi.fn().mockReturnValue(false),
    };
    flowOverlayServiceSpy = {
      isFlowOverlayOpen: vi.fn().mockReturnValue(false),
      toggleFlowOverlay: vi.fn(),
    };
    matDialogSpy = { openDialogs: [] };
    onboardingStateServiceSpy = { isOnboardingActive: vi.fn().mockReturnValue(false) };

    await TestBed.configureTestingModule({
      imports: [TestHostComponent],
      providers: [
        provideTranslateService(),
        { provide: ModalService, useValue: modalServiceSpy },
        { provide: WindowService, useValue: windowServiceSpy },
        { provide: NautilusService, useValue: nautilusServiceSpy },
        { provide: FlowOverlayService, useValue: flowOverlayServiceSpy },
        { provide: MatDialog, useValue: matDialogSpy },
        { provide: OnboardingStateService, useValue: onboardingStateServiceSpy },
        {
          provide: NotificationService,
          useValue: { showSuccess: vi.fn(), showError: vi.fn() },
        },
        {
          provide: MountManagementService,
          useValue: { forceCheckMountedRemotes: vi.fn() },
        },
        {
          provide: ServeManagementService,
          useValue: { forceCheckServes: vi.fn() },
        },
        {
          provide: BackupRestoreUiService,
          useValue: { launchRestoreFlow: vi.fn() },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(TestHostComponent);
    fixture.detectChanges();
  });

  it('triggers quitApplication on Ctrl+Q even when in input field', () => {
    const input = document.createElement('input');
    const event = new KeyboardEvent('keydown', {
      key: 'q',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(event, 'target', { value: input });

    window.dispatchEvent(event);
    expect(windowServiceSpy.quitApplication).toHaveBeenCalled();
  });

  it('triggers toggleFileBrowser on Ctrl+B', () => {
    const event = new KeyboardEvent('keydown', {
      key: 'b',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });

    window.dispatchEvent(event);
    expect(nautilusServiceSpy.toggleNautilusOverlay).toHaveBeenCalled();
  });

  it('opens main shortcuts modal on Ctrl+? when neither flow nor nautilus is open', () => {
    const event = new KeyboardEvent('keydown', {
      key: '?',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });

    window.dispatchEvent(event);
    expect(modalServiceSpy.openKeyboardShortcuts).toHaveBeenCalledWith({ context: 'main' });
  });

  it('opens flow shortcuts modal on Ctrl+? when flow overlay is open', () => {
    flowOverlayServiceSpy.isFlowOverlayOpen.mockReturnValue(true);

    const event = new KeyboardEvent('keydown', {
      key: '?',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });

    window.dispatchEvent(event);
    expect(modalServiceSpy.openKeyboardShortcuts).toHaveBeenCalledWith({ context: 'flow' });
  });

  it('opens nautilus shortcuts modal on Ctrl+? when nautilus overlay is open', () => {
    nautilusServiceSpy.isBrowserOverlayOpen.mockReturnValue(true);

    const event = new KeyboardEvent('keydown', {
      key: '?',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });

    window.dispatchEvent(event);
    expect(modalServiceSpy.openKeyboardShortcuts).toHaveBeenCalledWith({ context: 'nautilus' });
  });

  it('blocks non-critical shortcuts when dialog is open', () => {
    matDialogSpy.openDialogs = [{ id: 'some-dialog' }];

    const event = new KeyboardEvent('keydown', {
      key: 'b',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });

    window.dispatchEvent(event);
    expect(nautilusServiceSpy.toggleNautilusOverlay).not.toHaveBeenCalled();
  });
});
