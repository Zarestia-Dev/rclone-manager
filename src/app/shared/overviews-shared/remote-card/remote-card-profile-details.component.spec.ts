import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideTranslateService } from '@ngx-translate/core';
import { RemoteCardProfileDetailsComponent } from './remote-card-profile-details.component';
import { DetailedOperationViewModel } from './remote-card.types';

describe('RemoteCardProfileDetailsComponent', () => {
  let fixture: ComponentFixture<RemoteCardProfileDetailsComponent>;
  let component: RemoteCardProfileDetailsComponent;

  const mountVm: DetailedOperationViewModel = {
    operation: 'mount',
    tone: 'accent',
    labelIcon: 'mount',
    profiles: [
      {
        name: 'default',
        isBusy: false,
        isActive: true,
        isOpening: false,
        tooltipKey: 'overviews.remoteCard.actions.unmount',
        openPaths: [{ path: '/media/test', icon: 'folder' }],
      },
    ],
  };

  const el = (): HTMLElement => fixture.nativeElement;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [RemoteCardProfileDetailsComponent],
      providers: [provideTranslateService()],
    }).compileComponents();

    fixture = TestBed.createComponent(RemoteCardProfileDetailsComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('shows the shared empty state when there is no profile to list', () => {
    expect(el().querySelector('.empty-state')).not.toBeNull();
    expect(el().querySelector('.profile-group')).toBeNull();
  });

  it('lists each operation with its profile count and chips', () => {
    fixture.componentRef.setInput('detailedOperationViewModels', [mountVm]);
    fixture.detectChanges();

    expect(el().querySelector('.empty-state')).toBeNull();
    expect(
      el()
        .querySelector('.profile-group-header [appPill], .profile-group-header .app-pill')
        ?.textContent?.trim()
    ).toBe('1');
    expect(el().querySelector('.profile-name-text')?.textContent?.trim()).toBe('default');
    expect(el().querySelector('.profile-pills button')?.getAttribute('title')).toBe(
      'overviews.remoteCard.actions.unmount (default)'
    );
  });

  it('emits profileToggle for a clicked chip without letting the click reach the card', () => {
    const emitted = vi.fn();
    const cardClick = vi.fn();
    component.profileToggle.subscribe(emitted);
    el().addEventListener('click', cardClick);
    fixture.componentRef.setInput('detailedOperationViewModels', [mountVm]);
    fixture.detectChanges();

    el().querySelector<HTMLButtonElement>('.profile-pills button')?.click();

    expect(emitted).toHaveBeenCalledWith({ operation: 'mount', profile: 'default' });
    expect(cardClick).not.toHaveBeenCalled();
  });

  it('emits profileOpenInFiles with the path of the clicked folder button', () => {
    const emitted = vi.fn();
    component.profileOpenInFiles.subscribe(emitted);
    fixture.componentRef.setInput('detailedOperationViewModels', [mountVm]);
    fixture.detectChanges();

    el().querySelector<HTMLButtonElement>('.profile-open-btn')?.click();

    expect(emitted).toHaveBeenCalledWith({
      operation: 'mount',
      profile: 'default',
      path: '/media/test',
    });
  });

  it('disables a busy chip', () => {
    fixture.componentRef.setInput('detailedOperationViewModels', [
      { ...mountVm, profiles: [{ ...mountVm.profiles[0], isBusy: true }] },
    ]);
    fixture.detectChanges();

    expect(el().querySelector<HTMLButtonElement>('.profile-pills button')?.disabled).toBe(true);
  });
});
