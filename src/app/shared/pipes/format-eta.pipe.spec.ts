import { TestBed } from '@angular/core/testing';
import { TranslateService } from '@ngx-translate/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { FormatEtaPipe } from './format-eta.pipe';

describe('FormatEtaPipe', () => {
  let pipe: FormatEtaPipe;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        FormatEtaPipe,
        { provide: TranslateService, useValue: { instant: (key: string): string => key } },
      ],
    });
    pipe = TestBed.inject(FormatEtaPipe);
  });

  it('shows seconds under a minute', () => {
    expect(pipe.transform(1)).toBe('1s');
    expect(pipe.transform(45.4)).toBe('45s');
    expect(pipe.transform(59)).toBe('59s');
  });

  it('shows minutes with their seconds, and only the minutes when the seconds are zero', () => {
    expect(pipe.transform(60)).toBe('1m');
    expect(pipe.transform(83)).toBe('1m 23s');
    expect(pipe.transform(125)).toBe('2m 5s');
    expect(pipe.transform(3599)).toBe('59m 59s');
  });

  it('shows hours with their minutes and days with their hours', () => {
    expect(pipe.transform(3600)).toBe('1h');
    expect(pipe.transform(3780)).toBe('1h 3m');
    expect(pipe.transform(86400)).toBe('1d');
    expect(pipe.transform(86400 + 4 * 3600 + 59)).toBe('1d 4h');
  });

  it('rounds to whole seconds before splitting, so it never shows 60s', () => {
    expect(pipe.transform(59.6)).toBe('1m');
    expect(pipe.transform(119.5)).toBe('2m');
  });

  it('passes a string through and calls a missing or unusable value unknown', () => {
    expect(pipe.transform('soon')).toBe('soon');
    expect(pipe.transform(0)).toBe('common.unknown');
    expect(pipe.transform(-5)).toBe('common.unknown');
    expect(pipe.transform(Infinity)).toBe('common.unknown');
    expect(pipe.transform(NaN)).toBe('common.unknown');
  });
});
