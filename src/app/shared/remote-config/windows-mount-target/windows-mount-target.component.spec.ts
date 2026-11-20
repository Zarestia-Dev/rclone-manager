import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { signal } from '@angular/core';
import { FormControl } from '@angular/forms';
import { provideTranslateService } from '@ngx-translate/core';
import { MatIconTestingModule } from '@angular/material/icon/testing';
import { MatSelectHarness } from '@angular/material/select/testing';
import { TestbedHarnessEnvironment } from '@angular/cdk/testing/testbed';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WindowsMountTargetComponent } from './windows-mount-target.component';
import { PathInspectionService } from 'src/app/services/infrastructure/platform/path-inspection.service';
import { WindowsMountTargetService } from 'src/app/services/operations/windows-mount-target.service';
import { PathSelectionService } from 'src/app/services/remote/path-selection.service';

describe('WindowsMountTargetComponent', () => {
  const getDriveOptions = vi.fn();
  const inspect = vi.fn();

  beforeEach(async () => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe = vi.fn();
        disconnect = vi.fn();
      }
    );
    getDriveOptions.mockReset().mockResolvedValue([
      { letter: 'Z:', status: 'occupied', availableForAutomatic: false },
      { letter: 'Y:', status: 'reserved', availableForAutomatic: false },
      { letter: 'W:', status: 'free', availableForAutomatic: true },
    ]);
    inspect.mockReset().mockResolvedValue(null);
    await TestBed.configureTestingModule({
      imports: [WindowsMountTargetComponent, MatIconTestingModule],
      providers: [
        provideTranslateService(),
        { provide: WindowsMountTargetService, useValue: { getDriveOptions } },
        { provide: PathInspectionService, useValue: { inspect } },
        {
          provide: PathSelectionService,
          useValue: {
            registerField: vi
              .fn()
              .mockImplementation((id: string) =>
                signal({ id, remoteName: '', currentPath: '', options: [], isLoading: false })
              ),
            unregisterField: vi.fn(),
            triggerLoad: vi.fn(),
            updateInput: vi.fn(),
            navigateUp: vi.fn(),
            selectEntry: vi.fn(),
          },
        },
      ],
    }).compileComponents();
  });

  afterEach(() => vi.unstubAllGlobals());

  const setup = (
    initialPath = ''
  ): { fixture: ComponentFixture<WindowsMountTargetComponent>; path: FormControl } => {
    const fixture = TestBed.createComponent(WindowsMountTargetComponent);
    const path = new FormControl(initialPath);
    fixture.componentRef.setInput('pathControl', path);
    fixture.componentRef.setInput('currentRemoteName', 'example');
    fixture.detectChanges();
    return { fixture, path };
  };

  const folderInput = (fixture: ComponentFixture<WindowsMountTargetComponent>): HTMLInputElement =>
    fixture.nativeElement.querySelector('input');

  const hint = (fixture: ComponentFixture<WindowsMountTargetComponent>): string =>
    fixture.nativeElement.querySelector('.mount-target-hint')?.textContent ?? '';

  const pastePath = (field: HTMLInputElement, text: string): boolean => {
    const event = Object.assign(new Event('paste', { bubbles: true, cancelable: true }), {
      clipboardData: { getData: (type: string): string => (type === 'text/plain' ? text : '') },
    });
    field.dispatchEvent(event);
    return event.defaultPrevented;
  };

  it('shows the drive picker for an empty, automatic or drive target and a folder field otherwise', () => {
    const cases: [string, boolean][] = [
      ['', true],
      ['*', true],
      ['X:', true],
      ['x:\\', true],
      ['D:\\Mounts\\cloud', false],
    ];
    for (const [value, isPicker] of cases) {
      const { fixture } = setup(value);
      const element: HTMLElement = fixture.nativeElement;
      expect(!!element.querySelector('.mount-drive-letter'), value).toBe(isPicker);
      expect(!!element.querySelector('.mount-parent-picker'), value).toBe(!isPicker);
    }
  });

  it('keeps a taken letter selectable and only flags it', async () => {
    const { fixture, path } = setup('*');
    const picker = await TestbedHarnessEnvironment.loader(fixture).getHarness(
      MatSelectHarness.with({ selector: '.mount-drive-letter' })
    );
    await picker.open();
    const reserved = (await picker.getOptions({ text: /^Y:/ }))[0];
    expect(await reserved.isDisabled()).toBe(false);
    await reserved.click();
    await fixture.whenStable();

    expect(path.value).toBe('Y:');
    expect(path.valid).toBe(true);
    expect(hint(fixture)).toContain('mountDriveReserved');
  });

  it('requires a path once a folder is chosen, and flags a path outside a drive without rejecting it', async () => {
    const { fixture, path } = setup('');
    const location = await TestbedHarnessEnvironment.loader(fixture).getHarness(
      MatSelectHarness.with({ selector: '.mount-location' })
    );
    await location.open();
    await (await location.getOptions())[1].click();
    expect(path.hasError('required')).toBe(true);

    const field = folderInput(fixture);
    field.value = 'Mounts\\cloud';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    await fixture.whenStable();

    expect(path.value).toBe('Mounts\\cloud');
    expect(path.valid).toBe(true);
    expect(hint(fixture)).toContain('mountFolderPathRequired');
  });

  it('removes the quotes Explorer adds to a pasted folder path and says so', async () => {
    const { fixture, path } = setup('D:\\old');
    const field = folderInput(fixture);
    field.select();

    expect(pastePath(field, '"D:\\Mounts\\cloud"')).toBe(true);
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(path.value).toBe('D:\\Mounts\\cloud');
      expect(hint(fixture)).toContain('mountFolderQuotesRemoved');
    });
  });

  it('offers to mount into a new folder inside an existing one and uses the disk name', async () => {
    const { fixture, path } = setup('D:\\Mounts');
    const status = {
      state: 'exists',
      icon: 'folder-open',
      badgeClass: 'non-empty',
      labelKey: 'wizards.appOperation.mountFolderAlreadyExists',
    };
    fixture.componentRef.setInput('inspection', status);
    fixture.componentRef.setInput('volumeNameControl', new FormControl('Backup'));
    fixture.detectChanges();

    const button = fixture.nativeElement.querySelector('.mount-use-parent') as HTMLButtonElement;
    expect(button).not.toBeNull();
    button.click();
    fixture.detectChanges();

    expect(path.value).toBe('D:\\Mounts\\Backup');
    expect(path.dirty).toBe(true);
  });

  it('leaves text that is not a drive path to the browser', () => {
    const { fixture, path } = setup('D:\\old');
    const field = folderInput(fixture);
    field.select();

    expect(pastePath(field, 'relative\\folder')).toBe(false);
    expect(pastePath(field, '"D:\\open')).toBe(false);
    expect(path.value).toBe('D:\\old');
    expect(inspect).not.toHaveBeenCalled();
  });
});
