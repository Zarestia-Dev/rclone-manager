import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideTranslateService } from '@ngx-translate/core';
import { NotificationService } from '../../../services/ui/notification.service';
import { MASK } from '../../utils/rc/rc-output.util';
import { RcOutputComponent } from './rc-output.component';

describe('RcOutputComponent', () => {
  let fixture: ComponentFixture<RcOutputComponent>;
  let component: RcOutputComponent;

  const show = (body: unknown, mask = true): void => {
    fixture.componentRef.setInput('body', body);
    fixture.componentRef.setInput('mask', mask);
    fixture.detectChanges();
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [RcOutputComponent],
      providers: [provideTranslateService(), { provide: NotificationService, useValue: {} }],
    }).compileComponents();
    fixture = TestBed.createComponent(RcOutputComponent);
    component = fixture.componentInstance;
  });

  it('pretty-prints and colours JSON, and the raw view is compact', () => {
    show({ a: 1, b: 'x' });
    expect(component.text()).toBe('{\n  "a": 1,\n  "b": "x"\n}');
    expect(fixture.nativeElement.querySelector('.tok-key')).not.toBeNull();

    component.setView('raw');
    expect(component.text()).toBe('{"a":1,"b":"x"}');
  });

  it('shows a plain string as it is', () => {
    show('hello\nworld');
    expect(component.text()).toBe('hello\nworld');
    expect(fixture.nativeElement.querySelector('.tok-key')).toBeNull();
  });

  it('folds a long output after 16 lines and unfolds it', () => {
    show({ list: Array.from({ length: 40 }, (_, i) => i) });
    expect(component.canFold()).toBe(true);
    const lines = (): number =>
      fixture.nativeElement.querySelector('pre').textContent.split('\n').length;
    expect(lines()).toBe(16);

    component.toggleExpanded();
    fixture.detectChanges();
    expect(lines()).toBe(component.lineCount());
    expect(component.text().split('\n')).toHaveLength(component.lineCount());
  });

  it('cuts text beyond the display limit but still copies all of it', () => {
    show('x'.repeat(150_000));
    expect(component.cutByLimit()).toBe(true);
    expect(component.canFold()).toBe(false);
    expect(fixture.nativeElement.querySelector('pre').textContent).toHaveLength(100_000);
    expect(component.text()).toHaveLength(150_000);
  });

  it('offers a table for a list of objects and folds its rows', () => {
    show({ list: Array.from({ length: 12 }, (_, i) => ({ Name: `f${i}`, Size: i })) });
    expect(component.table()?.columns).toEqual(['Name', 'Size']);

    component.setView('table');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('tbody tr')).toHaveLength(10);
    expect(component.canFold()).toBe(true);

    component.toggleExpanded();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('tbody tr')).toHaveLength(12);
  });

  it('has no table view for other output', () => {
    show({ version: 'v1' });
    expect(component.table()).toBeNull();
  });

  it('masks secrets in the view and the copied text unless masking is off', () => {
    show({ remote: { type: 'drive', token: 'abc' } });
    expect(component.text()).toContain(MASK);
    expect(component.text()).not.toContain('abc');

    show({ remote: { type: 'drive', token: 'abc' } }, false);
    expect(component.text()).toContain('abc');
  });
});
