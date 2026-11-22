import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import type { FlowDirection } from 'src/app/shared/utils/wizard.util';
import { FlowNode, WizardFlowDiagramComponent } from './flow-diagram.component';

const FROM: FlowNode = {
  icon: 'desktop',
  title: 'This computer',
  text: '/home/me/…',
  hint: '/home/me/Docs',
};
const TO: FlowNode = { icon: 'cloud', title: 'drive', text: 'Whole cloud' };

@Component({
  imports: [WizardFlowDiagramComponent],
  template: `<app-wizard-flow-diagram [from]="from" [to]="to" [direction]="direction"
    ><span class="caption">Backup</span></app-wizard-flow-diagram
  >`,
})
class HostComponent {
  from = FROM;
  to = TO;
  direction: FlowDirection = 'right';
}

describe('WizardFlowDiagramComponent', () => {
  const render = (direction: FlowDirection): HTMLElement => {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.componentInstance.direction = direction;
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  };

  it('names both places and keeps the full path for a title attribute', () => {
    const el = render('right');
    const nodes = el.querySelectorAll('.node');
    expect(nodes).toHaveLength(2);
    expect(nodes[0].querySelector('strong')?.textContent).toBe('This computer');
    expect(nodes[0].querySelector('.text')?.getAttribute('title')).toBe('/home/me/Docs');
    expect(nodes[1].querySelector('.text')?.hasAttribute('title')).toBe(false);
    expect(el.querySelector('.label .caption')?.textContent).toBe('Backup');
    // Only a real path is set in mono; a name such as "Whole cloud" is plain text.
    expect(nodes[0].querySelector('.text')?.classList.contains('path')).toBe(true);
    expect(nodes[1].querySelector('.text')?.classList.contains('path')).toBe(false);
  });

  it('is only a picture for assistive technology', () => {
    const el = render('right');
    expect(el.querySelector('.arrow')?.getAttribute('aria-hidden')).toBe('true');
  });

  it.each([
    ['right', 1, 2],
    ['left', 1, 2],
    ['both', 2, 2],
    ['link', 2, 1],
    ['broadcast', 0, 0],
    ['none', 0, 0],
  ] as const)('draws %s with %i heads and %i dots', (direction, heads, packets) => {
    const el = render(direction);
    expect(el.querySelectorAll('.head')).toHaveLength(heads);
    expect(el.querySelectorAll('.packet')).toHaveLength(packets);
  });

  it('spreads rings from the machine that serves, and breathes when it only looks', () => {
    expect(render('broadcast').querySelectorAll('.ring')).toHaveLength(2);
    TestBed.resetTestingModule();
    expect(render('none').querySelector('.pulse')).not.toBeNull();
  });
});
