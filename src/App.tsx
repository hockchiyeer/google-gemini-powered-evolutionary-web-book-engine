/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { initializeApp, type FirebaseApp } from "firebase/app";
import {
  getAuth,
  onAuthStateChanged,
  signInAnonymously,
  type Auth,
  type User,
} from "firebase/auth";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDocs,
  getFirestore,
  orderBy,
  query as firestoreQuery,
  serverTimestamp,
  setDoc,
  writeBatch,
  type Firestore,
} from "firebase/firestore";
import html2canvas from 'html2canvas';
import { jsPDF } from 'jspdf';

import { motion, AnimatePresence } from 'motion/react';
import {
  Search, 
  BookOpen, 
  Dna, 
  Cpu, 
  Layers, 
  ChevronRight, 
  ExternalLink, 
  Loader2,
  Info,
  CheckCircle2,
  AlertCircle,
  History,
  Trash2,
  Plus,
  X,
  Clock,
  Image as ImageIcon,
  Download,
  FileText,
  FileCode,
  ChevronDown,
  Printer
} from 'lucide-react';
import { WebBook, WebPageGenotype, EvolutionState } from './types';
import { buildChapterRenderPlan } from './utils/webBookRender';

type PersistedSearchStatus = "started" | "complete" | "failed";

interface PersistedSearchRecord {
  query: string;
  status: PersistedSearchStatus;
  timestamp: number;
  error: string | null;
  webBook: WebBook | null;
  createdAt?: unknown;
  updatedAt?: unknown;
}

const FIREBASE_CONFIG = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID,
};

let firebaseApp: FirebaseApp | null = null;
let firebaseAuth: Auth | null = null;
let firebaseDb: Firestore | null = null;
let authInitPromise: Promise<User | null> | null = null;

type PdfLinkAnnotation = {
  sourcePageNumber: number;
  targetPageNumber: number;
  xRatio: number;
  yRatio: number;
  widthRatio: number;
  heightRatio: number;
};

const PDF_EXPORT_PAGE_WIDTH = 794;
const PDF_EXPORT_PAGE_HEIGHT = 1123;
const PDF_IMAGE_MAX_DIMENSION = 1600;

const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));
const getPdfRenderScale = (pageCount: number) => {
  if (pageCount >= 12) return 1.35;
  if (pageCount >= 8) return 1.5;
  if (pageCount >= 5) return 1.7;
  return 1.9;
};

const inlineImagesForExport = async (
  root: HTMLElement,
  options: { maxDimension: number; quality: number; hideOnError?: boolean }
): Promise<void> => {
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
};

const createHiddenExportClone = (element: HTMLElement): { clone: HTMLElement; cleanup: () => void } => {
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
};

const prepareWordFooterForExport = (root: HTMLElement): void => {
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
};

const collectPdfLinkAnnotations = (root: HTMLElement): PdfLinkAnnotation[] =>
  Array.from(root.querySelectorAll<HTMLElement>('[data-pdf-target-page]'))
    .map((element) => {
      const sourcePage = element.closest<HTMLElement>('[data-pdf-page-number]');
      const sourcePageNumber = Number(sourcePage?.dataset.pdfPageNumber);
      const targetPageNumber = Number(element.dataset.pdfTargetPage);

      if (!sourcePage || !Number.isFinite(sourcePageNumber) || !Number.isFinite(targetPageNumber)) {
        return null;
      }

      const sourceRect = sourcePage.getBoundingClientRect();
      const elementRect = element.getBoundingClientRect();
      if (!sourceRect.width || !sourceRect.height || !elementRect.width || !elementRect.height) {
        return null;
      }

      return {
        sourcePageNumber,
        targetPageNumber,
        xRatio: (elementRect.left - sourceRect.left) / sourceRect.width,
        yRatio: (elementRect.top - sourceRect.top) / sourceRect.height,
        widthRatio: elementRect.width / sourceRect.width,
        heightRatio: elementRect.height / sourceRect.height,
      };
    })
    .filter((annotation): annotation is PdfLinkAnnotation => Boolean(annotation));

const isFirebaseConfigured = (): boolean => Boolean(
  FIREBASE_CONFIG.apiKey &&
  FIREBASE_CONFIG.authDomain &&
  FIREBASE_CONFIG.projectId &&
  FIREBASE_CONFIG.appId
);

const getFirebaseServices = (): { auth: Auth; db: Firestore } | null => {
  if (!isFirebaseConfigured()) return null;

  if (!firebaseApp) {
    firebaseApp = initializeApp(FIREBASE_CONFIG);
    firebaseAuth = getAuth(firebaseApp);
    firebaseDb = getFirestore(firebaseApp);
  }

  return { auth: firebaseAuth!, db: firebaseDb! };
};

const waitForExistingUser = async (auth: Auth): Promise<User | null> => {
  if (auth.currentUser) {
    return auth.currentUser;
  }

  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe = () => {};
    let timer: number | undefined;

    const finish = (user: User | null) => {
      if (settled) return;
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      unsubscribe();
      resolve(user);
    };

    unsubscribe = onAuthStateChanged(
      auth,
      (user) => finish(user),
      () => finish(auth.currentUser)
    );

    timer = window.setTimeout(() => finish(auth.currentUser), 300);
  });
};

const ensureAnonymousUser = async (): Promise<User | null> => {
  const services = getFirebaseServices();
  if (!services) return null;

  if (!authInitPromise) {
    authInitPromise = (async () => {
      const existingUser = await waitForExistingUser(services.auth);
      if (existingUser) {
        return existingUser;
      }

      const credential = await signInAnonymously(services.auth);
      return credential.user;
    })().catch((error) => {
      authInitPromise = null;
      console.error("Firebase persistence auth failed", error);
      return null;
    });
  }

  return authInitPromise;
};

const getSearchesCollection = (db: Firestore, userId: string) =>
  collection(db, "webbookUsers", userId, "searches");

const normalizeWebBook = (raw: unknown, fallbackId: string): WebBook | null => {
  if (!raw || typeof raw !== "object") return null;

  const candidate = raw as Partial<WebBook>;
  if (typeof candidate.topic !== "string" || !Array.isArray(candidate.chapters)) {
    return null;
  }

  return {
    id: typeof candidate.id === "string" ? candidate.id : fallbackId,
    topic: candidate.topic,
    timestamp: typeof candidate.timestamp === "number" ? candidate.timestamp : Date.now(),
    chapters: candidate.chapters as WebBook["chapters"],
  };
};

