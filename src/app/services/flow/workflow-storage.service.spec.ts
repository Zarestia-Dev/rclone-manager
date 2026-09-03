import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { WorkflowStorageService } from './workflow-storage.service';
import { ApiClientService } from '../infrastructure/platform/api-client.service';
import { WorkflowDefinition } from '../../flow/workflow/types/workflow.types';
import { provideTranslateService } from '@ngx-translate/core';
import { NotificationService } from '../ui/notification.service';

describe('WorkflowStorageService', () => {
  let service: WorkflowStorageService;
  let mockApiClient: {
    invoke: ReturnType<typeof vi.fn>;
  };
  let backendWorkflows: WorkflowDefinition[] = [];

  beforeEach(() => {
    backendWorkflows = [];

    mockApiClient = {
      invoke: vi.fn().mockImplementation((command: string, args?: Record<string, unknown>) => {
        if (command === 'list_workflows') {
          return Promise.resolve([...backendWorkflows]);
        }
        if (command === 'create_workflow') {
          const wf = args?.['workflow'] as WorkflowDefinition;
          const created = { ...wf, id: wf.id || `wf-${Date.now()}` };
          backendWorkflows.push(created);
          return Promise.resolve(created);
        }
        if (command === 'update_workflow') {
          const wf = args?.['workflow'] as WorkflowDefinition;
          const idx = backendWorkflows.findIndex(w => w.id === wf.id);
          if (idx >= 0) backendWorkflows[idx] = wf;
          else backendWorkflows.push(wf);
          return Promise.resolve(wf);
        }
        if (command === 'delete_workflow') {
          const id = args?.['workflowId'] as string;
          backendWorkflows = backendWorkflows.filter(w => w.id !== id);
          return Promise.resolve();
        }
        if (command === 'duplicate_workflow') {
          const id = args?.['workflowId'] as string;
          const src = backendWorkflows.find(w => w.id === id);
          const copy = {
            ...(src || ({} as WorkflowDefinition)),
            id: `wf-dup-${Date.now()}`,
            name: `${src?.name || ''} (Copy)`,
          };
          backendWorkflows.push(copy);
          return Promise.resolve(copy);
        }
        if (command === 'export_workflow') {
          const id = args?.['workflowId'] as string;
          const src = backendWorkflows.find(w => w.id === id);
          return Promise.resolve(JSON.stringify(src, null, 2));
        }
        if (command === 'import_workflow') {
          const jsonStr = args?.['jsonStr'] as string;
          const parsed = JSON.parse(jsonStr);
          const imported = {
            ...parsed,
            id: `wf-imp-${Date.now()}`,
            name: `${parsed.name} (Imported)`,
          };
          backendWorkflows.push(imported);
          return Promise.resolve(imported);
        }
        return Promise.resolve(null);
      }),
    };

    TestBed.configureTestingModule({
      providers: [
        provideTranslateService(),
        WorkflowStorageService,
        { provide: ApiClientService, useValue: mockApiClient },
      ],
    });
    service = TestBed.inject(WorkflowStorageService);
  });

  it('loads templates and provides preset templates', () => {
    const templates = service.getPresetTemplates();
    expect(templates.length).toBeGreaterThan(0);
    expect(templates[0].name).toContain('Daily Backup');
  });

  it('saves and updates a workflow via backend', async () => {
    const wf: WorkflowDefinition = {
      id: 'custom-wf',
      name: 'Custom Flow',
      nodes: [],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    };

    await service.saveWorkflow(wf);
    expect(service.workflows().some(w => w.id === 'custom-wf')).toBe(true);

    const updated = await service.saveWorkflow({ ...wf, name: 'Custom Flow 2' });
    expect(updated.name).toBe('Custom Flow 2');
    expect(service.workflows().find(w => w.id === 'custom-wf')?.name).toBe('Custom Flow 2');
  });

  it('deletes a workflow via backend', async () => {
    const wf: WorkflowDefinition = {
      id: 'to-delete',
      name: 'Delete Me',
      nodes: [],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    };
    await service.saveWorkflow(wf);
    expect(service.workflows().some(w => w.id === 'to-delete')).toBe(true);

    await service.deleteWorkflow('to-delete');
    expect(service.workflows().some(w => w.id === 'to-delete')).toBe(false);
  });

  it('duplicates an existing workflow with a unique name', async () => {
    const wf: WorkflowDefinition = {
      id: 'orig-wf',
      name: 'Original Flow',
      nodes: [],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    };
    await service.saveWorkflow(wf);
    const duplicated = await service.duplicateWorkflow('orig-wf');

    expect(duplicated).not.toBeNull();
    expect(duplicated?.id).not.toBe('orig-wf');
    expect(duplicated?.name).toBe('Original Flow (Copy)');
  });

  it('exports and imports workflow JSON correctly', async () => {
    const wf: WorkflowDefinition = {
      id: 'export-wf',
      name: 'Exportable Flow',
      nodes: [
        {
          id: 'n1',
          type: 'manual',
          category: 'trigger',
          title: 'T',
          x: 0,
          y: 0,
          inputs: [],
          outputs: [],
          config: {},
        },
      ],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    };

    await service.saveWorkflow(wf);
    const json = await service.exportWorkflowJson(wf);
    expect(json).toContain('Exportable Flow');

    const imported = await service.importWorkflowJson(json);
    expect(imported.name).toContain('Exportable Flow (Imported)');
    expect(imported.nodes.length).toBe(1);
  });

  it('cleans duplicate workflows with the same name', async () => {
    backendWorkflows.length = 0;
    backendWorkflows.push(
      {
        id: 'dup-1',
        name: 'Daily Backup',
        nodes: [],
        edges: [],
        viewport: { x: 0, y: 0, zoom: 1 },
      },
      {
        id: 'dup-2',
        name: 'Daily Backup',
        nodes: [],
        edges: [],
        viewport: { x: 0, y: 0, zoom: 1 },
      },
      { id: 'dup-3', name: 'Other Flow', nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } }
    );
    await service.loadAllWorkflows();
    expect(service.workflows().length).toBe(3);

    const removed = await service.cleanDuplicates();
    expect(removed).toBe(1);
    expect(service.workflows().length).toBe(2);
  });

  it('duplicateWorkflowWithFeedback duplicates and loads workflow into state', async () => {
    const wf: WorkflowDefinition = {
      id: 'wf-orig',
      name: 'Original Flow',
      nodes: [],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    };
    await service.saveWorkflow(wf);

    const dup = await service.duplicateWorkflowWithFeedback('wf-orig');
    expect(dup).not.toBeNull();
    expect(dup?.name).toContain('Original Flow (Copy)');
  });

  it('promptAndDeleteWorkflow deletes when confirmed', async () => {
    const wf: WorkflowDefinition = {
      id: 'wf-del',
      name: 'To Delete',
      nodes: [],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    };
    await service.saveWorkflow(wf);
    expect(service.workflows().some(w => w.id === 'wf-del')).toBe(true);

    const notificationService = TestBed.inject(NotificationService);
    vi.spyOn(notificationService, 'confirmModal').mockResolvedValue(true);

    const result = await service.promptAndDeleteWorkflow('wf-del');
    expect(result).toBe(true);
    expect(service.workflows().some(w => w.id === 'wf-del')).toBe(false);
  });

  it('promptAndDeleteWorkflow aborts when not confirmed', async () => {
    const wf: WorkflowDefinition = {
      id: 'wf-keep',
      name: 'To Keep',
      nodes: [],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    };
    await service.saveWorkflow(wf);

    const notificationService = TestBed.inject(NotificationService);
    vi.spyOn(notificationService, 'confirmModal').mockResolvedValue(false);

    const result = await service.promptAndDeleteWorkflow('wf-keep');
    expect(result).toBe(false);
    expect(service.workflows().some(w => w.id === 'wf-keep')).toBe(true);
  });
});
