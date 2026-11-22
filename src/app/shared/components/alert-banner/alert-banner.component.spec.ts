import { TestBed } from '@angular/core/testing';
import { Component, ComponentRef } from '@angular/core';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { provideTranslateService } from '@ngx-translate/core';
import { AlertBannerComponent } from './alert-banner.component';

describe('AlertBannerComponent', () => {
  let component: AlertBannerComponent;
  let componentRef: ComponentRef<AlertBannerComponent>;
  let fixture: ReturnType<typeof TestBed.createComponent<AlertBannerComponent>>;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [AlertBannerComponent],
      providers: [provideTranslateService()],
    });

    fixture = TestBed.createComponent(AlertBannerComponent);
    component = fixture.componentInstance;
    componentRef = fixture.componentRef;
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should resolve default icons based on severity', () => {
    componentRef.setInput('severity', 'warning');
    expect(component.resolvedIcon()).toBe('warning');

    componentRef.setInput('severity', 'info');
    expect(component.resolvedIcon()).toBe('circle-info');

    componentRef.setInput('severity', 'error');
    expect(component.resolvedIcon()).toBe('circle-xmark');

    componentRef.setInput('severity', 'success');
    expect(component.resolvedIcon()).toBe('check-circle');

    componentRef.setInput('severity', 'dim');
    expect(component.resolvedIcon()).toBe('circle-info');
  });

  it('should prioritize custom icon over severity icon', () => {
    componentRef.setInput('severity', 'warning');
    componentRef.setInput('icon', 'hard-drive');
    expect(component.resolvedIcon()).toBe('hard-drive');
  });

  it('should not render dismiss button when dismissable is false', () => {
    componentRef.setInput('dismissable', false);
    fixture.detectChanges();

    const button = fixture.nativeElement.querySelector('.dismiss-button');
    expect(button).toBeNull();
  });

  it('should render dismiss button and emit dismiss event on click when dismissable is true', () => {
    componentRef.setInput('dismissable', true);
    componentRef.setInput('dismissTooltip', 'Close this');
    fixture.detectChanges();

    const button = fixture.nativeElement.querySelector('.dismiss-button') as HTMLButtonElement;
    expect(button).not.toBeNull();
    expect(button.getAttribute('title')).toBe('Close this');

    const emitSpy = vi.spyOn(component.dismiss, 'emit');
    button.click();
    expect(emitSpy).toHaveBeenCalledTimes(1);
  });

  it('puts a button marked bannerAction in the actions slot, and the others in the text', () => {
    @Component({
      imports: [AlertBannerComponent],
      template: `
        <app-alert-banner title="t">
          <button class="inline">a</button>
          <button class="action" bannerAction>b</button>
        </app-alert-banner>
      `,
    })
    class HostComponent {}

    const host = TestBed.createComponent(HostComponent);
    host.detectChanges();
    const el = host.nativeElement as HTMLElement;
    expect(el.querySelector('.alert-actions .action')).not.toBeNull();
    expect(el.querySelector('.alert-actions .inline')).toBeNull();
    expect(el.querySelector('.alert-content .inline')).not.toBeNull();
  });

  it('leaves the actions slot empty, so it takes no room, when there is no action', () => {
    fixture.detectChanges();
    const actions = (fixture.nativeElement as HTMLElement).querySelector('.alert-actions');
    expect(actions?.childElementCount).toBe(0);
  });
});
