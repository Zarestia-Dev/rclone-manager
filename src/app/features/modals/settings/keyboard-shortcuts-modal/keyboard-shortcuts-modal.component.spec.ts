import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { provideTranslateService } from '@ngx-translate/core';
import { KeyboardShortcutsModalComponent } from './keyboard-shortcuts-modal.component';

describe('KeyboardShortcutsModalComponent', () => {
  let fixture: ComponentFixture<KeyboardShortcutsModalComponent>;
  let component: KeyboardShortcutsModalComponent;
  let dialogRefSpy: { close: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    dialogRefSpy = { close: vi.fn() };

    await TestBed.configureTestingModule({
      imports: [KeyboardShortcutsModalComponent],
      providers: [
        provideTranslateService(),
        { provide: MatDialogRef, useValue: dialogRefSpy },
        { provide: MAT_DIALOG_DATA, useValue: null },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(KeyboardShortcutsModalComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should initialize with default shortcuts', () => {
    expect(component).toBeTruthy();
    expect(component.title).toBe('shortcuts.title');
    expect(component.shortcuts.length).toBeGreaterThan(0);
    expect(component.shortcuts.some(s => s.keys === 'Ctrl + Q')).toBe(true);
  });

  it('should correctly parse single and multi-combos', () => {
    const ctrlQ = component.shortcuts.find(s => s.keys === 'Ctrl + Q');
    expect(ctrlQ?.combos).toEqual([['Ctrl', 'Q']]);
  });

  it('should filter shortcuts based on search text', () => {
    component.onSearchTextChange('Quit');
    const filtered = component.filteredShortcuts();
    expect(filtered.some(s => s.keys === 'Ctrl + Q')).toBe(true);

    component.onSearchTextChange('non-existent-shortcut-12345');
    expect(component.filteredShortcuts().length).toBe(0);

    component.clearSearch();
    expect(component.searchText()).toBe('');
    expect(component.filteredShortcuts().length).toBe(component.shortcuts.length);
  });

  it('should toggle search visibility', () => {
    expect(component.searchVisible()).toBe(false);
    component.toggleSearch();
    expect(component.searchVisible()).toBe(true);
    component.toggleSearch();
    expect(component.searchVisible()).toBe(false);
  });

  it('should close dialog when close() is called', () => {
    component.close();
    expect(dialogRefSpy.close).toHaveBeenCalledTimes(1);
  });

  it('should highlight shortcut row and stop propagation on keydown when match is found', () => {
    const event = new KeyboardEvent('keydown', {
      key: 'q',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    const preventDefaultSpy = vi.spyOn(event, 'preventDefault');
    const stopPropagationSpy = vi.spyOn(event, 'stopPropagation');
    const stopImmediatePropagationSpy = vi.spyOn(event, 'stopImmediatePropagation');

    component.handleKeyDown(event);

    expect(component.pressedShortcutKeys()).toBe('Ctrl + Q');
    expect(preventDefaultSpy).toHaveBeenCalled();
    expect(stopPropagationSpy).toHaveBeenCalled();
    expect(stopImmediatePropagationSpy).toHaveBeenCalled();
  });

  it('should not preventDefault on Escape so escape-close directive can close the dialog', () => {
    const event = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    const preventDefaultSpy = vi.spyOn(event, 'preventDefault');

    component.handleKeyDown(event);

    expect(preventDefaultSpy).not.toHaveBeenCalled();
    expect(component.pressedShortcutKeys()).toBe('Escape');
  });

  it('should ignore keydown when typing in input elements', () => {
    const inputEl = document.createElement('input');
    const event = new KeyboardEvent('keydown', {
      key: 'q',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(event, 'target', { value: inputEl });

    component.handleKeyDown(event);

    expect(component.pressedShortcutKeys()).toBeNull();
  });

  it('should load nautilus shortcuts when data.nautilus is true or context is nautilus', async () => {
    TestBed.resetTestingModule();

    await TestBed.configureTestingModule({
      imports: [KeyboardShortcutsModalComponent],
      providers: [
        provideTranslateService(),
        { provide: MatDialogRef, useValue: dialogRefSpy },
        { provide: MAT_DIALOG_DATA, useValue: { context: 'nautilus' } },
      ],
    }).compileComponents();

    const nautilusComp = TestBed.createComponent(KeyboardShortcutsModalComponent).componentInstance;
    expect(nautilusComp.title).toBe('nautilus.shortcuts.title');
    expect(nautilusComp.shortcuts.some(s => s.keys === 'F5 / Ctrl + R')).toBe(true);

    const f5Shortcut = nautilusComp.shortcuts.find(s => s.keys === 'F5 / Ctrl + R');
    expect(f5Shortcut?.combos).toEqual([['F5'], ['Ctrl', 'R']]);
  });

  it('should load flow shortcuts when context is flow', async () => {
    TestBed.resetTestingModule();

    await TestBed.configureTestingModule({
      imports: [KeyboardShortcutsModalComponent],
      providers: [
        provideTranslateService(),
        { provide: MatDialogRef, useValue: dialogRefSpy },
        { provide: MAT_DIALOG_DATA, useValue: { context: 'flow' } },
      ],
    }).compileComponents();

    const flowComp = TestBed.createComponent(KeyboardShortcutsModalComponent).componentInstance;
    expect(flowComp.title).toBe('flow.shortcuts.title');
    expect(flowComp.shortcuts.some(s => s.keys === 'Ctrl + S')).toBe(true);
    expect(flowComp.shortcuts.some(s => s.keys === 'Delete / Backspace')).toBe(true);
  });
});
