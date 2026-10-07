import { ComponentFixture, TestBed } from '@angular/core/testing';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { of, Observable } from 'rxjs';
import { TranslateService, provideTranslateService } from '@ngx-translate/core';
import { PresetTemplateBarComponent } from './preset-template-bar.component';
import { UserTemplateService } from 'src/app/services/remote/user-template.service';
import { RemotePresetsService } from 'src/app/services/remote/remote-presets';
import { ModalService } from 'src/app/services/ui/modal.service';
import { NotificationService } from 'src/app/services/ui/notification.service';
import { UserPresetTemplate } from '@app/types';

describe('PresetTemplateBarComponent', () => {
  let component: PresetTemplateBarComponent;
  let fixture: ComponentFixture<PresetTemplateBarComponent>;
  let modalServiceMock: {
    openTemplateManager: ReturnType<typeof vi.fn>;
    openApplyTemplate: ReturnType<typeof vi.fn>;
  };
  let userTemplateServiceMock: {
    userTemplates: ReturnType<typeof vi.fn>;
  };
  let notificationServiceMock: {
    showWarning: ReturnType<typeof vi.fn>;
    showSuccess: ReturnType<typeof vi.fn>;
  };
  let remotePresetsServiceMock: {
    resolvePresets: ReturnType<typeof vi.fn>;
  };

  const mockDialogRef = {
    afterClosed: (): Observable<{ action: string }> => of({ action: 'saved' }),
  };

  const sampleTemplate: UserPresetTemplate = {
    id: 'tpl-1',
    name: 'Custom Template',
    values: {
      vfs: { vfs_cache_mode: 'full' },
    },
  };

  const mockApplyDialogRef = {
    afterClosed: (): Observable<{ applied: boolean; values: unknown }> =>
      of({ applied: true, values: sampleTemplate.values }),
  };

  beforeEach(() => {
    modalServiceMock = {
      openTemplateManager: vi.fn().mockReturnValue(mockDialogRef),
      openApplyTemplate: vi.fn().mockReturnValue(mockApplyDialogRef),
    };
    userTemplateServiceMock = {
      userTemplates: vi.fn().mockReturnValue([]),
    };
    notificationServiceMock = {
      showWarning: vi.fn(),
      showSuccess: vi.fn(),
    };
    remotePresetsServiceMock = {
      resolvePresets: vi.fn().mockReturnValue({
        vfs: { vfs_cache_mode: 'full' },
        backend: { buffer_size: '32M' },
      }),
    };

    TestBed.configureTestingModule({
      imports: [PresetTemplateBarComponent],
      providers: [
        { provide: ModalService, useValue: modalServiceMock },
        { provide: UserTemplateService, useValue: userTemplateServiceMock },
        { provide: NotificationService, useValue: notificationServiceMock },
        { provide: RemotePresetsService, useValue: remotePresetsServiceMock },
        provideTranslateService(),
      ],
    });

    const translate = TestBed.inject(TranslateService);
    translate.setTranslation('en', {
      templates: {
        defaultPresets: 'Default Presets',
        defaultPresetsDesc: 'Baseline configuration',
      },
      wizards: {
        presets: {
          noRemoteSelected: 'Please select a remote first',
        },
      },
    });
    translate.use('en');

    fixture = TestBed.createComponent(PresetTemplateBarComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create the component', () => {
    expect(component).toBeTruthy();
  });

  it('should open apply template modal and emit applyTemplate when confirmed', () => {
    const emittedEvents: unknown[] = [];
    component.applyTemplate.subscribe(evt => emittedEvents.push(evt));

    component.onSelectTemplate(sampleTemplate);

    expect(modalServiceMock.openApplyTemplate).toHaveBeenCalledWith({
      template: sampleTemplate,
      currentValues: {},
    });
    expect(emittedEvents.length).toBe(1);
    expect(emittedEvents[0]).toEqual({
      sourceName: 'Custom Template',
      values: {
        vfs: { vfs_cache_mode: 'full' },
      },
    });
  });

  it('should not emit applyTemplate when apply modal is cancelled', () => {
    modalServiceMock.openApplyTemplate.mockReturnValue({
      afterClosed: () => of(undefined),
    });

    const emittedEvents: unknown[] = [];
    component.applyTemplate.subscribe(evt => emittedEvents.push(evt));

    component.onSelectTemplate(sampleTemplate);

    expect(modalServiceMock.openApplyTemplate).toHaveBeenCalled();
    expect(emittedEvents.length).toBe(0);
  });

  it('should open the template manager in save mode with currentValues', () => {
    component.openSaveDialog();

    expect(modalServiceMock.openTemplateManager).toHaveBeenCalledWith({
      mode: 'save',
      currentValues: {},
    });
  });

  it('should open the template manager in manage mode', () => {
    component.openManageDialog();

    expect(modalServiceMock.openTemplateManager).toHaveBeenCalledWith({
      mode: 'manage',
    });
  });

  it('should show warning if no remoteType is set when applying default presets', () => {
    component.onApplyDefaultPresets();

    expect(notificationServiceMock.showWarning).toHaveBeenCalledWith(
      'Please select a remote first'
    );
    expect(modalServiceMock.openApplyTemplate).not.toHaveBeenCalled();
  });

  it('should open apply template modal with resolved presets when remoteType is present', () => {
    fixture.componentRef.setInput('remoteType', 's3');
    fixture.componentRef.setInput('vendor', 'aws');
    fixture.detectChanges();

    component.onApplyDefaultPresets();

    expect(remotePresetsServiceMock.resolvePresets).toHaveBeenCalledWith('s3', 'aws');
    expect(modalServiceMock.openApplyTemplate).toHaveBeenCalledWith(
      expect.objectContaining({
        template: expect.objectContaining({
          id: '__default_presets__',
          name: 'Default Presets',
          description: 'Baseline configuration',
          values: {
            vfs: { vfs_cache_mode: 'full' },
            backend: { buffer_size: '32M' },
          },
        }),
        currentValues: {},
      })
    );
  });

  it('should emit applyTemplate when default presets diff modal is confirmed', () => {
    fixture.componentRef.setInput('remoteType', 's3');
    fixture.detectChanges();

    const emittedEvents: unknown[] = [];
    component.applyTemplate.subscribe(evt => emittedEvents.push(evt));

    component.onApplyDefaultPresets();

    expect(emittedEvents.length).toBe(1);
    expect(emittedEvents[0]).toEqual({
      sourceName: 'Default Presets',
      values: sampleTemplate.values,
    });
  });

  it('should filter resolved preset values by applicableCategories when provided', () => {
    fixture.componentRef.setInput('remoteType', 's3');
    fixture.componentRef.setInput('applicableCategories', ['backend']);
    fixture.detectChanges();

    component.onApplyDefaultPresets();

    expect(modalServiceMock.openApplyTemplate).toHaveBeenCalledWith(
      expect.objectContaining({
        template: expect.objectContaining({
          values: {
            backend: { buffer_size: '32M' },
          },
        }),
        applicableCategories: ['backend'],
      })
    );
  });
});
