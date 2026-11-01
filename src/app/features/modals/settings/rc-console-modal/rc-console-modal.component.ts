import {
  afterNextRender,
  afterRenderEffect,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  HostListener,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatDrawerMode, MatSidenavModule } from '@angular/material/sidenav';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { RcCommandInfo, RcConsoleResponse, RcNotice } from '@app/types';
import { CopyToClipboardDirective } from '../../../../shared/directives/copy-to-clipboard.directive';
import { EscapeCloseDirective } from '../../../../shared/directives/escape-close.directive';
import { RemoteFacadeService } from '../../../../services/facade/remote-facade.service';
import { RcloneStatusService } from '../../../../services/infrastructure/maintenance/rclone-status.service';
import { BackendService } from '../../../../services/infrastructure/system/backend.service';
import { RcConsoleService } from '../../../../services/infrastructure/system/rc-console.service';
import { SystemInfoService } from '../../../../services/infrastructure/system/system-info.service';
import { NotificationService } from '../../../../services/ui/notification.service';
import {
  commandName,
  computeSuggestions,
  isDangerousCommand,
  isReadOnlyCommand,
  maskCommandLine,
  normalizeCommand,
  parseRcCommandLine,
  quoteToken,
  RcSuggestion,
  usedParamKeys,
} from '../../../../shared/utils/rc/rc-console.util';
import { syncResponsiveSidebar } from '../../../../shared/utils/responsive.util';
import { matchesShortcut } from '../../../../shared/utils/keyboard-utils';
import { paramsOf } from '../../../../shared/utils/rc/rc-schema.util';
import { RcHelpComponent } from './parts/rc-help.component';
import { RcJobCardComponent } from './parts/rc-job-card.component';
import { RcOutputComponent } from '../../../../shared/components/rc-output/rc-output.component';
import { RcSidebarComponent } from '../../../../shared/components/rc-sidebar/rc-sidebar.component';

/** Entries kept in the scrollback; the oldest go first. */
const MAX_ENTRIES = 100;
/** Lines of recent history offered in the history panel. */
const RECENT_SHOWN = 15;
/** How long the restart button waits for its second click. */
const RESTART_CONFIRM_MS = 4000;
/** The sidebar sits beside the terminal above this modal width and slides over it below. */
const SIDEBAR_BREAKPOINT_PX = 768;

type LoadState = 'loading' | 'ready' | 'unavailable';

export interface RcConsoleModalData {
  /** A line to start with, for example when opened from a remote. */
  line?: string;
}

interface ConsoleEntry {
  id: number;
  /** What was typed, as it is put back in the input. */
  line: string;
  /** The same with secret values masked, for showing and copying while masking is on. */
  maskedLine: string;
  command: string;
  params: Record<string, unknown>;
  /** `guide` is the syntax summary that `help` prints. */
  kind: 'call' | 'guide';
  running: boolean;
  response?: RcConsoleResponse;
  /** Set when an `_async` call returned a job to follow. */
  jobId?: number;
}

function isAsync(params: Record<string, unknown>): boolean {
  return /^(1|t|true)$/i.test(String(params['_async'] ?? ''));
}

