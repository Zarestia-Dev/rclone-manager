import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideTranslateService } from '@ngx-translate/core';
import { MountCardComponent } from './mount-card.component';
import { MountedRemote, Starter } from '@app/types';
import { PathService } from 'src/app/services/infrastructure/platform/path.service';

describe('MountCardComponent', () => {
  let fixture: ComponentFixture<MountCardComponent>;
  let component: MountCardComponent;

  const base: MountedRemote = { fs: 'drive:folder', mount_point: '/mnt/drive' };

  const render = (mount: MountedRemote): HTMLElement => {
    fixture.componentRef.setInput('mount', mount);
    fixture.detectChanges();
    return fixture.nativeElement;
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [MountCardComponent],
      providers: [
        provideTranslateService(),
        {
          provide: PathService,
          useValue: { getRemoteNameFromFs: (fs: string): string => fs.split(':')[0] },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(MountCardComponent);
    component = fixture.componentInstance;
  });

  it('shows the remote, the mount point and the filesystem', () => {
    const el = render(base);
    expect(el.querySelector('.mount-remote-name')?.textContent).toContain('drive');
    expect(el.querySelector('.mount-point')?.textContent).toContain('/mnt/drive');
    expect(el.querySelector('.mount-fs')?.textContent).toContain('drive:folder');
  });

  it.each<[Starter, string]>([
    [{ kind: 'profile', name: 'work' }, 'work'],
    [{ kind: 'quick_run', id: 'qr-1', name: 'Nightly backup' }, 'Nightly backup'],
    [
      { kind: 'workflow', workflowId: 'wf', workflowName: 'Sync all', nodeId: 'n', ancestors: [] },
      'Sync all',
    ],
  ])('names what started the mount: %j', (starter, name) => {
    const el = render({ ...base, starter });
    expect(el.querySelector('app-starter-pill')?.textContent).toContain(name);
  });

  it('names nothing for a mount without a starter', () => {
    const el = render(base);
    expect(el.querySelector('app-starter-pill span')).toBeNull();
  });

  it('emits unmount and open without also emitting a card click', () => {
    const el = render(base);
    const unmount = vi.fn();
    const open = vi.fn();
    const click = vi.fn();
    component.unmount.subscribe(unmount);
    component.openMount.subscribe(open);
    component.cardClick.subscribe(click);

    const [openBtn, unmountBtn] = Array.from(el.querySelectorAll<HTMLButtonElement>('button'));
    openBtn.click();
    unmountBtn.click();

    expect(open).toHaveBeenCalledWith(base);
    expect(unmount).toHaveBeenCalledWith(base);
    expect(click).not.toHaveBeenCalled();
  });
});
