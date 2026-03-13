import { ComponentFixture, TestBed } from '@angular/core/testing';
import { NautilusBottomBarComponent } from './nautilus-bottom-bar.component';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { CdkMenuModule } from '@angular/cdk/menu';

describe('NautilusBottomBarComponent', () => {
  let component: NautilusBottomBarComponent;
  let fixture: ComponentFixture<NautilusBottomBarComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [NautilusBottomBarComponent, MatIconModule, MatButtonModule, CdkMenuModule],
    }).compileComponents();

    fixture = TestBed.createComponent(NautilusBottomBarComponent);
    component = fixture.componentRef.instance;

    fixture.componentRef.setInput('canGoBack', false);
    fixture.componentRef.setInput('canGoForward', false);
    fixture.componentRef.setInput('layout', 'grid');
    fixture.componentRef.setInput('viewMenu', {}); // Mock object for required input
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should emit setLayout with inverted layout on toggle', () => {
    spyOn(component.setLayout, 'emit');

    // Initial is grid, toggle should emit list
    component.toggleLayout();
    expect(component.setLayout.emit).toHaveBeenCalledWith('list');

    // If layout is list, toggle should emit grid
    fixture.componentRef.setInput('layout', 'list');
    fixture.detectChanges();
    component.toggleLayout();
    expect(component.setLayout.emit).toHaveBeenCalledWith('grid');
  });
});
