import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { FormControl, FormGroup } from '@angular/forms';
import { provideTranslateService } from '@ngx-translate/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PathGroup, PathInspectionStatus } from '@app/types';
import { PathFieldComponent } from './path-field.component';
import { FileSystemService } from 'src/app/services/operations/file-system.service';
import { NotificationService } from 'src/app/services/ui/notification.service';
import { PathService } from 'src/app/services/infrastructure/platform/path.service';
import { PathInspectionService } from 'src/app/services/infrastructure/platform/path-inspection.service';
import { PathSelectionService } from 'src/app/services/remote/path-selection.service';

const group = (type = '', path = '', remote = ''): FormGroup =>
  new FormGroup({
    type: new FormControl(type),
    path: new FormControl(path),
    remote: new FormControl(remote),
  });

const CLEAN: PathInspectionStatus = {
  state: 'clean',
  icon: 'check-circle',
  badgeClass: 'clean',
  labelKey: 'remoteConfig.pathStatus.clean',
};

describe('PathFieldComponent', () => {
  let fixture: ComponentFixture<PathFieldComponent>;
  let component: PathFieldComponent;

  const state = signal({
    id: 'f1',
    remoteName: '',
    currentPath: '',
    options: [],
    isLoading: false,
  });
  const registerField = vi.fn();
  const unregisterField = vi.fn();
  const updateInput = vi.fn();
  const triggerLoad = vi.fn();
  const selectEntry = vi.fn();
  const navigateUp = vi.fn();
  const resetPath = vi.fn();
  const inspect = vi.fn();
  const selectFolder = vi.fn();
  const selectFile = vi.fn();
  const selectPathWithNautilus = vi.fn();
  const resolvePathGroup = vi.fn();
  const showError = vi.fn();

  const create = (control: FormGroup, inputs: Record<string, unknown> = {}): void => {
    fixture = TestBed.createComponent(PathFieldComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('control', control);
    fixture.componentRef.setInput('fieldId', 'f1');
    fixture.componentRef.setInput('currentRemote', 'drive');
    for (const [name, value] of Object.entries(inputs)) fixture.componentRef.setInput(name, value);
    fixture.detectChanges();
  };

  beforeEach(() => {
    vi.useFakeTimers();
    for (const fn of [
      registerField,
      unregisterField,
      updateInput,
      triggerLoad,
      selectEntry,
      navigateUp,
      resetPath,
      inspect,
      selectFolder,
      selectFile,
      selectPathWithNautilus,
      resolvePathGroup,
      showError,
    ]) {
      fn.mockReset();
    }
    registerField.mockReturnValue(state);
    inspect.mockResolvedValue(CLEAN);

    TestBed.configureTestingModule({
      imports: [PathFieldComponent],
      providers: [
        provideTranslateService(),
        {
          provide: PathSelectionService,
          useValue: {
            registerField,
            unregisterField,
            updateInput,
            triggerLoad,
            selectEntry,
            navigateUp,
            resetPath,
          },
        },
        { provide: PathInspectionService, useValue: { inspect } },
        {
          provide: FileSystemService,
          useValue: { selectFolder, selectFile, selectPathWithNautilus },
        },
        { provide: PathService, useValue: { resolvePathGroup } },
        { provide: NotificationService, useValue: { showError } },
      ],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    TestBed.resetTestingModule();
  });

  describe('type', () => {
    it('falls back to the default type when the form has none', () => {
      create(group(), { defaultType: 'local' });
      expect(component.type()).toBe('local');
      create(group());
      expect(component.type()).toBe('currentRemote');
      expect(component.remoteName()).toBe('drive');
    });

    it('reads another remote from the type', () => {
      create(group('otherRemote:box', 'Docs', 'box'));
      expect(component.type()).toBe('otherRemote');
      expect(component.remoteName()).toBe('box');
      expect(component.path()).toBe('Docs');
      expect(component.typeTone()).toBe('accent');
    });

    it('follows the form when it changes', () => {
      const control = group('local', '/a');
      create(control);
      control.get('path')?.setValue('/b');
      expect(component.path()).toBe('/b');
      control.get('type')?.setValue('currentRemote');
      expect(component.type()).toBe('currentRemote');
    });

    it('shows a fixed pill and no menu for a locked type', () => {
      create(group('local'), { lock: 'local' });
      const el: HTMLElement = fixture.nativeElement;
      expect(el.querySelector('.path-type-selector button')).toBeNull();
      expect(
        el.querySelector('.path-type-selector [appPill], .path-type-selector .app-pill')
      ).not.toBeNull();
    });

    it('switches the type, clears the path and the remote and tells the form', () => {
      const control = group('currentRemote', 'Docs', '');
      create(control);
      const dirty = vi.fn();
      component.dirty.subscribe(dirty);

      component.setType('otherRemote:box');

      expect(control.get('type')?.value).toBe('otherRemote:box');
      expect(control.get('path')?.value).toBe('');
      expect(control.get('remote')?.value).toBe('box');
      expect(resetPath).toHaveBeenCalledWith('f1');
      expect(dirty).toHaveBeenCalledOnce();

      component.setType('local');
      expect(control.get('remote')?.value).toBe('');
    });

    it('tells the group once, with the final values, when the type is switched', () => {
      const control = group('currentRemote', 'Docs');
      create(control);
      const seen: unknown[] = [];
      control.valueChanges.subscribe(value => seen.push(value));
      component.setType('otherRemote:box');
      expect(seen.at(-1)).toEqual({ type: 'otherRemote:box', path: '', remote: 'box' });
    });

    it('does nothing when the type is already chosen', () => {
      const control = group('local', '/a');
      create(control);
      const dirty = vi.fn();
      component.dirty.subscribe(dirty);
      component.setType('local');
      expect(dirty).not.toHaveBeenCalled();
      expect(control.get('path')?.value).toBe('/a');
    });
  });

  describe('suggestions', () => {
    it('registers the field for its remote and unregisters it when destroyed', () => {
      create(group());
      expect(registerField).toHaveBeenCalledWith('f1', 'drive', '');
      expect(component.suggestions()).toBe(state);
      fixture.destroy();
      expect(unregisterField).toHaveBeenCalledWith('f1');
    });

    it('registers again when the remote changes', () => {
      const control = group('currentRemote');
      create(control);
      registerField.mockClear();
      component.setType('otherRemote:box');
      fixture.detectChanges();
      expect(unregisterField).toHaveBeenCalledWith('f1');
      expect(registerField).toHaveBeenCalledWith('f1', 'box', '');
    });

    it('lists no suggestions while the remote does not exist yet', () => {
      create(group(), { suggest: false });
      expect(registerField).not.toHaveBeenCalled();
      expect(component.suggestions()).toBeNull();
    });

    it('passes typing, opening, choosing and going up to the service', () => {
      const control = group('currentRemote', 'Docs');
      create(control);
      const dirty = vi.fn();
      component.dirty.subscribe(dirty);

      component.onInput({ target: { value: 'Do' } } as unknown as Event);
      expect(updateInput).toHaveBeenCalledWith('f1', 'Do');

      component.onMenuOpened();
      expect(triggerLoad).toHaveBeenCalledWith('f1', 'drive', 'Docs');

      component.onEntryPicked('Photos');
      expect(selectEntry).toHaveBeenCalledWith('f1', 'Photos', control.get('path'));

      component.goUp();
      expect(navigateUp).toHaveBeenCalledWith('f1', control.get('path'));
      expect(dirty).toHaveBeenCalledTimes(2);
    });
  });

  describe('picker', () => {
    it('picks a local folder with the system dialog and makes the path local', async () => {
      const control = group('currentRemote', '/old');
      create(control, { requireEmpty: true });
      selectFolder.mockResolvedValue('/home/me/new');
      const dirty = vi.fn();
      component.dirty.subscribe(dirty);

      control.get('type')?.setValue('local');
      await component.pick();

      expect(selectFolder).toHaveBeenCalledWith(true, '/old');
      expect(control.get('path')?.value).toBe('/home/me/new');
      expect(control.get('type')?.value).toBe('local');
      expect(control.get('remote')?.value).toBe('');
      expect(dirty).toHaveBeenCalled();
    });

    it('picks a file when files are wanted', async () => {
      create(group('local', '/a'), { pickerSelection: 'files' });
      selectFile.mockResolvedValue('/a/b.txt');
      await component.pick();
      expect(selectFile).toHaveBeenCalledWith('/a');
      expect(selectFolder).not.toHaveBeenCalled();
    });

    it('keeps the path when the picker is cancelled or fails', async () => {
      const control = group('local', '/a');
      create(control);
      selectFolder.mockResolvedValueOnce('');
      await component.pick();
      selectFolder.mockRejectedValueOnce(new Error('cancelled'));
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      await component.pick();
      error.mockRestore();
      expect(control.get('path')?.value).toBe('/a');
    });

    it('does nothing while the picker is disabled', async () => {
      create(group('local', '/a'), { pickerDisabled: true });
      await component.pick();
      expect(selectFolder).not.toHaveBeenCalled();
    });

    it('opens the built-in browser for a remote, starting where the path is', async () => {
      const control = group('currentRemote', 'Docs');
      create(control, { multi: true });
      selectPathWithNautilus.mockResolvedValue({ cancelled: true, items: [], paths: [] });
      await component.pick();
      expect(selectPathWithNautilus).toHaveBeenCalledWith({
        mode: 'both',
        selection: 'folders',
        multi: true,
        allowedRemotes: undefined,
        initialLocation: 'drive:/Docs',
      });
    });

    it('limits the browser to the current remote when asked', async () => {
      create(group('currentRemote'), { restrictToCurrentRemote: true });
      selectPathWithNautilus.mockResolvedValue({ cancelled: true, items: [], paths: [] });
      await component.pick();
      expect(selectPathWithNautilus).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: 'remote',
          allowedRemotes: ['drive'],
          initialLocation: 'drive:',
        })
      );
    });

    it('fills the field with the first pick and hands the others on', async () => {
      const control = group('currentRemote');
      create(control, { multi: true });
      const picks: Record<string, PathGroup> = {
        a: { type: 'currentRemote', path: 'A', remote: '' },
        b: { type: 'otherRemote:box', path: 'B', remote: 'box' },
      };
      resolvePathGroup.mockImplementation((item: { name: string }) => picks[item.name]);
      selectPathWithNautilus.mockResolvedValue({
        cancelled: false,
        items: [{ name: 'a' }, { name: 'b' }],
        paths: [],
      });
      const more = vi.fn();
      component.morePicked.subscribe(more);

      await component.pick();

      expect(control.get('path')?.value).toBe('A');
      expect(more).toHaveBeenCalledWith([picks['b']]);
    });

    it('refuses a path on another remote when only local ones are allowed', async () => {
      const control = group('currentRemote', 'x');
      create(control, { localOnly: true });
      resolvePathGroup.mockReturnValue({ type: 'otherRemote:box', path: 'B', remote: 'box' });
      selectPathWithNautilus.mockResolvedValue({
        cancelled: false,
        items: [{ name: 'a' }],
        paths: [],
      });
      await component.pick();
      expect(showError).toHaveBeenCalled();
      expect(control.get('path')?.value).toBe('x');
    });
  });

  describe('folder check', () => {
    const settle = async (): Promise<void> => {
      await vi.advanceTimersByTimeAsync(400);
    };

    it('checks a local folder after a pause and shows the answer', async () => {
      create(group('local', '/home/me/drive'), { inspect: 'bisync', profileName: 'p' });
      await settle();
      expect(inspect).toHaveBeenCalledWith('/home/me/drive', 'drive', 'p', 'bisync', null);
      expect(component.status()).toEqual(CLEAN);
    });

    it('tells the check which Quick Run is being edited, so that its own folder is not taken', async () => {
      create(group('local', '/home/me/drive'), { inspect: 'mount', quickRunId: 'qr-1' });
      await settle();
      expect(inspect).toHaveBeenCalledWith('/home/me/drive', 'drive', undefined, 'mount', 'qr-1');
    });

    it('checks the folder once for the same path and again when it changes', async () => {
      const control = group('local', '/a');
      create(control, { inspect: 'mount' });
      await settle();
      fixture.detectChanges();
      await settle();
      expect(inspect).toHaveBeenCalledTimes(1);

      control.get('path')?.setValue('/b');
      fixture.detectChanges();
      await settle();
      expect(inspect).toHaveBeenCalledTimes(2);
    });

    it('does not check a remote path, an empty path or when there is no check', async () => {
      create(group('currentRemote', 'Docs'), { inspect: 'mount' });
      await settle();
      create(group('local', ''), { inspect: 'mount' });
      await settle();
      create(group('local', '/a'));
      await settle();
      expect(inspect).not.toHaveBeenCalled();
      expect(component.status()).toBeNull();
    });

    it('shows an error state when the check fails', async () => {
      inspect.mockRejectedValue(new Error('no rclone'));
      create(group('local', '/a'), { inspect: 'mount' });
      await settle();
      expect(component.status()?.state).toBe('unavailable');
    });

    it('clears the answer when the type is no longer local', async () => {
      const control = group('local', '/a');
      create(control, { inspect: 'mount' });
      await settle();
      expect(component.status()).not.toBeNull();
      component.setType('currentRemote');
      fixture.detectChanges();
      expect(component.status()).toBeNull();
    });

    it('colours each answer of the check', () => {
      create(group());
      expect(component.inspectionTone('clean')).toBe('primary');
      expect(component.inspectionTone('colliding')).toBe('warn');
      expect(component.inspectionTone('nonEmpty')).toBe('orange');
    });

    it('colours the answers for an existing folder and a file', () => {
      create(group());
      expect(component.inspectionTone('exists')).toBe('orange');
      expect(component.inspectionTone('notDirectory')).toBe('warn');
    });

    it('drops an answer for a path that was edited while the check ran', async () => {
      let answer: (status: unknown) => void = () => undefined;
      inspect.mockReturnValue(new Promise(resolve => (answer = resolve)));
      const control = group('local', '/a');
      create(control, { inspect: 'mount' });
      await settle();
      control.get('path')?.setValue('/b');
      answer({ state: 'nonEmpty', icon: 'warning', badgeClass: 'non-empty', labelKey: 'x' });
      await Promise.resolve();
      expect(component.status()?.state).not.toBe('nonEmpty');
    });
  });

  it('offers to remove the path when it can be removed', () => {
    create(group('local', '/a'), { removable: true });
    const removed = vi.fn();
    component.removed.subscribe(removed);
    const remove = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(
      'button.action-button'
    );
    remove?.click();
    expect(removed).toHaveBeenCalledOnce();
  });
});
