import { Component, CUSTOM_ELEMENTS_SCHEMA } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceShellComponent } from './workspace-shell.component';

@Component({
  imports: [WorkspaceShellComponent],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  template: `
    <app-workspace-shell>
      <app-titlebar>Header</app-titlebar>
      <app-banner>Banner</app-banner>
      <app-tabs>Navigation</app-tabs>
      <div class="workspace-scroll-region">Content</div>
    </app-workspace-shell>
  `,
})
class TestHostComponent {}

describe('WorkspaceShellComponent', () => {
  let fixture: ComponentFixture<TestHostComponent>;
  let callback: ResizeObserverCallback;
  let observe: ReturnType<typeof vi.fn>;
  let disconnect: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    observe = vi.fn();
    disconnect = vi.fn();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(onResize: ResizeObserverCallback) {
          callback = onResize;
        }
        observe = observe;
        disconnect = disconnect;
      }
    );
    TestBed.configureTestingModule({ imports: [TestHostComponent] });
    fixture = TestBed.createComponent(TestHostComponent);
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
    vi.unstubAllGlobals();
  });

  function resize(height: number): string {
    const shell: HTMLElement = fixture.nativeElement.querySelector('app-workspace-shell');
    const navigation = shell.querySelector('.workspace-navigation') as HTMLElement;
    vi.spyOn(navigation, 'getBoundingClientRect').mockReturnValue({ height } as DOMRect);
    callback([], {} as ResizeObserver);
    return shell.style.getPropertyValue('--workspace-navigation-clearance');
  }

  it('observes the navigation rather than shortening the content viewport', () => {
    expect(observe).toHaveBeenCalledWith(
      fixture.nativeElement.querySelector('.workspace-navigation')
    );
    const content = fixture.nativeElement.querySelector('.workspace-content');
    expect(content.querySelector('.workspace-scroll-region')).not.toBeNull();
    expect(content.style.height).toBe('');
  });

  it('projects the titlebar, banner and floating navigation outside the content viewport', () => {
    const shell: HTMLElement = fixture.nativeElement.querySelector('app-workspace-shell');
    expect(shell.querySelector(':scope > app-titlebar')).not.toBeNull();
    expect(shell.querySelector(':scope > app-banner')).not.toBeNull();
    expect(shell.querySelector('.workspace-navigation > app-tabs')).not.toBeNull();
    expect(shell.querySelector('.workspace-content app-tabs')).toBeNull();
  });

  it('updates clearance when translations, font size or safe-area gutters change', () => {
    expect(resize(96)).toBe('96px');
    expect(resize(137.5)).toBe('137.5px');
  });

  it('removes clearance for hidden navigation and restores it when shown', () => {
    expect(resize(104)).toBe('104px');
    expect(resize(0)).toBe('0px');
    expect(resize(104)).toBe('104px');
  });

  it('disconnects the observer when the workspace is destroyed', () => {
    fixture.destroy();
    expect(disconnect).toHaveBeenCalledOnce();
  });
});
