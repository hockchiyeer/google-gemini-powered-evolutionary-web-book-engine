import html2canvas from 'html2canvas';
import { jsPDF } from 'jspdf';
import type { WebBook } from '../types';

type PdfLinkAnnotation = {
  sourcePageNumber: number;
  xRatio: number;
  yRatio: number;
  widthRatio: number;
  heightRatio: number;
} & ({
  targetPageNumber: number;
} | {
  externalUrl: string;
});

const PDF_EXPORT_PAGE_WIDTH = 794;
const PDF_EXPORT_PAGE_HEIGHT = 1123;
const PDF_IMAGE_MAX_DIMENSION = 1600;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function getPdfRenderScale(pageCount: number): number {
  if (pageCount >= 40) return 0.8;
  if (pageCount >= 30) return 0.95;
  if (pageCount >= 20) return 1.1;
  if (pageCount >= 12) return 1.3;
  if (pageCount >= 8) return 1.5;
  if (pageCount >= 5) return 1.7;
  return 1.9;
}

function getWebBookElement(): HTMLElement {
  const element = document.querySelector('.web-book-container') as HTMLElement | null;
  if (!element) {
    throw new Error('No rendered Web-book was found to export.');
  }
  return element;
}

function formatSourceLink(source: string | { title: string; url: string }): string {
  return typeof source === 'string' ? source : `${source.title} - ${source.url}`;
}

async function inlineImagesForExport(
  root: HTMLElement,
  options: { maxDimension: number; quality: number; hideOnError?: boolean }
): Promise<void> {
  const images = Array.from(root.querySelectorAll('img'));

  await Promise.all(
    images.map(async (img) => {
      try {
        if (!img.src || img.src.startsWith('data:') || img.style.display === 'none') return;

        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        const tempImg = new Image();
        tempImg.crossOrigin = 'anonymous';

        await new Promise((resolve, reject) => {
          const timeout = window.setTimeout(() => reject(new Error('Image load timeout')), 7000);
          tempImg.onload = () => {
            window.clearTimeout(timeout);
            resolve(null);
          };
          tempImg.onerror = () => {
            window.clearTimeout(timeout);
            reject(new Error('Image load error'));
          };
          tempImg.src = img.src;
        });

        const originalWidth = tempImg.naturalWidth || tempImg.width;
        const originalHeight = tempImg.naturalHeight || tempImg.height;
        if (!ctx || !originalWidth || !originalHeight) {
          throw new Error('Image dimensions unavailable');
        }

        let width = originalWidth;
        let height = originalHeight;
        if (width > options.maxDimension || height > options.maxDimension) {
          if (width > height) {
            height = Math.round((height / width) * options.maxDimension);
            width = options.maxDimension;
          } else {
            width = Math.round((width / height) * options.maxDimension);
            height = options.maxDimension;
          }
        }

        canvas.width = width;
        canvas.height = height;
        ctx.drawImage(tempImg, 0, 0, width, height);
        img.src = canvas.toDataURL('image/jpeg', options.quality);
        img.style.filter = 'none';
        img.style.boxShadow = 'none';
        img.className = img.className.replace(/grayscale|hover:grayscale-0/g, '');
      } catch (error) {
        console.warn('Skipping image during export preprocessing:', error);
        if (options.hideOnError) {
          img.style.display = 'none';
        }
      }
    })
  );
}

function createHiddenExportClone(element: HTMLElement): { clone: HTMLElement; cleanup: () => void } {
  const wrapper = document.createElement('div');
  wrapper.setAttribute('aria-hidden', 'true');
  Object.assign(wrapper.style, {
    position: 'fixed',
    left: '-20000px',
    top: '0',
    width: `${PDF_EXPORT_PAGE_WIDTH}px`,
    zIndex: '-1',
    pointerEvents: 'none',
    background: 'white',
  });

  const clone = element.cloneNode(true) as HTMLElement;
  clone.style.width = `${PDF_EXPORT_PAGE_WIDTH}px`;
  clone.style.maxWidth = `${PDF_EXPORT_PAGE_WIDTH}px`;
  clone.style.margin = '0';
  clone.style.padding = '0';
  clone.style.background = 'transparent';
  clone.style.boxShadow = 'none';
  clone.style.border = 'none';
  clone.style.gap = '0';

  clone.querySelectorAll<HTMLElement>('[data-pdf-page-number]').forEach((page) => {
    page.style.width = `${PDF_EXPORT_PAGE_WIDTH}px`;
    page.style.minHeight = `${PDF_EXPORT_PAGE_HEIGHT}px`;
    page.style.margin = '0';
    page.style.borderRadius = '0';
    page.style.boxShadow = 'none';
    page.style.overflow = 'hidden';
    page.style.setProperty('break-inside', 'avoid');
    page.style.pageBreakAfter = 'always';
  });

  wrapper.appendChild(clone);
  document.body.appendChild(wrapper);

  return {
    clone,
    cleanup: () => wrapper.remove(),
  };
}

