import type { WebBook } from '../types';
import type { DocxChapterImageAsset } from './docxExport';

const EXPORT_CLEANUP_SELECTOR = 'button, .print\\:hidden, [data-html2canvas-ignore]';
const EXPORT_FONT_LINKS = '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;700&family=Playfair+Display:ital,wght@0,400;0,700;1,400;1,700&family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet">';

export interface PreparedExportContent {
  clone: HTMLElement;
  chapterImages: Array<DocxChapterImageAsset | null>;
}

export function getWebBookElement(): HTMLElement {
  const element = document.querySelector('.web-book-container') as HTMLElement | null;
  if (!element) {
    throw new Error('No rendered Web-book was found to export.');
  }

  return element;
}

export function getExportFileName(topic: string, extension: string): string {
  return `${topic.replace(/\s+/g, '_')}.${extension}`;
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

function parseDataUrlImage(src: string): DocxChapterImageAsset | null {
  const match = /^data:(image\/(?:jpeg|png|gif));base64,(.+)$/i.exec(src);
  if (!match) return null;

  const [, rawContentType, base64Payload] = match;
  const contentType = rawContentType.toLowerCase() as DocxChapterImageAsset['contentType'];
  const extension = contentType === 'image/png'
    ? 'png'
    : contentType === 'image/gif'
      ? 'gif'
      : 'jpeg';

  const binary = window.atob(base64Payload);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return {
    altText: '',
    bytes,
    contentType,
    extension,
    widthPx: 1,
    heightPx: 1,
  };
}

function collectWordChapterImages(root: HTMLElement): Array<DocxChapterImageAsset | null> {
  return Array.from(root.querySelectorAll<HTMLElement>('[data-pdf-page-kind="chapter"]'))
    .map((chapterSection) => {
      const image = chapterSection.querySelector<HTMLImageElement>('img');
      if (!image?.src) return null;

      const parsed = parseDataUrlImage(image.src);
      if (!parsed) return null;

      const exportedWidth = Number(image.dataset.exportWidth || image.dataset.exportOriginalWidth || image.naturalWidth || image.width || 0);
      const exportedHeight = Number(image.dataset.exportHeight || image.dataset.exportOriginalHeight || image.naturalHeight || image.height || 0);

      return {
        ...parsed,
        altText: image.alt || 'Chapter image',
        widthPx: Math.max(1, Math.round(exportedWidth || 1)),
        heightPx: Math.max(1, Math.round(exportedHeight || 1)),
      };
    });
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function loadImageMetadata(src: string): Promise<{ width: number; height: number; image: HTMLImageElement }> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => resolve({
      width: image.naturalWidth || image.width || 1,
      height: image.naturalHeight || image.height || 1,
      image,
    });
    image.onerror = reject;
    image.src = src;
  });
}

async function inlineImageForExport(image: HTMLImageElement): Promise<void> {
  if (!image.src) {
    return;
  }

  let exportSrc = image.src;
  let metadata = {
    width: image.naturalWidth || image.width || 1,
    height: image.naturalHeight || image.height || 1,
  };

  try {
    const loaded = await loadImageMetadata(image.src);
    metadata = { width: loaded.width, height: loaded.height };

    if (!image.src.startsWith('data:image/')) {
      const canvas = document.createElement('canvas');
      canvas.width = loaded.width;
      canvas.height = loaded.height;
      canvas.getContext('2d')?.drawImage(loaded.image, 0, 0);
      exportSrc = canvas.toDataURL('image/png');
    }
  } catch (inlineError) {
    try {
      const response = await fetch(image.src, { mode: 'cors' });
      if (!response.ok) {
        throw inlineError;
      }

      const blob = await response.blob();
      exportSrc = await blobToDataUrl(blob);
      const loaded = await loadImageMetadata(exportSrc);
      metadata = { width: loaded.width, height: loaded.height };
    } catch (fallbackError) {
      console.error('Failed to inline image for export', fallbackError);
      return;
    }
  }

  image.src = exportSrc;
  image.dataset.exportOriginalWidth = String(Math.max(1, Math.round(metadata.width)));
  image.dataset.exportOriginalHeight = String(Math.max(1, Math.round(metadata.height)));
  image.dataset.exportWidth = String(Math.max(1, Math.round(metadata.width)));
  image.dataset.exportHeight = String(Math.max(1, Math.round(metadata.height)));
  image.style.maxWidth = '100%';
  image.style.height = 'auto';
  image.style.display = 'block';
  image.style.margin = '20px auto';
  image.style.filter = 'none';
  image.className = image.className.replace(/grayscale|hover:grayscale-0/g, '').trim();
}

