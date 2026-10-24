import { describe, expect, it } from 'vitest';
import { ConfigEditorTools } from './config-editor-tools';

describe('configuration editor tools', () => {
  it('shows one tool and clears a search when switching away', () => {
    const tools = new ConfigEditorTools();
    tools.toggle('search');
    tools.searchQuery.set('token');
    tools.toggle('cliImport');
    expect(tools.searchVisible()).toBe(false);
    expect(tools.searchQuery()).toBe('');
    expect(tools.cliImportVisible()).toBe(true);
    tools.toggle('obscure');
    expect(tools.cliImportVisible()).toBe(false);
    expect(tools.obscureVisible()).toBe(true);
    tools.toggle('obscure');
    expect(tools.obscureVisible()).toBe(false);
  });

  it('closes all tools after applying or navigating away', () => {
    const tools = new ConfigEditorTools();
    tools.toggle('search');
    tools.searchQuery.set('anything');
    tools.close();
    expect(tools.searchVisible()).toBe(false);
    expect(tools.searchQuery()).toBe('');
  });
});
