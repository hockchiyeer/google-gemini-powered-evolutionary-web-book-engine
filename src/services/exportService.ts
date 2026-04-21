import type { WebBook } from '../types';
import { buildWebBookDocx } from './docxExport';
import { getWebBookDocumentTitle } from './documentTitle';
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

  downloadBlob(
    new Blob([text], { type: 'text/plain' }),
    getExportFileName(webBook.topic, 'txt')
  );
}

export async function exportWebBookToHtml(webBook: WebBook): Promise<void> {
  const { clone } = await prepareExportContent(getWebBookElement());
  const blob = new Blob([buildStandaloneHtmlDocument(webBook, clone.outerHTML)], { type: 'text/html' });
  downloadBlob(blob, getExportFileName(webBook.topic, 'html'));
}

export async function exportWebBookToWord(webBook: WebBook): Promise<void> {
  const { chapterImages } = await prepareExportContent(getWebBookElement());
  const blob = new Blob([buildWebBookDocx(webBook, chapterImages)], {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });

  downloadBlob(blob, getExportFileName(webBook.topic, 'docx'));
}

export async function exportWebBookToPdf(webBook: WebBook): Promise<void> {
  const { clone } = await prepareExportContent(getWebBookElement());
  
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
        html: buildPdfHtmlDocument(webBook, clone.outerHTML),
        fileName: webBook.topic.replace(/\s+/g, '_'),
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      throw new Error(`PDF export failed: ${errorText}`);
    }

    const blob = await response.blob();
    downloadBlob(blob, getExportFileName(webBook.topic, 'pdf'));
  } catch (error: any) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      throw new Error('PDF export timed out. The document might be too large or contain slow-loading assets.');
    }
    throw error;
  }
}

export async function printWebBook(webBook: WebBook): Promise<void> {
  const { clone } = await prepareExportContent(getWebBookElement());
  const htmlContent = buildPrintHtmlDocument(webBook, clone.outerHTML);
  const printTitle = getWebBookDocumentTitle(webBook.topic);

  const iframe = document.createElement('iframe');
  iframe.style.position = 'fixed';
  iframe.style.right = '0';
  iframe.style.bottom = '0';
  iframe.style.width = '0';
  iframe.style.height = '0';
  iframe.style.border = '0';
  iframe.title = printTitle;
  iframe.name = printTitle;
  document.body.appendChild(iframe);

  const iframeWindow = iframe.contentWindow;
  const iframeDoc = iframeWindow?.document;

  if (!iframeWindow || !iframeDoc) {
    document.body.removeChild(iframe);
    throw new Error('Failed to create print frame.');
  }

  const originalTitle = document.title;
  document.title = printTitle;

  let printDelayTimer = 0;
  let cleanupFallbackTimer = 0;
  let isCleanedUp = false;

  const cleanup = () => {
    if (isCleanedUp) {
      return;
    }

    isCleanedUp = true;
    window.clearTimeout(printDelayTimer);
    window.clearTimeout(cleanupFallbackTimer);
    window.removeEventListener('afterprint', cleanup);
    iframeWindow.removeEventListener('afterprint', cleanup);
    document.title = originalTitle;

    if (iframe.parentNode) {
      iframe.parentNode.removeChild(iframe);
    }
  };

  window.addEventListener('afterprint', cleanup);
  iframeWindow.addEventListener('afterprint', cleanup);

  iframeDoc.open();
  iframeDoc.write(htmlContent);
  iframeDoc.title = printTitle;

  // Wait for resources to load in the iframe before printing
  iframeWindow.onload = () => {
    iframeWindow.document.title = printTitle;
    cleanupFallbackTimer = window.setTimeout(cleanup, 300_000);
    printDelayTimer = window.setTimeout(() => {
      iframeWindow.focus();
      iframeWindow.print();
    }, 500);
  };

  iframeDoc.close();
}
