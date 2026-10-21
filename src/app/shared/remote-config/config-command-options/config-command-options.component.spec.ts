import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { ConfigCommandOptionsComponent } from './config-command-options.component';

describe('configuration command options', () => {
  const create = (): ConfigCommandOptionsComponent => {
    TestBed.configureTestingModule({ imports: [ConfigCommandOptionsComponent] }).overrideComponent(
      ConfigCommandOptionsComponent,
      { set: { template: '', imports: [] } }
    );
    const fixture = TestBed.createComponent(ConfigCommandOptionsComponent);
    fixture.componentRef.setInput('options', []);
    return fixture.componentInstance;
  };

  it('rejects empty and duplicate option keys', () => {
    const editor = create();
    editor.addCustomOption();
    expect(editor.options()).toEqual([]);
    editor.newOptionKey.set(' custom ');
    editor.addCustomOption();
    editor.newOptionKey.set('custom');
    editor.addCustomOption();
    expect(editor.options()).toEqual([{ key: 'custom', value: true }]);
  });

  it('keeps arrays and special characters intact and ignores invalid numeric edits', () => {
    const editor = create();
    editor.options.set([
      { key: 'headers', value: [] },
      { key: 'retries', value: 2 },
    ]);
    const input = document.createElement('input');
    editor.addArrayChip('headers', " X-Test: a'b,c ", input);
    editor.updateNumberOption('retries', 'invalid');
    expect(editor.options()).toEqual([
      { key: 'headers', value: ["X-Test: a'b,c"] },
      { key: 'retries', value: 2 },
    ]);
    editor.removeArrayChip('headers', 0);
    editor.removeOption('retries');
    expect(editor.options()).toEqual([{ key: 'headers', value: [] }]);
  });
});
