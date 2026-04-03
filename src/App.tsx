/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { BookOpen, Dna, Loader2 } from 'lucide-react';
import { AppHeader } from './components/AppHeader';
import { ControlSidebar } from './components/ControlSidebar';
import { HistoryDrawer } from './components/HistoryDrawer';
import { WebBookViewer } from './components/WebBookViewer';
import { useWebBookEngine } from './hooks/useWebBookEngine';
import {
  exportWebBookToHtml,
  exportWebBookToPdf,
  exportWebBookToTxt,
  exportWebBookToWord,
  printWebBook,
} from './services/exportService';

export default function App() {
  const [showHistory, setShowHistory] = useState(false);
  const [showArtifacts, setShowArtifacts] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const {
    query,
    setQuery,
    state,
    webBook,
    history,
    error,
    notice,
    runSearch,
    startNewSearch,
    viewHistoryItem,
    deleteHistoryItem,
    clearAllHistory,
  } = useWebBookEngine();

  const runExport = async (action: () => Promise<void>) => {
    setIsExporting(true);
    try {
      await action();
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#E4E3E0] text-[#141414] font-sans selection:bg-[#141414] selection:text-[#E4E3E0]">
      <AppHeader
        webBook={webBook}
        isExporting={isExporting}
        onNewSearch={startNewSearch}
        onToggleHistory={() => setShowHistory(true)}
        onExportPdf={() => webBook ? runExport(() => exportWebBookToPdf(webBook)) : Promise.resolve()}
        onExportPrint={() => webBook ? runExport(() => printWebBook(webBook)) : Promise.resolve()}
        onExportWord={() => webBook ? runExport(() => exportWebBookToWord(webBook)) : Promise.resolve()}
        onExportHtml={() => webBook ? runExport(() => exportWebBookToHtml(webBook)) : Promise.resolve()}
        onExportTxt={() => webBook ? runExport(() => exportWebBookToTxt(webBook)) : Promise.resolve()}
      />

      <main className="max-w-7xl mx-auto p-6 grid grid-cols-1 lg:grid-cols-12 gap-8 print:block print:p-0">
        <ControlSidebar
          query={query}
          onQueryChange={setQuery}
          state={state}
          error={error}
          notice={notice}
          showArtifacts={showArtifacts}
          onToggleArtifacts={() => setShowArtifacts((previousState) => !previousState)}
          onSearch={runSearch}
          onStartNewSearch={startNewSearch}
        />

        <div className="lg:col-span-8 print:w-full">
          <AnimatePresence mode="wait">
            {!webBook && state.status === 'idle' && (
              <motion.div
                key="empty"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="h-full flex flex-col items-center justify-center border-2 border-dashed border-[#141414] opacity-20 p-20 text-center"
              >
                <BookOpen size={80} strokeWidth={1} />
                <p className="mt-6 font-serif italic text-xl">Enter a topic to generate a structured Web-book</p>
              </motion.div>
            )}

            {(state.status === 'searching' || state.status === 'evolving' || state.status === 'assembling') && (
              <motion.div
                key="loading"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="h-full flex flex-col items-center justify-center bg-white border border-[#141414] p-20 text-center shadow-[8px_8px_0px_0px_rgba(20,20,20,1)]"
              >
                <div className="relative">
                  <Loader2 size={60} className="animate-spin text-[#141414]" />
                  <Dna size={30} className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2" />
                </div>
                <h3 className="mt-8 font-serif italic text-2xl uppercase tracking-tight">Evolving Knowledge Structure</h3>
                <p className="mt-4 text-sm opacity-60 max-w-md mx-auto">
                  The engine is currently mining concepts, evaluating informative value, and pruning redundant data structures...
                </p>
                <div className="mt-10 grid grid-cols-3 gap-8 w-full max-w-lg">
                  {['Crawling', 'Evolving', 'Assembling'].map((step, index) => (
                    <div key={step} className="flex flex-col items-center gap-2">
                      <div className={`w-3 h-3 rounded-full border border-[#141414] ${state.status === step.toLowerCase() || (state.status === 'searching' && index === 0) || (state.status === 'evolving' && index === 1) || (state.status === 'assembling' && index === 2) ? 'bg-[#141414]' : 'bg-transparent'}`} />
                      <span className="text-[9px] uppercase font-bold tracking-widest">{step}</span>
                    </div>
                  ))}
                </div>
              </motion.div>
            )}

            {webBook && state.status !== 'searching' && state.status !== 'evolving' && state.status !== 'assembling' && (
              <motion.div
                key="content"
                initial={{ opacity: 0, scale: 0.98 }}
                animate={{ opacity: 1, scale: 1 }}
                className="flex flex-col items-center gap-8 pb-20 overflow-x-hidden"
              >
                <WebBookViewer webBook={webBook} />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </main>

      <HistoryDrawer
        showHistory={showHistory}
        history={history}
        onClose={() => setShowHistory(false)}
        onView={(item) => {
          viewHistoryItem(item);
          setShowHistory(false);
        }}
        onDelete={deleteHistoryItem}
        onClearAll={clearAllHistory}
      />

      <footer className="mt-20 border-t border-[#141414] p-10 text-center opacity-40 print:hidden">
        <p className="text-[10px] uppercase tracking-[0.5em]">Architecting an Evolutionary Web-Book Engine (c) 2026</p>
        <p className="text-[9px] mt-2">Hock Chiye Er</p>
      </footer>
    </div>
  );
}
