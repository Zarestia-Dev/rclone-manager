import { Injectable } from '@angular/core';

export type DetectedFormat =
  'sqlite' | 'pe_executable' | 'elf' | 'macho' | 'pdf' | 'lnk' | 'unknown';

export interface DetectedSignature {
  format: DetectedFormat;
  label: string;
  mimeType?: string;
  suggestedCategory?: 'text' | 'pdf' | 'binary';
}

export interface HexDumpRow {
  offset: string;
  hex: string;
  ascii: string;
}

export interface BinaryInspectionResult {
  isBinary: boolean;
  signature: DetectedSignature | null;
  shortcutTargets?: string[];
  hexDump?: HexDumpRow[];
}

@Injectable({
  providedIn: 'root',
})
export class BinaryInspectorService {
  /**
   * Helper to convert string | Uint8Array | ArrayBuffer to Uint8Array.
   */
  private toUint8Array(input: string | Uint8Array | ArrayBuffer): Uint8Array {
    if (ArrayBuffer.isView(input)) {
      return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    }
    if (input instanceof ArrayBuffer) {
      return new Uint8Array(input);
    }
    if (typeof input === 'string') {
      const arr = new Uint8Array(input.length);
      for (let i = 0; i < input.length; i++) {
        arr[i] = input.charCodeAt(i) & 0xff;
      }
      return arr;
    }
    return new Uint8Array(0);
  }

  /**
   * Helper to get ASCII / raw byte string for regex pattern scanning.
   */
  private toByteString(input: string | Uint8Array | ArrayBuffer): string {
    if (typeof input === 'string') return input;
    const uint8 = this.toUint8Array(input);
    let str = '';
    const len = Math.min(uint8.length, 16384);
    for (let i = 0; i < len; i++) {
      str += String.fromCharCode(uint8[i]);
    }
    return str;
  }

