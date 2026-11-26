import { ComponentFixture, TestBed } from '@angular/core/testing';
import { OriginFilterBarComponent } from './origin-filter-bar.component';
import { provideTranslateService } from '@ngx-translate/core';
import { MatIconTestingModule } from '@angular/material/icon/testing';

describe('OriginFilterBarComponent', () => {
  let component: OriginFilterBarComponent;
  let fixture: ComponentFixture<OriginFilterBarComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [OriginFilterBarComponent, MatIconTestingModule],
      providers: [provideTranslateService()],
    }).compileComponents();

    fixture = TestBed.createComponent(OriginFilterBarComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create with default filter "all"', () => {
    expect(component).toBeTruthy();
    expect(component.selected()).toBe('all');
  });

  it('should update selected filter on click', () => {
    fixture.componentRef.setInput('origins', ['workflow', 'quickrun', 'dashboard']);
    fixture.detectChanges();
    const buttons = fixture.nativeElement.querySelectorAll('button[appPill]');
    expect(buttons.length).toBe(4);

    (buttons[1] as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(component.selected()).toBe('workflow');

    (buttons[2] as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(component.selected()).toBe('quickrun');

    (buttons[3] as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(component.selected()).toBe('dashboard');
  });

  it('shows only the available origin options', () => {
    fixture.componentRef.setInput('origins', ['quickrun']);
    fixture.detectChanges();

    const buttons = Array.from<HTMLButtonElement>(
      fixture.nativeElement.querySelectorAll('button[appPill]')
    );
    expect(buttons.length).toBe(2);
    expect(buttons.map(button => button.textContent?.trim())).toEqual([
      'common.all',
      'alerts.origins.quickrun',
    ]);
  });

  it('offers the hidden items only when the chip leaves some out', () => {
    const hiddenPill = (): HTMLButtonElement | null =>
      fixture.nativeElement.querySelector('button.ml-auto');
    expect(hiddenPill()).toBeNull();

    fixture.componentRef.setInput('hiddenCount', 2);
    fixture.detectChanges();
    component.selected.set('quickrun');
    hiddenPill()?.click();
    expect(component.selected()).toBe('all');
  });
});
