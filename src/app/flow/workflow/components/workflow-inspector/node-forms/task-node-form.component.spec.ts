import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideTranslateService } from '@ngx-translate/core';
import { TaskNodeFormComponent } from './task-node-form.component';
import { WorkflowNode } from '../../../types/workflow.types';

describe('TaskNodeFormComponent', () => {
  let fixture: ComponentFixture<TaskNodeFormComponent>;
  let component: TaskNodeFormComponent;

  const mockNode: WorkflowNode = {
    id: 'node-sync-1',
    type: 'sync',
    category: 'task',
    title: 'Sync Node',
    x: 0,
    y: 0,
    inputs: [],
    outputs: [],
    config: {},
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TaskNodeFormComponent],
      providers: [provideTranslateService()],
    }).compileComponents();

    fixture = TestBed.createComponent(TaskNodeFormComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('node', mockNode);
    fixture.componentRef.setInput('nodeConfig', {});
    fixture.detectChanges();
  });

  it('emits remoteChange when remote changes', () => {
    let emitted = '';
    component.remoteChange.subscribe(val => {
      emitted = val;
    });

    component.remoteChange.emit('gdrive');
    expect(emitted).toBe('gdrive');
  });

  it('identifies operation nodes with detailed config and renders summary card', () => {
    expect(component.isDetailedConfigNode()).toBe(true);

    fixture.componentRef.setInput('inspectorRemote', 'my-drive');
    fixture.componentRef.setInput('inspectorSource', '/data/source');
    fixture.componentRef.setInput('inspectorDest', 'my-drive:dest');
    fixture.componentRef.setInput('remotes', [{ name: 'my-drive', type: 'drive' }]);
    fixture.detectChanges();

    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('.operation-summary-card')).toBeTruthy();
    expect(compiled.querySelector('.remote-badge')?.textContent).toContain('my-drive');
    expect(compiled.textContent).toContain('/data/source');
    expect(compiled.textContent).toContain('my-drive:dest');

    let detailedOpened = false;
    component.openDetailed.subscribe(() => {
      detailedOpened = true;
    });

    const editBtn = compiled.querySelector('.btn-edit-config') as HTMLButtonElement | null;
    expect(editBtn).toBeTruthy();
    editBtn?.click();
    expect(detailedOpened).toBe(true);
  });

  it('identifies non-detailed config nodes correctly', () => {
    const scriptNode: WorkflowNode = {
      ...mockNode,
      id: 'node-script-1',
      type: 'exec_script',
      title: 'Script Node',
    };
    fixture.componentRef.setInput('node', scriptNode);
    fixture.detectChanges();

    expect(component.isDetailedConfigNode()).toBe(false);
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('.operation-summary-card')).toBeNull();
  });

  it('renders summary card for rc_command and emits openDetailed', () => {
    const rcNode: WorkflowNode = {
      ...mockNode,
      id: 'node-rc-test',
      type: 'rc_command',
      title: 'RC Command Node',
    };
    fixture.componentRef.setInput('node', rcNode);
    fixture.componentRef.setInput('nodeConfig', {
      command: 'vfs/refresh',
      params: { recursive: true },
    });
    fixture.detectChanges();

    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('.operation-summary-card')).toBeTruthy();
    expect(compiled.textContent).toContain('vfs/refresh');
    expect(compiled.textContent).toContain('1');

    let detailedOpened = false;
    component.openDetailed.subscribe(() => {
      detailedOpened = true;
    });

    const editBtn = compiled.querySelector('.btn-edit-config') as HTMLButtonElement | null;
    expect(editBtn).toBeTruthy();
    editBtn?.click();
    expect(detailedOpened).toBe(true);
  });

  it('renders correctly for cryptcheck task node', () => {
    const cryptNode: WorkflowNode = {
      ...mockNode,
      id: 'node-crypt-1',
      type: 'cryptcheck',
      title: 'Cryptcheck Node',
    };
    fixture.componentRef.setInput('node', cryptNode);
    fixture.detectChanges();
    expect(component.node().type).toBe('cryptcheck');
  });

  it('renders correctly for archivecreate task node and handles format and prefix', () => {
    const archiveNode: WorkflowNode = {
      ...mockNode,
      id: 'node-archive-1',
      type: 'archivecreate',
      title: 'Archive Node',
    };
    fixture.componentRef.setInput('node', archiveNode);
    fixture.componentRef.setInput('nodeConfig', {
      config: {
        rclone: {
          format: 'tar.gz',
          prefix: 'backup-folder',
        },
      },
    });
    fixture.detectChanges();

    expect(component.node().type).toBe('archivecreate');
    expect(component.archiveFormat()).toBe('tar.gz');
    expect(component.archivePrefix()).toBe('backup-folder');

    const emittedChanges: { key: string; value: unknown }[] = [];
    component.rcloneFieldChange.subscribe(c => emittedChanges.push(c));

    component.onArchiveFormatChange('tar.xz');
    expect(emittedChanges).toContainEqual({ key: 'format', value: 'tar.xz' });

    component.onArchivePrefixChange('new-prefix');
    expect(emittedChanges).toContainEqual({ key: 'prefix', value: 'new-prefix' });
  });

  it('renders correctly for copyurl task node and handles autoFilename', () => {
    const copyurlNode: WorkflowNode = {
      ...mockNode,
      id: 'node-copyurl-1',
      type: 'copyurl',
      title: 'Copy URL Node',
    };
    fixture.componentRef.setInput('node', copyurlNode);
    fixture.componentRef.setInput('nodeConfig', {
      config: {
        rclone: {
          url: 'https://example.com/file.zip',
          dstFs: 'downloads',
          autoFilename: true,
        },
      },
    });
    fixture.detectChanges();

    expect(component.node().type).toBe('copyurl');
    expect(component.autoFilename()).toBe(true);

    const emittedChanges: { key: string; value: unknown }[] = [];
    component.rcloneFieldChange.subscribe(c => emittedChanges.push(c));

    component.onAutoFilenameChange(false);
    expect(emittedChanges).toContainEqual({ key: 'autoFilename', value: false });
  });

  it('emits configChange when rc preset is applied', () => {
    let emitted: { key: string; value: unknown } | null = null;
    component.configChange.subscribe(val => {
      emitted = val;
    });

    component.applyRcPreset('vfs/forget');
    expect(emitted).toEqual({ key: 'command', value: 'vfs/forget' });
  });

  describe('RC command params handling', () => {
    it('returns empty string when params is null, undefined, or empty object', () => {
      fixture.componentRef.setInput('nodeConfig', {});
      expect(component.getRcParamsJson()).toBe('');

      fixture.componentRef.setInput('nodeConfig', { params: null });
      expect(component.getRcParamsJson()).toBe('');

      fixture.componentRef.setInput('nodeConfig', { params: {} });
      expect(component.getRcParamsJson()).toBe('');
    });

    it('formats object params as JSON string', () => {
      fixture.componentRef.setInput('nodeConfig', { params: { fs: 'remote:' } });
      expect(component.getRcParamsJson()).toBe(JSON.stringify({ fs: 'remote:' }, null, 2));
    });

    it('returns string params directly', () => {
      fixture.componentRef.setInput('nodeConfig', { params: '{"fs":"test"}' });
      expect(component.getRcParamsJson()).toBe('{"fs":"test"}');
    });

    it('emits empty object when params input is empty or whitespace', () => {
      let emitted: { key: string; value: unknown } | null = null;
      component.configChange.subscribe(val => {
        emitted = val;
      });

      component.onRcParamsChange('   ');
      expect(emitted).toEqual({ key: 'params', value: {} });
    });

    it('emits parsed object when valid JSON object string is entered', () => {
      let emitted: { key: string; value: unknown } | null = null;
      component.configChange.subscribe(val => {
        emitted = val;
      });

      component.onRcParamsChange('{"fs": "myremote:"}');
      expect(emitted).toEqual({ key: 'params', value: { fs: 'myremote:' } });
    });

    it('emits raw string when input contains template tokens or invalid JSON', () => {
      let emitted: { key: string; value: unknown } | null = null;
      component.configChange.subscribe(val => {
        emitted = val;
      });

      component.onRcParamsChange('{{nodes.node1.data}}');
      expect(emitted).toEqual({ key: 'params', value: '{{nodes.node1.data}}' });
    });

    it('validates jsonStatus for valid, invalid, and template JSON', () => {
      fixture.componentRef.setInput('nodeConfig', { params: {} });
      expect(component.jsonStatus().valid).toBe(true);

      fixture.componentRef.setInput('nodeConfig', { params: '{"valid": true}' });
      expect(component.jsonStatus().valid).toBe(true);
      expect(component.jsonStatus().isTemplate).toBe(false);

      fixture.componentRef.setInput('nodeConfig', { params: '{"fs": "{{nodes.n1.remote}}"}' });
      expect(component.jsonStatus().valid).toBe(true);
      expect(component.jsonStatus().isTemplate).toBe(true);

      fixture.componentRef.setInput('nodeConfig', { params: '{broken json' });
      expect(component.jsonStatus().valid).toBe(false);
    });

    it('formats and clears params', () => {
      const emittedList: { key: string; value: unknown }[] = [];
      component.configChange.subscribe(val => {
        emittedList.push(val);
      });

      fixture.componentRef.setInput('nodeConfig', { params: '{"fs":"test"}' });
      component.formatJson();
      expect(emittedList).toContainEqual({ key: 'params', value: { fs: 'test' } });

      component.clearParams();
      expect(emittedList).toContainEqual({ key: 'params', value: {} });
    });

    it('inserts token when params is empty', () => {
      let emitted: { key: string; value: unknown } | null = null;
      component.configChange.subscribe(val => {
        emitted = val;
      });

      fixture.componentRef.setInput('nodeConfig', { params: {} });
      component.insertToken('{{nodes.mount-1.mountPoint}}');
      expect(emitted).toEqual({
        key: 'params',
        value: { fs: '{{nodes.mount-1.mountPoint}}' },
      });
    });

    it('returns appropriate fields for node types in getNodeFieldsForType', () => {
      const mountFields = component.getNodeFieldsForType('mount');
      expect(mountFields.map(f => f.key)).toContain('mountPoint');
      expect(mountFields.map(f => f.key)).toContain('remote');

      const syncFields = component.getNodeFieldsForType('sync');
      expect(syncFields.map(f => f.key)).toContain('bytesTransferred');

      const cmdFields = component.getNodeFieldsForType('command');
      expect(cmdFields.map(f => f.key)).toContain('stdout');

      const scriptFields = component.getNodeFieldsForType('exec_script');
      expect(scriptFields.map(f => f.key)).toContain('stdout');
      expect(scriptFields.map(f => f.key)).toContain('exitCode');
    });

    it('populates defaultParams when applying preset to empty params and resolves first remote', () => {
      const emittedList: { key: string; value: unknown }[] = [];
      component.configChange.subscribe(val => {
        emittedList.push(val);
      });

      fixture.componentRef.setInput('nodeConfig', { params: {} });
      fixture.componentRef.setInput('remotes', [{ name: 'mygdrive', type: 'drive' }]);

      component.applyRcPreset('operations/cleanup', { fs: 'remote:' });
      expect(emittedList).toContainEqual({ key: 'command', value: 'operations/cleanup' });
      expect(emittedList).toContainEqual({ key: 'params', value: { fs: 'mygdrive:' } });
    });

    it('filters presets by category correctly', () => {
      component.setPresetCategory('all');
      expect(component.filteredPresets().length).toBe(component.rcPresets.length);

      component.setPresetCategory('vfs');
      expect(component.filteredPresets().every(p => p.category === 'vfs')).toBe(true);
      expect(component.filteredPresets().map(p => p.command)).toContain('vfs/refresh');

      component.setPresetCategory('ops');
      expect(component.filteredPresets().every(p => p.category === 'ops')).toBe(true);
      expect(component.filteredPresets().map(p => p.command)).toContain('operations/cleanup');

      component.setPresetCategory('core');
      expect(component.filteredPresets().every(p => p.category === 'core')).toBe(true);
      expect(component.filteredPresets().map(p => p.command)).toContain('core/bwlimit');
    });
  });
});
