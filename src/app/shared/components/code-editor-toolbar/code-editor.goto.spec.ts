import { TestBed } from '@angular/core/testing';
import { provideTranslateService, TranslateService } from '@ngx-translate/core';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { openSearchPanel, searchPanelOpen } from '@codemirror/search';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { codeEditorExtensions } from './code-editor.extensions';
import { goToLineOpen, toggleGoToLine } from './code-editor.goto';

describe('Go-to-line panel', () => {
  let view: EditorView;
  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideTranslateService()] });
    view = new EditorView({
      state: EditorState.create({
        doc: 'one\ntwo\nthree',
        extensions: [codeEditorExtensions(TestBed.inject(TranslateService))],
      }),
    });
    toggleGoToLine(view);
  });
  afterEach(() => view.destroy());

  function field(): HTMLInputElement {
    const el = view.dom.querySelector<HTMLInputElement>('input[name="line"]');
    if (!el) throw new Error('Go-to-line input missing');
    return el;
  }

  function submit(line: string): void {
    const input = field();
    input.value = line;
    input.form?.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
  }

  it('moves to a valid line and closes the panel', () => {
    submit('3');
    expect(view.state.selection.main.head).toBe(8);
    expect(goToLineOpen(view.state)).toBe(false);
  });

  it('rejects empty, fractional, and out-of-range lines', () => {
    for (const value of ['', '0', '4', '-1', '1.5']) {
      submit(value);
      expect(goToLineOpen(view.state)).toBe(true);
      expect(view.state.selection.main.head).toBe(0);
      expect(field().getAttribute('aria-invalid')).toBe('true');
    }
  });

  it('updates its bounds when the document changes', () => {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'one' } });
    expect(field().max).toBe('1');
    submit('2');
    expect(goToLineOpen(view.state)).toBe(true);
  });

  it('opens and closes by selecting the same tool, with no X button', () => {
    expect(view.dom.querySelector('.cm-goto-line button')?.textContent).toContain('go');
    expect(view.dom.querySelector('.cm-dialog-close')).toBeNull();
    toggleGoToLine(view);
    expect(goToLineOpen(view.state)).toBe(false);
  });

  it('closes search when opened and handles Escape locally', () => {
    toggleGoToLine(view);
    openSearchPanel(view);
    toggleGoToLine(view);
    expect(searchPanelOpen(view.state)).toBe(false);
    field().dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    );
    expect(goToLineOpen(view.state)).toBe(false);
  });
});
