import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TestBed, ComponentFixture } from '@angular/core/testing';
import { Clipboard } from '@angular/cdk/clipboard';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatIconRegistry } from '@angular/material/icon';
import { provideTranslateService } from '@ngx-translate/core';
import { Observable, of } from 'rxjs';
import { LoggingService } from '../../../../services/infrastructure/platform/logging.service';
import { NotificationService } from '../../../../services/ui/notification.service';
import { RemoteLogEntry } from '@app/types';
import { LogsModalComponent } from './logs-modal.component';

describe('LogsModalComponent command output', () => {
  let fixture: ComponentFixture<LogsModalComponent>;
  const copy = vi.fn(() => true);

  beforeEach(async () => {
    copy.mockClear();
    await TestBed.configureTestingModule({
      imports: [LogsModalComponent],
      providers: [
        provideTranslateService(),
        { provide: MAT_DIALOG_DATA, useValue: { remoteName: 'crypt' } },
        { provide: MatDialogRef, useValue: { close: vi.fn() } },
        { provide: LoggingService, useValue: { getRemoteLogs: vi.fn().mockResolvedValue([]) } },
        { provide: Clipboard, useValue: { copy } },
        { provide: NotificationService, useValue: { showSuccess: vi.fn(), showError: vi.fn() } },
        {
          provide: MatIconRegistry,
          useValue: {
            getNamedSvgIcon: (): Observable<SVGElement> =>
              of(document.createElementNS('http://www.w3.org/2000/svg', 'svg')),
          },
        },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(LogsModalComponent);
    vi.spyOn(fixture.componentInstance, 'scrollToBottom').mockImplementation(() => undefined);
    fixture.detectChanges();
    await fixture.whenStable();
  });

  function show(context: RemoteLogEntry['context']): HTMLElement {
    const log: RemoteLogEntry = {
      timestamp: '2026-10-20T07:28:39+03:00',
      level: 'info',
      message: 'Job finished',
      context,
    };
    fixture.componentInstance.logs.set([log]);
    fixture.componentInstance.toggleDetails(log);
    fixture.detectChanges();
    return fixture.nativeElement;
  }

  it('renders command failure and multiline output independently of RC success', () => {
    const text = 'INFO: Checking\n\nNOTICE: local path is not a crypt remote\n';
    const element = show({
      status: { success: true, error: '', output: { error: true, result: text } },
    });
    expect(element.querySelector('.app-pill.p-warn')).not.toBeNull();
    expect(element.querySelector('.code-block')?.textContent).toBe(text);
    expect(element.querySelector('details')?.open).toBe(false);
    expect(element.querySelector('details pre')?.textContent).toContain('"success": true');
    element.querySelector<HTMLButtonElement>('.detail-block button')?.click();
    expect(copy).toHaveBeenCalledWith(text);
  });

  it('escapes output markup while preserving terminal text', () => {
    const element = show({ output: { result: '<img src=x onerror=alert(1)>\nOK', error: false } });
    expect(element.querySelector('.code-block img')).toBeNull();
    expect(element.querySelector('.code-block')?.textContent).toBe(
      '<img src=x onerror=alert(1)>\nOK'
    );
    expect(element.querySelector('.app-pill.p-warn')).toBeNull();
  });

  it('keeps ordinary log context visible when there is no command output', () => {
    const element = show({ job_id: 2387, arguments: { command: 'cryptcheck' } });
    expect(element.querySelector('details')?.open).toBe(true);
    expect(element.querySelector('details pre')?.textContent).toContain('cryptcheck');
    expect(element.querySelector('.detail-block button')).toBeNull();
  });
});