function prepareWordFooterForExport(root: HTMLElement): void {
  const footerSection = root.querySelector<HTMLElement>('[data-pdf-page-kind="footer"]');
  if (!footerSection) return;

  footerSection.style.padding = '40px 40px 28px';
  footerSection.style.minHeight = '170px';
  footerSection.style.display = 'flex';
  footerSection.style.flexDirection = 'column';
  footerSection.style.justifyContent = 'space-between';
  footerSection.style.gap = '16px';

  const footerRow = footerSection.firstElementChild as HTMLElement | null;
  const footerPageNumber = footerSection.lastElementChild as HTMLElement | null;
  const footerMeta = footerRow?.firstElementChild as HTMLElement | null;
  const footerLink = footerRow?.querySelector<HTMLElement>('a[href="#top"]');

  if (footerRow && footerMeta && footerLink) {
    const table = document.createElement('table');
    table.setAttribute('role', 'presentation');
    table.style.width = '100%';
    table.style.borderCollapse = 'collapse';
    table.style.borderSpacing = '0';

    const row = document.createElement('tr');
    const leftCell = document.createElement('td');
    const rightCell = document.createElement('td');

    leftCell.style.padding = '0';
    leftCell.style.verticalAlign = 'bottom';
    rightCell.style.padding = '0';
    rightCell.style.verticalAlign = 'bottom';
    rightCell.style.textAlign = 'right';
    rightCell.style.whiteSpace = 'nowrap';

    footerLink.style.display = 'inline-block';
    footerLink.style.fontWeight = '700';
    footerLink.style.letterSpacing = '0.12em';
    footerLink.style.textTransform = 'uppercase';

    leftCell.appendChild(footerMeta);
    rightCell.appendChild(footerLink);
    row.append(leftCell, rightCell);
    table.appendChild(row);
    footerRow.replaceWith(table);
  }

  if (footerPageNumber) {
    footerPageNumber.style.marginTop = '0';
    footerPageNumber.style.textAlign = 'left';
  }
}