export async function prepareExportContent(root: HTMLElement): Promise<PreparedExportContent> {
  const clone = root.cloneNode(true) as HTMLElement;
  clone.querySelectorAll(EXPORT_CLEANUP_SELECTOR).forEach((node) => node.remove());

  const images = Array.from(clone.querySelectorAll('img'));
  for (const image of images) {
    await inlineImageForExport(image as HTMLImageElement);
  }

  return {
    clone,
    chapterImages: collectWordChapterImages(clone),
  };
}

function buildHtmlShell(title: string, htmlContent: string, headContent: string, bodyAttributes = ''): string {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>${title}</title>
      <script src="https://cdn.tailwindcss.com"></script>
      ${EXPORT_FONT_LINKS}
      ${headContent}
    </head>
    <body${bodyAttributes}>
      ${htmlContent}
    </body>
    </html>
  `;
}

export function buildStandaloneHtmlDocument(webBook: WebBook, htmlContent: string): string {
  return buildHtmlShell(
    webBook.topic,
    htmlContent,
    `
      <style>
        html { scroll-behavior: smooth; }
        body { font-family: 'Inter', sans-serif; background: #E4E3E0; padding: 40px 16px; margin: 0; overflow-x: hidden; }
        .font-serif { font-family: 'Playfair Display', serif; }
        .font-mono { font-family: 'JetBrains Mono', monospace; }
        * { word-break: break-word; overflow-wrap: break-word; box-sizing: border-box; }
        a { color: inherit; }
        .web-book-container { width: 100%; max-width: 900px; margin: 0 auto; display: flex; flex-direction: column; gap: 32px; }
        .web-book-page { background: white; border: 1px solid #141414; box-shadow: 12px 12px 0 rgba(20, 20, 20, 0.12); overflow: hidden; }
        @media print {
          body { background: white; padding: 0; overflow: visible !important; }
          .web-book-container { max-width: none; gap: 0; overflow: visible !important; }
          .web-book-page { box-shadow: none; break-after: page; page-break-after: always; overflow: visible !important; }
          .web-book-page:last-child { break-after: auto; page-break-after: auto; }
        }
      </style>
    `
  );
}

export function buildPdfHtmlDocument(webBook: WebBook, htmlContent: string): string {
  return buildHtmlShell(
    webBook.topic,
    htmlContent,
    `
      <style>
        body {
          font-family: 'Inter', sans-serif;
          margin: 0;
          padding: 0;
          background: white;
        }
        .font-serif { font-family: 'Playfair Display', serif; }
        .font-mono { font-family: 'JetBrains Mono', monospace; }
        * {
          box-sizing: border-box;
          overflow-wrap: break-word;
        }
        .web-book-container {
          width: 100%;
          max-width: none;
          margin: 0;
          padding: 0;
        }
        .web-book-page {
          break-after: page;
          page-break-after: always;
          padding: 24mm;
        }
        .web-book-page:last-child {
          break-after: auto;
          page-break-after: auto;
        }
        h1, h2, h3, h4 {
          break-after: avoid;
        }
        p, li {
          break-inside: avoid;
        }
        img {
          max-width: 100%;
          break-inside: avoid;
        }
        @page {
          size: A4;
          margin: 0;
        }
      </style>
    `
  );
}

export function buildPrintHtmlDocument(webBook: WebBook, htmlContent: string): string {
  return buildHtmlShell(
    webBook.topic,
    `${htmlContent}
      <script>
        window.onload = () => {
          setTimeout(() => {
            window.print();
          }, 1000);
        };
      </script>`,
    `
      <style>
        html { scroll-behavior: smooth; }
        body { font-family: 'Inter', sans-serif; background: white; padding: 24px 0; margin: 0; }
        .font-serif { font-family: 'Playfair Display', serif; }
        .font-mono { font-family: 'JetBrains Mono', monospace; }
        .print\\:hidden { display: none !important; }
        .web-book-container { width: 100%; max-width: 800px; margin: 0 auto; display: flex; flex-direction: column; gap: 0; }
        .web-book-page { background: white; width: 100%; min-height: 100vh; display: flex; flex-direction: column; position: relative; box-sizing: border-box; }
        @media print {
          body { padding: 0; margin: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; overflow: visible !important; }
          .no-print { display: none; }
          .web-book-page {
            break-after: page;
            page-break-after: always;
            border: none !important;
            box-shadow: none !important;
            margin: 0 !important;
            padding: 1.5cm !important;
            min-height: auto !important;
            height: auto !important;
            box-sizing: border-box !important;
            overflow: visible !important;
          }
          .web-book-page:last-child { break-after: auto; page-break-after: auto; }
          @page { size: A4; margin: 0; }
        }
      </style>
    `
  );
}