  /**
   * Check if content appears to be binary data.
   * Checks BOMs, NULL byte frequency, and non-printable character ratios.
   */
  looksLikeBinary(content: string | Uint8Array | ArrayBuffer): boolean {
    if (!content) return false;
    const bytes = this.toUint8Array(content);
    if (bytes.length === 0) return false;

    // Check for common BOMs (Byte Order Marks)
    // 1. UTF-8 BOM: EF BB BF
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      return false;
    }
    // 2. UTF-16 BOM: FF FE (LE) or FE FF (BE)
    if (
      bytes.length >= 2 &&
      ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))
    ) {
      return false;
    }
    // 3. UTF-32 BOM: 00 00 FE FF or FF FE 00 00
    if (
      bytes.length >= 4 &&
      ((bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0xfe && bytes[3] === 0xff) ||
        (bytes[0] === 0xff && bytes[1] === 0xfe && bytes[2] === 0x00 && bytes[3] === 0x00))
    ) {
      return false;
    }

    // Windows Shortcut (LNK) magic bytes: 4C 00 00 00
    if (
      bytes.length >= 4 &&
      bytes[0] === 0x4c &&
      bytes[1] === 0x00 &&
      bytes[2] === 0x00 &&
      bytes[3] === 0x00
    ) {
      return true;
    }

    const maxCheck = Math.min(bytes.length, 1024);
    let nullCount = 0;
    let controlCount = 0;

    for (let i = 0; i < maxCheck; i++) {
      const code = bytes[i];
      if (code === 0) {
        nullCount++;
      } else if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127) {
        controlCount++;
      }
    }

    // If there are NULL bytes:
    if (nullCount > 0) {
      const nullRatio = nullCount / maxCheck;
      // In UTF-16 text without BOM, ~50% of the bytes are 0x00 (typically 35% - 65%)
      if (nullRatio >= 0.35 && nullRatio <= 0.65) {
        let evenNulls = 0;
        let oddNulls = 0;
        for (let i = 0; i < maxCheck; i++) {
          if (bytes[i] === 0) {
            if (i % 2 === 0) evenNulls++;
            else oddNulls++;
          }
        }
        const dominant = Math.max(evenNulls, oddNulls);
        // In valid UTF-16 text, almost all nulls are consistently either even or odd
        if (dominant / nullCount > 0.85) {
          return false; // Valid UTF-16 text stream
        }
      }
      // Any other file containing NULL bytes is binary data
      return true;
    }

    // If there are no NULL bytes, check control characters:
    // In plain text, non-whitespace control characters (0x01-0x08, 0x0E-0x1F) do not appear.
    // If >1% of characters are control characters, treat as binary.
    if (controlCount / maxCheck > 0.01) {
      return true;
    }

    // Check UTF-8 validity if high bytes (>= 128) are present
    let hasHighBytes = false;
    for (let i = 0; i < maxCheck; i++) {
      if (bytes[i] >= 128) {
        hasHighBytes = true;
        break;
      }
    }

    if (hasHighBytes) {
      // Step back past any split UTF-8 continuation bytes at maxCheck boundary to avoid false syntax errors
      let checkLen = maxCheck;
      while (checkLen > 0 && (bytes[checkLen - 1] & 0xc0) === 0x80) {
        checkLen--;
      }
      if (checkLen > 0 && (bytes[checkLen - 1] & 0x80) !== 0) {
        checkLen--;
      }

      if (checkLen > 0) {
        try {
          new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, checkLen));
        } catch {
          if (controlCount > 0) {
            return true;
          }
        }
      }
    }

    return false;
  }

  /**
   * Detects known binary file signatures (Magic Bytes).
   * Supports Uint8Array, ArrayBuffer, and raw string.
   */
  detectFileSignature(content: string | Uint8Array | ArrayBuffer): DetectedSignature | null {
    if (!content) return null;
    const b = this.toUint8Array(content);
    if (b.length < 4) return null;

    // 1. SQLite Database: "SQLite format 3\0" (16 bytes)
    if (
      b.length >= 16 &&
      b[0] === 0x53 &&
      b[1] === 0x51 &&
      b[2] === 0x4c &&
      b[3] === 0x69 &&
      b[4] === 0x74 &&
      b[5] === 0x65 &&
      b[6] === 0x20 &&
      b[7] === 0x66 &&
      b[8] === 0x6f &&
      b[9] === 0x72 &&
      b[10] === 0x6d &&
      b[11] === 0x61 &&
      b[12] === 0x74 &&
      b[13] === 0x20 &&
      b[14] === 0x33 &&
      b[15] === 0x00
    ) {
      return {
        format: 'sqlite',
        label: 'SQLite 3 Database',
        mimeType: 'application/vnd.sqlite3',
        suggestedCategory: 'binary',
      };
    }

    // 2. Windows Executable / DLL: "MZ" (0x4D 0x5A)
    if (b[0] === 0x4d && b[1] === 0x5a) {
      let isPe = false;
      const peLimit = Math.min(b.length - 4, 1024);
      for (let i = 0; i < peLimit; i++) {
        if (b[i] === 0x50 && b[i + 1] === 0x45 && b[i + 2] === 0x00 && b[i + 3] === 0x00) {
          isPe = true;
          break;
        }
      }
      return {
        format: 'pe_executable',
        label: isPe ? 'Windows Executable / DLL (PE)' : 'DOS / Windows Executable (MZ)',
        mimeType: 'application/x-msdownload',
        suggestedCategory: 'binary',
      };
    }

    // 3. Linux Executable / Shared Library: 0x7F 'E' 'L' 'F' (0x7F 0x45 0x4C 0x46)
    if (b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46) {
      return {
        format: 'elf',
        label: 'Linux Executable / Library (ELF)',
        mimeType: 'application/x-executable',
        suggestedCategory: 'binary',
      };
    }

    // 4. macOS Mach-O: 0xCA 0xFE 0xBA 0xBE or 0xFE 0xED 0xFA 0xCE/CF
    if (
      (b[0] === 0xca && b[1] === 0xfe && b[2] === 0xba && b[3] === 0xbe) ||
      (b[0] === 0xfe && b[1] === 0xed && b[2] === 0xfa && (b[3] === 0xce || b[3] === 0xcf)) ||
      (b[0] === 0xce && b[1] === 0xfa && b[2] === 0xed && b[3] === 0xfe) ||
      (b[0] === 0xcf && b[1] === 0xfa && b[2] === 0xed && b[3] === 0xfe)
    ) {
      return {
        format: 'macho',
        label: 'macOS Mach-O Binary',
        mimeType: 'application/x-mach-binary',
        suggestedCategory: 'binary',
      };
    }

    // 5. Windows Shell Shortcut (.lnk): 4C 00 00 00
    if (b[0] === 0x4c && b[1] === 0x00 && b[2] === 0x00 && b[3] === 0x00) {
      return {
        format: 'lnk',
        label: 'Windows Shortcut (LNK)',
        mimeType: 'application/x-ms-shortcut',
        suggestedCategory: 'binary',
      };
    }

    // 6. PDF Document: "%PDF-" (0x25 0x50 0x44 0x46 0x2D)
    if (
      b.length >= 5 &&
      b[0] === 0x25 &&
      b[1] === 0x50 &&
      b[2] === 0x44 &&
      b[3] === 0x46 &&
      b[4] === 0x2d
    ) {
      return {
        format: 'pdf',
        label: 'PDF Document',
        mimeType: 'application/pdf',
        suggestedCategory: 'binary',
      };
    }

    return null;
  }

  /**
   * Scans binary content of Windows Shortcuts (.lnk) for target paths and environment variables.
   */
  extractLnkTargets(content: string | Uint8Array | ArrayBuffer): string[] {
    if (!content) return [];
    const text = this.toByteString(content);

    const pathRegex = /[a-zA-Z]:\\[^\ufffd\0\r\n\t"]+?(?:\.exe|\.dll|\.lnk|\.bat|\.cmd)/gi;
    const envRegex = /%[a-zA-Z0-9_]+%\\[^\ufffd\0\r\n\t"]+/gi;

    const paths = new Set<string>();
    let match: RegExpExecArray | null;

    while ((match = pathRegex.exec(text)) !== null) {
      paths.add(match[0]);
    }
    while ((match = envRegex.exec(text)) !== null) {
      paths.add(match[0]);
    }

    return Array.from(paths);
  }

  /**
   * Formats LNK targets into a readable string list.
   */
  extractLnkSummary(
    content: string | Uint8Array | ArrayBuffer,
    headerLabel = 'Shortcut Targets'
  ): string {
    const targets = this.extractLnkTargets(content);
    if (targets.length === 0) {
      return typeof content === 'string' ? content : this.toByteString(content);
    }
    let result = `${headerLabel}:\n\n`;
    for (const target of targets) {
      result += `- ${target}\n`;
    }
    return result;
  }

  /**
   * Decodes textual data (Uint8Array, ArrayBuffer, or string) with proper encoding detection:
   * Checks for UTF-8 and UTF-16 BOMs, alternating NULL UTF-16 patterns, or standard UTF-8.
   */
  decodeText(content: string | Uint8Array | ArrayBuffer): string {
    if (!content) return '';
    if (typeof content === 'string') return this.repairText(content);
    const bytes = this.toUint8Array(content);
    if (bytes.length === 0) return '';

    // 1. UTF-8 BOM: EF BB BF
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      return new TextDecoder('utf-8').decode(bytes.subarray(3));
    }
    // 2. UTF-16LE BOM: FF FE
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
      return new TextDecoder('utf-16le').decode(bytes.subarray(2));
    }
    // 3. UTF-16BE BOM: FE FF
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
      return new TextDecoder('utf-16be').decode(bytes.subarray(2));
    }

    // 4. Inspect for UTF-16 text without BOM (~50% NULLs predominantly in even or odd bytes)
    const maxCheck = Math.min(bytes.length, 1024);
    let evenNulls = 0;
    let oddNulls = 0;
    let nullCount = 0;
    for (let i = 0; i < maxCheck; i++) {
      if (bytes[i] === 0) {
        nullCount++;
        if (i % 2 === 0) evenNulls++;
        else oddNulls++;
      }
    }

    const nullRatio = nullCount / maxCheck;
    if (nullRatio >= 0.35 && nullRatio <= 0.65) {
      if (oddNulls / nullCount > 0.85) {
        return new TextDecoder('utf-16le').decode(bytes);
      }
      if (evenNulls / nullCount > 0.85) {
        return new TextDecoder('utf-16be').decode(bytes);
      }
    }

    // 5. Standard UTF-8
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }

  /**
   * Fallback for string-based legacy UTF-16 repair.
   */
  repairText(content: string): string {
    if (!content) return content;

    let nullCount = 0;
    const maxCheck = Math.min(content.length, 1024);
    for (let i = 0; i < maxCheck; i++) {
      if (content.charCodeAt(i) === 0) nullCount++;
    }

    const nullRatio = nullCount / maxCheck;

    if (nullRatio > 0.4 && nullRatio < 0.6) {
      const repaired = content.replace(/^\ufffd\ufffd/, '');
      return repaired.replace(/\0/g, '');
    }

    return content;
  }

  /**
   * Generates a structured Hex Dump (16 bytes per row) for the first N bytes of content.
   */
  generateHexDump(content: string | Uint8Array | ArrayBuffer, maxBytes = 512): HexDumpRow[] {
    if (!content) return [];

    const b = this.toUint8Array(content);
    const limit = Math.min(b.length, maxBytes);
    const rows: HexDumpRow[] = [];

    for (let i = 0; i < limit; i += 16) {
      const chunkLen = Math.min(16, limit - i);
      const hexParts: string[] = [];
      let ascii = '';

      for (let j = 0; j < 16; j++) {
        if (j < chunkLen) {
          const code = b[i + j];
          hexParts.push(code.toString(16).padStart(2, '0').toUpperCase());
          // Printable ASCII range (32-126)
          ascii += code >= 32 && code <= 126 ? String.fromCharCode(code) : '.';
        } else {
          hexParts.push('  ');
          ascii += ' ';
        }
      }

      // Group into 2 columns of 8 bytes
      const hexFormatted = `${hexParts.slice(0, 8).join(' ')}  ${hexParts.slice(8, 16).join(' ')}`;
      const offset = i.toString(16).padStart(8, '0').toUpperCase();

      rows.push({
        offset,
        hex: hexFormatted,
        ascii,
      });
    }

    return rows;
  }

  /**
   * Comprehensive inspection of payload.
   */
  inspect(content: string | Uint8Array | ArrayBuffer, fileName?: string): BinaryInspectionResult {
    let isBinary = this.looksLikeBinary(content);
    const signature = this.detectFileSignature(content);
    if (
      signature &&
      (signature.suggestedCategory === 'binary' || signature.suggestedCategory === 'pdf')
    ) {
      isBinary = true;
    }
    const isLnk = fileName?.toLowerCase().endsWith('.lnk') || signature?.format === 'lnk';

    const shortcutTargets = isLnk ? this.extractLnkTargets(content) : undefined;
    const hexDump = isBinary ? this.generateHexDump(content) : undefined;

    return {
      isBinary,
      signature,
      shortcutTargets,
      hexDump,
    };
  }
}