const updateSearchRecord = async (
  searchId: string | null,
  data: Partial<PersistedSearchRecord>
): Promise<void> => {
  if (!searchId) return;

  const services = getFirebaseServices();
  const user = await ensureAnonymousUser();
  if (!services || !user) return;

  await setDoc(
    doc(getSearchesCollection(services.db, user.uid), searchId),
    {
      ...data,
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );
};

const createPersistedSearch = async (queryText: string): Promise<string | null> => {
  const services = getFirebaseServices();
  const user = await ensureAnonymousUser();
  if (!services || !user) return null;

  const searchRef = await addDoc(getSearchesCollection(services.db, user.uid), {
    query: queryText,
    status: "started",
    timestamp: Date.now(),
    error: null,
    webBook: null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  return searchRef.id;
};

const completePersistedSearch = async (
  searchId: string | null,
  queryText: string,
  webBook: WebBook
): Promise<void> => {
  await updateSearchRecord(searchId, {
    query: queryText,
    status: "complete",
    timestamp: webBook.timestamp,
    error: null,
    webBook,
  });
};

const failPersistedSearch = async (
  searchId: string | null,
  queryText: string,
  errorMessage: string
): Promise<void> => {
  await updateSearchRecord(searchId, {
    query: queryText,
    status: "failed",
    timestamp: Date.now(),
    error: errorMessage,
    webBook: null,
  });
};

const loadPersistedWebBooks = async (): Promise<WebBook[]> => {
  const services = getFirebaseServices();
  const user = await ensureAnonymousUser();
  if (!services || !user) return [];

  const snapshot = await getDocs(
    firestoreQuery(getSearchesCollection(services.db, user.uid), orderBy("timestamp", "desc"))
  );

  return snapshot.docs
    .map((searchDoc) => {
      const data = searchDoc.data() as Partial<PersistedSearchRecord>;
      if (data.status !== "complete" || !data.webBook) {
        return null;
      }

      return normalizeWebBook(data.webBook, searchDoc.id);
    })
    .filter((webBook): webBook is WebBook => Boolean(webBook));
};

const deletePersistedSearch = async (searchId: string): Promise<void> => {
  const services = getFirebaseServices();
  const user = await ensureAnonymousUser();
  if (!services || !user || !searchId) return;

  await deleteDoc(doc(getSearchesCollection(services.db, user.uid), searchId));
};

const clearPersistedSearches = async (): Promise<void> => {
  const services = getFirebaseServices();
  const user = await ensureAnonymousUser();
  if (!services || !user) return;

  const snapshot = await getDocs(getSearchesCollection(services.db, user.uid));
  if (snapshot.empty) return;

  const batch = writeBatch(services.db);
  snapshot.docs.forEach((searchDoc) => batch.delete(searchDoc.ref));
  await batch.commit();
};

const mergeHistoryBooks = (...historyGroups: WebBook[][]): WebBook[] => {
  const historyById = new Map<string, WebBook>();

  historyGroups.flat().forEach((book) => {
    if (!book?.id) return;

    const existing = historyById.get(book.id);
    if (!existing || book.timestamp >= existing.timestamp) {
      historyById.set(book.id, book);
    }
  });

  return Array.from(historyById.values()).sort((a, b) => b.timestamp - a.timestamp);
};

export default function App() {
  const [query, setQuery] = useState('');
  const [state, setState] = useState<EvolutionState>({
    generation: 0,
    population: [],
    bestFitness: 0,
    status: 'idle',
    artifacts: {}
  });
  const [webBook, setWebBook] = useState<WebBook | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<WebBook[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [showArtifacts, setShowArtifacts] = useState(false);
  const [showExportOptions, setShowExportOptions] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const exportDropdownRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const artifactsRef = useRef<HTMLElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const [isHoveringInput, setIsHoveringInput] = useState(false);
  const [tooltipPosition, setTooltipPosition] = useState<'top' | 'bottom'>('top');

  // Close export options when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (exportDropdownRef.current && !exportDropdownRef.current.contains(event.target as Node)) {
        setShowExportOptions(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Auto-scroll to artifacts when expanded
  useEffect(() => {
    if (showArtifacts && artifactsRef.current) {
      // Small delay to allow the motion section to start expanding
      const timer = setTimeout(() => {
        artifactsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 150);
      return () => clearTimeout(timer);
    }
  }, [showArtifacts]);

  // Handle tooltip positioning
  useEffect(() => {
    if (isHoveringInput && formRef.current) {
      const rect = formRef.current.getBoundingClientRect();
      const spaceAbove = rect.top;
      // If less than 320px above, flip to bottom to avoid header/top overflow
      if (spaceAbove < 320) {
        setTooltipPosition('bottom');
      } else {
        setTooltipPosition('top');
      }
    }
  }, [isHoveringInput, query]);

  // Load history from localStorage
  useEffect(() => {
    const savedHistory = localStorage.getItem('webbook_history');
    if (savedHistory) {
      try {
        setHistory(mergeHistoryBooks(JSON.parse(savedHistory)));
      } catch (e) {
        console.error("Failed to parse history", e);
      }
    }
  }, []);

  useEffect(() => {
    let isMounted = true;

    const syncPersistedHistory = async () => {
      try {
        const persistedHistory = await loadPersistedWebBooks();
        if (!isMounted || persistedHistory.length === 0) return;

        setHistory(prev => mergeHistoryBooks(prev, persistedHistory));
      } catch (e) {
        console.error("Failed to load Firebase history", e);
      }
    };

    void syncPersistedHistory();

    return () => {
      isMounted = false;
    };
  }, []);

  // Save history to localStorage
  useEffect(() => {
    localStorage.setItem('webbook_history', JSON.stringify(history));
  }, [history]);

  // Check if search query overflows the input box width for accessibility tooltip
  useEffect(() => {
    if (textareaRef.current && query) {
      const el = textareaRef.current;
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      if (context) {
        const style = window.getComputedStyle(el);
        context.font = style.font;
        const metrics = context.measureText(query);
        const textWidth = metrics.width;
        
        const paddingLeft = parseFloat(style.paddingLeft);
        const paddingRight = parseFloat(style.paddingRight);
        // Subtract button space too (pr-14 is 56px)
        const availableWidth = el.clientWidth - paddingLeft - paddingRight;
        
        setIsOverflowing(textWidth > availableWidth);
      }
    } else {
      setIsOverflowing(false);
    }
  }, [query]);

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedQuery = query.trim();
    if (!trimmedQuery) return;

    setState({ ...state, status: 'searching', generation: 0, population: [], artifacts: {} });
    setWebBook(null);
    setError(null);

    let persistedSearchId: string | null = null;

    try {
      try {
        persistedSearchId = await createPersistedSearch(trimmedQuery);
      } catch (persistenceError) {
        console.error("Failed to create persisted search record", persistenceError);
      }

      const { searchAndExtract, evolve, assembleWebBook } = await import('./services/evolutionService');
      
      // 1. Targeted Crawling & Ingestion
      const { results: initialPopulation, artifacts: searchArtifacts } = await searchAndExtract(trimmedQuery);
      setState(s => ({ 
        ...s, 
        status: 'evolving', 
        population: initialPopulation,
        artifacts: {
          ...s.artifacts,
          rawSearchResults: searchArtifacts?.groundingChunks || []
        }
      }));
      
      // 2. Evolutionary Processing Engine
      const evolvedPopulation = await evolve(initialPopulation);
      setState(s => ({ 
        ...s, 
        status: 'assembling', 
        population: evolvedPopulation,
        artifacts: {
          ...s.artifacts,
          evolvedPopulation: evolvedPopulation
        }
      }));
      
      // 3. Web-Book Assembly
      const assembledBook = await assembleWebBook(evolvedPopulation, trimmedQuery);
      const book = persistedSearchId
        ? { ...assembledBook, id: persistedSearchId }
        : assembledBook;
      
      setWebBook(book);
      setHistory(prev => mergeHistoryBooks([book], prev));
      void completePersistedSearch(persistedSearchId, trimmedQuery, book).catch((persistenceError) => {
        console.error("Failed to persist completed WebBook", persistenceError);
      });
      setState(s => ({
        ...s,
        status: 'complete',
        generation: 3,
        population: evolvedPopulation,
        bestFitness: Math.max(...evolvedPopulation.map((p: any) => p.fitness || 0)),
        artifacts: {
          ...s.artifacts,
          assemblyInput: evolvedPopulation.slice(0, 4), // What was sent to assembly
          assemblyOutput: book
        }
      }));
    } catch (err: any) {
      console.error("Evolution error:", err);
      let message = err.message || "An unexpected error occurred during evolution.";
      if (message.includes("429") || message.includes("quota") || message.includes("RESOURCE_EXHAUSTED")) {
        message = "The AI engine is currently busy or has reached its rate limit. Please wait a minute and try again.";
      }
      void failPersistedSearch(persistedSearchId, trimmedQuery, message).catch((persistenceError) => {
        console.error("Failed to persist failed search", persistenceError);
      });
      setError(message);
      setState({ ...state, status: 'idle' });
    }
  };

  const deleteHistoryItem = (id: string) => {
    setHistory(prev => prev.filter(item => item.id !== id));
    void deletePersistedSearch(id).catch((e) => {
      console.error("Failed to delete persisted history item", e);
    });
  };

  const clearAllHistory = () => {
    if (window.confirm("Are you sure you want to delete all search history?")) {
      setHistory([]);
      void clearPersistedSearches().catch((e) => {
        console.error("Failed to clear persisted history", e);
      });
    }
  };

  const startNewSearch = () => {
    setQuery('');
    setWebBook(null);
    setError(null);
    setState({
      generation: 0,
      population: [],
      bestFitness: 0,
      status: 'idle',
      artifacts: {}
    });
    if (textareaRef.current) {
      textareaRef.current.focus();
    }
  };

  const exportToTXT = () => {
    if (!webBook) return;
    setIsExporting(true);
    setShowExportOptions(false);
    
    setTimeout(() => {
      let text = `${webBook.topic.toUpperCase()}\n`;
      text += `Generated on: ${new Date(webBook.timestamp).toLocaleString()}\n\n`;
      
      webBook.chapters.forEach((chapter, i) => {
        text += `CHAPTER ${i + 1}: ${chapter.title}\n`;
        text += `${"=".repeat(chapter.title.length + 11)}\n\n`;
        text += `${chapter.content}\n\n`;
        
        text += `VISUAL CONCEPT: ${chapter.visualSeed}\n\n`;
        
        text += `CORE CONCEPTS:\n`;
        chapter.definitions.forEach(def => {
          text += `- ${def.term}: ${def.description}\n`;
        });
        text += `\n`;
        
        text += `SUB-TOPICS:\n`;
        chapter.subTopics.forEach(sub => {
          text += `- ${sub.title}: ${sub.summary}\n`;
        });
        text += `\nSOURCES:\n`;
        chapter.sourceUrls.forEach(url => text += `- ${url}\n`);
        text += `\n\n`;
      });

      const blob = new Blob([text], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${webBook.topic.replace(/\s+/g, '_')}.txt`;
      a.click();
      URL.revokeObjectURL(url);
      setIsExporting(false);
    }, 800);
  };

  const exportToHTML = () => {
    if (!webBook) return;
    const element = document.querySelector('.web-book-container') as HTMLElement | null;
    const htmlContent = element?.outerHTML;
    if (!htmlContent) return;

    setIsExporting(true);
    setShowExportOptions(false);

    setTimeout(() => {
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
              body { background: white; padding: 0; }
              .web-book-container { max-width: none; gap: 0; }
              .web-book-page { box-shadow: none; break-after: page; page-break-after: always; }
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
      const a = document.createElement('a');
      a.href = url;
      a.download = `${webBook.topic.replace(/\s+/g, '_')}.html`;
      a.click();
      URL.revokeObjectURL(url);
      setIsExporting(false);
    }, 800);
  };

  const exportToWord = async () => {
    if (!webBook) return;
    const element = document.querySelector('.web-book-container') as HTMLElement | null;
    if (!element) return;

    setIsExporting(true);
    setShowExportOptions(false);

    try {
      // Create a clone to modify for Word export
      const clone = element.cloneNode(true) as HTMLElement;
      
      // Remove elements that don't translate well
      clone.querySelectorAll('button, .print\\:hidden, [data-html2canvas-ignore]').forEach(el => el.remove());
      
      // Convert images to base64 to ensure they are embedded in Word
      const images = clone.querySelectorAll('img');
      for (const img of Array.from(images)) {
        try {
          // Use a canvas to convert image to base64, which is more reliable than fetch for some cases
          // and allows us to strip filters like grayscale
          const canvas = document.createElement('canvas');
          const ctx = canvas.getContext('2d');
          const tempImg = new Image();
          tempImg.crossOrigin = 'anonymous';
          
          await new Promise((resolve, reject) => {
            tempImg.onload = resolve;
            tempImg.onerror = reject;
            tempImg.src = img.src;
          });

          canvas.width = tempImg.width;
          canvas.height = tempImg.height;
          ctx?.drawImage(tempImg, 0, 0);
          img.src = canvas.toDataURL('image/jpeg', 0.8);
          
          // Clear any filters that might prevent Word from displaying the image
          img.style.filter = 'none';
          img.className = img.className.replace(/grayscale|hover:grayscale-0/g, '');
        } catch (e) {
          console.error("Failed to convert image to base64 for Word export", e);
          // Fallback to original fetch method if canvas fails
          try {
            const response = await fetch(img.src, { mode: 'cors' });
            if (response.ok) {
              const blob = await response.blob();
              const base64 = await new Promise<string>((resolve, reject) => {
                const reader = new FileReader();
                reader.onloadend = () => resolve(reader.result as string);
                reader.onerror = reject;
                reader.readAsDataURL(blob);
              });
              img.src = base64;
            }
          } catch (fetchErr) {
            console.error("Fetch fallback also failed", fetchErr);
          }
        }
        img.style.maxWidth = '100%';
        img.style.height = 'auto';
        img.style.display = 'block';
        img.style.margin = '20px auto';
      }

      // Add name anchors for internal links to work better in Word
      clone.querySelectorAll('[id]').forEach(el => {
        const id = el.getAttribute('id');
        if (!id) return;

        const anchor = document.createElement('a');
        anchor.setAttribute('name', id);
        el.prepend(anchor);
      });

      if (!clone.querySelector('a[name="top"]')) {
        const topAnchor = document.createElement('a');
        topAnchor.setAttribute('name', 'top');
        clone.prepend(topAnchor);
      }

      prepareWordFooterForExport(clone);

      const htmlContent = clone.outerHTML;
      const header = "<html xmlns:o='urn:schemas-microsoft-com:office:office' "+
              "xmlns:w='urn:schemas-microsoft-com:office:word' "+
              "xmlns='http://www.w3.org/TR/REC-html40'>"+
              "<head><meta charset='utf-8'><title>WebBook Export</title>"+
              "<style>"+
              "body { font-family: 'Arial', sans-serif; } "+
              "img { max-width: 100%; height: auto; display: block; margin: 20px auto; } "+
              "h2, h3, h4 { font-family: 'Georgia', serif; } "+
              "a { text-decoration: none; color: inherit; } "+
              ".font-mono { font-family: 'Courier New', monospace; } "+
              "</style></head><body>";
      const footer = "</body></html>";
      const sourceHTML = header + htmlContent + footer;
      
      const blob = new Blob(['\ufeff', sourceHTML], {
          type: 'application/msword'
      });
      
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${webBook.topic.replace(/\s+/g, '_')}.doc`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Word export failed:", err);
    } finally {
      setIsExporting(false);
    }
  };

  const exportToPDF = async () => {
    if (!webBook) return;
    const element = document.querySelector('.web-book-container') as HTMLElement | null;
    if (!element) return;

    setIsExporting(true);
    setShowExportOptions(false);

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
            pdf.link(
              annotation.xRatio * pdfWidth,
              annotation.yRatio * pdfHeight,
              annotation.widthRatio * pdfWidth,
              annotation.heightRatio * pdfHeight,
              { pageNumber: annotation.targetPageNumber }
            );
          });

        await wait(0);
      }

      pdf.save(`${webBook.topic.replace(/\s+/g, '_')}.pdf`);
    } catch (err) {
      console.error('PDF Export failed:', err);
      alert("High-res PDF export still hit a browser limit before finishing. The exporter now renders one page at a time, but very large books or blocked remote images can still fail. Please use 'Print / Save as PDF' as the fallback if needed.");
    } finally {
      cleanup?.();
      setIsExporting(false);
    }
  };

  const exportToPrint = () => {
    if (!webBook) return;
    const element = document.querySelector('.web-book-container') as HTMLElement | null;
    const htmlContent = element?.outerHTML;
    if (!htmlContent) return;

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
            body { font-family: 'Inter', sans-serif; background: white; padding: 24px 0; margin: 0; overflow-x: hidden; }
            .font-serif { font-family: 'Playfair Display', serif; }
            .print\\:hidden { display: none !important; }
            .web-book-container { width: 100%; max-width: 900px; margin: 0 auto; display: flex; flex-direction: column; gap: 0; }
            .web-book-page { background: white; break-after: page; page-break-after: always; }
            .web-book-page:last-child { break-after: auto; page-break-after: auto; }
            @media print {
              body { padding: 0; }
              .no-print { display: none; }
              @page { margin: 1.5cm; }
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
  };

  const viewHistoryItem = (item: WebBook) => {
    setWebBook(item);
    setQuery(item.topic);
    setState({
      generation: 3,
      population: [],
      bestFitness: 0,
      status: 'complete'
    });
    setShowHistory(false);
  };

  const chapterRenderPlan = webBook ? buildChapterRenderPlan(webBook.chapters) : [];
  const finalDocumentPageNumber = chapterRenderPlan.length > 0
    ? (chapterRenderPlan[chapterRenderPlan.length - 1].analysisPageNumber ?? chapterRenderPlan[chapterRenderPlan.length - 1].titlePageNumber) + 1
    : 3;

  return (
    <div className="min-h-screen bg-[#E4E3E0] text-[#141414] font-sans selection:bg-[#141414] selection:text-[#E4E3E0]">
      {/* Header */}
      <header 
        data-html2canvas-ignore="true"
        className="border-b border-[#141414] p-4 md:p-6 flex flex-col md:flex-row justify-between items-center gap-4 bg-[#E4E3E0] sticky top-0 z-50 print:hidden"
      >
        <div className="flex items-center gap-3 w-full md:w-auto">
          <div className="w-10 h-10 bg-[#141414] flex items-center justify-center rounded-sm shrink-0">
            <Dna className="text-[#E4E3E0] w-6 h-6" />
          </div>
          <div className="overflow-hidden">
            <h1 className="text-lg md:text-xl font-bold tracking-tighter uppercase italic font-serif truncate">Evolutionary Web-Book Engine</h1>
            <p className="text-[9px] md:text-[10px] uppercase tracking-widest opacity-60 truncate">Mitigating Search Redundancy via Evolutionary Computing</p>
          </div>
        </div>

        {/* Dynamic Navigation & Actions */}
        <div className="flex items-center gap-2 md:gap-6 w-full md:w-auto justify-between md:justify-end">
          {webBook && (
            <div className="hidden xl:flex items-center gap-3 border-x border-[#141414]/10 px-6 mx-2 h-10">
              <span className="text-[10px] font-bold uppercase tracking-widest opacity-40">Jump:</span>
              <div className="flex gap-1.5">
                {webBook.chapters.map((_, i) => (
                  <a 
                    key={i} 
                    href={`#chapter-${i}`}
                    className="w-7 h-7 flex items-center justify-center font-mono text-[10px] border border-[#141414]/10 hover:bg-[#141414] hover:text-white transition-all"
                    title={`Jump to Chapter ${i+1}: ${webBook.chapters[i].title}`}
                  >
                    {i+1}
                  </a>
                ))}
              </div>
            </div>
          )}

          <div className="flex items-center gap-2 md:gap-4">
            {webBook && (
              <div className="flex items-center gap-2 md:gap-3 border-r border-[#141414]/10 pr-2 md:pr-4 mr-2 md:mr-4">
                <button 
                  onClick={startNewSearch}
                  title="Clear current book and start a new evolutionary search"
                  className="px-3 md:px-4 py-2 border border-[#141414] text-[9px] md:text-[10px] uppercase font-bold tracking-widest hover:bg-[#141414] hover:text-white transition-all active:scale-95"
                >
                  New Search
                </button>
                
                <div className="relative" ref={exportDropdownRef}>
                  <button 
                    onClick={() => setShowExportOptions(!showExportOptions)}
                    aria-expanded={showExportOptions}
                    aria-haspopup="true"
                    disabled={isExporting}
                    title="Download or print this Web-book in various formats"
                    className="px-3 md:px-4 py-2 bg-[#141414] text-[#E4E3E0] text-[9px] md:text-[10px] uppercase font-bold tracking-widest hover:bg-opacity-90 transition-all flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {isExporting ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      <>
                        <Download size={12} /> <span className="hidden sm:inline">Export</span> <ChevronDown size={12} className={`transition-transform ${showExportOptions ? 'rotate-180' : ''}`} />
                      </>
                    )}
                  </button>

                  <AnimatePresence>
                    {showExportOptions && (
                      <motion.div 
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: 10 }}
                        className="absolute top-full right-0 mt-2 w-48 bg-white border border-[#141414] shadow-2xl z-50 overflow-hidden print:hidden"
                      >
                        <button 
                          onClick={() => { exportToPDF(); setShowExportOptions(false); }}
                          title="Generate a high-quality PDF with images and styling"
                          className="w-full px-4 py-3 text-left text-[10px] uppercase font-bold hover:bg-[#F5F5F5] flex items-center gap-3 border-b border-[#141414]/10"
                        >
                          <FileText size={14} className="text-red-600" /> PDF Document (High Res)
                        </button>
                        <button 
                          onClick={() => { exportToPrint(); setShowExportOptions(false); }}
                          title="Open system print dialog (recommended for large books)"
                          className="w-full px-4 py-3 text-left text-[10px] uppercase font-bold hover:bg-[#F5F5F5] flex items-center gap-3 border-b border-[#141414]/10"
                        >
                          <Printer size={14} className="text-green-600" /> Print / Save as PDF (Lightweight)
                        </button>
                        <button 
                          onClick={() => { exportToWord(); setShowExportOptions(false); }}
                          title="Export as Microsoft Word document for editing"
                          className="w-full px-4 py-3 text-left text-[10px] uppercase font-bold hover:bg-[#F5F5F5] flex items-center gap-3 border-b border-[#141414]/10"
                        >
                          <FileText size={14} className="text-blue-600" /> Word (.doc)
                        </button>
                        <button 
                          onClick={() => { exportToHTML(); setShowExportOptions(false); }}
                          title="Download as a standalone HTML file"
                          className="w-full px-4 py-3 text-left text-[10px] uppercase font-bold hover:bg-[#F5F5F5] flex items-center gap-3 border-b border-[#141414]/10"
                        >
                          <FileCode size={14} className="text-orange-600" /> HTML Webpage
                        </button>
                        <button 
                          onClick={() => { exportToTXT(); setShowExportOptions(false); }}
                          title="Export as a simple text file without formatting"
                          className="w-full px-4 py-3 text-left text-[10px] uppercase font-bold hover:bg-[#F5F5F5] flex items-center gap-3"
                        >
                          <FileText size={14} className="text-gray-600" /> Plain Text
                        </button>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </div>
            )}

            <button 
              onClick={() => setShowHistory(true)}
              title="View and manage previously generated Web-books"
              className="flex items-center gap-2 text-[10px] md:text-[11px] uppercase tracking-wider font-bold hover:opacity-70 transition-opacity"
            >
              <History size={14} /> <span className="hidden sm:inline">History</span>
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto p-6 grid grid-cols-1 lg:grid-cols-12 gap-8 print:block print:p-0">
        {/* Left Column: Search & Status */}
        <div 
          data-html2canvas-ignore="true"
          className="lg:col-span-4 space-y-8 print:hidden"
        >
          <section className="bg-white border border-[#141414] p-6 shadow-[4px_4px_0px_0px_rgba(20,20,20,1)]">
            <div className="flex justify-between items-center mb-4">
              <h2 className="font-serif italic text-sm uppercase opacity-50">Targeted Ingestion</h2>
              <button 
                onClick={startNewSearch}
                title="Reset engine and start a new search"
                className="text-[10px] uppercase font-bold flex items-center gap-1 hover:underline"
              >
                <Plus size={12}/> New Search
              </button>
            </div>
            <form 
              ref={formRef}
              onSubmit={handleSearch} 
              className="relative"
              onMouseEnter={() => setIsHoveringInput(true)}
              onMouseLeave={() => setIsHoveringInput(false)}
              onFocus={() => setIsHoveringInput(true)}
              onBlur={() => setIsHoveringInput(false)}
              onClick={() => setIsHoveringInput(true)}
            >
              <AnimatePresence>
                {isOverflowing && isHoveringInput && query && (
                  <motion.div
                    initial={{ opacity: 0, y: tooltipPosition === 'top' ? 10 : -10, scale: 0.95 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: tooltipPosition === 'top' ? 10 : -10, scale: 0.95 }}
                    className={`absolute ${tooltipPosition === 'top' ? 'bottom-full mb-3' : 'top-full mt-3'} left-0 w-full z-[60] pointer-events-none`}
                  >
                    <div className="bg-yellow-300 text-[#141414] p-4 border-2 border-[#141414] shadow-[6px_6px_0px_0px_rgba(20,20,20,1)] text-sm font-mono break-words max-h-[40vh] overflow-y-auto custom-scrollbar pointer-events-auto">
                      <div className="flex items-center gap-2 mb-2 opacity-70 text-[10px] uppercase font-bold tracking-widest">
                        <Info size={12} className="text-[#141414]" /> Full Search Query Preview
                      </div>
                      <div className="leading-relaxed">
                        {query}
                      </div>
                      <div className="mt-2 text-[9px] opacity-40 italic">
                        Text exceeds box width. Showing full query for accessibility.
                      </div>
                    </div>
                    {/* Tooltip Arrow */}
                    <div className={`absolute ${tooltipPosition === 'top' ? '-bottom-2 border-r-2 border-b-2' : '-top-2 border-l-2 border-t-2'} left-8 w-4 h-4 bg-yellow-300 border-[#141414] rotate-45`} />
                  </motion.div>
                )}
              </AnimatePresence>

              <textarea 
                ref={textareaRef}
                rows={1}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Enter search topic..."
                className="w-full bg-[#F5F5F5] border border-[#141414] p-4 pr-14 focus:outline-none focus:ring-0 text-base sm:text-lg font-mono resize-none overflow-y-auto max-h-32"
                style={{ height: 'auto', minHeight: '72px' }}
                disabled={state.status !== 'idle' && state.status !== 'complete'}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleSearch(e);
                  }
                }}
              />
              <button 
                type="submit"
                title="Execute evolutionary synthesis pipeline"
                className="absolute right-4 top-1/2 -translate-y-1/2 w-8 h-8 bg-[#141414] text-[#E4E3E0] flex items-center justify-center hover:bg-opacity-90 transition-colors disabled:opacity-50 shadow-[2px_2px_0px_0px_rgba(0,0,0,0.2)]"
                disabled={state.status !== 'idle' && state.status !== 'complete'}
              >
                {state.status === 'idle' || state.status === 'complete' ? <Search size={16} /> : <Loader2 size={16} className="animate-spin" />}
              </button>
            </form>
            <p className="mt-3 text-[10px] opacity-60 leading-relaxed">
              Initiates a multi-tiered pipeline: Targeted Crawling → NLP Extraction → Evolutionary Processing → Assembly.
            </p>
          </section>

          {/* Engine Status */}
          <section className="bg-white border border-[#141414] p-6 shadow-[4px_4px_0px_0px_rgba(20,20,20,1)]">
            <div className="flex justify-between items-center mb-6">
              <h2 className="font-serif italic text-sm uppercase opacity-50">Evolutionary Metrics</h2>
              <div className="flex items-center gap-3">
                <AnimatePresence>
                  {state.status !== 'idle' && state.status !== 'complete' && !showArtifacts && (
                    <motion.div
                      initial={{ opacity: 0, x: 10 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: 10 }}
                      className="flex items-center gap-2"
                    >
                      <div className="flex items-center gap-1 bg-red-50 px-1.5 py-0.5 border border-red-200 rounded-sm">
                        <motion.div 
                          animate={{ scale: [1, 1.5, 1], opacity: [1, 0.5, 1] }}
                          transition={{ repeat: Infinity, duration: 1.5 }}
                          className="w-1.5 h-1.5 bg-red-600 rounded-full"
                        />
                        <motion.span
                          animate={{ opacity: [1, 0, 1, 0.2, 1] }}
                          transition={{ repeat: Infinity, duration: 0.8, ease: "linear" }}
                          className="text-[8px] font-black text-red-600 tracking-tighter"
                        >
                          LIVE
                        </motion.span>
                      </div>
                      <motion.span
                        animate={{ opacity: [0.6, 1, 0.6] }}
                        transition={{ repeat: Infinity, duration: 2 }}
                        className="text-[9px] uppercase font-bold tracking-tighter text-blue-600 hidden sm:inline"
                      >
                        Click [Show Artifacts] to monitor synthesis trace
                      </motion.span>
                    </motion.div>
                  )}
                </AnimatePresence>
                <button 
                  onClick={() => setShowArtifacts(!showArtifacts)}
                  title={showArtifacts ? "Close the technical artifacts panel" : "View raw search results, evolutionary population, and assembly trace"}
                  className={`text-[10px] uppercase font-bold flex items-center gap-1 px-2 py-1 border border-[#141414] transition-all ${showArtifacts ? 'bg-[#141414] text-white' : 'hover:bg-[#F5F5F5]'}`}
                >
                  <Layers size={12}/> {showArtifacts ? 'Hide Artifacts' : 'Show Artifacts'}
                </button>
              </div>
            </div>
            
            <div className="space-y-6">
              <div className="flex justify-between items-end border-b border-[#141414] pb-2">
                <span className="text-[11px] uppercase font-bold">Status</span>
                <span className={`text-[11px] uppercase font-mono px-2 py-0.5 rounded-full ${state.status === 'complete' ? 'bg-green-100 text-green-800' : 'bg-blue-100 text-blue-800'}`}>
                  {state.status}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="border border-[#141414] p-3 bg-[#F5F5F5]">
                  <span className="block text-[9px] uppercase opacity-50 mb-1">Generation</span>
                  <span className="text-2xl font-mono font-bold">{state.generation}</span>
                </div>
                <div className="border border-[#141414] p-3 bg-[#F5F5F5]">
                  <span className="block text-[9px] uppercase opacity-50 mb-1">Pop. Size</span>
                  <span className="text-2xl font-mono font-bold">{state.population.length}</span>
                </div>
              </div>

              {state.status !== 'idle' && (
                <div className="space-y-2">
                  <div className="flex justify-between text-[10px] uppercase font-bold">
                    <span>Processing Pipeline</span>
                    <span>{state.status === 'complete' ? '100%' : 'In Progress'}</span>
                  </div>
                  <div className="h-2 bg-[#F5F5F5] border border-[#141414] overflow-hidden">
                    <motion.div 
                      className="h-full bg-[#141414]"
                      initial={{ width: 0 }}
                      animate={{ width: state.status === 'complete' ? '100%' : '60%' }}
                      transition={{ duration: 2, ease: "easeInOut" }}
                    />
                  </div>
                </div>
              )}

              {error && (
                <div className="bg-red-50 border border-red-200 p-3 text-red-800 text-xs flex gap-2 items-start">
                  <AlertCircle size={14} className="shrink-0 mt-0.5" />
                  <span>{error}</span>
                </div>
              )}
            </div>
          </section>

          {/* Legend */}
          <section className="p-4 border border-[#141414] border-dashed opacity-60">
            <h3 className="text-[10px] uppercase font-bold mb-3 flex items-center gap-2"><Info size={12}/> Fitness Function F(w)</h3>
            <p className="text-[10px] font-mono leading-relaxed">
              F(w) = αI(w) + βA(w) − γR(w,S)<br/>
              α: Informative Score (NLP)<br/>
              β: Authority Score (Topology)<br/>
              γ: Redundancy Penalty (Overlap)
            </p>
          </section>

          {/* Artifacts Panel (Collapsible) */}
          <AnimatePresence>
            {showArtifacts && (
              <motion.section 
                ref={artifactsRef}
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                className="overflow-hidden"
              >
                <div className="bg-[#141414] text-[#E4E3E0] p-6 border border-[#141414] shadow-[4px_4px_0px_0px_rgba(20,20,20,0.5)] space-y-6 font-mono text-[10px]">
                  <div className="flex items-center justify-between border-b border-white/10 pb-2">
                    <h3 className="uppercase font-bold tracking-widest flex items-center gap-2">
                      <Cpu size={14} /> System Artifacts
                    </h3>
                    <button onClick={() => setShowArtifacts(false)} title="Close panel" className="hover:opacity-50">
                      <X size={14} />
                    </button>
                  </div>

                  {/* Raw Search Results */}
                  <div className="space-y-2">
                    <h4 className="text-blue-400 uppercase font-bold border-l-2 border-blue-400 pl-2">Raw Search Grounding</h4>
                    {state.artifacts?.rawSearchResults && state.artifacts.rawSearchResults.length > 0 ? (
                      <div className="space-y-2 max-h-40 overflow-y-auto pr-2 custom-scrollbar">
                        {state.artifacts.rawSearchResults.map((chunk: any, i: number) => (
                          <div key={i} className="bg-white/5 p-2 border border-white/10">
                            <div className="font-bold text-white truncate">{chunk.web?.title || 'Untitled Source'}</div>
                            <div className="opacity-50 truncate">{chunk.web?.uri}</div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="opacity-30 italic">No search artifacts captured yet.</div>
                    )}
                  </div>

                  {/* Evolved Population */}
                  <div className="space-y-2">
                    <h4 className="text-green-400 uppercase font-bold border-l-2 border-green-400 pl-2">Evolved Population</h4>
                    {state.artifacts?.evolvedPopulation && state.artifacts.evolvedPopulation.length > 0 ? (
                      <div className="space-y-2 max-h-40 overflow-y-auto pr-2 custom-scrollbar">
                        {state.artifacts.evolvedPopulation.map((gen: WebPageGenotype, i: number) => (
                          <div key={i} className="bg-white/5 p-2 border border-white/10 flex justify-between items-center">
                            <div className="truncate flex-1 mr-4">
                              <div className="font-bold text-white truncate">{gen.title}</div>
                              <div className="opacity-50 truncate text-[8px]">{gen.url}</div>
                            </div>
                            <div className="text-right shrink-0">
                              <div className="text-green-400 font-bold">{(gen.fitness || 0).toFixed(4)}</div>
                              <div className="text-[8px] opacity-40">FITNESS</div>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="opacity-30 italic">Evolution in progress...</div>
                    )}
                  </div>

                  {/* Assembly Pipeline */}
                  <div className="space-y-2">
                    <h4 className="text-orange-400 uppercase font-bold border-l-2 border-orange-400 pl-2">Assembly Pipeline</h4>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="bg-white/5 p-2 border border-white/10">
                        <div className="opacity-50 mb-1">INPUT (TOP GENES)</div>
                        <div className="font-bold text-white">
                          {state.artifacts?.assemblyInput ? `${state.artifacts.assemblyInput.length} Sources` : 'Pending'}
                        </div>
                      </div>
                      <div className="bg-white/5 p-2 border border-white/10">
                        <div className="opacity-50 mb-1">OUTPUT (BOOK)</div>
                        <div className="font-bold text-white">
                          {state.artifacts?.assemblyOutput ? `${state.artifacts.assemblyOutput.chapters.length} Chapters` : 'Pending'}
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="pt-2 text-[8px] opacity-30 italic text-center border-t border-white/10">
                    Real-time trace of the evolutionary assembly process.
                  </div>
                </div>
              </motion.section>
            )}
          </AnimatePresence>
        </div>

        {/* Right Column: Results */}
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

            {state.status === 'searching' || state.status === 'evolving' || state.status === 'assembling' ? (
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
                   {['Crawling', 'Evolving', 'Assembling'].map((step, i) => (
                     <div key={step} className="flex flex-col items-center gap-2">
                        <div className={`w-3 h-3 rounded-full border border-[#141414] ${state.status === step.toLowerCase() || (state.status === 'searching' && i === 0) || (state.status === 'evolving' && i === 1) || (state.status === 'assembling' && i === 2) ? 'bg-[#141414]' : 'bg-transparent'}`} />
                        <span className="text-[9px] uppercase font-bold tracking-widest">{step}</span>
                     </div>
                   ))}
                </div>
              </motion.div>
            ) : webBook && (
              <motion.div 
                key="content"
                initial={{ opacity: 0, scale: 0.98 }}
                animate={{ opacity: 1, scale: 1 }}
                className="flex flex-col items-center gap-8 pb-20 overflow-x-hidden"
              >
                {/* Document Container - Mimics A4/PDF */}
                <div id="top" className="web-book-container w-full max-w-[900px] space-y-8 overflow-x-hidden print:max-w-none print:space-y-0">
                  {/* PDF Style Header / Cover */}
                  <section id="page-1" data-pdf-page-number="1" data-pdf-page-kind="cover" className="web-book-page bg-[#141414] text-[#E4E3E0] p-16 relative overflow-hidden text-center min-h-[1000px] md:min-h-[1123px] flex flex-col justify-center border border-[#141414] shadow-[12px_12px_0px_0px_rgba(20,20,20,0.18)] print:shadow-none print:border-none print:break-inside-avoid print:page-break-after-always">
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
                          <span className="text-3xl font-mono">{webBook.chapters.reduce((acc, c) => acc + c.definitions.length, 0)}</span>
                        </div>
                        <div className="flex flex-col">
                          <span className="text-[9px] uppercase opacity-50 mb-2 tracking-widest">Date</span>
                          <span className="text-3xl font-mono">{new Date(webBook.timestamp).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}</span>
                        </div>
                      </div>
                    </div>
                    {/* Decorative background elements */}
                    <div className="absolute top-0 left-0 w-full h-full opacity-10 pointer-events-none">
                      <div className="absolute top-10 left-10 w-80 h-80 border border-white rounded-full" />
                      <div className="absolute bottom-10 right-10 w-96 h-96 border border-white rounded-full" />
                    </div>
                    <div className="absolute bottom-12 left-1/2 -translate-x-1/2 text-[10px] font-mono opacity-40">
                      PAGE 1
                    </div>
                  </section>

                  {/* Table of Contents - Page 2 Style */}
                  <section id="page-2" data-pdf-page-number="2" data-pdf-page-kind="toc" className="web-book-page p-12 md:p-20 bg-[#FAFAFA] min-h-[1000px] md:min-h-[1123px] flex flex-col relative border border-[#141414] shadow-[12px_12px_0px_0px_rgba(20,20,20,0.12)] print:shadow-none print:border-none print:break-inside-avoid print:page-break-after-always">
                    <h3 className="text-[14px] uppercase font-bold mb-16 tracking-[0.3em] border-b-2 border-[#141414] pb-6 inline-block self-start">Table of Contents</h3>
                    <div className="space-y-8 flex-1">
                      {chapterRenderPlan.map(({ chapter, titlePageNumber }, i) => (
                        <a key={i} href={`#chapter-${i}`} data-pdf-target-page={titlePageNumber} title={`Navigate to Chapter ${i+1}`} className="flex items-end gap-4 md:gap-6 group">
                          <span className="font-mono text-base opacity-40">0{i+1}</span>
                          <span className="text-lg md:text-xl font-medium group-hover:underline underline-offset-8 decoration-1 break-words">{chapter.title}</span>
                          <div className="flex-1 border-b border-dotted border-[#141414] opacity-20 mb-2" />
                          <span className="font-mono text-base opacity-40">P.{titlePageNumber}</span>
                        </a>
                      ))}
                    </div>
                    <div className="mt-auto pt-12 flex justify-center text-[10px] font-mono opacity-40">
                      PAGE 2
                    </div>
                  </section>

                  {/* Chapters - Paginated Experience */}
                  <div className="space-y-8">
                    {chapterRenderPlan.map(({ chapter, titlePageNumber, analysisPageNumber, renderableDefinitions, renderableSubTopics }, i) => (
                      <React.Fragment key={i}>
                        {/* Chapter Page 1: Title & Image */}
                        <section id={`page-${titlePageNumber}`} data-pdf-page-number={String(titlePageNumber)} data-pdf-page-kind="chapter" className="web-book-page p-10 md:p-16 bg-white border border-[#141414] shadow-[12px_12px_0px_0px_rgba(20,20,20,0.12)] min-h-[1000px] md:min-h-[1123px] flex flex-col relative print:shadow-none print:border-none print:break-inside-avoid print:page-break-after-always">
                          <div id={`chapter-${i}`} className="absolute top-0 left-0" aria-hidden="true" />
                          <div className="flex items-center justify-between gap-4 mb-12 border-b border-[#141414]/10 pb-6">
                            <div className="flex items-center gap-4 min-w-0">
                              <span className="w-10 h-10 bg-[#141414] text-white flex items-center justify-center font-mono text-sm">0{i+1}</span>
                              <h3 className="text-3xl md:text-4xl font-serif italic font-bold tracking-tight break-words">{chapter.title}</h3>
                            </div>
                            <div className="text-[10px] uppercase font-bold opacity-30 tracking-widest">Chapter {i+1} / {chapterRenderPlan.length}</div>
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
                          </div>

                          <div className="mt-auto pt-12 flex justify-between items-center border-t border-[#141414]/5 text-[10px] font-mono opacity-40">
                            <span className="break-words">{webBook.topic}</span>
                            <span>PAGE {titlePageNumber}</span>
                          </div>
                        </section>

                        {/* Chapter Page 2: Analysis & Glossary */}
                        {analysisPageNumber !== null && (
                          <section id={`page-${analysisPageNumber}`} data-pdf-page-number={String(analysisPageNumber)} data-pdf-page-kind="analysis" className="web-book-page p-10 md:p-16 bg-white border border-[#141414] shadow-[12px_12px_0px_0px_rgba(20,20,20,0.12)] min-h-[1000px] md:min-h-[1123px] flex flex-col relative print:shadow-none print:border-none print:break-inside-avoid print:page-break-after-always">
                            <div className="flex-1 space-y-12">
                              {renderableSubTopics.length > 0 && (
                                <div className="space-y-8">
                                  <h4 className="text-[12px] uppercase font-bold tracking-[0.2em] flex items-center gap-3 text-[#141414]/60 border-b border-[#141414]/10 pb-4">
                                    <Layers size={16} /> Deep Analysis & Sub-Topics
                                  </h4>
                                  <div className="grid grid-cols-1 md:grid-cols-2 gap-10">
                                    {renderableSubTopics.map((sub, j) => (
                                      <div key={j} className="relative pl-8 group">
                                        <div className="absolute left-0 top-0 bottom-0 w-[2px] bg-[#141414]/10 group-hover:bg-[#141414] transition-colors" />
                                        <h5 className="font-bold text-xl mb-3">{sub.title}</h5>
                                        <p className="text-base text-gray-600 leading-relaxed font-light">{sub.summary}</p>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              )}

                              {renderableDefinitions.length > 0 && (
                                <div className="bg-[#141414] text-white p-10 shadow-xl">
                                  <h4 className="text-[10px] uppercase font-bold tracking-[0.3em] mb-10 flex items-center gap-3 opacity-70 border-b border-white/10 pb-6">
                                    <BookOpen size={16} /> Technical Glossary
                                  </h4>
                                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-x-12 gap-y-10">
                                    {renderableDefinitions.map((def, j) => {
                                      const words = (def.description || "").split(/\s+/);
                                      const isLong = words.length > 100;
                                      const displayDescription = isLong 
                                        ? words.slice(0, 100).join(" ") 
                                        : def.description;

                                      return (
                                        <div key={j} className="group">
                                          <span className="font-mono text-[12px] font-bold block mb-3 uppercase text-blue-400 tracking-wider break-words">
                                            {def.term}
                                          </span>
                                          <p className="text-sm leading-relaxed opacity-80 font-light italic border-l border-white/10 pl-4 break-words">
                                            {displayDescription}
                                            {isLong && (
                                              <>
                                                ...{" "}
                                                <a 
                                                  href={def.sourceUrl} 
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
                                        </div>
                                      );
                                    })}
                                  </div>
                                  
                                  <div className="mt-10 pt-6 border-t border-white/10">
                                    <div className="flex items-center gap-3 text-[9px] font-bold uppercase opacity-40 break-all">
                                      <div className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-pulse shrink-0" />
                                      Source Verification:{" "}
                                      {typeof chapter.sourceUrls[0] === 'object' ? (
                                        <a 
                                          href={chapter.sourceUrls[0].url} 
                                          target="_blank" 
                                          rel="noopener noreferrer"
                                          title="Verify this information at the primary source"
                                          className="hover:underline"
                                        >
                                          {chapter.sourceUrls[0].title}
                                        </a>
                                      ) : (
                                        chapter.sourceUrls[0]
                                      )}
                                    </div>
                                  </div>
                                </div>
                              )}
                            </div>

                            <div className="mt-auto pt-12 flex justify-between items-center border-t border-[#141414]/5 text-[10px] font-mono opacity-40">
                              <span>Evolutionary Node {i+1}.{chapter.visualSeed?.length || 0}</span>
                              <span>PAGE {analysisPageNumber}</span>
                            </div>
                          </section>
                        )}
                      </React.Fragment>
                    ))}
                  </div>

                  {/* Document Footer - Inside export container for inclusion in PDF/Word */}
                  <section id={`page-${finalDocumentPageNumber}`} data-pdf-page-number={String(finalDocumentPageNumber)} data-pdf-page-kind="footer" className="web-book-page p-10 md:p-16 bg-[#F5F5F5] border border-[#141414] shadow-[12px_12px_0px_0px_rgba(20,20,20,0.12)] min-h-[170px] md:min-h-[210px] flex flex-col justify-end gap-4 w-full print:shadow-none print:border-none print:break-inside-avoid">
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
                    <div className="text-[10px] font-mono opacity-40">PAGE {finalDocumentPageNumber}</div>
                  </section>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </main>

      {/* History Sidebar/Modal Overlay */}
      <AnimatePresence>
        {showHistory && (
          <>
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowHistory(false)}
              className="fixed inset-0 bg-[#141414]/40 backdrop-blur-sm z-[100]"
              data-html2canvas-ignore="true"
            />
            <motion.div 
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              className="fixed right-0 top-0 bottom-0 w-full max-w-md bg-[#E4E3E0] border-l border-[#141414] z-[101] shadow-2xl flex flex-col"
              data-html2canvas-ignore="true"
            >
              <div className="p-6 border-b border-[#141414] flex justify-between items-center bg-white">
                <h2 className="text-lg font-serif italic font-bold flex items-center gap-2">
                  <History size={20} /> Archive & History
                </h2>
                <button onClick={() => setShowHistory(false)} title="Close history" className="p-2 hover:bg-[#F5F5F5] rounded-full transition-colors">
                  <X size={20} />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto p-6 space-y-4">
                {history.length === 0 ? (
                  <div className="h-full flex flex-col items-center justify-center opacity-30 text-center">
                    <Clock size={48} />
                    <p className="mt-4 font-serif italic">No archived Web-books found</p>
                  </div>
                ) : (
                  history.map((item) => (
                    <div 
                      key={item.id}
                      className="bg-white border border-[#141414] p-4 shadow-[4px_4px_0px_0px_rgba(20,20,20,1)] hover:translate-x-1 hover:translate-y-1 hover:shadow-none transition-all group relative"
                    >
                      <div className="flex justify-between items-start mb-2">
                        <span className="text-[9px] uppercase font-mono opacity-50">
                          {new Date(item.timestamp).toLocaleDateString()} • {new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </span>
                        <button 
                          onClick={(e) => {
                            e.stopPropagation();
                            deleteHistoryItem(item.id);
                          }}
                          title="Delete this book from history"
                          className="text-red-600 opacity-0 group-hover:opacity-100 transition-opacity p-1 hover:bg-red-50 rounded"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                      <h3 className="font-serif italic font-bold text-lg leading-tight mb-3">{item.topic}</h3>
                      <div className="flex justify-between items-center">
                        <span className="text-[10px] uppercase font-bold opacity-60">{item.chapters.length} Chapters</span>
                        <button 
                          onClick={() => viewHistoryItem(item)}
                          title="Load this archived Web-book into the viewer"
                          className="text-[10px] uppercase font-bold flex items-center gap-1 hover:underline"
                        >
                          View Book <ChevronRight size={12} />
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>

              {history.length > 0 && (
                <div className="p-6 border-t border-[#141414] bg-white">
                  <button 
                    onClick={clearAllHistory}
                    title="Permanently delete all archived Web-books"
                    className="w-full py-3 border border-red-600 text-red-600 text-[11px] uppercase font-bold tracking-widest hover:bg-red-600 hover:text-white transition-all"
                  >
                    Clear All History
                  </button>
                </div>
              )}
            </motion.div>
          </>
        )}
      </AnimatePresence>

      <footer className="mt-20 border-t border-[#141414] p-10 text-center opacity-40 print:hidden">
        <p className="text-[10px] uppercase tracking-[0.5em]">Architecting an Evolutionary Web-Book Engine © 2026</p>
        <p className="text-[9px] mt-2">Hock Chiye Er</p>
      </footer>
    </div>
  );
}
