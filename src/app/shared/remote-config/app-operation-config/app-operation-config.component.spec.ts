import { ComponentFixture, TestBed } from '@angular/core/testing';
import { FormArray, FormControl, FormGroup } from '@angular/forms';
import { provideTranslateService } from '@ngx-translate/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { OperationConfigComponent } from './app-operation-config.component';
import { PathInspectionService } from 'src/app/services/infrastructure/platform/path-inspection.service';
import { BackendService } from 'src/app/services/infrastructure/system/backend.service';
import { PathService } from 'src/app/services/infrastructure/platform/path.service';
import { FileSystemService } from 'src/app/services/operations/file-system.service';
import { PathSelectionService } from 'src/app/services/remote/path-selection.service';
import { NotificationService } from 'src/app/services/ui/notification.service';

describe('OperationConfigComponent - Default Path Resolution', () => {
  let fixture: ComponentFixture<OperationConfigComponent>;
  let component: OperationConfigComponent;
  let pathInspectionServiceMock: {
    resolveDefaultPath: ReturnType<typeof vi.fn>;
    getPathStatus: ReturnType<typeof vi.fn>;
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
      getPathStatus: vi.fn().mockResolvedValue({ exists: true, isDirectory: true }),
    };

    backendServiceMock = {
      isLocalBackend: vi.fn().mockReturnValue(true),
    };

    pathServiceMock = {
      parsePathType: vi.fn((val: string) => (val === 'local' ? 'local' : 'currentRemote')),
      getRemoteNameFromValue: vi.fn(() => ''),
    };

    await TestBed.configureTestingModule({
      imports: [OperationConfigComponent],
      providers: [
        provideTranslateService(),
        { provide: PathInspectionService, useValue: pathInspectionServiceMock },
        { provide: BackendService, useValue: backendServiceMock },
        { provide: PathService, useValue: pathServiceMock },
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
    }).compileComponents();
  });

  const setupComponent = (
    operationType: 'mount' | 'bisync' | 'sync',
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

  it('should not auto-resolve path if isNewRemote is false', async () => {
    const { form } = setupComponent('mount', 'my-drive', false);

    await Promise.resolve();
    fixture.detectChanges();

    expect(pathInspectionServiceMock.resolveDefaultPath).not.toHaveBeenCalled();
    expect(form.get('dest.path')?.value).toBe('');
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
});