function collectPdfLinkAnnotations(root: HTMLElement): PdfLinkAnnotation[] {
  const internalLinks = Array.from(root.querySelectorAll<HTMLElement>('[data-pdf-target-page]'));
  const externalLinks = Array.from(root.querySelectorAll<HTMLAnchorElement>('a[href]'))
    .filter((anchor) => /^https?:\/\//i.test(anchor.href));

  return [...internalLinks, ...externalLinks]
    .map((element) => {
      const sourcePage = element.closest<HTMLElement>('[data-pdf-page-number]');
      const sourcePageNumber = Number(sourcePage?.dataset.pdfPageNumber);

      if (!sourcePage || !Number.isFinite(sourcePageNumber)) {
        return null;
      }

      const sourceRect = sourcePage.getBoundingClientRect();
      const elementRect = element.getBoundingClientRect();
      if (!sourceRect.width || !sourceRect.height || !elementRect.width || !elementRect.height) {
        return null;
      }

      const baseAnnotation = {
        sourcePageNumber,
        xRatio: (elementRect.left - sourceRect.left) / sourceRect.width,
        yRatio: (elementRect.top - sourceRect.top) / sourceRect.height,
        widthRatio: elementRect.width / sourceRect.width,
        heightRatio: elementRect.height / sourceRect.height,
      };

      if (element instanceof HTMLAnchorElement && /^https?:\/\//i.test(element.href)) {
        return {
          ...baseAnnotation,
          externalUrl: element.href,
        };
      }

      const targetPageNumber = Number(element.dataset.pdfTargetPage);
      if (!Number.isFinite(targetPageNumber)) {
        return null;
      }

      return {
        ...baseAnnotation,
        targetPageNumber,
      };
    })
    .filter((annotation): annotation is PdfLinkAnnotation => Boolean(annotation));
}

export async function exportWebBookToTxt(webBook: WebBook): Promise<void> {
  let text = `${webBook.topic.toUpperCase()}\n`;
  text += `Generated on: ${new Date(webBook.timestamp).toLocaleString()}\n\n`;

  webBook.chapters.forEach((chapter, index) => {
    text += `CHAPTER ${index + 1}: ${chapter.title}\n`;
    text += `${'='.repeat(chapter.title.length + 11)}\n\n`;
    text += `${chapter.content}\n\n`;
    text += `VISUAL CONCEPT: ${chapter.visualSeed}\n\n`;
    text += 'CORE CONCEPTS:\n';
    chapter.definitions.forEach((definition) => {
      text += `- ${definition.term}: ${definition.description}\n`;
    });
    text += '\nSUB-TOPICS:\n';
    chapter.subTopics.forEach((subTopic) => {
      text += `- ${subTopic.title}: ${subTopic.summary}\n`;
    });
    text += '\nSOURCES:\n';
    chapter.sourceUrls.forEach((sourceUrl) => {
      text += `- ${formatSourceLink(sourceUrl)}\n`;
    });
    text += '\n\n';
  });

  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${webBook.topic.replace(/\s+/g, '_')}.txt`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export async function exportWebBookToHtml(webBook: WebBook): Promise<void> {
  const htmlContent = getWebBookElement().outerHTML;

  const fullHtml = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>${webBook.topic}</title>
      <script src="https://cdn.tailwindcss.com"></script>
      <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;700&family=Playfair+Display:ital,wght@0,400;0,700;1,400;1,700&family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet">
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
    </head>
    <body>
      ${htmlContent}
    </body>
    </html>
  `;

  const blob = new Blob([fullHtml], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${webBook.topic.replace(/\s+/g, '_')}.html`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export async function exportWebBookToWord(webBook: WebBook): Promise<void> {
  const element = getWebBookElement();
  const clone = element.cloneNode(true) as HTMLElement;

  clone.querySelectorAll('button, .print\\:hidden, [data-html2canvas-ignore]').forEach((node) => node.remove());

  const images = clone.querySelectorAll('img');
  for (const image of Array.from(images)) {
    try {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      const tempImg = new Image();
      tempImg.crossOrigin = 'anonymous';

      await new Promise((resolve, reject) => {
        tempImg.onload = resolve;
        tempImg.onerror = reject;
        tempImg.src = image.src;
      });

      canvas.width = tempImg.width;
      canvas.height = tempImg.height;
      ctx?.drawImage(tempImg, 0, 0);
      image.src = canvas.toDataURL('image/jpeg', 0.8);
      image.style.filter = 'none';
      image.className = image.className.replace(/grayscale|hover:grayscale-0/g, '');
    } catch (error) {
      console.error('Failed to convert image to base64 for Word export', error);
      try {
        const response = await fetch(image.src, { mode: 'cors' });
        if (response.ok) {
          const blob = await response.blob();
          const base64 = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result as string);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          });
          image.src = base64;
        }
      } catch (fallbackError) {
        console.error('Fetch fallback also failed', fallbackError);
      }
    }

    image.style.maxWidth = '100%';
    image.style.height = 'auto';
    image.style.display = 'block';
    image.style.margin = '20px auto';
  }

  clone.querySelectorAll('[id]').forEach((node) => {
    const id = node.getAttribute('id');
    if (!id) return;

    const anchor = document.createElement('a');
    anchor.setAttribute('name', id);
    node.prepend(anchor);
  });

  if (!clone.querySelector('a[name="top"]')) {
    const topAnchor = document.createElement('a');
    topAnchor.setAttribute('name', 'top');
    clone.prepend(topAnchor);
  }

  prepareWordFooterForExport(clone);

  const htmlContent = clone.outerHTML;
  const header = "<html xmlns:o='urn:schemas-microsoft-com:office:office' " +
    "xmlns:w='urn:schemas-microsoft-com:office:word' " +
    "xmlns='http://www.w3.org/TR/REC-html40'>" +
    "<head><meta charset='utf-8'><title>WebBook Export</title>" +
    "<style>" +
    "body { font-family: 'Arial', sans-serif; } " +
    "img { max-width: 100%; height: auto; display: block; margin: 20px auto; } " +
    "h2, h3, h4 { font-family: 'Georgia', serif; } " +
    "a { text-decoration: none; color: inherit; } " +
    ".font-mono { font-family: 'Courier New', monospace; } " +
    "</style></head><body>";
  const footer = '</body></html>';
  const sourceHtml = header + htmlContent + footer;

  const blob = new Blob(['\ufeff', sourceHtml], {
    type: 'application/msword',
  });

  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${webBook.topic.replace(/\s+/g, '_')}.doc`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export async function exportWebBookToPdf(webBook: WebBook): Promise<void> {
  const element = getWebBookElement();
  await wait(150);

  let cleanup: (() => void) | null = null;

  try {
    const hiddenClone = createHiddenExportClone(element);
    cleanup = hiddenClone.cleanup;
    const { clone } = hiddenClone;

    await wait(100);
    await inlineImagesForExport(clone, {
      maxDimension: PDF_IMAGE_MAX_DIMENSION,
      quality: 0.84,
      hideOnError: true,
    });
    await wait(100);

    const linkAnnotations = collectPdfLinkAnnotations(clone);
    const pages = Array.from(clone.querySelectorAll<HTMLElement>('[data-pdf-page-number]'));
    if (pages.length === 0) {
      throw new Error('No paged content found for PDF export');
    }

    await document.fonts?.ready?.catch(() => undefined);

    const pdf = new jsPDF({
      unit: 'mm',
      format: 'a4',
      orientation: 'portrait',
      compress: true,
      putOnlyUsedFonts: true,
    });
    const pdfWidth = pdf.internal.pageSize.getWidth();
    const pdfHeight = pdf.internal.pageSize.getHeight();
    const renderScale = getPdfRenderScale(pages.length);

    for (const [index, page] of pages.entries()) {
      if (index > 0) {
        pdf.addPage();
      }

      const canvas = await html2canvas(page, {
        scale: renderScale,
        useCORS: true,
        logging: false,
        backgroundColor: '#ffffff',
        imageTimeout: 15000,
        removeContainer: true,
        foreignObjectRendering: false,
        windowWidth: PDF_EXPORT_PAGE_WIDTH,
        scrollX: 0,
        scrollY: 0,
      });

      const imageData = canvas.toDataURL('image/jpeg', 0.92);
      pdf.addImage(imageData, 'JPEG', 0, 0, pdfWidth, pdfHeight, undefined, 'MEDIUM');
      canvas.width = 0;
      canvas.height = 0;

      const sourcePageNumber = Number(page.dataset.pdfPageNumber);
      if (!Number.isFinite(sourcePageNumber)) continue;

      linkAnnotations
        .filter((annotation) => annotation.sourcePageNumber === sourcePageNumber)
        .forEach((annotation) => {
          const rect = [
            annotation.xRatio * pdfWidth,
            annotation.yRatio * pdfHeight,
            annotation.widthRatio * pdfWidth,
            annotation.heightRatio * pdfHeight,
          ] as const;

          if ('externalUrl' in annotation) {
            pdf.link(rect[0], rect[1], rect[2], rect[3], { url: annotation.externalUrl });
            return;
          }

          pdf.link(rect[0], rect[1], rect[2], rect[3], { pageNumber: annotation.targetPageNumber });
        });

      await wait(0);
    }

    pdf.save(`${webBook.topic.replace(/\s+/g, '_')}.pdf`);
  } catch (error) {
    console.error('PDF Export failed:', error);
    alert("High-res PDF export still hit a browser limit before finishing. The exporter now renders one page at a time, but very large books or blocked remote images can still fail. Please use 'Print / Save as PDF' as the fallback if needed.");
  } finally {
    cleanup?.();
  }
}

export async function printWebBook(webBook: WebBook): Promise<void> {
  const htmlContent = getWebBookElement().outerHTML;
  const printWindow = window.open('', '_blank');
  if (!printWindow) {
    alert('Please allow popups to use the print feature.');
    return;
  }

  printWindow.document.write(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>${webBook.topic}</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;700&family=Playfair+Display:ital,wght@0,400;0,700;1,400;1,700&display=swap" rel="stylesheet">
        <style>
          html { scroll-behavior: smooth; }
          body { font-family: 'Inter', sans-serif; background: white; padding: 24px 0; margin: 0; }
          .font-serif { font-family: 'Playfair Display', serif; }
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
      </head>
      <body>
        ${htmlContent}
        <script>
          window.onload = () => {
            setTimeout(() => {
              window.print();
            }, 1000);
          };
        </script>
      </body>
    </html>
  `);
  printWindow.document.close();
}
