import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { FormArray, FormControl, FormGroup } from '@angular/forms';
import { provideTranslateService } from '@ngx-translate/core';
import { MatIconTestingModule } from '@angular/material/icon/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { OperationConfigComponent } from './app-operation-config.component';
import { PathInspectionService } from 'src/app/services/infrastructure/platform/path-inspection.service';
import { BackendService } from 'src/app/services/infrastructure/system/backend.service';
import { PathService } from 'src/app/services/infrastructure/platform/path.service';
import { FileSystemService } from 'src/app/services/operations/file-system.service';
import { PathSelectionService } from 'src/app/services/remote/path-selection.service';
import { NotificationService } from 'src/app/services/ui/notification.service';
import { AutomationService } from 'src/app/services/operations/automation.service';

describe('OperationConfigComponent', () => {
  let fixture: ComponentFixture<OperationConfigComponent>;
  let component: OperationConfigComponent;
  let pathInspectionServiceMock: {
    resolveDefaultPath: ReturnType<typeof vi.fn>;
    inspect: ReturnType<typeof vi.fn>;
  };
  let backendServiceMock: {
    isLocalBackend: ReturnType<typeof vi.fn>;
  };
  let pathServiceMock: {
    parsePathType: ReturnType<typeof vi.fn>;
    getRemoteNameFromValue: ReturnType<typeof vi.fn>;
  };

  const createOpFormGroup = (path = ''): FormGroup => {
    return new FormGroup({
      source: new FormArray([
        new FormGroup({
          type: new FormControl('currentRemote'),
          path: new FormControl(''),
        }),
      ]),
      dest: new FormGroup({
        type: new FormControl('local'),
        path: new FormControl(path),
      }),
      autoStart: new FormControl(false),
      autoStartDelay: new FormControl(0),
      cronEnabled: new FormControl(false),
      cronExpression: new FormControl(null),
      watchEnabled: new FormControl(false),
      watchDelay: new FormControl(5),
      watchChangedOnly: new FormControl(false),
      options: new FormGroup({}),
    });
  };

  beforeEach(async () => {
    pathInspectionServiceMock = {
      resolveDefaultPath: vi
        .fn()
        .mockImplementation((remote: string, type: string) =>
          Promise.resolve(`/home/user/rclone-${type}/${remote}`)
        ),
      inspect: vi.fn().mockResolvedValue({
        state: 'clean',
        icon: 'check-circle',
        badgeClass: 'clean',
        labelKey: 'remoteConfig.pathStatus.clean',
      }),
    };

    backendServiceMock = {
      isLocalBackend: vi.fn().mockReturnValue(true),
    };

    pathServiceMock = {
      parsePathType: vi.fn((val: string) => (val === 'local' ? 'local' : 'currentRemote')),
      getRemoteNameFromValue: vi.fn(() => ''),
    };

    await TestBed.configureTestingModule({
      imports: [OperationConfigComponent, MatIconTestingModule],
      providers: [
        provideTranslateService(),
        { provide: PathInspectionService, useValue: pathInspectionServiceMock },
        { provide: BackendService, useValue: backendServiceMock },
        { provide: PathService, useValue: pathServiceMock },
        {
          provide: AutomationService,
          useValue: { validateCron: vi.fn().mockResolvedValue({ isValid: true }) },
        },
        {
          provide: FileSystemService,
          useValue: { getOperations: vi.fn(), listRemotes: vi.fn() },
        },
        {
          provide: PathSelectionService,
          useValue: {
            resetPath: vi.fn(),
            unregisterField: vi.fn(),
            registerField: vi.fn(),
          },
        },
        {
          provide: NotificationService,
          useValue: { showError: vi.fn(), showWarning: vi.fn(), showSuccess: vi.fn() },
        },
      ],
    })
      .overrideComponent(OperationConfigComponent, {
        set: {
          providers: [
            {
              provide: PathSelectionService,
              useValue: {
                resetPath: vi.fn(),
                unregisterField: vi.fn(),
                registerField: vi
                  .fn()
                  .mockImplementation((id: string, remoteName: string) =>
                    signal({ id, remoteName, currentPath: '', options: [], isLoading: false })
                  ),
              },
            },
          ],
        },
      })
      .compileComponents();
  });

  const setupComponent = (
    operationType: 'mount' | 'serve' | 'bisync' | 'sync',
    currentRemoteName: string,
    isNewRemote = true,
    initialPath = ''
  ): {
    form: FormGroup;
    component: OperationConfigComponent;
    fixture: ComponentFixture<OperationConfigComponent>;
  } => {
    fixture = TestBed.createComponent(OperationConfigComponent);
    component = fixture.componentInstance;
    const form = createOpFormGroup(initialPath);

    fixture.componentRef.setInput('opFormGroup', form);
    fixture.componentRef.setInput('operationType', operationType);
    fixture.componentRef.setInput('currentRemoteName', currentRemoteName);
    fixture.componentRef.setInput('isNewRemote', isNewRemote);
    fixture.detectChanges();

    return { form, component, fixture };
  };

  it('marks cron changes and schedule removal dirty for general remote saving', () => {
    const { form } = setupComponent('sync', 'drive', false);
    form.markAsPristine();
    component.onCronChange('0 2 * * *');
    expect(form.dirty).toBe(true);
    expect(form.get('cronExpression')?.value).toBe('0 2 * * *');
    form.markAsPristine();
    component.clearSchedule();
    expect(form.dirty).toBe(true);
    expect(form.get('cronExpression')?.value).toBeNull();
  });

  it.each(['mount', 'serve', 'sync'] as const)(
    'removes the empty path container for an unmatched %s search',
    operationType => {
      const { form } = setupComponent(operationType, 'drive', false, '/tmp/destination');
      const original = form.getRawValue();
      expect(fixture.nativeElement.querySelector('.paths-container')).not.toBeNull();
      fixture.componentRef.setInput('searchQuery', 'rdf');
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.paths-container')).toBeNull();
      fixture.componentRef.setInput('searchQuery', '');
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.paths-container')).not.toBeNull();
      expect(form.getRawValue()).toEqual(original);
    }
  );

  it.each(['source', 'destination'])(
    'keeps the path container when only the %s section matches',
    query => {
      setupComponent('sync', 'drive', false);
      fixture.componentRef.setInput('searchQuery', query);
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.paths-container')).not.toBeNull();
      expect(
        fixture.nativeElement.querySelectorAll('.paths-container .section-header')
      ).toHaveLength(1);
    }
  );

  describe('automation visibility', () => {
    it.each(['mount', 'serve', 'sync', 'bisync'] as const)(
      'should show autostart during initial %s setup',
      operationType => {
        setupComponent(operationType, 'new-remote');

        expect(fixture.nativeElement.querySelector('[formControlName="autoStart"]')).not.toBeNull();
      }
    );

    it('should expand the startup delay only while autostart is enabled', () => {
      setupComponent('mount', 'new-remote');
      expect(component.autoStartPanelExpanded()).toBe(false);

      component.opFormGroup().get('autoStart')?.setValue(true);
      fixture.detectChanges();

      expect(component.isAutoStartEnabled()).toBe(true);
      expect(component.autoStartPanelExpanded()).toBe(true);
      expect(
        fixture.nativeElement.querySelector('[formControlName="autoStartDelay"]')
      ).not.toBeNull();
    });

    it('should expose the configured startup delay and treat blank values as zero', () => {
      setupComponent('mount', 'new-remote');
      const delay = component.opFormGroup().get('autoStartDelay');

      delay?.setValue(15);
      expect(component.autoStartDelayValue()).toBe(15);

      delay?.setValue(null);
      expect(component.autoStartDelayValue()).toBe(0);
    });

    it('should keep the delay summary visible as none when autostart has no delay', () => {
      setupComponent('mount', 'new-remote');
      const summary = (): string =>
        fixture.nativeElement.querySelector('mat-panel-description')?.textContent ?? '';

      component.opFormGroup().get('autoStart')?.setValue(true);
      fixture.detectChanges();
      expect(summary()).toContain('wizards.appOperation.autoStartDelayNone');

      component.opFormGroup().get('autoStartDelay')?.setValue(15);
      fixture.detectChanges();
      expect(summary()).toContain('15s');
      expect(summary()).not.toContain('wizards.appOperation.autoStartDelayNone');
    });

    it.each(['sync', 'bisync'] as const)(
      'should show scheduling and file watching during initial %s setup',
      operationType => {
        setupComponent(operationType, 'new-remote');

        expect(
          fixture.nativeElement.querySelector('[formControlName="cronEnabled"]')
        ).not.toBeNull();
        expect(
          fixture.nativeElement.querySelector('[formControlName="watchEnabled"]')
        ).not.toBeNull();
      }
    );

    it.each(['mount', 'serve'] as const)(
      'should keep scheduling and file watching unavailable for %s',
      operationType => {
        setupComponent(operationType, 'new-remote');

        expect(fixture.nativeElement.querySelector('[formControlName="cronEnabled"]')).toBeNull();
        expect(fixture.nativeElement.querySelector('[formControlName="watchEnabled"]')).toBeNull();
      }
    );

    it('should keep automations visible when editing an existing remote', () => {
      setupComponent('sync', 'existing-remote', false);

      expect(component.showAutoStart()).toBe(true);
      expect(component.showCronSection()).toBe(true);
      expect(component.showWatchSection()).toBe(true);
    });

    it('should respect the explicit automation visibility input during initial setup', () => {
      setupComponent('sync', 'new-remote');
      fixture.componentRef.setInput('showAutomations', false);
      fixture.detectChanges();

      expect(fixture.nativeElement.querySelector('.automation-accordion')).toBeNull();
      expect(component.showAutoStart()).toBe(false);
      expect(component.showCronSection()).toBe(false);
      expect(component.showWatchSection()).toBe(false);
    });

    it('should filter automation sections by search during initial setup', () => {
      setupComponent('sync', 'new-remote');
      fixture.componentRef.setInput('searchQuery', 'schedule');
      fixture.detectChanges();

      expect(component.showAutoStart()).toBe(false);
      expect(component.showCronSection()).toBe(true);

      fixture.componentRef.setInput('searchQuery', 'start');
      fixture.detectChanges();

      expect(component.showAutoStart()).toBe(true);
      expect(component.showCronSection()).toBe(false);

      fixture.componentRef.setInput('searchQuery', 'unrelated');
      fixture.detectChanges();

      expect(component.showAutoStart()).toBe(false);
      expect(component.showCronSection()).toBe(false);
    });

    it('ignores extra whitespace and requires all search words to match', () => {
      setupComponent('sync', 'new-remote');
      for (const query of ['unrelated  query', 'unrelated ', 'source nonexistent']) {
        fixture.componentRef.setInput('searchQuery', query);
        fixture.detectChanges();
        expect(component.showSourcePath()).toBe(false);
        expect(component.showDestPath()).toBe(false);
        expect(component.showAutoStart()).toBe(false);
        expect(component.showCronSection()).toBe(false);
      }
      fixture.componentRef.setInput('searchQuery', ' source \t path ');
      fixture.detectChanges();
      expect(component.showSourcePath()).toBe(true);
      expect(component.showDestPath()).toBe(false);
      fixture.componentRef.setInput('searchQuery', 'destination path');
      fixture.detectChanges();
      expect(component.showDestPath()).toBe(true);
      fixture.componentRef.setInput('searchQuery', 'auto-start');
      fixture.detectChanges();
      expect(component.showAutoStart()).toBe(true);
    });

    it('should keep file watching disabled without a local source during initial sync setup', () => {
      const { form } = setupComponent('sync', 'new-remote');

      expect(component.showWatchSection()).toBe(true);
      expect(form.get('watchEnabled')?.disabled).toBe(true);

      form.get('source.0.type')?.setValue('local');
      fixture.detectChanges();

      expect(form.get('watchEnabled')?.enabled).toBe(true);
    });

    it('should hide file watching when using a remote backend during initial setup', () => {
      backendServiceMock.isLocalBackend.mockReturnValue(false);
      setupComponent('sync', 'new-remote');

      expect(component.showAutoStart()).toBe(true);
      expect(component.showCronSection()).toBe(true);
      expect(fixture.nativeElement.querySelector('[formControlName="watchEnabled"]')).toBeNull();
    });
  });

  it('should auto-resolve default local path for new mount operation', async () => {
    const { form } = setupComponent('mount', 'my-drive', true);

    await Promise.resolve();
    fixture.detectChanges();

    expect(pathInspectionServiceMock.resolveDefaultPath).toHaveBeenCalledWith('my-drive', 'mount');
    expect(form.get('dest.path')?.value).toBe('/home/user/rclone-mount/my-drive');
  });

  it('should auto-resolve default local path for new bisync operation', async () => {
    const { form } = setupComponent('bisync', 'backup-drive', true);

    await Promise.resolve();
    fixture.detectChanges();

    expect(pathInspectionServiceMock.resolveDefaultPath).toHaveBeenCalledWith(
      'backup-drive',
      'bisync'
    );
    expect(form.get('dest.path')?.value).toBe('/home/user/rclone-bisync/backup-drive');
  });

  it('resolves a missing default for an existing profile through the shared owner', async () => {
    const { form } = setupComponent('mount', 'my-drive', false);

    await Promise.resolve();
    fixture.detectChanges();

    expect(pathInspectionServiceMock.resolveDefaultPath).toHaveBeenCalledWith('my-drive', 'mount');
    expect(form.get('dest.path')?.value).toBe('/home/user/rclone-mount/my-drive');
  });

  it('should not auto-resolve path for sync operation', async () => {
    const { form } = setupComponent('sync', 'my-drive', true);

    await Promise.resolve();
    fixture.detectChanges();

    expect(pathInspectionServiceMock.resolveDefaultPath).not.toHaveBeenCalled();
    expect(form.get('dest.path')?.value).toBe('');
  });

  it('should not overwrite path if dest.path is not pristine (user modified)', async () => {
    fixture = TestBed.createComponent(OperationConfigComponent);
    component = fixture.componentInstance;
    const form = createOpFormGroup('');
    const pathCtrl = form.get('dest.path');
    pathCtrl?.setValue('/custom/manual/path');
    pathCtrl?.markAsDirty();

    fixture.componentRef.setInput('opFormGroup', form);
    fixture.componentRef.setInput('operationType', 'mount');
    fixture.componentRef.setInput('currentRemoteName', 'my-drive');
    fixture.componentRef.setInput('isNewRemote', true);
    fixture.detectChanges();

    await Promise.resolve();
    fixture.detectChanges();

    expect(pathInspectionServiceMock.resolveDefaultPath).not.toHaveBeenCalled();
    expect(form.get('dest.path')?.value).toBe('/custom/manual/path');
  });

  it('should update default path when remote name changes and path is still pristine', async () => {
    const { form } = setupComponent('mount', 'initial-name', true);

    await Promise.resolve();
    fixture.detectChanges();
    expect(form.get('dest.path')?.value).toBe('/home/user/rclone-mount/initial-name');

    // Change remote name
    fixture.componentRef.setInput('currentRemoteName', 'updated-name');
    fixture.detectChanges();

    await Promise.resolve();
    fixture.detectChanges();

    expect(pathInspectionServiceMock.resolveDefaultPath).toHaveBeenCalledWith(
      'updated-name',
      'mount'
    );
    expect(form.get('dest.path')?.value).toBe('/home/user/rclone-mount/updated-name');
  });

  it('should trigger inspect after debounce for local path in mount operation', async () => {
    vi.useFakeTimers();
    try {
      setupComponent('mount', 'my-drive', true, '/home/user/test-mount');
      expect(pathInspectionServiceMock.inspect).not.toHaveBeenCalled();

      vi.advanceTimersByTime(300);
      expect(pathInspectionServiceMock.inspect).toHaveBeenCalledWith(
        '/home/user/test-mount',
        'my-drive',
        undefined,
        'mount'
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('rechecks an unchanged path when the edited profile changes', () => {
    vi.useFakeTimers();
    try {
      setupComponent('mount', 'my-drive', false, '/mnt/shared');
      fixture.componentRef.setInput('currentProfileName', 'First');
      fixture.detectChanges();
      vi.advanceTimersByTime(300);
      expect(pathInspectionServiceMock.inspect).toHaveBeenLastCalledWith(
        '/mnt/shared',
        'my-drive',
        'First',
        'mount'
      );
      fixture.componentRef.setInput('currentProfileName', 'Second');
      fixture.detectChanges();
      vi.advanceTimersByTime(300);
      expect(pathInspectionServiceMock.inspect).toHaveBeenCalledTimes(2);
      expect(pathInspectionServiceMock.inspect).toHaveBeenLastCalledWith(
        '/mnt/shared',
        'my-drive',
        'Second',
        'mount'
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
