import { TestBed } from '@angular/core/testing';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { of, Observable } from 'rxjs';
import { TranslateService } from '@ngx-translate/core';
import { PresetTemplateBarComponent } from './preset-template-bar.component';
import { UserTemplateService } from 'src/app/services/remote/user-template.service';
import { ModalService } from 'src/app/services/ui/modal.service';
import { UserPresetTemplate } from '@app/types';

describe('PresetTemplateBarComponent', () => {
  let component: PresetTemplateBarComponent;
  let modalServiceMock: {
    openTemplateManager: ReturnType<typeof vi.fn>;
  };
  let userTemplateServiceMock: {
    userTemplates: ReturnType<typeof vi.fn>;
  };

  const mockDialogRef = {
    afterClosed: (): Observable<{ action: string }> => of({ action: 'saved' }),
  };

  beforeEach(() => {
    modalServiceMock = {
      openTemplateManager: vi.fn().mockReturnValue(mockDialogRef),
    };
    userTemplateServiceMock = {
      userTemplates: vi.fn().mockReturnValue([]),
    };

    TestBed.configureTestingModule({
      providers: [
        PresetTemplateBarComponent,
        { provide: ModalService, useValue: modalServiceMock },
        { provide: UserTemplateService, useValue: userTemplateServiceMock },
        {
          provide: TranslateService,
          useValue: { instant: vi.fn((k: string) => k), get: vi.fn(() => of('')) },
        },
      ],
    });

    component = TestBed.inject(PresetTemplateBarComponent);
  });

  it('should create the component', () => {
    expect(component).toBeTruthy();
  });

  it('should emit applyTemplate when a template is selected', () => {
    const emittedEvents: unknown[] = [];
    component.applyTemplate.subscribe(evt => emittedEvents.push(evt));

    const sampleTemplate: UserPresetTemplate = {
      id: 'tpl-1',
      name: 'Custom Template',
      values: {
        vfs: { vfs_cache_mode: 'full' },
      },
    };

    component.onSelectTemplate(sampleTemplate);

    expect(emittedEvents.length).toBe(1);
    expect(emittedEvents[0]).toEqual({
      sourceName: 'Custom Template',
      values: {
        vfs: { vfs_cache_mode: 'full' },
      },
    });
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
});
