import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideTranslateService } from '@ngx-translate/core';
import { RemoteCardProfileDetailsComponent } from './remote-card-profile-details.component';
import { ProfileChipClickEvent, ProfileOpenInFilesEvent } from './remote-card.types';

describe('RemoteCardProfileDetailsComponent', () => {
  let fixture: ComponentFixture<RemoteCardProfileDetailsComponent>;
  let component: RemoteCardProfileDetailsComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [RemoteCardProfileDetailsComponent],
      providers: [provideTranslateService()],
    }).compileComponents();

    fixture = TestBed.createComponent(RemoteCardProfileDetailsComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('emits profileChipClick when onProfileChipClick is called', () => {
    let emitted: ProfileChipClickEvent | undefined;
    component.profileChipClick.subscribe((val: ProfileChipClickEvent) => {
      emitted = val;
    });

    const event = new MouseEvent('click');
    component.onProfileChipClick('mount', 'default', event);

    expect(emitted).toBeDefined();
    expect(emitted?.operation).toBe('mount');
    expect(emitted?.profile).toBe('default');
  });

  it('emits profileOpenInFiles when onProfileOpenInFiles is called', () => {
    let emitted: ProfileOpenInFilesEvent | undefined;
    component.profileOpenInFiles.subscribe((val: ProfileOpenInFilesEvent) => {
      emitted = val;
    });

    const event = new MouseEvent('click');
    component.onProfileOpenInFiles('mount', 'default', '/media/test', event);

    expect(emitted).toBeDefined();
    expect(emitted?.operation).toBe('mount');
    expect(emitted?.profile).toBe('default');
    expect(emitted?.path).toBe('/media/test');
  });
});
