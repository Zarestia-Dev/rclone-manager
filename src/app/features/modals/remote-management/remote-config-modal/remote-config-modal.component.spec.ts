import { TestBed } from '@angular/core/testing';
import { ElementRef, signal, WritableSignal } from '@angular/core';
import { FormControl, FormGroup } from '@angular/forms';
import { MatDialogRef } from '@angular/material/dialog';
import { provideTranslateService } from '@ngx-translate/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EditTarget } from '@app/types';
import { RemoteConfigModalComponent } from './remote-config-modal.component';
import { RemoteConfigStateService } from '../../../../services/remote/remote-config-state.service';
import { RemoteCreationOrchestrator } from '../../../../services/remote/remote-creation-orchestrator.service';
import { RcloneValueMapperService } from '../../../../services/remote/rclone-value-mapper.service';
import { AuthStateService } from '../../../../services/security/auth-state.service';
import { RemoteManagementService } from '../../../../services/remote/remote-management.service';
import { NotificationService } from '../../../../services/ui/notification.service';
import { createInitialInteractiveFlowState } from '../../../../services/remote/utils/interactive-flow.utils';

describe('RemoteConfigModalComponent', () => {
  let component: RemoteConfigModalComponent;
  let remoteForm: FormGroup;
  let configForm: FormGroup;
  let activeStep: WritableSignal<EditTarget>;
  let close: ReturnType<typeof vi.fn>;
  let submitAnswer: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    remoteForm = new FormGroup({
      name: new FormControl('drive'),
      type: new FormControl('drive'),
      token: new FormControl('initial'),
    });
    configForm = new FormGroup({
      vfsConfig: new FormGroup({
        options: new FormGroup({ vfs_cache_mode: new FormControl('off') }),
      }),
    });
    activeStep = signal<EditTarget>('vfs');
    close = vi.fn();
    submitAnswer = vi.fn().mockResolvedValue(false);
    TestBed.configureTestingModule({
      providers: [
        provideTranslateService(),
        RcloneValueMapperService,
        { provide: MatDialogRef, useValue: { close } },
        { provide: ElementRef, useValue: { nativeElement: {} } },
        {
          provide: RemoteConfigStateService,
          useValue: {
            remoteForm,
            remoteConfigForm: configForm,
            remoteEditVisibleSections: signal(new Set()),
            activeStepType: activeStep,
            getProfileTemplateValues: (type: string): Record<string, unknown> =>
              configForm.get(`${type}Config.options`)?.getRawValue() ?? {},
            cleanFormData: (data: Record<string, unknown>): Record<string, unknown> => data,
            interactiveFlowState: signal(createInitialInteractiveFlowState()),
            commandOptions: signal([]),
            init: vi.fn().mockResolvedValue(undefined),
            isInitializing: signal(true),
            loadFailed: signal(false),
            isSaveDisabled: signal(true),
          },
        },
        {
          provide: RemoteCreationOrchestrator,
          useValue: {
            submitInteractiveAnswer: submitAnswer,
            cancelAuth: vi.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: AuthStateService,
          useValue: { cancelAuth: vi.fn().mockResolvedValue(undefined) },
        },
        { provide: RemoteManagementService, useValue: {} },
        { provide: NotificationService, useValue: {} },
      ],
    });
    component = TestBed.runInInjectionContext(() => new RemoteConfigModalComponent());
  });

  it('updates template values when an operation form changes', () => {
    expect(component.currentValues().vfs?.['vfs_cache_mode']).toBe('off');
    configForm.get('vfsConfig.options.vfs_cache_mode')?.setValue('full');
    expect(component.currentValues().vfs?.['vfs_cache_mode']).toBe('full');
  });

  it('updates provider template values and excludes the remote identity', () => {
    activeStep.set('remote');
    expect(component.currentValues().remote).toEqual({ token: 'initial' });
    remoteForm.get('token')?.setValue('changed');
    expect(component.currentValues().remote).toEqual({ token: 'changed' });
    remoteForm.get('token')?.setValue('');
    expect(component.currentValues().remote).toEqual({ token: '' });
  });

  it('does not close after an unsuccessful answer submission', async () => {
    component.onInteractiveContinue(null);
    await Promise.resolve();
    expect(close).not.toHaveBeenCalled();
  });

  it('closes only when answer submission explicitly succeeds', async () => {
    submitAnswer.mockResolvedValue(true);
    component.onInteractiveContinue('yes');
    await Promise.resolve();
    expect(close).toHaveBeenCalledOnce();
  });
});
