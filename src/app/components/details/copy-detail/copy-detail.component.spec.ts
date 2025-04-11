import { ComponentFixture, TestBed } from '@angular/core/testing';

import { CopyDetailComponent } from './copy-detail.component';

describe('CopyDetailComponent', () => {
  let component: CopyDetailComponent;
  let fixture: ComponentFixture<CopyDetailComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [CopyDetailComponent]
    })
    .compileComponents();

    fixture = TestBed.createComponent(CopyDetailComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
