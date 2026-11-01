import { Injectable, inject, signal } from '@angular/core';
import { RcCommandInfo, RcConsoleResponse } from '@app/types';
import { pushUnique } from '../../../shared/utils/rc/rc-console.util';
import { lineHasSecret } from '../../../shared/utils/rc/rc-output.util';
import { LocalStorageService } from '../../ui/state/local-storage.service';
import { TauriBaseService } from '../platform/tauri-base.service';
import { BackendService } from './backend.service';

/** Most lines kept in the command history; the oldest go first. */
const MAX_HISTORY = 200;
const MAX_SNIPPETS = 50;
const SNIPPETS_KEY = 'rcConsole.snippets';

@Injectable({ providedIn: 'root' })
export class RcConsoleService extends TauriBaseService {
  /** Lines the user ran, oldest first. Kept in memory only, and never one that sets a secret. */
  private readonly historyLines = signal<readonly string[]>([]);
  readonly history = this.historyLines.asReadonly();

  private readonly storage = inject(LocalStorageService);

  /** Lines the user chose to keep. They are stored in the browser, so a secret is never saved. */
  private readonly snippetLines = signal<readonly string[]>(
    this.storage.get<unknown[]>(SNIPPETS_KEY, []).filter((l): l is string => typeof l === 'string')
  );
  readonly snippets = this.snippetLines.asReadonly();

  private readonly backend = inject(BackendService);
  private cachedCommands?: { backend: string; list: RcCommandInfo[] };

  /**
   * Never rejects: a call that rclone refused, and one that never reached it, both come back as a
   * response with `ok: false`.
   */
  async call(command: string, params?: unknown): Promise<RcConsoleResponse> {
    try {
      return await this.invokeCommand<RcConsoleResponse>('rc_console_call', { command, params });
    } catch (err) {
      return {
        ok: false,
        durationMs: 0,
        body: { error: this.backendTranslation.translateBackendMessage(err) },
      };
    }
  }

  /**
   * Every command the active rclone offers, with its help. The list is large, so it is asked once
   * per backend; an empty answer (rclone not reached) is not kept, so the next ask tries again.
   * `force` asks again, for a rclone that was replaced by a new build.
   */
  async loadCommands(force = false): Promise<RcCommandInfo[]> {
    const backend = this.backend.activeBackend();
    if (!force && this.cachedCommands?.backend === backend) return this.cachedCommands.list;

    const res = await this.call('rc/list');
    const found = (res.body as { commands?: RcCommandInfo[] } | null)?.commands;
    const list = res.ok && Array.isArray(found) ? found : [];
    if (list.length > 0) this.cachedCommands = { backend, list };
    return list;
  }

  addToHistory(line: string): void {
    if (lineHasSecret(line)) return;
    this.historyLines.update(lines => pushUnique(lines, line, MAX_HISTORY));
  }

  /** Returns `false` when the line was not saved because it sets a secret. */
  saveSnippet(line: string): boolean {
    if (lineHasSecret(line)) return false;
    this.snippetLines.update(lines => pushUnique(lines, line, MAX_SNIPPETS));
    this.persistSnippets();
    return true;
  }

  removeSnippet(line: string): void {
    this.snippetLines.update(lines => lines.filter(l => l !== line));
    this.persistSnippets();
  }

  private persistSnippets(): void {
    this.storage.set(SNIPPETS_KEY, this.snippetLines());
  }
}
