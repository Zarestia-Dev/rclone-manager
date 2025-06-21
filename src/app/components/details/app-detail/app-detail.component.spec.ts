import { ComponentFixture, TestBed } from '@angular/core/testing';

import { AppDetailComponent } from './app-detail.component';

describe('AppDetailComponent', () => {
  let component: AppDetailComponent;
  let fixture: ComponentFixture<AppDetailComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AppDetailComponent]
    })
    .compileComponents();

    fixture = TestBed.createComponent(AppDetailComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
