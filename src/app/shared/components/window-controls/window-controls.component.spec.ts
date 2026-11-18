import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { WindowControlsComponent } from './window-controls.component';
import { UiStateService } from 'src/app/services/ui/state/ui-state.service';
import { WindowService } from 'src/app/services/ui/window.service';
import { DEFAULT_WINDOW_BUTTON_LAYOUT, WindowButtonLayout } from 'src/app/shared/utils';

describe('WindowControlsComponent', () => {
  const setup = (
    layout: WindowButtonLayout,
    side?: 'start' | 'end'
  ): { component: WindowControlsComponent; windowService: Record<string, unknown> } => {
    const windowService = {
      buttonLayout: signal(layout),
      isMaximized: signal(false),
      minimize: vi.fn().mockResolvedValue(undefined),
      maximize: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    TestBed.configureTestingModule({
      providers: [
        { provide: WindowService, useValue: windowService },
        { provide: UiStateService, useValue: { platform: 'linux' } },
      ],
    });
    const fixture = TestBed.createComponent(WindowControlsComponent);
    if (side) fixture.componentRef.setInput('side', side);
    return { component: fixture.componentInstance, windowService };
  };

  it('shows minimize, maximize and close at the end by default', () => {
    const { component } = setup(DEFAULT_WINDOW_BUTTON_LAYOUT);
    expect(component.controls().map(control => control.label)).toEqual([
      'titlebar.minimize',
      'titlebar.maximize',
      'titlebar.close',
    ]);
  });

  it('shows only the buttons the layout puts on its side, in that order', () => {
    const layout: WindowButtonLayout = { start: ['close', 'maximize'], end: [] };
    expect(
      setup(layout, 'start')
        .component.controls()
        .map(control => control.icon)
    ).toEqual(['close', 'expand']);
    TestBed.resetTestingModule();
    expect(setup(layout, 'end').component.controls()).toEqual([]);
  });

  it('runs the window action of each button', async () => {
    const { component, windowService } = setup({ start: [], end: ['close'] });
    await component.controls()[0].action();
    expect(windowService['close']).toHaveBeenCalled();
  });
});
