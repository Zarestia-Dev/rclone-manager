import { Injectable } from '@angular/core';
import * as binaryUtil from '../../shared/utils/binary-signature.util';

export type {
  DetectedFormat,
  DetectedSignature,
  HexDumpRow,
  BinaryInspectionResult,
} from '../../shared/utils/binary-signature.util';

@Injectable({
  providedIn: 'root',
})
export class BinaryInspectorService {
  looksLikeBinary(content: string | Uint8Array | ArrayBuffer): boolean {
    return binaryUtil.looksLikeBinary(content);
  }

  detectFileSignature(
    content: string | Uint8Array | ArrayBuffer
  ): binaryUtil.DetectedSignature | null {
    return binaryUtil.detectFileSignature(content);
  }

  extractLnkTargets(content: string | Uint8Array | ArrayBuffer): string[] {
    return binaryUtil.extractLnkTargets(content);
  }

  extractLnkSummary(
    content: string | Uint8Array | ArrayBuffer,
    headerLabel = 'Shortcut Targets'
  ): string {
    return binaryUtil.extractLnkSummary(content, headerLabel);
  }

  decodeText(content: string | Uint8Array | ArrayBuffer): string {
    return binaryUtil.decodeText(content);
  }

  repairText(content: string): string {
    return binaryUtil.repairText(content);
  }

  generateHexDump(
    content: string | Uint8Array | ArrayBuffer,
    maxBytes = 512
  ): binaryUtil.HexDumpRow[] {
    return binaryUtil.generateHexDump(content, maxBytes);
  }

  inspect(
    content: string | Uint8Array | ArrayBuffer,
    fileName?: string
  ): binaryUtil.BinaryInspectionResult {
    return binaryUtil.inspectBinary(content, fileName);
  }
}
