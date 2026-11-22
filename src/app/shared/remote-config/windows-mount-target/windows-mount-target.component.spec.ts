import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { signal } from '@angular/core';
import { FormControl } from '@angular/forms';
import { provideTranslateService } from '@ngx-translate/core';
import { MatIconTestingModule } from '@angular/material/icon/testing';
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
      expect(!!element.querySelector('.drive-letters'), value).toBe(isPicker);
      expect(!!element.querySelector('.mount-parent-picker'), value).toBe(!isPicker);
    }
  });

  it('keeps a taken letter selectable and only flags it', async () => {
    const { fixture, path } = setup('*');
    await fixture.whenStable();
    fixture.detectChanges();
    const chip = (letter: string): HTMLButtonElement | undefined =>
      Array.from<HTMLButtonElement>(
        fixture.nativeElement.querySelectorAll('.mount-drive-letter')
      ).find(button => button.textContent?.trim() === letter);
    const occupied = chip('Z:');
    expect(occupied?.disabled).toBe(false);
    expect(occupied?.title).toContain('mountDriveOccupied');
    const reserved = chip('Y:');
    expect(reserved?.disabled).toBe(false);
    reserved?.click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(path.value).toBe('Y:');
    expect(path.valid).toBe(true);
    expect(chip('Y:')?.getAttribute('aria-pressed')).toBe('true');
    expect(hint(fixture)).toContain('mountDriveReserved');
  });

  it('says that a chosen letter is in use and that only the selected choice is coloured', async () => {
    const { fixture, path } = setup('*');
    await fixture.whenStable();
    fixture.detectChanges();
    const element: HTMLElement = fixture.nativeElement;
    const chip = (letter: string): HTMLButtonElement | undefined =>
      Array.from<HTMLButtonElement>(element.querySelectorAll('.mount-drive-letter')).find(
        button => button.textContent?.trim() === letter
      );
    const automatic = (): Element | null => element.querySelector('.mount-drive-automatic');
    expect(automatic()?.getAttribute('data-tone')).toBe('purple');
    expect(chip('W:')?.getAttribute('data-tone')).toBeNull();

    chip('Z:')?.click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(path.value).toBe('Z:');
    expect(hint(fixture)).toContain('mountDriveOccupiedHint');
    expect(automatic()?.getAttribute('data-tone')).toBeNull();
    expect(chip('Z:')?.getAttribute('data-tone')).toBe('purple');
  });

  it('hides the system and floppy letters unless one of them is saved', async () => {
    getDriveOptions.mockResolvedValue(
      ['E:', 'D:', 'C:', 'B:', 'A:'].map(letter => ({
        letter,
        status: 'free',
        availableForAutomatic: false,
      }))
    );
    const letters = (fixture: ComponentFixture<WindowsMountTargetComponent>): string[] =>
      Array.from<HTMLElement>(fixture.nativeElement.querySelectorAll('.mount-drive-letter')).map(
        chip => chip.textContent?.trim() ?? ''
      );

    const { fixture } = setup('*');
    await fixture.whenStable();
    fixture.detectChanges();
    expect(letters(fixture)).toEqual(['E:', 'D:']);

    const saved = setup('B:');
    await saved.fixture.whenStable();
    saved.fixture.detectChanges();
    expect(letters(saved.fixture)).toEqual(['E:', 'D:', 'B:']);
  });

  it('points to Folder when no drive letter is free', async () => {
    getDriveOptions.mockResolvedValue(
      ['Z:', 'Y:', 'C:'].map(letter => ({
        letter,
        status: 'occupied',
        availableForAutomatic: false,
      }))
    );
    const { fixture } = setup('*');
    await fixture.whenStable();
    fixture.detectChanges();
    expect(hint(fixture)).toContain('mountNoFreeLetter');

    getDriveOptions.mockResolvedValue([
      { letter: 'Z:', status: 'occupied', availableForAutomatic: false },
      { letter: 'Y:', status: 'free', availableForAutomatic: true },
    ]);
    const free = setup('*');
    await free.fixture.whenStable();
    free.fixture.detectChanges();
    expect(hint(free.fixture)).not.toContain('mountNoFreeLetter');
  });

  it('keeps the Windows appearance closed until it holds a disk name', () => {
    const details = (fixture: ComponentFixture<WindowsMountTargetComponent>): HTMLDetailsElement =>
      fixture.nativeElement.querySelector('details.windows-appearance');
    const withControls = (
      network: boolean,
      name: string
    ): ComponentFixture<WindowsMountTargetComponent> => {
      const fixture = TestBed.createComponent(WindowsMountTargetComponent);
      fixture.componentRef.setInput('pathControl', new FormControl('*'));
      fixture.componentRef.setInput('currentRemoteName', 'example');
      fixture.componentRef.setInput('networkModeControl', new FormControl(network));
      fixture.componentRef.setInput('volumeNameControl', new FormControl(name));
      fixture.detectChanges();
      return fixture;
    };

    expect(details(withControls(false, '')).open).toBe(false);
    expect(details(withControls(true, '')).open).toBe(false);
    expect(details(withControls(false, 'Backup')).open).toBe(true);
  });

  it('shows no passing "checking" line after a letter is picked, so nothing below it moves', async () => {
    inspect.mockImplementation(() => new Promise(() => undefined));
    const { fixture } = setup('*');
    await fixture.whenStable();
    fixture.detectChanges();
    const free = Array.from<HTMLButtonElement>(
      fixture.nativeElement.querySelectorAll('.mount-drive-letter')
    ).find(chip => chip.textContent?.trim() === 'W:');
    free?.click();
    // Past the pause before a path is checked; the check itself never finishes here.
    await new Promise(resolve => setTimeout(resolve, 400));
    fixture.detectChanges();

    expect(inspect).toHaveBeenCalled();
    expect(hint(fixture)).not.toContain('pathStatus.checking');
  });

  it('shows every letter at once and keeps the known ones while the same owner reloads', async () => {
    let answer: (options: unknown[]) => void = () => undefined;
    getDriveOptions.mockImplementation(
      () => new Promise(resolve => (answer = resolve as typeof answer))
    );
    const { fixture } = setup('*');
    fixture.detectChanges();
    const element: HTMLElement = fixture.nativeElement;
    const letters = (): string[] =>
      Array.from(element.querySelectorAll('.mount-drive-letter')).map(
        chip => chip.textContent?.trim() ?? ''
      );
    const locks = (): number => element.querySelectorAll('.mount-drive-letter mat-icon').length;

    // Nothing answered yet: D: to Z: are there, without a status.
    expect(letters()).toHaveLength(23);
    expect(letters()[0]).toBe('Z:');
    expect(letters()[22]).toBe('D:');
    expect(locks()).toBe(0);

    answer([
      { letter: 'Z:', status: 'occupied', availableForAutomatic: false },
      { letter: 'Y:', status: 'free', availableForAutomatic: true },
    ]);
    await fixture.whenStable();
    fixture.detectChanges();
    expect(letters()).toEqual(['Z:', 'Y:']);
    expect(locks()).toBe(1);

    // The same owner asks again: the old answer stays until the new one replaces it.
    fixture.componentRef.setInput('mountProfiles', { Default: {} });
    fixture.detectChanges();
    expect(letters()).toEqual(['Z:', 'Y:']);
    expect(locks()).toBe(1);

    // Another remote must not show the first one's letters.
    fixture.componentRef.setInput('currentRemoteName', 'other');
    fixture.detectChanges();
    expect(letters()).toHaveLength(23);
    expect(locks()).toBe(0);
  });

  it('requires a path once a folder is chosen, and flags a path outside a drive without rejecting it', async () => {
    const { fixture, path } = setup('');
    (fixture.nativeElement.querySelector('.mount-location-folder') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(path.hasError('required')).toBe(true);

    const field = folderInput(fixture);
    field.value = 'Mounts\\cloud';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    await fixture.whenStable();

    expect(path.value).toBe('Mounts\\cloud');
    expect(path.valid).toBe(true);
    expect(hint(fixture)).toContain('mountFolderPathRequired');
  });

  it('starts on Automatic and loads the letters when it is switched from a folder to a drive', async () => {
    const { fixture, path } = setup('D:\\Mounts\\cloud');
    await fixture.whenStable();
    expect(getDriveOptions).not.toHaveBeenCalled();

    (fixture.nativeElement.querySelector('.mount-location-letter') as HTMLButtonElement).click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(path.value).toBe('*');
    expect(path.valid).toBe(true);
    expect(getDriveOptions).toHaveBeenCalledTimes(1);
    expect(hint(fixture)).not.toContain('mountDriveChecking');
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
    inspect.mockResolvedValue(status);
    fixture.componentRef.setInput('volumeNameControl', new FormControl('Backup'));
    fixture.detectChanges();

    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.mount-use-parent')).not.toBeNull();
    });
    const button = fixture.nativeElement.querySelector('.mount-use-parent') as HTMLButtonElement;
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
