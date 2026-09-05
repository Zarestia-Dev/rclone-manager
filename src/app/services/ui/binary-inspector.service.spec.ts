import { describe, it, expect, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { BinaryInspectorService } from './binary-inspector.service';

describe('BinaryInspectorService', () => {
  let service: BinaryInspectorService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [BinaryInspectorService],
    });
    service = TestBed.inject(BinaryInspectorService);
  });

  describe('looksLikeBinary', () => {
    it('should return false for empty or falsy content', () => {
      expect(service.looksLikeBinary('')).toBe(false);
    });

    it('should return false for standard text files', () => {
      const text = 'Hello world! This is a simple configuration or source code file.\nLine 2.';
      expect(service.looksLikeBinary(text)).toBe(false);
    });

    it('should return false for text with UTF-8 or UTF-16 Byte Order Marks', () => {
      expect(service.looksLikeBinary('\xEF\xBB\xBFHello UTF-8')).toBe(false);
      expect(service.looksLikeBinary('\xFF\xFEHello UTF-16LE')).toBe(false);
      expect(service.looksLikeBinary('\xFE\xFFHello UTF-16BE')).toBe(false);
    });

    it('should return true for Windows Shortcut (LNK) magic bytes', () => {
      expect(service.looksLikeBinary('L\0\0\0\x01\x02\x03\x04')).toBe(true);
    });

    it('should return true for binary content with high ratio of non-printable bytes', () => {
      const binary = '\x01\x02\x03\x04\x05\x06\x07\x08\x0B\x0C\x0E\x0F\x10\x11\x12\x13';
      expect(service.looksLikeBinary(binary)).toBe(true);
    });

    it('should identify real binary content with abnormal null ratios', () => {
      // 20% null bytes (not the ~50% UTF-16 pattern)
      let mixed = '';
      for (let i = 0; i < 100; i++) {
        mixed += i % 5 === 0 ? '\0' : 'A';
      }
      expect(service.looksLikeBinary(mixed)).toBe(true);
    });

    it('should identify raw binary byte streams (e.g. 0-255 cyclic bytes) as binary', () => {
      const rawBytes = new Uint8Array(Array.from({ length: 512 }, (_, i) => i % 256));
      expect(service.looksLikeBinary(rawBytes)).toBe(true);
    });

    it('should not flag alternating UTF-16 text without BOM as binary', () => {
      const utf16leText = 'H\0e\0l\0l\0o\0 \0W\0o\0r\0l\0d\0';
      expect(service.looksLikeBinary(utf16leText)).toBe(false);
    });

    it('should return false for valid UTF-8 text containing multi-byte characters', () => {
      const turkishText = new TextEncoder().encode('Türkçe metin örneği: Şemsiye, çanta, övgü.');
      expect(service.looksLikeBinary(turkishText)).toBe(false);
    });
  });

  describe('detectFileSignature', () => {
    it('should detect SQLite 3 database signature', () => {
      const sqlite = 'SQLite format 3\0\x04\x00\x01\x01\x00@  ';
      const sig = service.detectFileSignature(sqlite);
      expect(sig).not.toBeNull();
      expect(sig?.format).toBe('sqlite');
      expect(sig?.label).toBe('SQLite 3 Database');
      expect(sig?.mimeType).toBe('application/vnd.sqlite3');
    });

    it('should detect Windows PE executables and DLLs', () => {
      const pe = 'MZ' + '\0'.repeat(250) + 'PE\0\0' + 'extra';
      const sig = service.detectFileSignature(pe);
      expect(sig).not.toBeNull();
      expect(sig?.format).toBe('pe_executable');
      expect(sig?.label).toContain('Windows Executable');
    });

    it('should detect Linux ELF binaries', () => {
      const elf = '\x7FELF\x02\x01\x01\x00';
      const sig = service.detectFileSignature(elf);
      expect(sig).not.toBeNull();
      expect(sig?.format).toBe('elf');
      expect(sig?.label).toBe('Linux Executable / Library (ELF)');
    });

    it('should detect macOS Mach-O binaries', () => {
      const macho = '\xCA\xFE\xBA\xBE\x00\x00\x00\x02';
      const sig = service.detectFileSignature(macho);
      expect(sig).not.toBeNull();
      expect(sig?.format).toBe('macho');
      expect(sig?.label).toBe('macOS Mach-O Binary');
    });

    it('should detect Windows Shortcuts (LNK)', () => {
      const lnk = 'L\0\0\0\x01\x14\x02\x00';
      const sig = service.detectFileSignature(lnk);
      expect(sig).not.toBeNull();
      expect(sig?.format).toBe('lnk');
      expect(sig?.label).toBe('Windows Shortcut (LNK)');
    });

    it('should detect PDF documents', () => {
      const pdf = '%PDF-1.7\r\n%âãÏÓ';
      const sig = service.detectFileSignature(pdf);
      expect(sig).not.toBeNull();
      expect(sig?.format).toBe('pdf');
      expect(sig?.suggestedCategory).toBe('binary');
    });

    it('should return null for unrecognized or plain text files', () => {
      expect(service.detectFileSignature('Hello world')).toBeNull();
      expect(service.detectFileSignature('abc')).toBeNull();
    });
  });

  describe('extractLnkTargets & extractLnkSummary', () => {
    it('should extract Windows drive paths and environment variables from LNK content', () => {
      const lnkContent =
        'L\0\0\0random\0\0C:\\Program Files\\App\\target.exe\0\0some-data\0%USERPROFILE%\\test.bat';
      const targets = service.extractLnkTargets(lnkContent);
      expect(targets).toContain('C:\\Program Files\\App\\target.exe');
      expect(targets).toContain('%USERPROFILE%\\test.bat');
    });

    it('should return empty array when no path matches are found', () => {
      expect(service.extractLnkTargets('No paths here')).toEqual([]);
      expect(service.extractLnkTargets('')).toEqual([]);
    });

    it('should format summary with header label', () => {
      const lnkContent = 'C:\\Windows\\System32\\cmd.exe';
      const summary = service.extractLnkSummary(lnkContent, 'Targets');
      expect(summary).toContain('Targets:');
      expect(summary).toContain('- C:\\Windows\\System32\\cmd.exe');
    });
  });

  describe('decodeText & repairText', () => {
    it('should leave normal text untouched', () => {
      expect(service.repairText('Hello World')).toBe('Hello World');
      expect(service.decodeText('Hello World')).toBe('Hello World');
    });

    it('should decode UTF-8 byte arrays correctly', () => {
      const bytes = new TextEncoder().encode('Örnek UTF-8 metin: İğne, çanta.');
      expect(service.decodeText(bytes)).toBe('Örnek UTF-8 metin: İğne, çanta.');
    });

    it('should decode UTF-16LE with BOM correctly', () => {
      const utf16leWithBom = new Uint8Array([
        0xff,
        0xfe, // BOM
        0x48,
        0x00, // H
        0x69,
        0x00, // i
      ]);
      expect(service.decodeText(utf16leWithBom)).toBe('Hi');
    });

    it('should decode UTF-16LE without BOM correctly', () => {
      const utf16le = new Uint8Array([
        0x48,
        0x00, // H
        0x65,
        0x00, // e
        0x6c,
        0x00, // l
        0x6c,
        0x00, // l
        0x6f,
        0x00, // o
      ]);
      expect(service.decodeText(utf16le)).toBe('Hello');
    });

    it('should repair mangled UTF-16 string by stripping null bytes and replacement chars', () => {
      const mangled = '\ufffd\ufffdH\0e\0l\0l\0o\0 \0W\0o\0r\0l\0d\0';
      expect(service.repairText(mangled)).toBe('Hello World');
    });
  });

  describe('generateHexDump', () => {
    it('should generate empty array for empty content', () => {
      expect(service.generateHexDump('')).toEqual([]);
    });

    it('should generate 16-byte hex dump rows with offset, formatted hex, and ascii', () => {
      const content = 'Hello, World! 12'; // 16 characters
      const rows = service.generateHexDump(content);
      expect(rows.length).toBe(1);
      expect(rows[0].offset).toBe('00000000');
      expect(rows[0].ascii).toBe('Hello, World! 12');
      // 'H' is 0x48, 'e' is 0x65
      expect(rows[0].hex.startsWith('48 65')).toBe(true);
    });

    it('should respect maxBytes limit', () => {
      const longContent = 'A'.repeat(100);
      const rows = service.generateHexDump(longContent, 32);
      expect(rows.length).toBe(2); // 32 bytes / 16 = 2 rows
    });
  });

  describe('inspect', () => {
    it('should produce a complete inspection report for binary files', () => {
      const elf = '\x7FELF\x02\x01\x01\x00' + '\x01\x02\x03\x04'.repeat(10);
      const result = service.inspect(elf, 'binary-tool');
      expect(result.isBinary).toBe(true);
      expect(result.signature?.format).toBe('elf');
      expect(result.hexDump).toBeDefined();
      expect(result.hexDump?.length).toBeGreaterThan(0);
    });

    it('should produce an inspection report for shortcut files', () => {
      const lnk = 'L\0\0\0C:\\Apps\\Tool.exe';
      const result = service.inspect(lnk, 'shortcut.lnk');
      expect(result.isBinary).toBe(true);
      expect(result.signature?.format).toBe('lnk');
      expect(result.shortcutTargets).toContain('C:\\Apps\\Tool.exe');
    });

    it('should produce an inspection report with hexDump for raw binary data without signature', () => {
      const rawBytes = new Uint8Array(Array.from({ length: 256 }, (_, i) => i % 256));
      const result = service.inspect(rawBytes, 'sample-raw-data.dat');
      expect(result.isBinary).toBe(true);
      expect(result.signature).toBeNull();
      expect(result.hexDump).toBeDefined();
      expect(result.hexDump?.length).toBe(16); // 256 bytes / 16 = 16 rows
    });

    it('should mark disguised PDF files as binary even if purely ascii-formatted', () => {
      const pdf = '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>';
      const result = service.inspect(pdf, 'disguised.dat');
      expect(result.isBinary).toBe(true);
      expect(result.signature?.format).toBe('pdf');
      expect(result.signature?.suggestedCategory).toBe('binary');
    });
  });
});
