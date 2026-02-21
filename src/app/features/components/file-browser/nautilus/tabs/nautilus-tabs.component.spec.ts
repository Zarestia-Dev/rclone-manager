import { ComponentFixture, TestBed } from '@angular/core/testing';
import { NautilusTabsComponent } from './nautilus-tabs.component';
import { TranslateModule } from '@ngx-translate/core';
import { MatIconTestingModule } from '@angular/material/icon/testing';
import { DragDropModule } from '@angular/cdk/drag-drop';

describe('NautilusTabsComponent', () => {
  let component: NautilusTabsComponent;
  let fixture: ComponentFixture<NautilusTabsComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [
        NautilusTabsComponent,
        TranslateModule.forRoot(),
        MatIconTestingModule,
        DragDropModule,
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(NautilusTabsComponent);
    component = fixture.componentInstance;

    // Provide inputs
    fixture.componentRef.setInput('tabs', [
      { id: 1, title: 'Local', path: '/', remote: null },
      { id: 2, title: 'Gems', path: '/gems', remote: { label: 'Drive' } },
    ]);
    fixture.componentRef.setInput('activeTabIndex', 0);

    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should emit switchTab when a tab is clicked', () => {
    spyOn(component.switchTab, 'emit');
    const tabEls = fixture.debugElement.nativeElement.querySelectorAll('.tab');
    tabEls[1].click();
    expect(component.switchTab.emit).toHaveBeenCalledWith(1);
  });

  it('should emit closeTab when the close button is clicked', () => {
    spyOn(component.closeTab, 'emit');
    const closeBtns = fixture.debugElement.nativeElement.querySelectorAll('.close-tab');
    closeBtns[0].click();
    expect(component.closeTab.emit).toHaveBeenCalledWith(0);
  });
});
