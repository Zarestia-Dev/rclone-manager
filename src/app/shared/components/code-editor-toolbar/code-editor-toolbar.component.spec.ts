import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { DomSanitizer } from '@angular/platform-browser';
import { MatIconRegistry } from '@angular/material/icon';
import { provideTranslateService, TranslateService } from '@ngx-translate/core';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { history } from '@codemirror/commands';
import { searchPanelOpen } from '@codemirror/search';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodeEditorToolbarComponent } from './code-editor-toolbar.component';
import { codeEditorExtensions } from './code-editor.extensions';
import { goToLineOpen } from './code-editor.goto';

describe('CodeEditorToolbarComponent', () => {
  let fixture: ComponentFixture<CodeEditorToolbarComponent>;
  let view: EditorView;
  const readonly = new Compartment();

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [CodeEditorToolbarComponent],
      providers: [provideTranslateService(), provideHttpClient()],
    });
    const icons = TestBed.inject(MatIconRegistry);
    const sanitizer = TestBed.inject(DomSanitizer);
    for (const name of ['search', 'ellipsis-vertical', 'remove', 'plus']) {
      icons.addSvgIconLiteral(
        name,
        sanitizer.bypassSecurityTrustHtml('<svg xmlns="http://www.w3.org/2000/svg" />')
      );
    }
    view = new EditorView({
      state: EditorState.create({
        doc: 'one\ntwo',
        extensions: [
          history(),
          readonly.of(EditorState.readOnly.of(false)),
          codeEditorExtensions(TestBed.inject(TranslateService)),
        ],
      }),
    });
    fixture = TestBed.createComponent(CodeEditorToolbarComponent);
    fixture.componentRef.setInput('editor', view);
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
    view.destroy();
    vi.unstubAllGlobals();
  });

  it('opens search by clicking the visible button', () => {
    fixture.nativeElement.querySelector('button').click();
    expect(searchPanelOpen(view.state)).toBe(true);
    expect(fixture.componentInstance.searching()).toBe(true);
    fixture.nativeElement.querySelector('button').click();
    expect(searchPanelOpen(view.state)).toBe(false);
  });

  it('toggles go-to-line and closes it when opening search', () => {
    const tools = fixture.componentInstance;
    tools.goToLine();
    expect(goToLineOpen(view.state)).toBe(true);
    tools.goToLine();
    expect(goToLineOpen(view.state)).toBe(false);
    tools.goToLine();
    tools.find();
    expect(goToLineOpen(view.state)).toBe(false);
    expect(searchPanelOpen(view.state)).toBe(true);
    expect(view.dom.querySelector('button[name="close"]')).toBeNull();
  });

  it('shows find and go-to-line together and keeps wrapping exclusively in the menu', () => {
    const buttons = [
      ...fixture.nativeElement.querySelectorAll('.editor-tools button'),
    ] as HTMLButtonElement[];
    expect(buttons[0].textContent).toContain('find');
    expect(buttons[1].textContent).toContain('goToLine');
    expect(buttons.map(button => button.textContent)).not.toContainEqual(
      expect.stringContaining('wrap')
    );
    buttons[buttons.length - 1].click();
    fixture.detectChanges();
    expect(document.querySelector('[role="menuitemcheckbox"]')).not.toBeNull();
    expect(document.querySelector('[role="menu"]')?.textContent).not.toContain('goToLine');
  });

  it('updates position and undo/redo availability from editor transactions', () => {
    view.dispatch({ changes: { from: 7, insert: '!' }, selection: { anchor: 8 } });
    const tools = fixture.componentInstance;
    expect(tools.line()).toBe(2);
    expect(tools.column()).toBe(5);
    expect(tools.canUndo()).toBe(true);
    tools.history('undo');
    expect(view.state.doc.toString()).toBe('one\ntwo');
    expect(tools.canRedo()).toBe(true);
    tools.history('redo');
    expect(view.state.doc.toString()).toBe('one\ntwo!');
  });

  it('keeps wrapping and font preferences when the editor changes', () => {
    const tools = fixture.componentInstance;
    const initialWrap = tools.wrap();
    tools.toggleWrap();
    tools.resizeFont(1);
    fixture.detectChanges();
    view.dispatch({ changes: { from: 0, insert: 'x' } });
    fixture.detectChanges();
    expect(tools.wrap()).toBe(!initialWrap);
    expect(tools.fontSize()).toBe(1);
    expect(view.contentDOM.classList.contains('cm-lineWrapping')).toBe(!initialWrap);
  });

  it('limits font sizes to supported tokens', () => {
    const tools = fixture.componentInstance;
    tools.resizeFont(-100);
    expect(tools.fontSize()).toBe(0);
    tools.resizeFont(100);
    expect(tools.fontSize()).toBe(tools.fontSizes.length - 1);
  });

  it('toggles line-number visibility without changing the document', () => {
    fixture.componentInstance.toggleLineNumbers();
    expect(view.dom.classList.contains('cm-hide-line-numbers')).toBe(true);
    expect(view.state.doc.toString()).toBe('one\ntwo');
    fixture.componentInstance.toggleLineNumbers();
    expect(view.dom.classList.contains('cm-hide-line-numbers')).toBe(false);
  });

  it('blocks history mutations in read-only mode while keeping search available', () => {
    view.dispatch({ changes: { from: 0, insert: 'x' } });
    view.dispatch({ effects: readonly.reconfigure(EditorState.readOnly.of(true)) });
    expect(fixture.componentInstance.readOnly()).toBe(true);
    fixture.componentInstance.history('undo');
    expect(view.state.doc.toString()).toBe('xone\ntwo');
    fixture.componentInstance.find();
    expect(searchPanelOpen(view.state)).toBe(true);
  });

  it('enables wrapping and larger text initially on touch screens', () => {
    fixture.destroy();
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    fixture = TestBed.createComponent(CodeEditorToolbarComponent);
    // A new toolbar can attach to an editor that outlived the previous toolbar.
    fixture.componentRef.setInput('editor', view);
    fixture.detectChanges();
    expect(fixture.componentInstance.wrap()).toBe(true);
    expect(fixture.componentInstance.fontSize()).toBe(1);
  });

  it('can be destroyed after its editor without dispatching into a destroyed view', () => {
    view.destroy();
    expect(() => fixture.destroy()).not.toThrow();
  });
});
