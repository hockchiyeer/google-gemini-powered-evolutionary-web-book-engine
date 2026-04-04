import React from 'react';
import { ArrowUpRight, BookOpen, CheckCircle2, Image as ImageIcon, Layers } from 'lucide-react';
import type { WebBook } from '../types';
import { buildChapterRenderPlan, getChapterSourceLinks, normalizeSourceLink } from '../utils/webBookRender';

interface WebBookViewerProps {
  webBook: WebBook;
}

export function WebBookViewer({ webBook }: WebBookViewerProps) {
  const chapterRenderPlan = buildChapterRenderPlan(webBook.chapters);
  const finalDocumentPageNumber = chapterRenderPlan.length > 0
    ? (chapterRenderPlan[chapterRenderPlan.length - 1].analysisPageNumber ?? chapterRenderPlan[chapterRenderPlan.length - 1].titlePageNumber) + 1
    : 3;

  return (
    <div className="web-book-container w-full max-w-[900px] space-y-8 overflow-x-hidden print:max-w-none print:space-y-0 print:block print:overflow-visible" id="top">
      <section id="page-1" data-pdf-page-number="1" data-pdf-page-kind="cover" className="web-book-page bg-[#141414] text-[#E4E3E0] p-16 relative overflow-hidden text-center min-h-[1000px] md:min-h-[1123px] flex flex-col justify-center border border-[#141414] shadow-[12px_12px_0px_0px_rgba(20,20,20,0.18)] print:shadow-none print:border-none print:block print:min-h-0 print:h-auto print:page-break-after-always">
        <div className="relative z-10">
          <div className="flex flex-col items-center gap-4 mb-8">
            <div className="w-12 h-12 border-2 border-[#E4E3E0] flex items-center justify-center rotate-45">
              <Layers size={24} className="-rotate-45" />
            </div>
            <span className="text-[10px] uppercase tracking-[0.5em] opacity-60">Evolutionary Web-Book Engine</span>
          </div>
          <h2 className="text-5xl md:text-7xl font-serif italic font-bold tracking-tighter leading-tight mb-8 break-words">{webBook.topic}</h2>
          <div className="w-24 h-1 bg-[#E4E3E0] mx-auto mb-12 opacity-30" />
          <div className="flex justify-center gap-16">
            <div className="flex flex-col">
              <span className="text-[9px] uppercase opacity-50 mb-2 tracking-widest">Chapters</span>
              <span className="text-3xl font-mono">{webBook.chapters.length}</span>
            </div>
            <div className="flex flex-col">
              <span className="text-[9px] uppercase opacity-50 mb-2 tracking-widest">Concepts</span>
              <span className="text-3xl font-mono">{webBook.chapters.reduce((accumulator, chapter) => accumulator + chapter.definitions.length, 0)}</span>
            </div>
            <div className="flex flex-col">
              <span className="text-[9px] uppercase opacity-50 mb-2 tracking-widest">Date</span>
              <span className="text-3xl font-mono">{new Date(webBook.timestamp).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}</span>
            </div>
          </div>
        </div>
        <div className="absolute top-0 left-0 w-full h-full opacity-10 pointer-events-none">
          <div className="absolute top-10 left-10 w-80 h-80 border border-white rounded-full" />
          <div className="absolute bottom-10 right-10 w-96 h-96 border border-white rounded-full" />
        </div>
        <div className="absolute bottom-12 left-1/2 -translate-x-1/2 text-[10px] font-mono opacity-40 print:hidden">PAGE 1</div>
      </section>

      <section id="page-2" data-pdf-page-number="2" data-pdf-page-kind="toc" className="web-book-page p-12 md:p-20 bg-[#FAFAFA] min-h-[1000px] md:min-h-[1123px] flex flex-col relative border border-[#141414] shadow-[12px_12px_0px_0px_rgba(20,20,20,0.12)] print:shadow-none print:border-none print:block print:min-h-0 print:h-auto print:page-break-after-always">
        <h3 className="text-[14px] uppercase font-bold mb-16 tracking-[0.3em] border-b-2 border-[#141414] pb-6 inline-block self-start">Table of Contents</h3>
        <div className="space-y-8 flex-1">
          {chapterRenderPlan.map(({ chapter, titlePageNumber }, index) => (
            <a key={chapter.title + index} href={`#chapter-${index}`} data-pdf-target-page={titlePageNumber} title={`Navigate to Chapter ${index + 1}`} className="flex items-end gap-4 md:gap-6 group">
              <span className="font-mono text-base opacity-40">0{index + 1}</span>
              <span className="text-lg md:text-xl font-medium group-hover:underline underline-offset-8 decoration-1 break-words">{chapter.title}</span>
              <div className="flex-1 border-b border-dotted border-[#141414] opacity-20 mb-2" />
              <span className="font-mono text-base opacity-40">P.{titlePageNumber}</span>
            </a>
          ))}
        </div>
        <div className="mt-auto pt-12 flex justify-center text-[10px] font-mono opacity-40 print:hidden">PAGE 2</div>
      </section>

      <div className="space-y-8">
        {chapterRenderPlan.map(({ chapter, titlePageNumber, analysisPageNumber, renderableDefinitions, renderableSubTopics }, index) => {
          const sourceLinks = getChapterSourceLinks(chapter, { maxItems: 5 });
          const externalSourceLinks = getChapterSourceLinks(chapter, { includeSearchResults: false, maxItems: 4 });
          const verificationSource = externalSourceLinks[0] || sourceLinks[0] || null;

          return (
            <React.Fragment key={chapter.title + titlePageNumber}>
              <section id={`page-${titlePageNumber}`} data-pdf-page-number={String(titlePageNumber)} data-pdf-page-kind="chapter" className="web-book-page p-10 md:p-16 bg-white border border-[#141414] shadow-[12px_12px_0px_0px_rgba(20,20,20,0.12)] min-h-[1000px] md:min-h-[1123px] flex flex-col relative print:shadow-none print:border-none print:block print:min-h-0 print:h-auto print:page-break-after-always">
                <div id={`chapter-${index}`} className="flex items-center justify-between gap-4 mb-12 border-b border-[#141414]/10 pb-6">
                  <div className="flex items-center gap-4 min-w-0">
                    <span className="w-10 h-10 bg-[#141414] text-white flex items-center justify-center font-mono text-sm">0{index + 1}</span>
                    <h3 className="text-3xl md:text-4xl font-serif italic font-bold tracking-tight break-words">{chapter.title}</h3>
                  </div>
                  <div className="text-[10px] uppercase font-bold opacity-30 tracking-widest">Chapter {index + 1} / {chapterRenderPlan.length}</div>
                </div>

                <div className="mb-12 relative group">
                  <div className="aspect-[16/9] w-full overflow-hidden border border-[#141414] bg-[#F5F5F5] shadow-inner">
                    <img
                      src={`https://picsum.photos/seed/${chapter.visualSeed || chapter.title}/1200/800`}
                      alt={chapter.title}
                      referrerPolicy="no-referrer"
                      crossOrigin="anonymous"
                      className="w-full h-full object-cover grayscale hover:grayscale-0 transition-all duration-1000 scale-105 group-hover:scale-100"
                    />
                  </div>
                  <div className="absolute -bottom-4 right-8 max-w-[75%] bg-white border border-[#141414] px-4 py-2 text-[10px] uppercase font-bold tracking-widest flex items-center gap-3 shadow-md break-words">
                    <ImageIcon size={12} /> {chapter.visualSeed}
                  </div>
                </div>

                <div className="flex-1">
                  <p className="text-xl leading-relaxed text-gray-800 mb-12 font-light first-letter:text-6xl first-letter:font-serif first-letter:mr-3 first-letter:float-left first-letter:leading-none">
                    {chapter.content.split('. ').slice(0, 3).join('. ') + '.'}
                  </p>
                  <p className="text-lg leading-relaxed text-gray-700 font-light">
                    {chapter.content.split('. ').slice(3).join('. ')}
                  </p>

                  {externalSourceLinks.length > 0 && (
                    <div className="mt-12 border border-[#141414] bg-[#F7F4EE] p-6 print:break-inside-avoid">
                      <div className="text-[10px] uppercase font-bold tracking-[0.28em] text-[#141414]/60 mb-5">Detailed Reading</div>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {externalSourceLinks.map((sourceLink, sourceIndex) => (
                          <a
                            key={sourceLink.url + sourceIndex}
                            href={sourceLink.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="border border-[#141414] bg-white px-4 py-4 hover:bg-[#141414] hover:text-white transition-colors group"
                            title="Open the supporting article in a new tab"
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className="font-semibold text-sm uppercase tracking-wide break-words">{sourceLink.title}</div>
                                <div className="text-[11px] opacity-60 mt-2 break-all">{sourceLink.hostname}</div>
                              </div>
                              <ArrowUpRight size={16} className="shrink-0 mt-0.5 opacity-70 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-transform" />
                            </div>
                          </a>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                <div className="mt-auto pt-12 flex justify-between items-center border-t border-[#141414]/5 text-[10px] font-mono opacity-40 print:hidden">
                  <span className="break-words">{webBook.topic}</span>
                  <span>PAGE {titlePageNumber}</span>
                </div>
              </section>

              {analysisPageNumber !== null && (
                <section id={`page-${analysisPageNumber}`} data-pdf-page-number={String(analysisPageNumber)} data-pdf-page-kind="analysis" className="web-book-page p-10 md:p-16 bg-white border border-[#141414] shadow-[12px_12px_0px_0px_rgba(20,20,20,0.12)] min-h-[1000px] md:min-h-[1123px] flex flex-col relative print:shadow-none print:border-none print:block print:min-h-0 print:h-auto print:page-break-after-always">
                  <div className="flex-1 space-y-12">
                    {renderableSubTopics.length > 0 && (
                      <div className="space-y-8">
                        <h4 className="text-[12px] uppercase font-bold tracking-[0.2em] flex items-center gap-3 text-[#141414]/60 border-b border-[#141414]/10 pb-4">
                          <Layers size={16} /> Deep Analysis & Sub-Topics
                        </h4>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-10">
                          {renderableSubTopics.map((subTopic, subTopicIndex) => {
                            const subTopicSource = normalizeSourceLink({ title: subTopic.title, url: subTopic.sourceUrl });

                            return (
                              <div key={subTopic.title + subTopicIndex} className="relative pl-8 group print:break-inside-avoid">
                                <div className="absolute left-0 top-0 bottom-0 w-[2px] bg-[#141414]/10 group-hover:bg-[#141414] transition-colors" />
                                <h5 className="font-bold text-xl mb-3">{subTopic.title}</h5>
                                <p className="text-base text-gray-600 leading-relaxed font-light">{subTopic.summary}</p>
                                {subTopicSource && (
                                  <a
                                    href={subTopicSource.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="inline-flex items-center gap-2 mt-4 text-[11px] uppercase tracking-[0.2em] font-bold text-[#141414] hover:underline"
                                    title="Open the external article for deeper reading"
                                  >
                                    Open Source Article <ArrowUpRight size={12} />
                                  </a>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {renderableDefinitions.length > 0 && (
                      <div className="bg-[#141414] text-white p-10 shadow-xl">
                        <h4 className="text-[10px] uppercase font-bold tracking-[0.3em] mb-10 flex items-center gap-3 opacity-70 border-b border-white/10 pb-6">
                          <BookOpen size={16} /> Technical Glossary
                        </h4>
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-x-12 gap-y-10">
                          {renderableDefinitions.map((definition, definitionIndex) => {
                            const words = (definition.description || '').split(/\s+/);
                            const isLong = words.length > 100;
                            const displayDescription = isLong ? words.slice(0, 100).join(' ') : definition.description;
                            const definitionSource = normalizeSourceLink({ title: definition.term, url: definition.sourceUrl });

                            return (
                              <div key={definition.term + definitionIndex} className="group print:break-inside-avoid">
                                <span className="font-mono text-[12px] font-bold block mb-3 uppercase text-blue-400 tracking-wider break-words">
                                  {definition.term}
                                </span>
                                <p className="text-sm leading-relaxed opacity-80 font-light italic border-l border-white/10 pl-4 break-words">
                                  {displayDescription}
                                  {isLong && (
                                    <>
                                      ...{' '}
                                      <a
                                        href={definition.sourceUrl}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        title="Read the full definition at the original source"
                                        className="text-blue-400 hover:underline font-bold not-italic"
                                      >
                                        [Full Definition]
                                      </a>
                                    </>
                                  )}
                                </p>
                                {definitionSource && (
                                  <a
                                    href={definitionSource.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    title="Read the external article behind this concept"
                                    className="inline-flex items-center gap-2 mt-4 text-[11px] uppercase tracking-[0.2em] font-bold text-blue-400 hover:underline"
                                  >
                                    Source Article <ArrowUpRight size={12} />
                                  </a>
                                )}
                              </div>
                            );
                          })}
                        </div>

                        <div className="mt-10 pt-6 border-t border-white/10">
                          <div className="flex flex-wrap items-center gap-3 text-[9px] font-bold uppercase opacity-40 break-all">
                            <div className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-pulse shrink-0" />
                            Source Verification:{' '}
                            {verificationSource ? (
                              <a
                                href={verificationSource.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                title="Verify this information at the primary source"
                                className="hover:underline"
                              >
                                {verificationSource.title}
                              </a>
                            ) : (
                              'Unavailable'
                            )}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="mt-auto pt-12 flex justify-between items-center border-t border-[#141414]/5 text-[10px] font-mono opacity-40 print:hidden">
                    <span>Evolutionary Node {index + 1}.{chapter.visualSeed?.length || 0}</span>
                    <span>PAGE {analysisPageNumber}</span>
                  </div>
                </section>
              )}
            </React.Fragment>
          );
        })}
      </div>

      <section id={`page-${finalDocumentPageNumber}`} data-pdf-page-number={String(finalDocumentPageNumber)} data-pdf-page-kind="footer" className="web-book-page p-10 md:p-16 bg-[#F5F5F5] border border-[#141414] shadow-[12px_12px_0px_0px_rgba(20,20,20,0.12)] min-h-[170px] md:min-h-[210px] flex flex-col justify-end gap-4 w-full print:shadow-none print:border-none print:block print:min-h-0 print:h-auto">
        <div className="flex items-end justify-between gap-4">
          <div className="flex items-center gap-4 min-w-0 flex-1">
            <div className="w-10 h-10 rounded-full bg-green-100 flex items-center justify-center">
              <CheckCircle2 className="text-green-600" size={20} />
            </div>
            <div className="flex flex-col">
              <span className="text-[10px] uppercase font-bold tracking-widest">Synthesis Verified</span>
              <span className="text-[9px] opacity-50 font-mono text-left">Engine v2.5 - Evolutionary Pass Complete</span>
            </div>
          </div>
          <a
            href="#top"
            data-pdf-target-page={1}
            title="Scroll back to the beginning of the book"
            className="shrink-0 text-[10px] uppercase font-bold hover:underline inline-flex items-center justify-end gap-2 text-right"
          >
            Back to Top
          </a>
        </div>
        <div className="text-[10px] font-mono opacity-40 print:hidden">PAGE {finalDocumentPageNumber}</div>
      </section>
    </div>
  );
}
