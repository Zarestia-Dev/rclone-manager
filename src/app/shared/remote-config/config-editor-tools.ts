import { computed, signal } from '@angular/core';

type EditorTool = 'search' | 'cliImport' | 'obscure';

export class ConfigEditorTools {
  private readonly active = signal<EditorTool | null>(null);
  readonly searchQuery = signal('');
  readonly searchVisible = computed(() => this.active() === 'search');
  readonly cliImportVisible = computed(() => this.active() === 'cliImport');
  readonly obscureVisible = computed(() => this.active() === 'obscure');

  toggle(tool: EditorTool): void {
    this.active.update(current => (current === tool ? null : tool));
    if (!this.searchVisible()) this.searchQuery.set('');
  }

  close(): void {
    this.active.set(null);
    this.searchQuery.set('');
  }
}
