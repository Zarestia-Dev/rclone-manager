import { Injectable, signal } from '@angular/core';
import { NodeLayout, WorkflowNode } from '../../flow/workflow/types/workflow.types';
import { DEFAULT_NODE_HEIGHT, NODE_WIDTH } from '../../flow/workflow/constants/workflow.constants';

/** Key of a port in `NodeLayout.ports`: an input and an output may share an id. */
export function portKey(portId: string, isOutput: boolean): string {
  return `${isOutput ? 'out' : 'in'}:${portId}`;
}

/**
 * What the browser measured of each node on the canvas. Nodes size themselves from their content;
 * wires, the minimap and fit-to-view read the result here instead of assuming a size.
 */
@Injectable({ providedIn: 'root' })
export class WorkflowNodeLayoutService {
  private readonly _layouts = signal<ReadonlyMap<string, NodeLayout>>(new Map());

  /** The last measurement of a node, if it has been drawn. */
  layoutOf(nodeId: string): NodeLayout | undefined {
    return this._layouts().get(nodeId);
  }

  /** Records a measurement; nothing changes (and nothing recomputes) when it equals the last one. */
  set(nodeId: string, layout: NodeLayout): void {
    const current = this.layoutOf(nodeId);
    if (current && sameLayout(current, layout)) return;
    this._layouts.update(map => new Map(map).set(nodeId, layout));
  }

  remove(nodeId: string): void {
    if (!this._layouts().has(nodeId)) return;
    this._layouts.update(map => {
      const next = new Map(map);
      next.delete(nodeId);
      return next;
    });
  }

  /** Size of a node; before it is measured, the width its style gives and a typical height. */
  sizeOf(nodeId: string): { width: number; height: number } {
    const layout = this.layoutOf(nodeId);
    return layout
      ? { width: layout.width, height: layout.height }
      : { width: NODE_WIDTH, height: DEFAULT_NODE_HEIGHT };
  }

  /** Canvas position of a port's centre, or null while its node has not been measured. */
  portPosition(
    node: WorkflowNode | undefined,
    portId: string,
    isOutput: boolean
  ): { x: number; y: number } | null {
    if (!node) return null;
    const port = this.layoutOf(node.id)?.ports[portKey(portId, isOutput)];
    return port ? { x: node.x + port.x, y: node.y + port.y } : null;
  }
}

function sameLayout(a: NodeLayout, b: NodeLayout): boolean {
  if (a.width !== b.width || a.height !== b.height) return false;
  const keys = Object.keys(b.ports);
  if (keys.length !== Object.keys(a.ports).length) return false;
  return keys.every(key => {
    const before = a.ports[key];
    const after = b.ports[key];
    return !!before && before.x === after.x && before.y === after.y;
  });
}
