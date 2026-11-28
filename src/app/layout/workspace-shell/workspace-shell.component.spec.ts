import { Component, CUSTOM_ELEMENTS_SCHEMA } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideTranslateService, TranslateService } from '@ngx-translate/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceShellComponent } from './workspace-shell.component';

@Component({
  imports: [WorkspaceShellComponent],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  template: `
    <app-workspace-shell>
      <app-titlebar>Header</app-titlebar>
      <app-banner>Banner</app-banner>
      <app-tabs>
        <button type="button" class="tab-btn">General</button>
        <button type="button" class="tab-btn selected">Mount</button>
      </app-tabs>
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
    TestBed.configureTestingModule({
      imports: [TestHostComponent],
      providers: [provideTranslateService()],
    });
    const translate = TestBed.inject(TranslateService);
    translate.setTranslation('en', {
      overviews: { headers: { general: 'RClone Manager' } },
      titlebar: { skipToNavigation: 'Skip to navigation' },
    });
    translate.use('en');
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

  it('gives screen readers a main landmark and a page heading', () => {
    const main: HTMLElement | null = fixture.nativeElement.querySelector('main.workspace-content');
    expect(main?.querySelector('.workspace-scroll-region')).not.toBeNull();
    const heading = main?.querySelector('h1');
    expect(heading?.textContent?.trim()).toBe('RClone Manager');
    expect(heading?.classList.contains('cdk-visually-hidden')).toBe(true);
    // The titlebar and the navigation stay outside the main landmark.
    expect(main?.querySelector('app-titlebar, app-tabs')).toBeNull();
  });

  it('offers keyboard users a skip to the view tabs before the content', () => {
    const shell: HTMLElement = fixture.nativeElement.querySelector('app-workspace-shell');
    const skip = shell.firstElementChild as HTMLButtonElement;
    expect(skip.matches('button.skip-to-navigation')).toBe(true);
    expect(skip.textContent?.trim()).toBe('Skip to navigation');

    skip.click();
    expect(document.activeElement?.textContent).toBe('Mount');
  });

  it('skips to the first view tab when none is selected', () => {
    const shell: HTMLElement = fixture.nativeElement.querySelector('app-workspace-shell');
    shell.querySelector('.selected')?.classList.remove('selected');
    (shell.querySelector('.skip-to-navigation') as HTMLButtonElement).click();
    expect(document.activeElement?.textContent).toBe('General');
  });

  it('disconnects the observer when the workspace is destroyed', () => {
    fixture.destroy();
    expect(disconnect).toHaveBeenCalledOnce();
  });
});