@Component({
  selector: 'app-rc-console-modal',
  imports: [
    MatButtonModule,
    MatIconModule,
    MatSidenavModule,
    TranslatePipe,
    CopyToClipboardDirective,
    RcHelpComponent,
    RcJobCardComponent,
    RcOutputComponent,
    RcSidebarComponent,
  ],
  hostDirectives: [EscapeCloseDirective],
  templateUrl: './rc-console-modal.component.html',
  styleUrls: ['./rc-console-modal.component.scss', '../../../../styles/_shared-modal.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RcConsoleModalComponent {
  private readonly dialogRef = inject(MatDialogRef<RcConsoleModalComponent>);
  private readonly rcConsole = inject(RcConsoleService);
  private readonly backend = inject(BackendService);
  private readonly rcloneStatus = inject(RcloneStatusService);
  private readonly systemInfo = inject(SystemInfoService);
  private readonly notifications = inject(NotificationService);
  private readonly translate = inject(TranslateService);
  private readonly remoteFacade = inject(RemoteFacadeService, { optional: true });
  private readonly data = inject<RcConsoleModalData | null>(MAT_DIALOG_DATA, { optional: true });
  private readonly hostEl = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly destroyRef = inject(DestroyRef);

  private readonly outputEl = viewChild<ElementRef<HTMLElement>>('output');
  private readonly inputEl = viewChild<ElementRef<HTMLTextAreaElement>>('lineInput');
  private readonly sidebar = viewChild(RcSidebarComponent);

  readonly line = signal(this.data?.line ?? '');
  readonly entries = signal<ConsoleEntry[]>([]);
  readonly commands = signal<RcCommandInfo[]>([]);
  readonly loadState = signal<LoadState>('loading');
  readonly notice = signal<RcNotice | null>(null);
  readonly selectedSuggestion = signal(0);
  /** The dialog is 90% of the screen wide, so it starts closed where the sidebar will slide over. */
  readonly isSidebarOpen = signal(window.innerWidth * 0.9 >= SIDEBAR_BREAKPOINT_PX);
  readonly sidebarMode = signal<MatDrawerMode>('side');
  /** The command whose help panel is open, or `null` when it is closed. */
  readonly helpPath = signal<string | null>(null);
  readonly recentOpen = signal(false);

  /**
   * Only calls that read are let through. This is a guard against slips, not a boundary: the
   * backend runs whatever it is sent. Both switches start on each time the console opens.
   */
  readonly readOnly = signal(true);
  readonly maskOutput = signal(true);
  readonly isDangerous = isDangerousCommand;
  readonly backendName = this.backend.activeBackend;
  readonly engineVersion = computed(() => this.rcloneStatus.rcloneInfo()?.version ?? '');
  readonly enginePid = this.rcloneStatus.rclonePID;
  readonly engineActive = computed(() => this.rcloneStatus.rcloneStatus() === 'active');
  /** Starts true so the button stays hidden until the platform is known. */
  private readonly isLibrclone = signal(true);
  /**
   * The app owns the engine process only on a local desktop backend, where it starts rclone again
   * once the process is gone. A remote rclone, or the library inside a phone app, is left alone.
   */
  readonly canRestartEngine = computed(
    () => this.backend.activeBackend() === 'Local' && !this.isLibrclone()
  );
  /** The restart button was clicked once and waits for a second click. */
  readonly restartArmed = signal(false);
  readonly restartingEngine = signal(false);
  readonly saved = this.rcConsole.snippets;
  readonly recent = computed(() => [...this.rcConsole.history()].reverse().slice(0, RECENT_SHOWN));

  /** The line whose dangerous call is waiting for a second Enter. */
  private readonly pendingConfirm = signal<string | null>(null);
  private readonly suggestionsDismissed = signal(false);
  private readonly remoteNames = computed(
    () => this.remoteFacade?.orderedVisibleRemotes().map(r => r.name) ?? []
  );
  private readonly touchScreen =
    typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  private shiftEnter = false;
  private armTimer?: ReturnType<typeof setTimeout>;
  private lastPid: number | null = null;
  private nextId = 1;
  private historyCursor = -1;
  private draft = '';

  /** The command being typed, once it names a call rclone knows. */
  readonly activeCommand = computed(() => {
    const word = commandName(this.line());
    return word ? this.commands().find(c => c.Path === word) : undefined;
  });
  private readonly activeParams = computed(() => {
    const command = this.activeCommand();
    return command ? paramsOf(command) : [];
  });

  /** Parameters of the typed command that are not on the line yet. */
  readonly missingParams = computed(() => {
    const used = usedParamKeys(this.line());
    return this.activeParams()
      .filter(p => !used.has(p.name))
      .slice(0, 10);
  });

  /** Lines to try from the empty console; the last one uses the first remote when there is one. */
  readonly quickStart = computed(() => {
    const lines = ['core/version', 'core/stats', 'config/listremotes', 'job/list'];
    const remote = this.remoteNames()[0];
    return remote ? [...lines, `operations/about fs=${quoteToken(`${remote}:`)}`] : lines;
  });

  readonly helpCommand = computed(() => {
    const path = this.helpPath();
    return path ? this.commands().find(c => c.Path === path) : undefined;
  });

  readonly suggestions = computed<RcSuggestion[]>(() =>
    this.suggestionsDismissed()
      ? []
      : computeSuggestions({
          line: this.line(),
          commands: this.commands(),
          remotes: this.remoteNames(),
          params: this.activeParams(),
        })
  );

  readonly confirmCommand = computed(() => {
    const raw = this.line().trim();
    if (this.pendingConfirm() !== raw) return null;
    return commandName(raw);
  });

  constructor() {
    syncResponsiveSidebar(
      SIDEBAR_BREAKPOINT_PX,
      this.sidebarMode,
      this.isSidebarOpen,
      this.destroyRef,
      this.hostEl.nativeElement
    );
    afterNextRender(() => this.focusInput(true));
    afterRenderEffect(() => {
      this.line(); // measure the box again whenever the text changes
      const el = this.inputEl()?.nativeElement;
      if (el) {
        el.style.height = 'auto';
        el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
      }
    });
    afterRenderEffect(() => {
      this.entries(); // follow the output when a call is added or finishes
      const el = this.outputEl()?.nativeElement;
      if (el) el.scrollTop = el.scrollHeight;
    });
    void this.loadCommands();
    void this.systemInfo.isLibrclone().then(
      isLib => this.isLibrclone.set(isLib),
      () => undefined
    );
    this.destroyRef.onDestroy(() => clearTimeout(this.armTimer));
    // A new process may be a new build with calls the old one did not have.
    effect(() => {
      const pid = this.enginePid();
      if (!pid) return;
      const previous = this.lastPid;
      this.lastPid = pid;
      if (previous !== null && previous !== pid) untracked(() => void this.loadCommands(true));
    });
  }

  /** An empty answer, as from an engine that is still starting, leaves the list it had. */
  private async loadCommands(force = false): Promise<void> {
    try {
      const commands = await this.rcConsole.loadCommands(force);
      if (commands.length > 0) this.commands.set(commands);
    } catch {
      // The list stays as it was.
    }
    this.loadState.set(this.commands().length > 0 ? 'ready' : 'unavailable');
  }

  /**
   * Stops the local rclone process, which the app starts again from the same path, so a build
   * that replaced the binary is picked up. Running jobs and mounts end with it, so it takes two
   * clicks.
   */
  async restartEngine(): Promise<void> {
    if (this.restartingEngine()) return;
    if (!this.restartArmed()) {
      this.restartArmed.set(true);
      clearTimeout(this.armTimer);
      this.armTimer = setTimeout(() => this.restartArmed.set(false), RESTART_CONFIRM_MS);
      return;
    }

    clearTimeout(this.armTimer);
    this.restartArmed.set(false);
    const pid = this.enginePid();
    if (!pid) {
      this.notifications.showInfo(this.translate.instant('modals.rcConsole.engine.noProcess'));
      return;
    }
    this.restartingEngine.set(true);
    try {
      await this.systemInfo.killProcess(pid);
      this.notifications.showInfo(this.translate.instant('modals.rcConsole.engine.restarting'));
      await this.rcloneStatus.refreshStatus();
    } catch (error) {
      console.error('Failed to stop the rclone engine:', error);
      this.notifications.showError(this.translate.instant('modals.rcConsole.engine.failed'));
    } finally {
      this.restartingEngine.set(false);
    }
  }

  /**
   * Ctrl+F shows the search of the API list. While the sidebar is open the search box answers it
   * itself; when the sidebar is hidden it is inert, so the sidebar is opened here first.
   */
  @HostListener('window:keydown', ['$event'])
  onWindowKeydown(event: KeyboardEvent): void {
    if (event.defaultPrevented || this.isSidebarOpen() || !matchesShortcut('Ctrl + F', event)) {
      return;
    }
    event.preventDefault();
    this.isSidebarOpen.set(true);
    this.sidebar()?.setSearchVisible(true);
  }

  onInput(value: string): void {
    this.line.set(value);
    this.historyCursor = -1;
    this.selectedSuggestion.set(0);
    this.suggestionsDismissed.set(false);
    this.notice.set(null);
    this.recentOpen.set(false);
    this.shiftEnter = false;
    const active = this.activeCommand();
    if (this.helpPath() !== null && active) this.helpPath.set(active.Path);
  }

  onKeydown(event: KeyboardEvent): void {
    if (event.isComposing) return;
    const suggestions = this.suggestions();
    const field = event.target as HTMLTextAreaElement | null;

    if (matchesShortcut('Ctrl + L', event)) {
      event.preventDefault();
      this.clear();
      return;
    }

    switch (event.key) {
      case 'Enter':
        if (event.shiftKey) {
          this.shiftEnter = true;
          return;
        }
        event.preventDefault();
        void this.run();
        break;
      case 'Tab':
        if (suggestions.length > 0) {
          event.preventDefault();
          this.acceptSuggestion(suggestions[this.selectedSuggestion()] ?? suggestions[0]);
        }
        break;
      case 'ArrowUp':
        if (suggestions.length > 0) {
          event.preventDefault();
          this.selectedSuggestion.update(i => Math.max(0, i - 1));
        } else if (!field?.value.slice(0, field.selectionStart).includes('\n')) {
          event.preventDefault();
          this.historyPrevious();
        }
        break;
      case 'ArrowDown':
        if (suggestions.length > 0) {
          event.preventDefault();
          this.selectedSuggestion.update(i => Math.min(suggestions.length - 1, i + 1));
        } else if (!field?.value.slice(field.selectionEnd).includes('\n')) {
          event.preventDefault();
          this.historyNext();
        }
        break;
      case 'Escape':
        // Only swallow Escape while it has something to cancel; otherwise it closes the modal.
        if (suggestions.length > 0) {
          event.stopPropagation();
          this.suggestionsDismissed.set(true);
        } else if (this.recentOpen()) {
          event.stopPropagation();
          this.recentOpen.set(false);
        } else if (this.confirmCommand()) {
          event.stopPropagation();
          this.pendingConfirm.set(null);
        }
        break;
    }
  }

  /**
   * Android keyboards often send no usable Enter `keydown`, especially while a word is still being
   * composed, but they do announce the line break. A line break that Shift+Enter did not ask for
   * runs the line.
   */
  onBeforeInput(event: Event): void {
    if ((event as InputEvent).inputType !== 'insertLineBreak') return;
    if (this.shiftEnter) {
      this.shiftEnter = false;
      return;
    }
    event.preventDefault();
    void this.run();
  }

  acceptSuggestion(suggestion: RcSuggestion): void {
    this.line.set(suggestion.line);
    this.selectedSuggestion.set(0);
    this.suggestionsDismissed.set(false);
    this.focusInput();
  }

  setLine(line: string): void {
    this.line.set(line);
    this.notice.set(null);
    this.focusInput();
  }

  /** Runs a line taken from the help panel or the history. */
  runLine(line: string): void {
    this.line.set(line);
    void this.run();
  }

  insertParam(name: string): void {
    this.line.update(l => `${l}${l === '' || /\s$/.test(l) ? '' : ' '}${name}=`);
    this.focusInput();
  }

  pickCommand(path: string): void {
    this.line.set(`${path} `);
    this.helpPath.set(path);
    this.notice.set(null);
    if (this.sidebarMode() === 'over') this.isSidebarOpen.set(false);
    this.focusInput();
  }

  async run(): Promise<void> {
    const raw = this.line().trim();
    if (!raw) return;

    const [first, second] = raw.split(/\s+/);
    const word = first.toLowerCase();
    if (word === 'clear' || word === 'cls') {
      this.clear();
      return;
    }
    if (word === 'help' || word === '?') {
      this.runHelp(raw, second);
      return;
    }

    const parsed = parseRcCommandLine(raw);
    if (!parsed.ok) {
      this.notice.set(parsed.error);
      return;
    }

    const { command, params } = parsed.value;
    if (this.readOnly() && !isReadOnlyCommand(command)) {
      this.notice.set({
        key: 'modals.rcConsole.readOnlyBlocked',
        params: { command },
        allowWrites: true,
      });
      return;
    }
    if (isDangerousCommand(command) && this.pendingConfirm() !== raw) {
      this.pendingConfirm.set(raw);
      return;
    }

    this.pendingConfirm.set(null);
    this.rcConsole.addToHistory(raw);
    this.line.set('');
    this.historyCursor = -1;
    const id = this.pushEntry({
      line: raw,
      maskedLine: maskCommandLine(raw, parsed.value),
      command,
      params,
      kind: 'call',
      running: true,
    });

    const response = await this.rcConsole.call(command, params);
    const jobid = (response.body as { jobid?: unknown } | null)?.jobid;
    this.patchEntry(id, {
      running: false,
      response,
      jobId: response.ok && isAsync(params) && typeof jobid === 'number' ? jobid : undefined,
    });
    this.focusInput(true);
  }

  clear(): void {
    this.entries.set([]);
    this.line.set('');
    this.notice.set(null);
  }

  allowWrites(): void {
    this.readOnly.set(false);
    this.notice.set(null);
  }

  toggleReadOnly(): void {
    this.readOnly.update(on => !on);
    this.notice.set(null);
  }

  toggleMask(): void {
    this.maskOutput.update(on => !on);
  }

  toggleSidebar(): void {
    this.isSidebarOpen.update(open => !open);
  }

  toggleRecent(): void {
    this.recentOpen.update(open => !open);
  }

  showHelp(path: string): void {
    this.helpPath.set(path);
  }

  closeHelp(): void {
    this.helpPath.set(null);
  }

  saveCurrent(): void {
    const raw = this.line().trim();
    if (!raw) return;
    if (!this.rcConsole.saveSnippet(raw)) {
      this.notice.set({ key: 'modals.rcConsole.snippetSecret' });
    }
  }

  removeSaved(line: string): void {
    this.rcConsole.removeSnippet(line);
  }

  useRecent(line: string): void {
    this.recentOpen.set(false);
    this.setLine(line);
  }

  entryRcLine(entry: ConsoleEntry): string {
    return `rclone rc ${this.maskOutput() ? entry.maskedLine : entry.line}`;
  }

  close(): void {
    this.dialogRef.close();
  }

  private runHelp(raw: string, target?: string): void {
    this.rcConsole.addToHistory(raw);
    const path = target ? normalizeCommand(target) : '';
    if (path && this.commands().some(c => c.Path === path)) {
      this.helpPath.set(path);
    } else {
      this.pushEntry({
        line: raw,
        maskedLine: raw,
        command: 'help',
        params: {},
        kind: 'guide',
        running: false,
      });
    }
    this.line.set('');
  }

  private historyPrevious(): void {
    const history = this.rcConsole.history();
    if (history.length === 0) return;
    if (this.historyCursor === -1) {
      this.draft = this.line();
      this.historyCursor = history.length - 1;
    } else if (this.historyCursor > 0) {
      this.historyCursor--;
    }
    this.line.set(history[this.historyCursor]);
  }

  private historyNext(): void {
    if (this.historyCursor === -1) return;
    const history = this.rcConsole.history();
    if (this.historyCursor < history.length - 1) {
      this.historyCursor++;
      this.line.set(history[this.historyCursor]);
    } else {
      this.historyCursor = -1;
      this.line.set(this.draft);
    }
  }

  private pushEntry(entry: Omit<ConsoleEntry, 'id'>): number {
    const id = this.nextId++;
    this.entries.update(list => [...list, { ...entry, id }].slice(-MAX_ENTRIES));
    return id;
  }

  private patchEntry(id: number, patch: Partial<ConsoleEntry>): void {
    this.entries.update(list => list.map(e => (e.id === id ? { ...e, ...patch } : e)));
  }

  /**
   * `automatic` focus is skipped on touch screens: it would raise the on-screen keyboard over the
   * output nobody asked to hide. Focus the user asked for, such as picking a call, still happens.
   */
  private focusInput(automatic = false): void {
    if (automatic && this.touchScreen) return;
    this.inputEl()?.nativeElement.focus();
  }
}
