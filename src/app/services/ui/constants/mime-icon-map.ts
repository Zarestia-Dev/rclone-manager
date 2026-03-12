/**
 * Comprehensive MIME type to Adwaita icon mapping.
 */
export const MIME_TO_ICON_MAP: Record<string, string> = {
  // --- Archives ---
  'application/zip': 'package-x-generic',
  'application/x-tar': 'package-x-generic',
  'application/gzip': 'package-x-generic',
  'application/x-7z-compressed': 'package-x-generic',
  'application/x-rar-compressed': 'package-x-generic',
  'application/x-bzip2': 'package-x-generic',
  'application/x-xz': 'package-x-generic',
  'application/vnd.android.package-archive': 'android-package-archive',
  'application/vnd.appimage': 'application-x-iso9600-appimage',
  'application/x-deb': 'application-x-deb',
  'application/x-rpm': 'application-x-rpm',
  'application/java-archive': 'application-x-java-archive',
  'application/x-java-archive': 'application-x-java-archive',
  'application/x-iso9660-image': 'application-x-cd-image',
  'application/x-cd-image': 'application-x-cd-image',

  // --- Programming Languages ---
  'text/x-python': 'text-x-python',
  'application/x-python': 'text-x-python',
  'text/x-java': 'text-x-java',
  'text/x-java-source': 'text-x-java',
  'application/javascript': 'text-x-javascript',
  'text/javascript': 'text-x-javascript',
  'text/x-typescript': 'text-x-typescript',
  'text/x-c': 'text-x-c',
  'text/x-cpp': 'text-x-cpp',
  'text/x-csharp': 'text-x-csharp',
  'text/x-go': 'text-x-go',
  'text/x-rust': 'text-rust',
  'text/x-ruby': 'text-x-ruby',
  'text/x-php': 'application-x-php',
  'text/x-perl': 'application-x-perl',
  'text/x-lua': 'text-x-lua',
  'text/x-shellscript': 'application-x-shellscript',

  // --- Markup & Data ---
  'text/html': 'application-xml',
  'text/xml': 'application-xml',
  'application/xml': 'application-xml',
  'text/x-yaml': 'application-x-yaml',
  'application/json': 'application-json',
  'text/markdown': 'text-x-markdown',
  'text/x-makefile': 'text-x-makefile',
  'text/css': 'text-css',

  // --- Office Documents ---
  'application/pdf': 'application-pdf',
  'application/msword': 'x-office-document',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'x-office-document',
  'application/vnd.oasis.opendocument.text': 'oasis-text',
  'application/vnd.oasis.opendocument.spreadsheet': 'oasis-spreadsheet',
  'application/vnd.oasis.opendocument.presentation': 'oasis-presentation',

  // --- Media Categories ---
  'image/jpeg': 'image-x-generic',
  'image/png': 'image-x-generic',
  'image/gif': 'image-x-generic',
  'image/svg+xml': 'image-x-generic',
  'audio/mpeg': 'audio-x-generic',
  'audio/ogg': 'audio-x-generic',
  'audio/wav': 'audio-x-generic',
  'video/mp4': 'video-x-generic',
  'video/mpeg': 'video-x-generic',
  'video/webm': 'video-x-generic',

  // --- Fonts ---
  'font/ttf': 'font-x-generic',
  'font/otf': 'font-x-generic',
  'application/x-font-ttf': 'font-x-generic',

  // --- Virtualization ---
  'application/x-virtualbox-vdi': 'virtualbox-vdi',
  'application/x-virtualbox-vbox': 'virtualbox-vbox',
};

/**
 * Get icon name for a MIME type with intelligent fallbacks.
 */
export function getIconForMimeType(mimeType: string): string | null {
  if (!mimeType) return null;
  const normalized = mimeType.toLowerCase().trim().split(';')[0];
  return MIME_TO_ICON_MAP[normalized] || null;
}

/**
 * Get generic fallback icon based on MIME type category.
 */
export function getGenericIconForMimeType(mimeType: string): string {
  if (!mimeType) return 'text-x-generic';
  const category = mimeType.split('/')[0].toLowerCase();

  const categoryMap: Record<string, string> = {
    text: 'text-x-generic',
    image: 'image-x-generic',
    audio: 'audio-x-generic',
    video: 'video-x-generic',
    font: 'font-x-generic',
    application: 'package-x-generic',
    model: 'application-x-model',
  };

  return categoryMap[category] || 'text-x-generic';
}
