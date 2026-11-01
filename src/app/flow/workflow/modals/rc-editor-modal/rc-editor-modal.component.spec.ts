import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { provideTranslateService } from '@ngx-translate/core';
import { RcEditorModalComponent } from './rc-editor-modal.component';
import { WorkflowStateService } from '../../../../services/flow/workflow-state.service';
import { RemoteFacadeService } from '../../../../services/facade/remote-facade.service';
import { RcConsoleService } from '../../../../services/infrastructure/system/rc-console.service';
import { WorkflowNode } from '../../types/workflow.types';

const LIST_HELP = `- fs - a remote name
- remote - a path
- opt - options (optional)

Returns:

- list`;

describe('RcEditorModalComponent', () => {
  let fixture: ComponentFixture<RcEditorModalComponent>;
  let component: RcEditorModalComponent;
  let dialogRefSpy: { close: ReturnType<typeof vi.fn> };
  let workflowStateSpy: {
    updateNodeConfig: ReturnType<typeof vi.fn>;
    currentWorkflow: ReturnType<typeof vi.fn>;
  };
  let remoteFacadeSpy: { orderedVisibleRemotes: ReturnType<typeof vi.fn> };
  let call: ReturnType<typeof vi.fn>;
  let loadCommands: ReturnType<typeof vi.fn>;

  const mockNode: WorkflowNode = {
    id: 'node-rc-1',
    type: 'rc_command',
    category: 'task',
    title: 'Refresh VFS Cache',
    x: 0,
    y: 0,
    inputs: [],
    outputs: [],
    config: {
      command: 'vfs/refresh',
      params: { recursive: true },
    },
  };

  beforeEach(async () => {
    dialogRefSpy = { close: vi.fn() };
    call = vi.fn().mockResolvedValue({ ok: true, durationMs: 7, body: { version: 'v1' } });
    loadCommands = vi.fn().mockResolvedValue([
      { Path: 'operations/list', Title: 'List files', Help: LIST_HELP },
      { Path: 'operations/size', Title: 'Count and size', Help: '- fs - a remote' },
      { Path: 'operations/cleanup', Title: 'Empty the trash', Help: '- fs - a remote' },
      { Path: 'vfs/refresh', Title: 'Refresh the cache', Help: 'Prose only.' },
    ]);
    workflowStateSpy = {
      updateNodeConfig: vi.fn(),
      currentWorkflow: vi.fn().mockReturnValue({
        id: 'wf-1',
        nodes: [mockNode],
        edges: [],
      }),
    };
    remoteFacadeSpy = {
      orderedVisibleRemotes: vi.fn().mockReturnValue([{ name: 'mygdrive', type: 'drive' }]),
    };

    await TestBed.configureTestingModule({
      imports: [RcEditorModalComponent],
      providers: [
        provideTranslateService(),
        { provide: MatDialogRef, useValue: dialogRefSpy },
        { provide: MAT_DIALOG_DATA, useValue: { node: mockNode } },
        { provide: WorkflowStateService, useValue: workflowStateSpy },
        { provide: RemoteFacadeService, useValue: remoteFacadeSpy },
        {
          provide: RcConsoleService,
          useValue: {
            call,
            loadCommands,
          },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(RcEditorModalComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    await fixture.whenStable();
  });

  it('initializes with node command and params', () => {
    expect(component.command()).toBe('vfs/refresh');
    expect(component.rawParamsJson()).toBe(JSON.stringify({ recursive: true }, null, 2));
  });

  it('formats JSON and clears params', () => {
    component.rawParamsJson.set('{"test":123}');
    component.formatJson();
    expect(component.rawParamsJson()).toBe('{\n  "test": 123\n}');

    component.clearParams();
    expect(component.rawParamsJson()).toBe('');
  });

  it('evaluates jsonStatus correctly', () => {
    component.rawParamsJson.set('{"valid": true}');
    expect(component.jsonStatus().valid).toBe(true);
    expect(component.jsonStatus().isTemplate).toBe(false);

    component.rawParamsJson.set('{"path": "{{nodes.n1.out}}"}');
    expect(component.jsonStatus().valid).toBe(true);
    expect(component.jsonStatus().isTemplate).toBe(true);

    component.rawParamsJson.set('{broken json');
    expect(component.jsonStatus().valid).toBe(false);
  });

  it('closes without changes on dismiss', () => {
    component.dismiss();
    expect(dialogRefSpy.close).toHaveBeenCalledWith();
  });

  it('updates workflow state and closes on save', () => {
    component.command.set('core/bwlimit');
    component.rawParamsJson.set('{"rate": "20M"}');
    component.save();

    expect(workflowStateSpy.updateNodeConfig).toHaveBeenCalledWith('node-rc-1', {
      command: 'core/bwlimit',
      params: { rate: '20M' },
    });
    expect(dialogRefSpy.close).toHaveBeenCalledWith({
      command: 'core/bwlimit',
      params: { rate: '20M' },
    });
  });

  describe('endpoint help from rclone', () => {
    it('suggests the calls that match what is typed', () => {
      component.command.set('operations/');
      expect(component.endpointSuggestions().map(s => s.Path)).toEqual([
        'operations/list',
        'operations/size',
        'operations/cleanup',
      ]);
      component.pickEndpoint('operations/size');
      expect(component.command()).toBe('operations/size');
      expect(component.endpointSuggestions()).toEqual([]);
    });

    it('shows the chosen call and its parameters, required first, minus the ones already set', () => {
      component.command.set('operations/list');
      component.rawParamsJson.set('');
      expect(component.activeEndpoint()?.Title).toBe('List files');
      expect(component.endpointParams().map(p => p.name)).toEqual(['fs', 'remote', 'opt']);

      component.addParam('fs');
      expect(JSON.parse(component.rawParamsJson())).toEqual({ fs: '' });
      expect(component.endpointParams().map(p => p.name)).toEqual(['remote', 'opt']);
    });

    it('does not rewrite parameters that hold workflow tokens', () => {
      component.command.set('operations/list');
      component.rawParamsJson.set('{"fs": {{prev.fs}}}');
      component.addParam('remote');
      expect(component.rawParamsJson()).toBe('{"fs": {{prev.fs}}}');
    });

    it('offers nothing for a call rclone does not list', () => {
      component.command.set('made/up');
      expect(component.activeEndpoint()).toBeUndefined();
      expect(component.endpointParams()).toEqual([]);
    });
  });

  describe('test run', () => {
    it('runs a read call through the console service and keeps the response', async () => {
      component.command.set('core/version');
      component.rawParamsJson.set('');
      await component.testRun();

      expect(call).toHaveBeenCalledWith('core/version', {});
      expect(component.testResult()).toEqual({ ok: true, durationMs: 7, body: { version: 'v1' } });
      expect(component.testNotice()).toBeNull();
      expect(component.isTesting()).toBe(false);
    });

    it('sends the parameters as an object', async () => {
      component.command.set('operations/about');
      component.rawParamsJson.set('{"fs":"gdrive:"}');
      await component.testRun();
      expect(call).toHaveBeenCalledWith('operations/about', { fs: 'gdrive:' });
    });

    it('does not run a call that writes while read-only mode is on', async () => {
      component.command.set('operations/purge');
      component.rawParamsJson.set('{"fs":"a:","remote":"x"}');
      await component.testRun();

      expect(call).not.toHaveBeenCalled();
      expect(component.testNotice()).toMatchObject({
        key: 'modals.rcConsole.readOnlyBlocked',
        params: { command: 'operations/purge' },
        allowWrites: true,
      });

      component.allowWrites();
      expect(component.testNotice()).toBeNull();
      await component.testRun();
      expect(call).toHaveBeenCalledTimes(1);
    });

    it('explains why parameters with workflow variables or broken JSON cannot be tested', async () => {
      component.command.set('core/version');
      component.rawParamsJson.set('{"fs": "{{prev.fs}}"}');
      await component.testRun();
      expect(component.testNotice()?.key).toBe('flow.workflow.inspector.testNeedsPlainJson');

      component.rawParamsJson.set('{broken');
      await component.testRun();
      expect(component.testNotice()?.key).toBe('flow.workflow.inspector.invalidJson');
      expect(call).not.toHaveBeenCalled();
    });

    it('rejects parameters that are not an object', async () => {
      component.command.set('core/version');
      component.rawParamsJson.set('[1,2]');
      await component.testRun();
      expect(component.testNotice()?.key).toBe('flow.workflow.inspector.invalidJson');
      expect(call).not.toHaveBeenCalled();
    });

    it('shows a failed call as a failed result', async () => {
      call.mockResolvedValueOnce({
        ok: false,
        status: 500,
        durationMs: 3,
        body: { error: 'no fs' },
      });
      component.command.set('core/version');
      await component.testRun();
      expect(component.testResult()).toMatchObject({ ok: false, status: 500 });
      expect(component.isTesting()).toBe(false);
    });

    it('fills an empty sample from a successful test and opens it', async () => {
      component.command.set('core/version');
      await component.testRun();

      expect(JSON.parse(component.sampleOutputJson())).toEqual({ version: 'v1' });
      expect(component.sampleOpen()).toBe(true);
    });

    it('leaves a sample that is already written alone', async () => {
      component.sampleOutputJson.set('{"mine":1}');
      component.command.set('core/version');
      await component.testRun();

      expect(component.sampleOutputJson()).toBe('{"mine":1}');
    });

    it('does not fill the sample from a failed test', async () => {
      call.mockResolvedValueOnce({ ok: false, status: 500, durationMs: 3, body: { error: 'x' } });
      component.command.set('core/version');
      await component.testRun();

      expect(component.sampleOutputJson()).toBe('');
    });

    it('keeps only the shape of a successful reply as the sample, with secrets masked', async () => {
      call.mockResolvedValueOnce({
        ok: true,
        durationMs: 1,
        body: { remote: { type: 'drive', token: 'abc' } },
      });
      component.command.set('core/version');
      await component.testRun();
      component.saveTestAsSample();

      const sample = JSON.parse(component.sampleOutputJson());
      expect(sample.remote.type).toBe('drive');
      expect(component.sampleOutputJson()).not.toContain('abc');
    });

    it('does not save a failed reply as the sample', async () => {
      call.mockResolvedValueOnce({ ok: false, status: 400, durationMs: 1, body: { error: 'x' } });
      component.command.set('core/version');
      component.sampleOutputJson.set('');
      await component.testRun();
      component.saveTestAsSample();
      expect(component.sampleOutputJson()).toBe('');
    });
  });

  describe('choosing a call', () => {
    beforeEach(() => component.rawParamsJson.set(''));

    it('starts with the required keys, and the first remote for an fs', () => {
      component.pickEndpoint('operations/list');
      expect(component.command()).toBe('operations/list');
      expect(JSON.parse(component.rawParamsJson())).toEqual({ fs: 'mygdrive:', remote: '' });
    });

    it('adds the values of a preset for the call', () => {
      component.pickEndpoint('operations/cleanup');
      expect(JSON.parse(component.rawParamsJson())).toEqual({ fs: 'mygdrive:' });

      component.rawParamsJson.set('');
      component.pickEndpoint('vfs/refresh');
      expect(JSON.parse(component.rawParamsJson())).toEqual({ recursive: true });
    });

    it('starts empty for a call with nothing required', () => {
      component.pickEndpoint('core/version');
      expect(component.rawParamsJson()).toBe('');
    });

    it('keeps parameters the user has written', () => {
      component.rawParamsJson.set('{"fs":"mine:"}');
      component.pickEndpoint('operations/size');
      expect(component.command()).toBe('operations/size');
      expect(component.rawParamsJson()).toBe('{"fs":"mine:"}');
    });

    it('replaces the starter of the last pick, but not once it was edited', () => {
      component.pickEndpoint('operations/list');
      component.pickEndpoint('operations/size');
      expect(JSON.parse(component.rawParamsJson())).toEqual({ fs: 'mygdrive:' });

      component.rawParamsJson.set('{"fs":"mygdrive:","extra":1}');
      component.pickEndpoint('operations/list');
      expect(JSON.parse(component.rawParamsJson())).toEqual({ fs: 'mygdrive:', extra: 1 });
    });

    it('puts the sidebar away after a pick only when it slides over the form', () => {
      component.sidebarMode.set('side');
      component.isSidebarOpen.set(true);
      component.onSidebarPick('operations/size');
      expect(component.isSidebarOpen()).toBe(true);

      component.sidebarMode.set('over');
      component.onSidebarPick('operations/list');
      expect(component.isSidebarOpen()).toBe(false);
    });

    it('toggles the sidebar', () => {
      const before = component.isSidebarOpen();
      component.toggleSidebar();
      expect(component.isSidebarOpen()).toBe(!before);
    });

    it('marks a call that needs care', () => {
      component.command.set('operations/purge');
      expect(component.activeDangerous()).toBe(true);
      component.command.set('operations/list');
      expect(component.activeDangerous()).toBe(false);
    });
  });

  describe('when rclone cannot list its calls', () => {
    it('offers the common calls instead and says so', async () => {
      loadCommands.mockRejectedValue(new Error('offline'));
      const other = TestBed.createComponent(RcEditorModalComponent);
      await other.whenStable();
      const editor = other.componentInstance;

      expect(editor.offline()).toBe(true);
      expect(editor.catalog().map(c => c.Path)).toContain('vfs/refresh');
      editor.pickEndpoint('vfs/refresh');
      expect(JSON.parse(editor.rawParamsJson())).toEqual({ recursive: true });
    });

    it('is not offline while the list is read or once it arrived', () => {
      expect(component.offline()).toBe(false);
      expect(component.catalog().length).toBe(4);
    });
  });
});
