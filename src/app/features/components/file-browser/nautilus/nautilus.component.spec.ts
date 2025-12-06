import { ComponentFixture, TestBed } from '@angular/core/testing';
import { BehaviorSubject } from 'rxjs';
import { RemoteManagementService } from '@app/services';

import { NautilusComponent } from './nautilus.component';
import { UiStateService } from '@app/services';
import { firstValueFrom } from 'rxjs';

describe('NautilusComponent', () => {
  let component: NautilusComponent;
  let fixture: ComponentFixture<NautilusComponent>;

  class MockRemoteManagementService {
    remotes$ = new BehaviorSubject<string[]>(['remoteA', 'remoteB']);
    async getRemotes(): Promise<string[]> {
      // Simulate a successful fetch
      this.remotes$.next(['remoteA', 'remoteB']);
      return ['remoteA', 'remoteB'];
    }
    async getAllRemoteConfigs(): Promise<Record<string, unknown>> {
      return {
        remoteA: { type: 's3' },
        remoteB: { type: 'drive' },
      };
    }
  }

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [NautilusComponent],
      providers: [{ provide: RemoteManagementService, useClass: MockRemoteManagementService }],
    }).compileComponents();

    fixture = TestBed.createComponent(NautilusComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should display remote names', async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    const items = Array.from(host.querySelectorAll('mat-list-item h4'));
    const texts = items.map(i => i.textContent?.trim() ?? '');
    expect(texts).toContain('remoteA');
    expect(texts).toContain('remoteB');
  });

  it('should show remote icons for items', async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const icons = fixture.nativeElement.querySelectorAll('mat-icon.remote-type-icon');
    expect(icons.length).toBeGreaterThan(0);
  });

  it('should set default selected remote to first remote if none selected', async () => {
    const ui = TestBed.inject(UiStateService);
    fixture.detectChanges();
    await fixture.whenStable();

    const selected = await firstValueFrom(ui.selectedRemote$);
    expect(selected).not.toBeNull();
    expect(selected?.remoteSpecs?.name).toBe('remoteA');
  });

  it('should update UI state when a remote is clicked', async () => {
    const ui = TestBed.inject(UiStateService);
    fixture.detectChanges();
    await fixture.whenStable();

    const firstItem = fixture.nativeElement.querySelector('mat-list-item');
    firstItem.click();

    const selected = await firstValueFrom(ui.selectedRemote$);
    expect(selected?.remoteSpecs?.name).toBe('remoteA');
  });
});
