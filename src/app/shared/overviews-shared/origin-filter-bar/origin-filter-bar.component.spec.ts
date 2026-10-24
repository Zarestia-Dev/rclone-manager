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
    const buttons = fixture.nativeElement.querySelectorAll('button.app-pill');
    expect(buttons.length).toBe(4);

    (buttons[1] as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(component.selected()).toBe('flow');

    (buttons[2] as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(component.selected()).toBe('quickrun');

    (buttons[3] as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(component.selected()).toBe('dashboard');
  });
});
