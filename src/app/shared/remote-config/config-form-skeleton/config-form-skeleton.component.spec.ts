import { TestBed } from '@angular/core/testing';
import { provideTranslateService } from '@ngx-translate/core';
import { describe, expect, it } from 'vitest';
import { ConfigFormSkeletonComponent } from './config-form-skeleton.component';

describe('configuration skeleton layout', () => {
  it('uses a single selection placeholder and labels its loading status', () => {
    TestBed.configureTestingModule({ providers: [provideTranslateService()] });
    const fixture = TestBed.createComponent(ConfigFormSkeletonComponent);
    fixture.componentRef.setInput('variant', 'selection');
    fixture.componentRef.setInput('label', 'Loading providers');
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelectorAll('.skeleton-form-row')).toHaveLength(1);
    expect(element.querySelector('[role="status"]')?.getAttribute('aria-label')).toBe(
      'Loading providers'
    );
  });

  it('renders the requested number of fields with a nonempty fallback', () => {
    TestBed.configureTestingModule({ providers: [provideTranslateService()] });
    const fixture = TestBed.createComponent(ConfigFormSkeletonComponent);
    fixture.componentRef.setInput('fieldCount', 2);
    fixture.detectChanges();
    expect(fixture.componentInstance.rows()).toEqual([0, 1]);
    fixture.componentRef.setInput('fieldCount', 0);
    fixture.detectChanges();
    expect(fixture.componentInstance.rows()).toEqual([0]);
  });
});
