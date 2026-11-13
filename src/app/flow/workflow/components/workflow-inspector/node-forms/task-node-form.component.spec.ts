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

  it('identifies operation nodes with detailed config and renders summary card', () => {
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

  it('reads the archive format and prefix from the rclone settings, with zip as the default', () => {
    const archiveNode: WorkflowNode = {
      ...mockNode,
      id: 'node-archive-1',
      type: 'archivecreate',
      title: 'Archive Node',
    };
    fixture.componentRef.setInput('node', archiveNode);
    expect(component.archiveFormat()).toBe('zip');
    expect(component.archivePrefix()).toBe('');

    fixture.componentRef.setInput('rcloneConfig', { format: 'tar.gz', prefix: 'backup-folder' });
    fixture.detectChanges();

    expect(component.archiveFormat()).toBe('tar.gz');
    expect(component.archivePrefix()).toBe('backup-folder');
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('TAR.GZ');
  });

  it('treats a download as named after the file unless autoFilename is off', () => {
    expect(component.autoFilename()).toBe(true);
    fixture.componentRef.setInput('rcloneConfig', { url: 'https://example.com/f.zip' });
    expect(component.autoFilename()).toBe(true);
    fixture.componentRef.setInput('rcloneConfig', { autoFilename: false });
    expect(component.autoFilename()).toBe(false);
  });

  it('computes rcParamCount correctly for empty, object, and string configs', () => {
    fixture.componentRef.setInput('nodeConfig', {});
    expect(component.rcParamCount()).toBe(0);

    fixture.componentRef.setInput('nodeConfig', { params: null });
    expect(component.rcParamCount()).toBe(0);

    fixture.componentRef.setInput('nodeConfig', { params: { fs: 'remote:', dryRun: true } });
    expect(component.rcParamCount()).toBe(2);

    fixture.componentRef.setInput('nodeConfig', { params: 'raw string param' });
    expect(component.rcParamCount()).toBe(1);

    fixture.componentRef.setInput('nodeConfig', { params: '' });
    expect(component.rcParamCount()).toBe(0);
  });

  it('emits configChange via onFieldChange', () => {
    let emitted: { key: string; value: unknown } | null = null;
    component.configChange.subscribe(val => {
      emitted = val;
    });

    component.onFieldChange('command', 'vfs/refresh');
    expect(emitted).toEqual({ key: 'command', value: 'vfs/refresh' });
  });
});
