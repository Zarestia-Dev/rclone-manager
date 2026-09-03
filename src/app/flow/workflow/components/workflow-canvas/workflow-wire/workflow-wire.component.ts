import { Component, ChangeDetectionStrategy, input, output, computed } from '@angular/core';
import { WorkflowEdge } from '../../../types/workflow.types';
import { generateCubicBezierPath, getCubicBezierMidpoint } from '../../../utils/bezier.util';

@Component({
  // eslint-disable-next-line @angular-eslint/component-selector
  selector: '[app-workflow-wire], g[app-workflow-wire]',
  imports: [],
  templateUrl: './workflow-wire.component.html',
  styleUrl: './workflow-wire.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WorkflowWireComponent {
  readonly edge = input.required<WorkflowEdge>();
  readonly sourcePos = input.required<{ x: number; y: number }>();
  readonly targetPos = input.required<{ x: number; y: number }>();
  readonly isSelected = input<boolean>(false);
  readonly isActive = input<boolean>(false);

  readonly selectWire = output<string>();
  readonly removeWire = output<string>();

  readonly pathD = computed(() => {
    const s = this.sourcePos();
    const t = this.targetPos();
    return generateCubicBezierPath(s.x, s.y, t.x, t.y);
  });

  readonly midpoint = computed(() => {
    const s = this.sourcePos();
    const t = this.targetPos();
    return getCubicBezierMidpoint(s.x, s.y, t.x, t.y);
  });

  onSelect(event: MouseEvent): void {
    event.stopPropagation();
    this.selectWire.emit(this.edge().id);
  }

  onRemove(event: MouseEvent): void {
    event.stopPropagation();
    this.removeWire.emit(this.edge().id);
  }
}
