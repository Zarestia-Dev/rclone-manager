import {
  Component,
  ChangeDetectionStrategy,
  DestroyRef,
  ElementRef,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatDrawerMode, MatSidenavModule } from '@angular/material/sidenav';
import { TranslatePipe } from '@ngx-translate/core';
import { RcCommandInfo, RcConsoleResponse, RcNotice } from '@app/types';
import { WorkflowNode } from '../../types/workflow.types';
import { WorkflowStateService } from '../../../../services/flow/workflow-state.service';
import { RemoteFacadeService } from '../../../../services/facade/remote-facade.service';
import {
  extractFieldsFromObject,
  getAvailableUpstreamNodes,
  getNodeFields,
  getNodeFieldsForType,
  NodeVariableField,
} from '../../utils/node-fields.util';
import { RC_PRESETS } from '../../constants/rc-presets.constant';
import { EscapeCloseDirective } from '../../../../shared/directives/escape-close.directive';
import { RcConsoleService } from '../../../../services/infrastructure/system/rc-console.service';
import { RcDocsComponent } from '../../../../shared/components/rc-docs/rc-docs.component';
import { RcOutputComponent } from '../../../../shared/components/rc-output/rc-output.component';
import { RcSidebarComponent } from '../../../../shared/components/rc-sidebar/rc-sidebar.component';
import {
  isDangerousCommand,
  isReadOnlyCommand,
  normalizeCommand,
  suggestCommands,
} from '../../../../shared/utils/rc/rc-console.util';
import { addParamKey, jsonObjectOrNull } from '../../../../shared/utils/rc/rc-json-params.util';
import { maskSecrets } from '../../../../shared/utils/rc/rc-output.util';
import { paramsOf } from '../../../../shared/utils/rc/rc-schema.util';
import { syncResponsiveSidebar } from '../../../../shared/utils/responsive.util';

import { PillDirective } from '../../../../shared/directives/pill.directive';
/** The dialog is wide enough for the sidebar beside the form from this width up. */
const SIDEBAR_BREAKPOINT_PX = 768;

/** What is offered when rclone cannot list its own calls. */
const FALLBACK_COMMANDS: readonly RcCommandInfo[] = RC_PRESETS.map(p => ({
  Path: p.command,
  Title: p.title,
  Help: '',
}));

export interface RcEditorModalData {
  node: WorkflowNode;
}

