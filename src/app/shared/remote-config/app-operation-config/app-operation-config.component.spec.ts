import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { FormArray, FormControl, FormGroup } from '@angular/forms';
import { provideTranslateService, TranslateService } from '@ngx-translate/core';
import { MatIconTestingModule } from '@angular/material/icon/testing';
import { MatSelectHarness } from '@angular/material/select/testing';
import { TestbedHarnessEnvironment } from '@angular/cdk/testing/testbed';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OperationConfigComponent } from './app-operation-config.component';
import { ApiClientService } from 'src/app/services/infrastructure/platform/api-client.service';
import { PathInspectionService } from 'src/app/services/infrastructure/platform/path-inspection.service';
import { BackendService } from 'src/app/services/infrastructure/system/backend.service';
import { PathService } from 'src/app/services/infrastructure/platform/path.service';
import { BackendTranslationService } from 'src/app/services/i18n/backend-translation.service';
import { WindowsMountTargetService } from 'src/app/services/operations/windows-mount-target.service';
import { MountManagementService } from 'src/app/services/operations/mount-management.service';
import { FileSystemService } from 'src/app/services/operations/file-system.service';
import { PathSelectionService } from 'src/app/services/remote/path-selection.service';
import { RemoteFileOperationsService } from 'src/app/services/remote/remote-file-operations.service';
import { AppSettingsService } from 'src/app/services/settings/app-settings.service';
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
    isWindows: ReturnType<typeof vi.fn>;
    activeBackend: () => string;
  };
  let pathServiceMock: {
    parsePathType: ReturnType<typeof vi.fn>;
    getRemoteNameFromValue: ReturnType<typeof vi.fn>;
    getParentPath: ReturnType<typeof vi.fn>;
    normalizeForPlatform: ReturnType<typeof vi.fn>;
  };
  let fileSystemServiceMock: {
    selectFolder: ReturnType<typeof vi.fn>;
  };

  const getDriveOptions = vi.fn();

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
      options: new FormGroup({
        network_mode: new FormControl(false),
        volname: new FormControl(''),
      }),
    });
  };

  beforeEach(async () => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe = vi.fn();
        disconnect = vi.fn();
      }
    );
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
      isWindows: vi.fn().mockReturnValue(false),
      activeBackend: (): string => 'Local',
    };

    pathServiceMock = {
      parsePathType: vi.fn((val: string) => (val === 'local' ? 'local' : 'currentRemote')),
      getRemoteNameFromValue: vi.fn(() => ''),
      getParentPath: vi.fn().mockReturnValue('D:\\'),
      normalizeForPlatform: vi.fn((path: string) => path),
    };
    fileSystemServiceMock = {
      selectFolder: vi.fn().mockResolvedValue(null),
    };

    getDriveOptions.mockReset().mockResolvedValue([
      { letter: 'Z:', status: 'occupied' },
      { letter: 'Y:', status: 'reserved' },
      { letter: 'X:', status: 'current' },
      { letter: 'W:', status: 'free' },
    ]);
    await TestBed.configureTestingModule({
      imports: [OperationConfigComponent, MatIconTestingModule],
      providers: [
        provideTranslateService(),
        { provide: PathInspectionService, useValue: pathInspectionServiceMock },
        {
          provide: WindowsMountTargetService,
          useValue: { canCheck: (): boolean => true, getDriveOptions },
        },
        { provide: BackendService, useValue: backendServiceMock },
        { provide: PathService, useValue: pathServiceMock },
        {
          provide: AutomationService,
          useValue: { validateCron: vi.fn().mockResolvedValue({ isValid: true }) },
        },
        {
          provide: FileSystemService,
          useValue: fileSystemServiceMock,
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
                triggerLoad: vi.fn(),
                updateInput: vi.fn(),
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
    operationType: 'mount' | 'serve' | 'bisync' | 'sync' | 'copy',
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

  afterEach(() => vi.unstubAllGlobals());

  const selectDestination = (): Promise<void> => {
    const item = component.destItem();
    if (!item) throw new Error('Missing destination');
    return component.selectPath(item);
  };

  it('disables occupied and reserved letters, keeps the current drive and offers folder mode', async () => {
    backendServiceMock.isWindows.mockReturnValue(true);
    const { form, fixture } = setupComponent('mount', 'example', false, 'X:');
    const loader = TestbedHarnessEnvironment.loader(fixture);
    const picker = await loader.getHarness(
      MatSelectHarness.with({ selector: '.mount-drive-letter' })
    );
    expect(fixture.nativeElement.querySelector('.mount-parent-picker')).toBeNull();
    expect(await picker.getValueText()).toBe('X:');
    await picker.open();
    const letters = await picker.getOptions();
    expect(await Promise.all(letters.map(letter => letter.isDisabled()))).toEqual([
      false,
      true,
      true,
      false,
      false,
    ]);
    await letters[2].click();
    expect(form.get('dest.path')?.value).toBe('X:');
    await letters[4].click();
    expect(form.get('dest.path')?.value).toBe('W:');
    expect(form.dirty).toBe(true);
    expect(fileSystemServiceMock.selectFolder).not.toHaveBeenCalled();

    const location = await loader.getHarness(
      MatSelectHarness.with({ selector: '.mount-location' })
    );
    const diskType = await loader.getHarness(
      MatSelectHarness.with({ selector: '.mount-disk-type' })
    );
    const localName = fixture.nativeElement.querySelector(
      '.windows-appearance input'
    ) as HTMLInputElement;
    localName.value = 'Skúšobný disk';
    localName.dispatchEvent(new Event('input', { bubbles: true }));
    await diskType.open();
    const diskOptions = await diskType.getOptions();
    expect(await diskOptions[0].getText()).toContain('mountLocalDrive');
    expect(await diskOptions[1].getText()).toContain('mountNetworkDrive');
    await diskOptions[1].click();
    expect(form.get('options.network_mode')?.value).toBe(true);

    const name = fixture.nativeElement.querySelector(
      '.windows-appearance input'
    ) as HTMLInputElement;
    expect(fixture.nativeElement.querySelector('.windows-appearance').textContent).toContain(
      'mountNetworkName'
    );
    name.value = 'Testing volume';
    name.dispatchEvent(new Event('input', { bubbles: true }));
    expect(form.get('options.volname')?.value).toBe('Testing volume');
    await location.open();
    await (await location.getOptions())[1].click();
    expect(
      await loader.hasHarness(MatSelectHarness.with({ selector: '.mount-drive-letter' }))
    ).toBe(false);
    expect(fixture.nativeElement.querySelector('.mount-parent-picker')).not.toBeNull();
    expect(form.get('options.network_mode')?.value).toBe(false);
    expect(form.get('dest.path')?.invalid).toBe(true);
    fileSystemServiceMock.selectFolder.mockResolvedValueOnce('D:\\Mounts');
    (fixture.nativeElement.querySelector('.mount-parent-picker') as HTMLButtonElement).click();
    await fixture.whenStable();
    expect(form.get('dest.path')?.value).toBe('D:\\Mounts\\Skúšobný disk');
    expect(form.get('dest.path')?.valid).toBe(true);
    expect(fixture.nativeElement.querySelector('.windows-appearance')).toBeNull();
    expect(await loader.hasHarness(MatSelectHarness.with({ selector: '.mount-disk-type' }))).toBe(
      false
    );

    const folder = fixture.nativeElement.querySelector(
      'app-windows-mount-target .path-item-row input'
    ) as HTMLInputElement;
    const hint = fixture.nativeElement.querySelector('.mount-target-hint') as HTMLElement;
    expect(hint.previousElementSibling?.classList.contains('path-list')).toBe(true);
    expect(hint.textContent).toContain('mountFolderNameHint');
    folder.value = 'D:\\Mounts\\backup';
    folder.dispatchEvent(new Event('input', { bubbles: true }));
    expect(form.get('dest.path')?.value).toBe('D:\\Mounts\\backup');
    expect(form.get('options.volname')?.value).toBe('Skúšobný disk');
    folder.value = 'D:' + String.fromCharCode(92);
    folder.dispatchEvent(new Event('input', { bubbles: true }));
    expect(form.get('dest.path')?.hasError('mountFolderPath')).toBe(true);

    await location.open();
    await (await location.getOptions())[0].click();
    expect(form.get('dest.path')?.value).toBe('W:');
    expect(form.get('options.network_mode')?.value).toBe(true);
    expect(form.get('options.volname')?.value).toBe('Testing volume');
    const restoredName = fixture.nativeElement.querySelector(
      '.windows-appearance input'
    ) as HTMLInputElement;
    expect(restoredName.value).toBe('Testing volume');
    restoredName.value = '';
    restoredName.dispatchEvent(new Event('input', { bubbles: true }));
    expect(form.get('options.volname')?.value).toBe('');
    expect(restoredName.placeholder).toContain('mountAutomaticName');
  });

  it('offers only drive and folder modes and remembers the automatic drive selection', async () => {
    backendServiceMock.isWindows.mockReturnValue(true);
    const { fixture, form } = setupComponent('mount', 'example', false, 'X:');
    const location = await TestbedHarnessEnvironment.loader(fixture).getHarness(
      MatSelectHarness.with({ selector: '.mount-location' })
    );
    const picker = await TestbedHarnessEnvironment.loader(fixture).getHarness(
      MatSelectHarness.with({ selector: '.mount-drive-letter' })
    );
    async function choose(index: number): Promise<void> {
      await location.open();
      await (await location.getOptions())[index].click();
    }
    const path = form.get('dest.path');
    await location.open();
    expect(await location.getOptions()).toHaveLength(2);
    await location.close();
    await picker.open();
    await (await picker.getOptions({ text: /mountAutomaticDrive/ }))[0].click();
    expect(path?.value).toBe('*');
    await choose(1);
    expect(path?.value).toBe('');
    await choose(0);
    expect(path?.value).toBe('*');
  });

  it('shows a saved wildcard as Automatic while preserving the stored value', async () => {
    backendServiceMock.isWindows.mockReturnValue(true);
    const { fixture, form } = setupComponent('mount', 'example', false, '*');
    await fixture.whenStable();
    const target = fixture.nativeElement.querySelector('app-windows-mount-target') as HTMLElement;
    expect(target.querySelector('.path-item-row input')).toBeNull();
    expect(target.querySelector('.mount-parent-picker')).toBeNull();
    const picker = await TestbedHarnessEnvironment.loader(fixture).getHarness(
      MatSelectHarness.with({ selector: '.mount-drive-letter' })
    );
    expect(await picker.getValueText()).toContain('mountAutomaticDrive');
    expect(form.get('dest.path')?.value).toBe('*');
    expect(form.pristine).toBe(true);
  });

  it('keeps a legacy relative folder visible and valid', () => {
    backendServiceMock.isWindows.mockReturnValue(true);
    const path = 'Relative\\Mount';
    const { fixture, form } = setupComponent('mount', 'example', false, path);
    const input = fixture.nativeElement.querySelector(
      'app-windows-mount-target .path-item-row input'
    ) as HTMLInputElement;
    expect(input.value).toBe(path);
    expect(form.get('dest.path')?.valid).toBe(true);
    expect(form.pristine).toBe(true);
  });

  describe('legacy Windows network targets', () => {
    const unc = '\\\\server\\share';
    const setupLegacy = async (
      target = unc
    ): Promise<{
      form: FormGroup;
      picker: MatSelectHarness;
      diskType: MatSelectHarness;
      name: HTMLInputElement;
    }> => {
      backendServiceMock.isWindows.mockReturnValue(true);
      const { fixture, form } = setupComponent('mount', 'example', false, target);
      const loader = TestbedHarnessEnvironment.loader(fixture);
      const picker = await loader.getHarness(
        MatSelectHarness.with({ selector: '.mount-drive-letter' })
      );
      const diskType = await loader.getHarness(
        MatSelectHarness.with({ selector: '.mount-disk-type' })
      );
      const name = fixture.nativeElement.querySelector(
        '.windows-appearance input'
      ) as HTMLInputElement;
      return { form, picker, diskType, name };
    };

    it('shows the network name and automatic letter without rewriting the stored target', async () => {
      const { form, picker, diskType, name } = await setupLegacy();
      expect(await picker.getValueText()).toContain('mountAutomaticDrive');
      expect(await diskType.getValueText()).toContain('mountNetworkDrive');
      expect(name.value).toBe(unc);
      expect(form.get('dest.path')?.value).toBe(unc);
      expect(form.get('options.volname')?.value).toBe('');
      expect(form.get('options.network_mode')?.value).toBe(false);
      expect(form.pristine).toBe(true);
    });

    it('keeps the same network name when an explicit drive letter is picked', async () => {
      const { form, picker } = await setupLegacy();
      await picker.open();
      await (await picker.getOptions({ text: /^W:$/ }))[0].click();
      expect(form.get('dest.path')?.value).toBe('W:');
      expect(form.get('options.volname')?.value).toBe(unc);
      expect(form.get('options.network_mode')?.value).toBe(true);
    });

    it('stores an edited legacy network name with an automatic letter', async () => {
      const { form, name } = await setupLegacy();
      name.value = '\\\\server\\different';
      name.dispatchEvent(new Event('input', { bubbles: true }));
      expect(form.get('dest.path')?.value).toBe('*');
      expect(form.get('options.volname')?.value).toBe('\\\\server\\different');
      expect(form.get('options.network_mode')?.value).toBe(true);
    });

    it('switches to a local disk and restores the network name on switching back', async () => {
      const { form, diskType, name } = await setupLegacy();
      await diskType.open();
      await (await diskType.getOptions())[0].click();
      expect(await diskType.getValueText()).toContain('mountLocalDrive');
      expect(form.get('dest.path')?.value).toBe('*');
      expect(name.value).toBe('');

      await diskType.open();
      await (await diskType.getOptions())[1].click();
      expect(await diskType.getValueText()).toContain('mountNetworkDrive');
      expect(name.value).toBe(unc);
      expect(form.get('options.volname')?.value).toBe(unc);
      expect(form.get('options.network_mode')?.value).toBe(true);
    });
  });

  it('finds the Windows mount display settings by their original CLI option', () => {
    backendServiceMock.isWindows.mockReturnValue(true);
    const { fixture } = setupComponent('mount', 'example', false, 'X:');
    fixture.componentRef.setInput('searchQuery', 'volname');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.windows-appearance input')).not.toBeNull();
  });

  it('keeps the saved drive letter when availability cannot be checked', async () => {
    backendServiceMock.isWindows.mockReturnValue(true);
    getDriveOptions.mockRejectedValue(new Error('Unavailable'));
    const { form, fixture } = setupComponent('mount', 'example', false, 'Y:');
    const picker = await TestbedHarnessEnvironment.loader(fixture).getHarness(
      MatSelectHarness.with({ selector: '.mount-drive-letter' })
    );
    expect(await picker.getValueText()).toBe('Y:');
    await picker.open();
    const options = await picker.getOptions();
    expect(await Promise.all(options.map(option => option.isDisabled()))).toEqual([
      false,
      true,
      true,
    ]);
    expect(form.get('dest.path')?.value).toBe('Y:');
    expect(form.dirty).toBe(false);
    await options[0].click();
    expect(form.get('dest.path')?.value).toBe('*');
    expect(await picker.getValueText()).toContain('mountAutomaticDrive');
  });

  it('selects an existing Windows parent without requiring it to be empty', async () => {
    backendServiceMock.isWindows.mockReturnValue(true);
    fileSystemServiceMock.selectFolder.mockResolvedValueOnce('D:\\Mounts');
    const { form } = setupComponent('mount', 'example', false, 'X:');
    await selectDestination();
    expect(fileSystemServiceMock.selectFolder).toHaveBeenCalledWith(false, undefined);
    expect(form.get('dest.path')?.value).toBe('D:\\Mounts\\example');
  });

  it('keeps a cancelled Windows folder selection and preserves an existing mount folder name', async () => {
    backendServiceMock.isWindows.mockReturnValue(true);
    const { form } = setupComponent('mount', 'example', false, 'D:\\Cloud');
    await selectDestination();
    expect(form.get('dest.path')?.value).toBe('D:\\Cloud');
    expect(form.dirty).toBe(false);
    fileSystemServiceMock.selectFolder.mockResolvedValueOnce('E:\\');
    await selectDestination();
    expect(fileSystemServiceMock.selectFolder).toHaveBeenLastCalledWith(false, 'D:\\');
    expect(form.get('dest.path')?.value).toBe('E:\\Cloud');
  });

  it('allows an existing drive root as a regular file operation destination', async () => {
    backendServiceMock.isWindows.mockReturnValue(true);
    fileSystemServiceMock.selectFolder.mockResolvedValueOnce('D:\\');
    const { form } = setupComponent('copy', 'example', false);
    await selectDestination();
    expect(fileSystemServiceMock.selectFolder).toHaveBeenCalledWith(false, '');
    expect(form.get('dest.path')?.value).toBe('D:\\');
    expect(getDriveOptions).not.toHaveBeenCalled();
  });

  it('allows an existing drive root as a regular file operation source', async () => {
    backendServiceMock.isWindows.mockReturnValue(true);
    fileSystemServiceMock.selectFolder.mockResolvedValueOnce('D:\\');
    const { form } = setupComponent('sync', 'example', false);
    form.get('source.0.type')?.setValue('local');
    fixture.detectChanges();
    const [source] = component.sourceItems();
    await component.selectPath(source);
    expect(fileSystemServiceMock.selectFolder).toHaveBeenCalledWith(false, '');
    expect(form.get('source.0.path')?.value).toBe('D:\\');
    expect(getDriveOptions).not.toHaveBeenCalled();
  });

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

  describe('Windows path inspection messages', () => {
    const notDirectory = 'Cesta vedie na súbor. Vyber priečinok.';
    const notDirectoryWindowsMount =
      'Cesta vedie na súbor. Vyber voľnú jednotku alebo zadaj cestu k novému priečinku.';
    const unavailable = 'Cestu sa nepodarilo overiť. Skontroluj jej zápis a prístup k umiestneniu.';
    const folderHint =
      'Ak chceš zmeniť názov priečinka, prepíš poslednú časť cesty. Priečinok vznikne pri pripojení.';
    let getStat: ReturnType<typeof vi.fn>;
    let getRemoteSettings: ReturnType<typeof vi.fn>;
    let getMountedRemotes: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      backendServiceMock.isWindows.mockReturnValue(true);
      getStat = vi.fn();
      getRemoteSettings = vi.fn().mockResolvedValue({});
      getMountedRemotes = vi.fn().mockResolvedValue([]);
      TestBed.overrideProvider(ApiClientService, { useValue: {} });
      TestBed.overrideProvider(BackendTranslationService, { useValue: {} });
      TestBed.overrideProvider(AppSettingsService, { useValue: { getRemoteSettings } });
      TestBed.overrideProvider(RemoteFileOperationsService, { useValue: { getStat } });
      TestBed.overrideProvider(MountManagementService, { useValue: { getMountedRemotes } });
      TestBed.overrideProvider(PathService, { useFactory: (): PathService => new PathService() });
      TestBed.overrideProvider(PathInspectionService, {
        useFactory: (): PathInspectionService => new PathInspectionService(),
      });
      const translate = TestBed.inject(TranslateService);
      translate.setTranslation('sk-SK', {
        remoteConfig: { pathStatus: { notDirectory, notDirectoryWindowsMount, unavailable } },
        wizards: { appOperation: { mountFolderNameHint: folderHint } },
      });
      translate.use('sk-SK');
    });

    it.each(['mount', 'bisync'] as const)('shows specific path warnings in %s', async operation => {
      getStat.mockResolvedValueOnce({ item: { IsDir: false } });
      const { form, fixture } = setupComponent(operation, 'example', false, 'D:\\file.txt');
      const selector =
        operation === 'mount'
          ? '.mount-target-hint [data-tone="warn"]'
          : '.path-row-wrapper .app-pill[data-tone="warn"], .path-row-wrapper .app-pill[data-tone="orange"]';
      const expectMessage = async (text: string): Promise<void> => {
        await vi.waitFor(() => {
          fixture.detectChanges();
          expect(fixture.nativeElement.querySelector(selector)?.textContent?.trim()).toBe(text);
        });
      };

      await expectMessage(operation === 'mount' ? notDirectoryWindowsMount : notDirectory);
      expect(form.get('dest.path')?.valid).toBe(true);

      getStat.mockRejectedValueOnce(new Error('Access denied'));
      form.get('dest.path')?.setValue('D:\\unreadable');
      fixture.detectChanges();
      await expectMessage(unavailable);
      expect(getStat).toHaveBeenLastCalledWith('D:/', 'unreadable');
    });

    it('shows the folder hint in place of the generic creation status', async () => {
      getStat.mockResolvedValue({ item: null });
      const { fixture } = setupComponent('mount', 'example', false, 'D:\\test\\backup');
      await vi.waitFor(() => expect(getStat).toHaveBeenCalledWith('D:/', 'test/backup'));
      fixture.detectChanges();

      const hint = fixture.nativeElement.querySelector('.mount-target-hint') as HTMLElement;
      expect(hint.textContent.trim()).toBe(folderHint);
      expect(fixture.nativeElement.querySelector('.windows-appearance')).toBeNull();
    });

    it('reopens an active Windows folder profile without warning that its junction is a file', async () => {
      TestBed.inject(PathService).setRemoteNames(['example']);
      getMountedRemotes.mockResolvedValue([
        {
          fs: 'example:share',
          mount_point: 'D:/test/Example',
          starter: { kind: 'profile', name: 'Default' },
        },
      ]);
      getStat.mockResolvedValue({ item: { IsDir: false } });
      const { fixture } = setupComponent('mount', 'example', false, 'D:\\test\\example');
      fixture.componentRef.setInput('currentProfileName', 'Default');
      fixture.detectChanges();

      await vi.waitFor(() => expect(getMountedRemotes).toHaveBeenCalled());
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.mount-target-hint').textContent.trim()).toBe(
        folderHint
      );
      expect(getStat).not.toHaveBeenCalled();
    });

    it('shows the path warning if checking saved profiles fails', async () => {
      getRemoteSettings.mockRejectedValueOnce(new Error('Settings unavailable'));
      const { fixture } = setupComponent('bisync', 'example', false, 'D:\\folder');

      await vi.waitFor(() => {
        fixture.detectChanges();
        expect(fixture.nativeElement.textContent).toContain(unavailable);
      });
      expect(getStat).not.toHaveBeenCalled();
    });

    it.each(['X:', 'X:\\', 'X:/'])(
      'shows the drive selector without a path warning for saved target %s',
      async path => {
        getDriveOptions.mockResolvedValue([{ letter: 'X:', status: 'free' }]);
        const inspection = vi.spyOn(TestBed.inject(PathInspectionService), 'inspect');
        const { fixture, form } = setupComponent('mount', 'example', false, path);
        const picker = await TestbedHarnessEnvironment.loader(fixture).getHarness(
          MatSelectHarness.with({ selector: '.mount-drive-letter' })
        );
        expect(await picker.getValueText()).toBe('X:');

        await vi.waitFor(() => {
          fixture.detectChanges();
          expect(inspection).toHaveBeenCalledWith(path, 'example', undefined, 'mount');
          expect(fixture.nativeElement.querySelector('.mount-target-hint').textContent.trim()).toBe(
            'wizards.appOperation.mountLocalDriveHint'
          );
        });
        expect(form.get('dest.path')?.value).toBe(path);
        expect(getStat).not.toHaveBeenCalled();
      }
    );
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
