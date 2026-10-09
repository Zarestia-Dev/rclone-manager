import { TestBed } from '@angular/core/testing';
import { DomSanitizer } from '@angular/platform-browser';
import { describe, it, expect, beforeEach } from 'vitest';
import { LineBreaksPipe } from './linebreaks.pipe';

describe('LineBreaksPipe', () => {
  let pipe: LineBreaksPipe;
  let sanitizer: DomSanitizer;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [LineBreaksPipe],
    });
    pipe = TestBed.inject(LineBreaksPipe);
    sanitizer = TestBed.inject(DomSanitizer);
  });

  it('should return empty string for null, undefined, or empty values', () => {
    expect(pipe.transform('')).toBe('');
    expect(pipe.transform(null)).toBe('');
    expect(pipe.transform(undefined)).toBe('');
  });

  it('should escape HTML characters without allocating DOM nodes', () => {
    const raw = '<img src=x onerror="alert(\'xss\')" & test>';
    const result = pipe.transform(raw);
    const sanitizedHtml = sanitizer.sanitize(1, result) ?? '';
    expect(sanitizedHtml).toContain('&lt;img');
    expect(sanitizedHtml).toContain('&amp; test&gt;');
    expect(sanitizedHtml).not.toContain('<img');
  });

  it('should convert newlines to <br> tags', () => {
    const raw = 'line 1\nline 2\r\nline 3';
    const result = pipe.transform(raw);
    const sanitizedHtml = sanitizer.sanitize(1, result) ?? '';
    expect(sanitizedHtml).toContain('line 1<br>line 2<br>line 3');
  });

  it('should convert markdown bold, italic, and inline code', () => {
    const raw = '**bold** *italic* `code`';
    const result = pipe.transform(raw);
    const sanitizedHtml = sanitizer.sanitize(1, result) ?? '';
    expect(sanitizedHtml).toContain('<strong>bold</strong>');
    expect(sanitizedHtml).toContain('<em>italic</em>');
    expect(sanitizedHtml).toContain('<code>code</code>');
  });

  it('should transform plain URLs into safe anchor tags', () => {
    const raw = 'Visit https://rclone.org for info';
    const result = pipe.transform(raw);
    const sanitizedHtml = sanitizer.sanitize(1, result) ?? '';
    expect(sanitizedHtml).toContain('href="https://rclone.org"');
    expect(sanitizedHtml).toContain('target="_blank"');
    expect(sanitizedHtml).toContain('rel="noopener noreferrer"');
  });
});
