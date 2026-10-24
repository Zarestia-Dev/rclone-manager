import { TestBed } from '@angular/core/testing';
import { provideTranslateService, TranslateService } from '@ngx-translate/core';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { highlightingFor } from '@codemirror/language';
import { json } from '@codemirror/lang-json';
import { tags } from '@lezer/highlight';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { codeEditorExtensions } from './code-editor.extensions';

describe('Shared CodeMirror appearance', () => {
  let view: EditorView;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideTranslateService()] });
    view = new EditorView({
      state: EditorState.create({
        doc: '{"name":"hello","count":42}',
        extensions: [json(), codeEditorExtensions(TestBed.inject(TranslateService))],
      }),
    });
  });

  afterEach(() => {
    view.destroy();
    document.documentElement.classList.remove('dark');
  });

  it('gives properties, values, and numbers distinct styles without the default setup', () => {
    const colors = [tags.propertyName, tags.string, tags.number].map(tag =>
      highlightingFor(view.state, [tag])
    );
    expect(colors.every(Boolean)).toBe(true);
    expect(new Set(colors).size).toBe(3);
    expect(highlightingFor(view.state, [tags.function(tags.variableName)])).not.toBeNull();
  });

  it('keeps read-only content keyboard focusable', () => {
    expect(view.contentDOM.getAttribute('tabindex')).toBe('0');
    expect(view.contentDOM.getAttribute('spellcheck')).toBe('false');
  });

  it('tracks theme changes without recreating the document or selection', async () => {
    view.dispatch({ selection: { anchor: 10 } });
    document.documentElement.classList.add('dark');
    await Promise.resolve();
    expect(view.state.facet(EditorView.darkTheme)).toBe(true);
    expect(view.state.selection.main.head).toBe(10);
    expect(view.state.doc.toString()).toBe('{"name":"hello","count":42}');
    document.documentElement.classList.remove('dark');
    await Promise.resolve();
    expect(view.state.facet(EditorView.darkTheme)).toBe(false);
  });
});
