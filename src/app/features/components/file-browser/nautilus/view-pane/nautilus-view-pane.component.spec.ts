import { ComponentFixture, TestBed } from '@angular/core/testing';
import { NautilusViewPaneComponent } from './nautilus-view-pane.component';
import { TranslateModule } from '@ngx-translate/core';
import { IconService } from '@app/services';
import { FormatFileSizePipe } from '@app/pipes';
import { CdkDragDrop } from '@angular/cdk/drag-drop';
import { signal } from '@angular/core';

class MockIconService {
  getIconForEntry(entry: any) {
    return 'folder';
  }
}

describe('NautilusViewPaneComponent', () => {
  let component: NautilusViewPaneComponent;
  let fixture: ComponentFixture<NautilusViewPaneComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [NautilusViewPaneComponent, TranslateModule.forRoot(), FormatFileSizePipe],
      providers: [{ provide: IconService, useClass: MockIconService }],
    }).compileComponents();

    fixture = TestBed.createComponent(NautilusViewPaneComponent);
    component = fixture.componentInstance;

    // Set required inputs
    fixture.componentRef.setInput('files', []);
    fixture.componentRef.setInput('selection', new Set<string>());
    fixture.componentRef.setInput('paneIndex', 0);
    fixture.componentRef.setInput('isSplitEnabled', false);
    fixture.componentRef.setInput('loading', false);
    fixture.componentRef.setInput('layout', 'grid');
    fixture.componentRef.setInput('iconSize', 64);
    fixture.componentRef.setInput('listRowHeight', 40);
    fixture.componentRef.setInput('isDragging', false);
    fixture.componentRef.setInput('cutItemPaths', new Set<string>());
    fixture.componentRef.setInput('starredMode', false);
    fixture.componentRef.setInput('sortKey', 'name');
    fixture.componentRef.setInput('sortDirection', 'asc');
    fixture.componentRef.setInput('activePaneIndex', 0);
    fixture.componentRef.setInput('getItemKey', (item: any) => item.entry.Path);
    fixture.componentRef.setInput('isItemSelectable', (entry: any) => true);
    fixture.componentRef.setInput('trackByFile', (index: number, item: any) => item.entry.Path);
    fixture.componentRef.setInput('trackBySortOption', (index: number, item: any) => item.key);
    fixture.componentRef.setInput('formatRelativeDate', (dateString: string) => dateString);
    fixture.componentRef.setInput('canAcceptFile', (drag: any, drop: any) => false);
    fixture.componentRef.setInput('fileMenu', null);

    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should emit switchPane when pane wrapper is clicked', () => {
    spyOn(component.switchPane, 'emit');
    const wrapper = fixture.nativeElement.querySelector('.pane-wrapper');
    const event = new MouseEvent('mousedown');
    wrapper.dispatchEvent(event);
    expect(component.switchPane.emit).toHaveBeenCalledWith(0);
  });
});
