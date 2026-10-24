import {
  looksLikeBinary,
  detectFileSignature,
  extractLnkTargets,
  extractLnkSummary,
  decodeText,
  repairText,
  generateHexDump,
  inspectBinary,
} from './binary-signature.util';

describe('binary-signature.util', () => {
  describe('looksLikeBinary', () => {
    it('returns false for empty content', () => {
      expect(looksLikeBinary('')).toBe(false);
      expect(looksLikeBinary(new Uint8Array(0))).toBe(false);
    });

    it('returns false for standard text', () => {
      expect(looksLikeBinary('Hello world! Simple text.')).toBe(false);
    });

    it('returns false for UTF BOMs', () => {
      expect(looksLikeBinary('\xEF\xBB\xBFHello UTF-8')).toBe(false);
      expect(looksLikeBinary('\xFF\xFEHello UTF-16LE')).toBe(false);
      expect(looksLikeBinary('\xFE\xFFHello UTF-16BE')).toBe(false);
    });

    it('returns true for LNK magic bytes', () => {
      expect(looksLikeBinary('L\0\0\0\x01\x02\x03\x04')).toBe(true);
    });

    it('returns true for high non-printable ratio', () => {
      const binary = '\x01\x02\x03\x04\x05\x06\x07\x08\x0B\x0C\x0E\x0F\x10\x11\x12\x13';
      expect(looksLikeBinary(binary)).toBe(true);
    });

    it('detects UTF-16 text without BOM as text (not binary)', () => {
      const utf16le = 'H\0e\0l\0l\0o\0 \0W\0o\0r\0l\0d\0';
      expect(looksLikeBinary(utf16le)).toBe(false);
    });
  });

  describe('detectFileSignature', () => {
    it('detects SQLite 3 signature', () => {
      const sig = detectFileSignature('SQLite format 3\0\x04\x00\x01\x01\x00@  ');
      expect(sig).not.toBeNull();
      expect(sig?.format).toBe('sqlite');
      expect(sig?.label).toBe('SQLite 3 Database');
      expect(sig?.mimeType).toBe('application/vnd.sqlite3');
    });

    it('detects Windows PE / MZ binary', () => {
      const sig = detectFileSignature('MZ' + '\0'.repeat(250) + 'PE\0\0' + 'extra');
      expect(sig).not.toBeNull();
      expect(sig?.format).toBe('pe_executable');
      expect(sig?.label).toContain('Windows Executable');
    });

    it('detects ELF binary', () => {
      const sig = detectFileSignature('\x7FELF\x02\x01\x01\x00');
      expect(sig).not.toBeNull();
      expect(sig?.format).toBe('elf');
      expect(sig?.label).toBe('Linux Executable / Library (ELF)');
    });

    it('detects Mach-O binary', () => {
      const sig = detectFileSignature('\xCA\xFE\xBA\xBE\x00\x00\x00\x02');
      expect(sig).not.toBeNull();
      expect(sig?.format).toBe('macho');
    });

    it('detects LNK shortcut', () => {
      const sig = detectFileSignature('L\0\0\0\x01\x14\x02\x00');
      expect(sig).not.toBeNull();
      expect(sig?.format).toBe('lnk');
    });

    it('detects PDF document', () => {
      const sig = detectFileSignature('%PDF-1.7\n1 0 obj');
      expect(sig).not.toBeNull();
      expect(sig?.format).toBe('pdf');
      expect(sig?.mimeType).toBe('application/pdf');
    });

    it('returns null for unknown format', () => {
      expect(detectFileSignature('Plain text without signatures')).toBeNull();
      expect(detectFileSignature('')).toBeNull();
    });
  });

  describe('extractLnkTargets & extractLnkSummary', () => {
    it('extracts executable and environment paths from LNK text', () => {
      const raw =
        'L\0\0\0random\0\0C:\\Program Files\\App\\app.exe\0\0some-data\0%APPDATA%\\Config\\run.dll\0end';
      const targets = extractLnkTargets(raw);
      expect(targets).toContain('C:\\Program Files\\App\\app.exe');
      expect(targets).toContain('%APPDATA%\\Config\\run.dll');

      const summary = extractLnkSummary(raw, 'Targets');
      expect(summary).toContain('Targets:\n\n- C:\\Program Files\\App\\app.exe');
    });
  });

  describe('decodeText & repairText', () => {
    it('decodes UTF-8 BOM', () => {
      const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x41, 0x42, 0x43]);
      expect(decodeText(bytes)).toBe('ABC');
    });

    it('decodes UTF-16LE BOM', () => {
      const bytes = new Uint8Array([0xff, 0xfe, 0x41, 0x00, 0x42, 0x00]);
      expect(decodeText(bytes)).toBe('AB');
    });

    it('repairs legacy null text strings', () => {
      expect(repairText('')).toBe('');
      expect(repairText('Normal text')).toBe('Normal text');
    });
  });

  describe('generateHexDump & inspectBinary', () => {
    it('generates hex dump rows', () => {
      const data = 'Hello, World! 1234567890';
      const rows = generateHexDump(data, 32);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0].offset).toBe('00000000');
      expect(rows[0].ascii).toContain('Hello, W');
    });

    it('inspects binary payload completely', () => {
      const payload = 'SQLite format 3\0\x04\x00\x01\x01\x00@  ';
      const result = inspectBinary(payload, 'test.db');
      expect(result.isBinary).toBe(true);
      expect(result.signature?.format).toBe('sqlite');
      expect(result.hexDump).toBeDefined();
    });
  });
});

