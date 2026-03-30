import { ComponentFixture, TestBed } from '@angular/core/testing';
import { NautilusToolbarComponent } from './nautilus-toolbar.component';
import { TranslateModule } from '@ngx-translate/core';
import { MatIconTestingModule } from '@angular/material/icon/testing';
import { IconService } from '@app/services';

describe('NautilusToolbarComponent', () => {
  let component: NautilusToolbarComponent;
  let fixture: ComponentFixture<NautilusToolbarComponent>;
  let mockIconService: jasmine.SpyObj<IconService>;

  beforeEach(async () => {
    mockIconService = jasmine.createSpyObj('IconService', ['getIconName']);

    await TestBed.configureTestingModule({
      imports: [NautilusToolbarComponent, TranslateModule.forRoot(), MatIconTestingModule],
      providers: [{ provide: IconService, useValue: mockIconService }],
    }).compileComponents();

    fixture = TestBed.createComponent(NautilusToolbarComponent);
    component = fixture.componentInstance;

    // Provide required inputs
    fixture.componentRef.setInput('isMobile', false);
    fixture.componentRef.setInput('canGoBack', false);
    fixture.componentRef.setInput('canGoForward', false);
    fixture.componentRef.setInput('isSearchMode', false);
    fixture.componentRef.setInput('searchFilter', '');
    fixture.componentRef.setInput('isEditingPath', false);
    fixture.componentRef.setInput('starredMode', false);
    fixture.componentRef.setInput('activeRemote', null);
    fixture.componentRef.setInput('pathSegments', []);
    fixture.componentRef.setInput('isDragging', false);
    fixture.componentRef.setInput('hoveredSegmentIndex', null);
    fixture.componentRef.setInput('fullPathInput', '');
    fixture.componentRef.setInput('layout', 'grid');

    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should emit goBack when back button is clicked', () => {
    spyOn(component.goBack, 'emit');
    fixture.componentRef.setInput('canGoBack', true);
    fixture.componentRef.setInput('isMobile', false);
    fixture.detectChanges();

    const buttons = fixture.debugElement.nativeElement.querySelectorAll('.nav-button');
    // The first nav-button when not mobile is the back button
    buttons[0].click();

    expect(component.goBack.emit).toHaveBeenCalled();
  });

  it('should emit goForward when forward button is clicked', () => {
    spyOn(component.goForward, 'emit');
    fixture.componentRef.setInput('canGoForward', true);
    fixture.componentRef.setInput('isMobile', false);
    fixture.detectChanges();

    const buttons = fixture.debugElement.nativeElement.querySelectorAll('.nav-button');
    // The second nav-button when not mobile is the forward button
    buttons[1].click();

    expect(component.goForward.emit).toHaveBeenCalled();
  });
});
