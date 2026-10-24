import { TestBed } from '@angular/core/testing';
import { provideTranslateService, TranslateService } from '@ngx-translate/core';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { history, undo } from '@codemirror/commands';
import {
  findNext,
  getSearchQuery,
  openSearchPanel,
  SearchQuery,
  searchPanelOpen,
  setSearchQuery,
} from '@codemirror/search';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { codeEditorExtensions } from './code-editor.extensions';
import { searchMatches } from './code-editor.search';

describe('Code editor search panel', () => {
  let view: EditorView;
  let translate: TranslateService;
  const readonly = new Compartment();

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideTranslateService()] });
    translate = TestBed.inject(TranslateService);
    const parent = document.createElement('div');
    document.body.append(parent);
    view = new EditorView({
      parent,
      state: EditorState.create({
        doc: 'cat Cat scatter\ncat',
        extensions: [
          history(),
          readonly.of(EditorState.readOnly.of(false)),
          codeEditorExtensions(translate),
        ],
      }),
    });
    openSearchPanel(view);
  });

  afterEach(() => {
    const parent = view.dom.parentElement;
    view.destroy();
    parent?.remove();
  });

  const query = (
    text: string,
    options: { regexp?: boolean; wholeWord?: boolean; caseSensitive?: boolean } = {}
  ): SearchQuery => new SearchQuery({ search: text, literal: true, ...options });

  function setQuery(value: SearchQuery): void {
    view.dispatch({ effects: setSearchQuery.of(value) });
  }

  function input(name: string): HTMLInputElement {
    const el = view.dom.querySelector<HTMLInputElement>(`input[name="${name}"]`);
    if (!el) throw new Error(`Missing input: ${name}`);
    return el;
  }

  function button(name: string): HTMLButtonElement {
    const el = view.dom.querySelector<HTMLButtonElement>(`button[name="${name}"]`);
    if (!el) throw new Error(`Missing button: ${name}`);
    return el;
  }

  it('counts full-document matches with case and whole-word options', () => {
    setQuery(query('cat'));
    expect(searchMatches(view.state).matches).toHaveLength(4);
    setQuery(query('cat', { wholeWord: true }));
    expect(searchMatches(view.state).matches).toHaveLength(3);
    setQuery(query('cat', { wholeWord: true, caseSensitive: true }));
    expect(searchMatches(view.state).matches).toHaveLength(2);
  });

  it('handles empty queries, missing results, and invalid regular expressions', () => {
    for (const value of [query(''), query('missing'), query('[', { regexp: true })]) {
      setQuery(value);
      expect(searchMatches(view.state)).toEqual({ matches: [], truncated: false });
      expect(button('next').disabled).toBe(true);
    }
    expect(input('find').getAttribute('aria-invalid')).toBe('true');
    expect(view.dom.querySelector('[role="status"]')?.textContent).toContain('invalidRegexp');
  });

  it('bounds the match counter while retaining searching beyond the limit', () => {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'x '.repeat(1002) } });
    setQuery(query('x'));
    const result = searchMatches(view.state);
    expect(result.matches).toHaveLength(1000);
    expect(result.truncated).toBe(true);
    view.dispatch({ selection: { anchor: 2000 } });
    findNext(view);
    expect(view.state.selection.main.from).toBe(2000);
  });

  it('updates the query on input, including mobile input and cleared searches', () => {
    const field = input('find');
    field.value = 'Cat';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    expect(getSearchQuery(view.state).search).toBe('Cat');
    expect(button('next').disabled).toBe(false);
    field.value = '';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    expect(button('next').disabled).toBe(true);
  });

  it('keeps Windows paths literal by default', () => {
    const path = String.raw`C:\new\test`;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: path } });
    input('find').value = path;
    input('find').dispatchEvent(new Event('input'));
    expect(searchMatches(view.state).matches).toEqual([{ from: 0, to: path.length }]);
  });

  it('updates externally changed queries and keeps replacement text when toggling options', () => {
    setQuery(new SearchQuery({ search: 'cat', replace: 'dog', literal: true }));
    expect(input('replace').value).toBe('dog');
    button('caseSensitive').click();
    expect(getSearchQuery(view.state).caseSensitive).toBe(true);
    expect(getSearchQuery(view.state).replace).toBe('dog');
    expect(button('caseSensitive').getAttribute('aria-pressed')).toBe('true');
    expect(button('caseSensitive').classList.contains('p-accent')).toBe(true);
  });

  it('supports next, previous, Enter and Shift+Enter without bubbling navigation keys', () => {
    setQuery(query('cat', { caseSensitive: true, wholeWord: true }));
    const bubbled = vi.fn();
    view.dom.parentElement?.addEventListener('keydown', bubbled);
    input('find').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    );
    expect(view.state.selection.main.from).toBe(0);
    button('next').click();
    expect(view.state.selection.main.from).toBe(16);
    input('find').dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      })
    );
    expect(view.state.selection.main.from).toBe(0);
    input('find').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(bubbled).not.toHaveBeenCalled();
  });

  it('replaces all matches as one undoable change', () => {
    setQuery(
      new SearchQuery({ search: 'cat', replace: 'dog', wholeWord: true, caseSensitive: true })
    );
    button('replaceAll').click();
    expect(view.state.doc.toString()).toBe('dog Cat scatter\ndog');
    undo(view);
    expect(view.state.doc.toString()).toBe('cat Cat scatter\ncat');
  });

  it('hides and disables replacement immediately when switching to read only', () => {
    setQuery(new SearchQuery({ search: 'cat', replace: 'dog' }));
    view.dispatch({ effects: readonly.reconfigure(EditorState.readOnly.of(true)) });
    expect(button('replace').closest('details')?.hidden).toBe(true);
    expect(button('replaceAll').disabled).toBe(true);
    button('replaceAll').click();
    expect(view.state.doc.toString()).toBe('cat Cat scatter\ncat');
    expect(button('next').disabled).toBe(false);
  });

  it('closes search with Escape without letting the modal close', () => {
    const bubbled = vi.fn();
    view.dom.parentElement?.addEventListener('keydown', bubbled);
    input('find').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    );
    expect(searchPanelOpen(view.state)).toBe(false);
    expect(bubbled).not.toHaveBeenCalled();
  });

  it('closes search with Escape from the document too', () => {
    view.contentDOM.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    );
    expect(searchPanelOpen(view.state)).toBe(false);
  });

  it('refreshes visible labels when the language changes', () => {
    translate.setTranslation('tr', { shared: { codeEditor: { find: 'Bul' } } });
    translate.use('tr');
    expect(input('find').placeholder).toBe('Bul');
  });
});
