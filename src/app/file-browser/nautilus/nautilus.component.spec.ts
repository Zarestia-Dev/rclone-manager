import { ComponentFixture, TestBed } from '@angular/core/testing';
import { BehaviorSubject } from 'rxjs';
import { RemoteManagementService } from '@app/services';

import { NautilusComponent } from './nautilus.component';

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
});
