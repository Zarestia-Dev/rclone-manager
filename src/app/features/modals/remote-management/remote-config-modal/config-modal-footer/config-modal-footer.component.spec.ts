import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MatIconTestingModule } from '@angular/material/icon/testing';
import { provideTranslateService } from '@ngx-translate/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteConfigStateService } from 'src/app/services/remote/remote-config-state.service';
import { ConfigModalFooterComponent } from './config-modal-footer.component';

describe('ConfigModalFooterComponent back navigation', () => {
  let fixture: ComponentFixture<ConfigModalFooterComponent>;
  const authenticating = signal(false);
  const step = signal(2);
  const editTarget = signal<string | null>(null);
  const flow = signal({ isActive: false, isProcessing: false, answer: null });

  beforeEach(() => {
    authenticating.set(false);
    step.set(2);
    editTarget.set(null);
    flow.set({ isActive: false, isProcessing: false, answer: null });
    TestBed.configureTestingModule({
      imports: [ConfigModalFooterComponent, MatIconTestingModule],
      providers: [
        provideTranslateService(),
        {
          provide: RemoteConfigStateService,
          useValue: {
            interactiveFlowState: flow,
            currentStep: step,
            editTarget,
            isAuthInProgress: authenticating,
            isAuthCancelled: signal(false),
            isSaveDisabled: signal(false),
            saveButtonLabel: signal('common.save'),
            stepConfigs: signal([{}, {}]),
            isNextDisabled: signal(false),
            isInteractiveContinueDisabled: signal(false),
          },
        },
      ],
    });
    fixture = TestBed.createComponent(ConfigModalFooterComponent);
    fixture.detectChanges();
  });

  it('disables Back during authentication and restores it when authentication ends', () => {
    const previous = vi.fn();
    fixture.componentInstance.prevStep.subscribe(previous);
    const button: HTMLButtonElement = fixture.nativeElement.querySelector('.back-btn');
    button.click();
    expect(previous).toHaveBeenCalledOnce();

    authenticating.set(true);
    fixture.detectChanges();
    expect(button.disabled).toBe(true);
    button.click();
    expect(previous).toHaveBeenCalledOnce();

    authenticating.set(false);
    fixture.detectChanges();
    expect(button.disabled).toBe(false);
    button.click();
    expect(previous).toHaveBeenCalledTimes(2);
  });

  it('hides Back for a direct edit, an interactive flow, and the first step', async () => {
    editTarget.set('vfs');
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('.back-btn')).toBeNull();
    editTarget.set(null);
    flow.set({ isActive: true, isProcessing: false, answer: null });
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('.back-btn')).toBeNull();
    flow.set({ isActive: false, isProcessing: false, answer: null });
    step.set(1);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('.back-btn')).toBeNull();
  });
});
