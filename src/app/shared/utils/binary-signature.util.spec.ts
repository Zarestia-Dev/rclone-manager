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
