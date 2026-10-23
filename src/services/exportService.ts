import type { WebBook } from '../types';
import { buildWebBookDocx } from './docxExport';
import { getWebBookDocumentTitle } from './documentTitle';
import { sanitizeWebBookForPresentation } from '../utils/webBookRender';
import {
  buildPdfHtmlDocument,
  buildPrintHtmlDocument,
  buildStandaloneHtmlDocument,
  downloadBlob,
  getExportFileName,
  getWebBookElement,
  prepareExportContent,
} from './exportDocument';

function formatSourceLink(source: string | { title: string; url: string }): string {
  return typeof source === 'string' ? source : `${source.title} - ${source.url}`;
}

export async function exportWebBookToTxt(webBook: WebBook): Promise<void> {
  const safeWebBook = sanitizeWebBookForPresentation(webBook);
  let text = `${safeWebBook.topic.toUpperCase()}\n`;
  text += `Generated on: ${new Date(safeWebBook.timestamp).toLocaleString()}\n\n`;

  safeWebBook.chapters.forEach((chapter, index) => {
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

  downloadBlob(
    new Blob([text], { type: 'text/plain' }),
    getExportFileName(safeWebBook.topic, 'txt')
  );
}

export async function exportWebBookToHtml(webBook: WebBook): Promise<void> {
  const safeWebBook = sanitizeWebBookForPresentation(webBook);
  const { clone } = await prepareExportContent(getWebBookElement());
  const blob = new Blob([buildStandaloneHtmlDocument(safeWebBook, clone.outerHTML)], { type: 'text/html' });
  downloadBlob(blob, getExportFileName(safeWebBook.topic, 'html'));
}

export async function exportWebBookToWord(webBook: WebBook): Promise<void> {
  const safeWebBook = sanitizeWebBookForPresentation(webBook);
  const { chapterImages } = await prepareExportContent(getWebBookElement());
  const blob = new Blob([buildWebBookDocx(safeWebBook, chapterImages)], {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });

  downloadBlob(blob, getExportFileName(safeWebBook.topic, 'docx'));
}

export async function exportWebBookToPdf(webBook: WebBook): Promise<void> {
  const safeWebBook = sanitizeWebBookForPresentation(webBook);
  const { clone } = await prepareExportContent(getWebBookElement(), { inlineImages: false });

  // Increase fetch timeout for PDF generation to 5 minutes
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 300000); // 5 minutes

  try {
    const response = await fetch('/__pdf', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        html: buildPdfHtmlDocument(safeWebBook, clone.outerHTML),
        fileName: safeWebBook.topic.replace(/\s+/g, '_'),
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      throw new Error(`PDF export failed: ${errorText}`);
    }

    const blob = await response.blob();
    downloadBlob(blob, getExportFileName(safeWebBook.topic, 'pdf'));
  } catch (error: any) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      throw new Error('PDF export timed out. The document might be too large or contain slow-loading assets.');
    }
    throw error;
  }
}

export async function printWebBook(webBook: WebBook): Promise<void> {
  const safeWebBook = sanitizeWebBookForPresentation(webBook);
  const { clone } = await prepareExportContent(getWebBookElement());
  const htmlContent = buildPrintHtmlDocument(safeWebBook, clone.outerHTML);
  const printTitle = getWebBookDocumentTitle(safeWebBook.topic);
  const printFileName = getExportFileName(safeWebBook.topic, 'pdf');

  const iframe = document.createElement('iframe');
  iframe.style.position = 'fixed';
  iframe.style.right = '0';
  iframe.style.bottom = '0';
  iframe.style.width = '0';
  iframe.style.height = '0';
  iframe.style.border = '0';
  iframe.title = printTitle;
  iframe.name = printFileName;
  document.body.appendChild(iframe);

  const iframeWindow = iframe.contentWindow;
  const iframeDoc = iframeWindow?.document;

  if (iframeWindow && iframeDoc) {
    try {
      iframeDoc.open();
      iframeDoc.write(htmlContent);
      iframeDoc.title = printTitle;
      iframeDoc.close();

      try {
        iframeWindow.focus();
        iframeWindow.print();
      } catch (printErr) {
        console.warn('System print dialog unavailable or blocked in iframe context:', printErr);
      }
    } catch (frameErr) {
      console.warn('Failed to write to print iframe:', frameErr);
    } finally {
      setTimeout(() => {
        if (iframe.parentNode) {
          iframe.parentNode.removeChild(iframe);
        }
      }, 1000);
    }
  } else if (iframe.parentNode) {
    document.body.removeChild(iframe);
  }
}
