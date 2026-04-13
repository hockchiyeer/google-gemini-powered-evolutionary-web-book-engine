import type { WebBook } from '../types';
import { buildWebBookDocx } from './docxExport';
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
  const response = await fetch('/__pdf', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      html: buildPdfHtmlDocument(webBook, clone.outerHTML),
      fileName: webBook.topic.replace(/\s+/g, '_'),
    }),
  });

  if (!response.ok) {
    throw new Error('PDF export failed');
  }

  const blob = await response.blob();
  downloadBlob(blob, getExportFileName(webBook.topic, 'pdf'));
}

export async function printWebBook(webBook: WebBook): Promise<void> {
  const printWindow = window.open('', '_blank');
  if (!printWindow) {
    alert('Please allow popups to use the print feature.');
    return;
  }

  const { clone } = await prepareExportContent(getWebBookElement());
  printWindow.document.write(buildPrintHtmlDocument(webBook, clone.outerHTML));
  printWindow.document.close();
}