@Component({
  selector: 'app-rc-editor-modal',
  imports: [
    FormsModule,
    MatButtonModule,
    MatIconModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatSidenavModule,
    TranslatePipe,
    RcDocsComponent,
    RcOutputComponent,
    RcSidebarComponent,
    PillDirective,
  ],
  hostDirectives: [EscapeCloseDirective],
  templateUrl: './rc-editor-modal.component.html',
  styleUrls: ['./rc-editor-modal.component.scss', '../../../../styles/_shared-modal.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RcEditorModalComponent {
  private readonly dialogRef = inject(MatDialogRef<RcEditorModalComponent>);
  readonly data: RcEditorModalData = inject(MAT_DIALOG_DATA);
  private readonly workflowState = inject(WorkflowStateService, { optional: true });
  private readonly remoteFacade = inject(RemoteFacadeService, { optional: true });
  private readonly rcConsole = inject(RcConsoleService);

  private readonly hostEl = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly destroyRef = inject(DestroyRef);
  private readonly paramsTextarea = viewChild<ElementRef<HTMLTextAreaElement>>('paramsTextarea');

  readonly command = signal<string>(
    (this.data?.node?.config?.['command'] as string) || 'core/version'
  );
  readonly rawParamsJson = signal<string>('');
  readonly sampleOutputJson = signal<string>('');
  /** The hint in the empty parameters box; a template attribute would not turn `\n` into a line break. */
  readonly paramsPlaceholder = '{\n  "fs": "remote:"\n}';
  /**
   * The sidebar is shown beside the form on a wide dialog and slides over it on a narrow one. It
   * starts closed where it will slide over, so it does not flash open across the form.
   */
  readonly isSidebarOpen = signal(window.innerWidth * 0.95 >= SIDEBAR_BREAKPOINT_PX);
  readonly sidebarMode = signal<MatDrawerMode>('side');
  /** The sample-output section is folded away until it has content. */
  readonly sampleOpen = signal(false);
  readonly selectedVariableNodeId = signal<string>('');
  readonly selectedVariableField = signal<string>('');

  // Live test runner state
  readonly isTesting = signal<boolean>(false);
  readonly testResult = signal<RcConsoleResponse | null>(null);
  /** Why the last test run did not run, as a translation key; the response is in `testResult`. */
  readonly testNotice = signal<RcNotice | null>(null);
  /** Test runs only read until writes are allowed here. A guard against slips, not a boundary. */
  readonly readOnly = signal(true);
  readonly maskOutput = signal(true);

  /** Every call the running rclone offers; empty until read, or when it cannot be reached. */
  private readonly knownCommands = signal<readonly RcCommandInfo[]>([]);
  private readonly commandsLoaded = signal(false);

  /** All of rclone's calls, or the common ones when rclone could not be asked. */
  readonly catalog = computed(() =>
    this.knownCommands().length > 0 ? this.knownCommands() : FALLBACK_COMMANDS
  );
  readonly offline = computed(() => this.commandsLoaded() && this.knownCommands().length === 0);

  readonly remotes = computed(() => this.remoteFacade?.orderedVisibleRemotes() ?? []);

  readonly endpointSuggestions = computed(() => {
    const typed = this.command().trim();
    const found = suggestCommands(this.catalog(), typed, 6);
    return found.length === 1 && found[0].Path === typed ? [] : found;
  });

  /** The chosen call, once what is typed names one of the known calls. */
  readonly activeEndpoint = computed(() => {
    const typed = normalizeCommand(this.command());
    return this.catalog().find(c => c.Path === typed);
  });
  readonly activeDangerous = computed(() => isDangerousCommand(this.command()));

  /** The parameters text as an object; `null` when it is not plain JSON (or holds `{{ }}` tokens). */
  private readonly parsedParams = computed(() => jsonObjectOrNull(this.rawParamsJson()));

  /** Parameters of the chosen call that are not in the JSON yet, required ones first. */
  readonly endpointParams = computed(() => {
    const endpoint = this.activeEndpoint();
    if (!endpoint) return [];
    const set = this.parsedParams() ?? {};
    return paramsOf(endpoint).filter(p => !(p.name in set));
  });

  readonly availableUpstreamNodes = computed<WorkflowNode[]>(() => {
    return getAvailableUpstreamNodes(
      this.workflowState?.currentWorkflow()?.nodes,
      this.data?.node?.id
    );
  });

  readonly availableFieldsForSelectedNode = computed<NodeVariableField[]>(() => {
    const targetId = this.activeVariableNodeId();
    if (!targetId) return [];
    if (targetId === 'prev') {
      return getNodeFieldsForType('prev');
    }
    const target = this.availableUpstreamNodes().find(n => n.id === targetId);
    if (!target) return [];
    return getNodeFields(target);
  });

  readonly activeVariableNodeId = computed(() => {
    const explicit = this.selectedVariableNodeId();
    if (explicit) return explicit;
    const nodes = this.availableUpstreamNodes();
    return nodes.length > 0 ? nodes[0].id : '';
  });

  readonly activeVariableField = computed(() => {
    const explicit = this.selectedVariableField();
    if (explicit) return explicit;
    const fields = this.availableFieldsForSelectedNode();
    return fields.length > 0 ? fields[0].key : '';
  });

  readonly selectedTokenPreview = computed(() => {
    const nId = this.activeVariableNodeId();
    const fKey = this.activeVariableField();
    if (!nId || !fKey) return '';
    if (nId === 'prev') {
      return `{{prev.${fKey}}}`;
    }
    return `{{nodes.${nId}.${fKey}}}`;
  });

  readonly jsonStatus = computed<{ valid: boolean; isTemplate: boolean; error?: string }>(() => {
    const raw = this.rawParamsJson().trim();
    if (!raw) return { valid: true, isTemplate: false };
    if (raw.includes('{{') && raw.includes('}}')) {
      const dummySubstituted = raw
        .replace(/"\{\{[^}]+\}\}"/g, '"__token__"')
        .replace(/\{\{[^}]+\}\}/g, '"__token__"');
      try {
        JSON.parse(dummySubstituted);
        return { valid: true, isTemplate: true };
      } catch (e) {
        return { valid: false, isTemplate: true, error: (e as Error).message };
      }
    }
    try {
      JSON.parse(raw);
      return { valid: true, isTemplate: false };
    } catch (e) {
      return { valid: false, isTemplate: false, error: (e as Error).message };
    }
  });

  readonly sampleOutputKeys = computed<NodeVariableField[]>(() => {
    const raw = this.sampleOutputJson().trim();
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return extractFieldsFromObject(parsed);
    } catch {
      return [];
    }
  });

  /** The text of the starter parameters last filled in, so a later pick can replace them. */
  private starterText = '';

  constructor() {
    syncResponsiveSidebar(
      SIDEBAR_BREAKPOINT_PX,
      this.sidebarMode,
      this.isSidebarOpen,
      this.destroyRef,
      this.hostEl.nativeElement
    );
    void this.rcConsole.loadCommands().then(
      commands => {
        this.knownCommands.set(commands);
        this.commandsLoaded.set(true);
      },
      () => this.commandsLoaded.set(true)
    );
    const currentParams = this.data?.node?.config?.['params'];
    if (currentParams !== undefined && currentParams !== null) {
      if (typeof currentParams === 'string') {
        this.rawParamsJson.set(currentParams);
      } else if (typeof currentParams === 'object') {
        this.rawParamsJson.set(
          Object.keys(currentParams).length === 0 ? '' : JSON.stringify(currentParams, null, 2)
        );
      } else {
        this.rawParamsJson.set(String(currentParams));
      }
    }

    const currentSample = this.data?.node?.config?.['sampleOutput'];
    if (currentSample) {
      if (typeof currentSample === 'string') {
        this.sampleOutputJson.set(currentSample);
      } else {
        this.sampleOutputJson.set(JSON.stringify(currentSample, null, 2));
      }
      this.sampleOpen.set(true);
    }
  }

  /**
   * Chooses a call. Parameters the user has not touched are replaced with a starter for the call:
   * its required keys, any preset values, and the first remote for an `fs`.
   */
  pickEndpoint(path: string): void {
    this.command.set(path);

    const current = this.rawParamsJson().trim();
    if (current && current !== '{}' && current !== this.starterText) return;

    const starter = this.starterParams(path);
    this.starterText = Object.keys(starter).length > 0 ? JSON.stringify(starter, null, 2) : '';
    this.rawParamsJson.set(this.starterText);
  }

  toggleSidebar(): void {
    this.isSidebarOpen.update(open => !open);
  }

  /** The sidebar slides over the form on a narrow dialog, so it is put away after a pick. */
  onSidebarPick(path: string): void {
    this.pickEndpoint(path);
    if (this.sidebarMode() === 'over') this.isSidebarOpen.set(false);
  }

  private starterParams(path: string): Record<string, unknown> {
    const endpoint = this.catalog().find(c => c.Path === path);
    const starter: Record<string, unknown> = {};
    if (endpoint) {
      for (const param of paramsOf(endpoint)) {
        if (param.required) starter[param.name] = '';
      }
    }
    Object.assign(starter, RC_PRESETS.find(p => p.command === path)?.defaultParams);

    const firstRemote = this.remotes()[0]?.name;
    if (firstRemote) {
      for (const [key, value] of Object.entries(starter)) {
        if (/fs$/i.test(key) && (value === '' || value === 'remote:')) {
          starter[key] = `${firstRemote}:`;
        }
      }
    }
    return starter;
  }

  addParam(name: string): void {
    this.rawParamsJson.set(addParamKey(this.rawParamsJson(), name));
  }

  formatJson(): void {
    const raw = this.rawParamsJson().trim();
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      this.rawParamsJson.set(JSON.stringify(parsed, null, 2));
    } catch {
      // ignore syntax errors
    }
  }

  clearParams(): void {
    this.rawParamsJson.set('');
  }

  async testRun(): Promise<void> {
    const cmd = this.command().trim();
    if (!cmd) return;

    this.testResult.set(null);
    this.testNotice.set(null);

    // A token inside a string is still valid JSON, so templates are checked for first.
    const isTemplate = this.jsonStatus().isTemplate;
    const params = isTemplate ? null : this.parsedParams();
    if (params === null) {
      this.testNotice.set({
        key: isTemplate
          ? 'flow.workflow.inspector.testNeedsPlainJson'
          : 'flow.workflow.inspector.invalidJson',
      });
      return;
    }
    if (this.readOnly() && !isReadOnlyCommand(cmd)) {
      this.testNotice.set({
        key: 'modals.rcConsole.readOnlyBlocked',
        params: { command: cmd },
        allowWrites: true,
      });
      return;
    }

    this.isTesting.set(true);
    const result = await this.rcConsole.call(cmd, params);
    this.testResult.set(result);
    this.isTesting.set(false);
    // The reply is what later steps can use as variables, so an empty sample starts from it.
    if (result.ok && !this.sampleOutputJson().trim()) this.saveTestAsSample();
  }

  allowWrites(): void {
    this.readOnly.set(false);
    this.testNotice.set(null);
  }

  /** What a test run keeps as the sample: the shape of the reply, with secrets masked. */
  saveTestAsSample(): void {
    const result = this.testResult();
    if (result?.ok) {
      this.sampleOutputJson.set(JSON.stringify(maskSecrets(result.body), null, 2));
      this.sampleOpen.set(true);
    }
  }

  formatSampleOutputJson(): void {
    const raw = this.sampleOutputJson().trim();
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      this.sampleOutputJson.set(JSON.stringify(parsed, null, 2));
    } catch {
      // ignore syntax errors
    }
  }

  onVariableNodeSelect(nodeId: string): void {
    this.selectedVariableNodeId.set(nodeId);
    this.selectedVariableField.set('');
  }

  onVariableFieldSelect(fieldKey: string): void {
    this.selectedVariableField.set(fieldKey);
  }

  insertToken(token: string): void {
    if (!token) return;
    const textarea = this.paramsTextarea()?.nativeElement;
    const current = this.rawParamsJson();

    if (textarea) {
      const start = textarea.selectionStart ?? current.length;
      const end = textarea.selectionEnd ?? current.length;
      const next = current.substring(0, start) + token + current.substring(end);
      this.rawParamsJson.set(next);
      setTimeout(() => {
        textarea.focus();
        const cursor = start + token.length;
        textarea.setSelectionRange(cursor, cursor);
      });
    } else if (!current.trim()) {
      this.rawParamsJson.set(JSON.stringify({ fs: token }, null, 2));
    } else {
      this.rawParamsJson.set(current + token);
    }
  }

  insertSelectedToken(): void {
    const token = this.selectedTokenPreview();
    if (token) {
      this.insertToken(token);
    }
  }

  dismiss(): void {
    this.dialogRef.close();
  }

  save(): void {
    const cmd = this.command().trim();
    const raw = this.rawParamsJson().trim();
    let finalParams: unknown = {};

    if (raw) {
      try {
        finalParams = JSON.parse(raw);
      } catch {
        finalParams = raw;
      }
    }

    const sampleRaw = this.sampleOutputJson().trim();
    const sampleOutput = sampleRaw || undefined;

    if (this.data?.node?.id && this.workflowState) {
      this.workflowState.updateNodeConfig(this.data.node.id, {
        command: cmd,
        params: finalParams,
        sampleOutput,
      });
    }

    this.dialogRef.close({ command: cmd, params: finalParams, sampleOutput });
  }
}