describe('binary inspection regression cases', () => {
  describe('looksLikeBinary', () => {
    it('should return false for empty or falsy content', () => {
      expect(looksLikeBinary('')).toBe(false);
    });

    it('should return false for standard text files', () => {
      const text = 'Hello world! This is a simple configuration or source code file.\nLine 2.';
      expect(looksLikeBinary(text)).toBe(false);
    });

    it('should return false for text with UTF-8 or UTF-16 Byte Order Marks', () => {
      expect(looksLikeBinary('\xEF\xBB\xBFHello UTF-8')).toBe(false);
      expect(looksLikeBinary('\xFF\xFEHello UTF-16LE')).toBe(false);
      expect(looksLikeBinary('\xFE\xFFHello UTF-16BE')).toBe(false);
    });

    it('should return true for Windows Shortcut (LNK) magic bytes', () => {
      expect(looksLikeBinary('L\0\0\0\x01\x02\x03\x04')).toBe(true);
    });

    it('should return true for binary content with high ratio of non-printable bytes', () => {
      const binary = '\x01\x02\x03\x04\x05\x06\x07\x08\x0B\x0C\x0E\x0F\x10\x11\x12\x13';
      expect(looksLikeBinary(binary)).toBe(true);
    });

    it('should identify real binary content with abnormal null ratios', () => {
      // 20% null bytes (not the ~50% UTF-16 pattern)
      let mixed = '';
      for (let i = 0; i < 100; i++) {
        mixed += i % 5 === 0 ? '\0' : 'A';
      }
      expect(looksLikeBinary(mixed)).toBe(true);
    });

    it('should identify raw binary byte streams (e.g. 0-255 cyclic bytes) as binary', () => {
      const rawBytes = new Uint8Array(Array.from({ length: 512 }, (_, i) => i % 256));
      expect(looksLikeBinary(rawBytes)).toBe(true);
    });

    it('should not flag alternating UTF-16 text without BOM as binary', () => {
      const utf16leText = 'H\0e\0l\0l\0o\0 \0W\0o\0r\0l\0d\0';
      expect(looksLikeBinary(utf16leText)).toBe(false);
    });

    it('should return false for valid UTF-8 text containing multi-byte characters', () => {
      const turkishText = new TextEncoder().encode('Türkçe metin örneği: Şemsiye, çanta, övgü.');
      expect(looksLikeBinary(turkishText)).toBe(false);
    });
  });

  describe('detectFileSignature', () => {
    it('should detect SQLite 3 database signature', () => {
      const sqlite = 'SQLite format 3\0\x04\x00\x01\x01\x00@  ';
      const sig = detectFileSignature(sqlite);
      expect(sig).not.toBeNull();
      expect(sig?.format).toBe('sqlite');
      expect(sig?.label).toBe('SQLite 3 Database');
      expect(sig?.mimeType).toBe('application/vnd.sqlite3');
    });

    it('should detect Windows PE executables and DLLs', () => {
      const pe = 'MZ' + '\0'.repeat(250) + 'PE\0\0' + 'extra';
      const sig = detectFileSignature(pe);
      expect(sig).not.toBeNull();
      expect(sig?.format).toBe('pe_executable');
      expect(sig?.label).toContain('Windows Executable');
    });

    it('should detect Linux ELF binaries', () => {
      const elf = '\x7FELF\x02\x01\x01\x00';
      const sig = detectFileSignature(elf);
      expect(sig).not.toBeNull();
      expect(sig?.format).toBe('elf');
      expect(sig?.label).toBe('Linux Executable / Library (ELF)');
    });

    it('should detect macOS Mach-O binaries', () => {
      const macho = '\xCA\xFE\xBA\xBE\x00\x00\x00\x02';
      const sig = detectFileSignature(macho);
      expect(sig).not.toBeNull();
      expect(sig?.format).toBe('macho');
      expect(sig?.label).toBe('macOS Mach-O Binary');
    });

    it('should detect Windows Shortcuts (LNK)', () => {
      const lnk = 'L\0\0\0\x01\x14\x02\x00';
      const sig = detectFileSignature(lnk);
      expect(sig).not.toBeNull();
      expect(sig?.format).toBe('lnk');
      expect(sig?.label).toBe('Windows Shortcut (LNK)');
    });

    it('should detect PDF documents', () => {
      const pdf = '%PDF-1.7\r\n%âãÏÓ';
      const sig = detectFileSignature(pdf);
      expect(sig).not.toBeNull();
      expect(sig?.format).toBe('pdf');
      expect(sig?.suggestedCategory).toBe('binary');
    });

    it('should return null for unrecognized or plain text files', () => {
      expect(detectFileSignature('Hello world')).toBeNull();
      expect(detectFileSignature('abc')).toBeNull();
    });
  });

  describe('extractLnkTargets & extractLnkSummary', () => {
    it('should extract Windows drive paths and environment variables from LNK content', () => {
      const lnkContent =
        'L\0\0\0random\0\0C:\\Program Files\\App\\target.exe\0\0some-data\0%USERPROFILE%\\test.bat';
      const targets = extractLnkTargets(lnkContent);
      expect(targets).toContain('C:\\Program Files\\App\\target.exe');
      expect(targets).toContain('%USERPROFILE%\\test.bat');
    });

    it('should return empty array when no path matches are found', () => {
      expect(extractLnkTargets('No paths here')).toEqual([]);
      expect(extractLnkTargets('')).toEqual([]);
    });

    it('should format summary with header label', () => {
      const lnkContent = 'C:\\Windows\\System32\\cmd.exe';
      const summary = extractLnkSummary(lnkContent, 'Targets');
      expect(summary).toContain('Targets:');
      expect(summary).toContain('- C:\\Windows\\System32\\cmd.exe');
    });
  });

  describe('decodeText & repairText', () => {
    it('should leave normal text untouched', () => {
      expect(repairText('Hello World')).toBe('Hello World');
      expect(decodeText('Hello World')).toBe('Hello World');
    });

    it('should decode UTF-8 byte arrays correctly', () => {
      const bytes = new TextEncoder().encode('Örnek UTF-8 metin: İğne, çanta.');
      expect(decodeText(bytes)).toBe('Örnek UTF-8 metin: İğne, çanta.');
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
      expect(decodeText(utf16leWithBom)).toBe('Hi');
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
      expect(decodeText(utf16le)).toBe('Hello');
    });

    it('should repair mangled UTF-16 string by stripping null bytes and replacement chars', () => {
      const mangled = '\ufffd\ufffdH\0e\0l\0l\0o\0 \0W\0o\0r\0l\0d\0';
      expect(repairText(mangled)).toBe('Hello World');
    });
  });

  describe('generateHexDump', () => {
    it('should generate empty array for empty content', () => {
      expect(generateHexDump('')).toEqual([]);
    });

    it('should generate 16-byte hex dump rows with offset, formatted hex, and ascii', () => {
      const content = 'Hello, World! 12'; // 16 characters
      const rows = generateHexDump(content);
      expect(rows.length).toBe(1);
      expect(rows[0].offset).toBe('00000000');
      expect(rows[0].ascii).toBe('Hello, World! 12');
      // 'H' is 0x48, 'e' is 0x65
      expect(rows[0].hex.startsWith('48 65')).toBe(true);
    });

    it('should respect maxBytes limit', () => {
      const longContent = 'A'.repeat(100);
      const rows = generateHexDump(longContent, 32);
      expect(rows.length).toBe(2); // 32 bytes / 16 = 2 rows
    });
  });

  describe('inspect', () => {
    it('should produce a complete inspection report for binary files', () => {
      const elf = '\x7FELF\x02\x01\x01\x00' + '\x01\x02\x03\x04'.repeat(10);
      const result = inspectBinary(elf, 'binary-tool');
      expect(result.isBinary).toBe(true);
      expect(result.signature?.format).toBe('elf');
      expect(result.hexDump).toBeDefined();
      expect(result.hexDump?.length).toBeGreaterThan(0);
    });

    it('should produce an inspection report for shortcut files', () => {
      const lnk = 'L\0\0\0C:\\Apps\\Tool.exe';
      const result = inspectBinary(lnk, 'shortcut.lnk');
      expect(result.isBinary).toBe(true);
      expect(result.signature?.format).toBe('lnk');
      expect(result.shortcutTargets).toContain('C:\\Apps\\Tool.exe');
    });

    it('should produce an inspection report with hexDump for raw binary data without signature', () => {
      const rawBytes = new Uint8Array(Array.from({ length: 256 }, (_, i) => i % 256));
      const result = inspectBinary(rawBytes, 'sample-raw-data.dat');
      expect(result.isBinary).toBe(true);
      expect(result.signature).toBeNull();
      expect(result.hexDump).toBeDefined();
      expect(result.hexDump?.length).toBe(16); // 256 bytes / 16 = 16 rows
    });

    it('should mark disguised PDF files as binary even if purely ascii-formatted', () => {
      const pdf = '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>';
      const result = inspectBinary(pdf, 'disguised.dat');
      expect(result.isBinary).toBe(true);
      expect(result.signature?.format).toBe('pdf');
      expect(result.signature?.suggestedCategory).toBe('binary');
    });
  });
});
