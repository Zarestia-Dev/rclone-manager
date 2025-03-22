import { ComponentFixture, TestBed } from '@angular/core/testing';

import { RemoteDetailComponent } from './remote-detail.component';

describe('RemoteDetailComponent', () => {
  let component: RemoteDetailComponent;
  let fixture: ComponentFixture<RemoteDetailComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [RemoteDetailComponent]
    })
    .compileComponents();

    fixture = TestBed.createComponent(RemoteDetailComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
