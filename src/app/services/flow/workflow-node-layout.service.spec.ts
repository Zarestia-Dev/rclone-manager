import { describe, it, expect, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { WorkflowNodeLayoutService, portKey } from './workflow-node-layout.service';
import { NodeLayout, WorkflowNode } from '../../flow/workflow/types/workflow.types';
import { DEFAULT_NODE_HEIGHT, NODE_WIDTH } from '../../flow/workflow/constants/workflow.constants';

const node = { id: 'n1', x: 100, y: 50 } as WorkflowNode;

const layout = (overrides: Partial<NodeLayout> = {}): NodeLayout => ({
  width: 240,
  height: 130,
  ports: {
    [portKey('in', false)]: { x: 0, y: 100 },
    [portKey('success', true)]: { x: 240, y: 100 },
  },
  ...overrides,
});

describe('WorkflowNodeLayoutService', () => {
  let service: WorkflowNodeLayoutService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(WorkflowNodeLayoutService);
  });

  it('keeps an input and an output with the same id apart', () => {
    expect(portKey('x', false)).not.toBe(portKey('x', true));
  });

  it('places a port at the node position plus the measured offset', () => {
    service.set('n1', layout());
    expect(service.portPosition(node, 'in', false)).toEqual({ x: 100, y: 150 });
    expect(service.portPosition(node, 'success', true)).toEqual({ x: 340, y: 150 });
  });

  it('follows the node when it moves, without a new measurement', () => {
    service.set('n1', layout());
    expect(service.portPosition({ ...node, x: 0, y: 0 }, 'in', false)).toEqual({ x: 0, y: 100 });
  });

  it('has no position for an unmeasured node, a missing node or an unknown port', () => {
    expect(service.portPosition(node, 'in', false)).toBeNull();
    expect(service.portPosition(undefined, 'in', false)).toBeNull();
    service.set('n1', layout());
    expect(service.portPosition(node, 'nope', true)).toBeNull();
    expect(service.portPosition(node, 'in', true)).toBeNull();
  });

  it('falls back to the default size until a node is measured', () => {
    expect(service.sizeOf('n1')).toEqual({ width: NODE_WIDTH, height: DEFAULT_NODE_HEIGHT });
    service.set('n1', layout({ width: 260, height: 180 }));
    expect(service.sizeOf('n1')).toEqual({ width: 260, height: 180 });
  });

  it('does not publish an identical measurement again', () => {
    service.set('n1', layout());
    const before = service.layoutOf('n1');
    service.set('n1', layout());
    expect(service.layoutOf('n1')).toBe(before);
    service.set('n1', layout({ height: 131 }));
    expect(service.layoutOf('n1')).not.toBe(before);
  });

  it('publishes a port that moved', () => {
    service.set('n1', layout());
    const before = service.layoutOf('n1');
    service.set('n1', layout({ ports: { [portKey('in', false)]: { x: 0, y: 110 } } }));
    expect(service.layoutOf('n1')).not.toBe(before);
    expect(service.portPosition(node, 'success', true)).toBeNull();
  });

  it('forgets a removed node and ignores an unknown one', () => {
    service.set('n1', layout());
    service.remove('n1');
    expect(service.portPosition(node, 'in', false)).toBeNull();
    service.remove('n1');
    expect(service.layoutOf('n1')).toBeUndefined();
    service.remove('n1');
    expect(service.layoutOf('n1')).toBeUndefined();
  });
});
