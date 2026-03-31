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

// Declare html2pdf as a global variable to avoid TypeScript errors
// It is loaded via CDN in index.html to avoid module resolution issues
declare const html2pdf: any;
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
    status: 'idle'
  });
  const [webBook, setWebBook] = useState<WebBook | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<WebBook[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [showExportOptions, setShowExportOptions] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const exportDropdownRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const [isHoveringInput, setIsHoveringInput] = useState(false);

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

    setState({ ...state, status: 'searching', generation: 0, population: [] });
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
      const initialPopulation = await searchAndExtract(trimmedQuery);
      
      // 2. Evolutionary Processing Engine
      setState(s => ({ ...s, status: 'evolving', population: initialPopulation }));
      const evolvedPopulation = await evolve(initialPopulation);
      
      // 3. Web-Book Assembly
      setState(s => ({ ...s, status: 'assembling', population: evolvedPopulation }));
      const assembledBook = await assembleWebBook(evolvedPopulation, trimmedQuery);
      const book = persistedSearchId
        ? { ...assembledBook, id: persistedSearchId }
        : assembledBook;
      
      setWebBook(book);
      setHistory(prev => mergeHistoryBooks([book], prev));
      void completePersistedSearch(persistedSearchId, trimmedQuery, book).catch((persistenceError) => {
        console.error("Failed to persist completed WebBook", persistenceError);
      });
      setState({
        status: 'complete',
        generation: 3,
        population: evolvedPopulation,
        bestFitness: Math.max(...evolvedPopulation.map((p: any) => p.fitness || 0))
      });
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
      status: 'idle'
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
    const htmlContent = document.querySelector('.web-book-container')?.innerHTML;
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
            body { font-family: 'Inter', sans-serif; background: #E4E3E0; padding: 40px 0; }
            .font-serif { font-family: 'Playfair Display', serif; }
            .font-mono { font-family: 'JetBrains Mono', monospace; }
            * { word-break: break-word; overflow-wrap: break-word; }
          </style>
        </head>
        <body>
          <div id="top" class="max-w-[850px] mx-auto bg-white border border-black shadow-xl">
            ${htmlContent}
          </div>
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
    const element = document.querySelector('.web-book-container');
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

      // Add name anchors for TOC links to work better in Word
      clone.querySelectorAll('[id^="chapter-"]').forEach(el => {
        const id = el.getAttribute('id');
        const anchor = document.createElement('a');
        anchor.setAttribute('name', id || '');
        el.prepend(anchor);
      });

      const htmlContent = clone.innerHTML;
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
    const element = document.querySelector('.web-book-container');
    if (!element) return;

    setIsExporting(true);
    setShowExportOptions(false);

    // Use a small delay to allow UI to update
    await new Promise(resolve => setTimeout(resolve, 100));

    try {
      // Create a simplified clone for PDF
      const clone = element.cloneNode(true) as HTMLElement;
      
      // Remove heavy elements
      clone.querySelectorAll('button, .print\\:hidden, [data-html2canvas-ignore]').forEach(el => el.remove());
      
      // Simplify styles
      clone.style.width = '800px'; 
      clone.style.background = 'white';
      clone.style.boxShadow = 'none';
      clone.style.margin = '0';
      clone.style.position = 'absolute';
      clone.style.left = '-9999px';
      clone.style.top = '0';
      document.body.appendChild(clone);
      
      // Fast image processing - only convert if necessary and use lower quality
      const images = clone.querySelectorAll('img');
      for (const img of Array.from(images)) {
        try {
          // Skip if already base64
          if (img.src.startsWith('data:')) continue;
          
          const canvas = document.createElement('canvas');
          const ctx = canvas.getContext('2d');
          const tempImg = new Image();
          tempImg.crossOrigin = 'anonymous';
          
          await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error("Image load timeout")), 3000);
            tempImg.onload = () => { clearTimeout(timeout); resolve(null); };
            tempImg.onerror = () => { clearTimeout(timeout); reject(new Error("Image load error")); };
            tempImg.src = img.src;
          });

          // Downscale for PDF to save memory
          const maxDim = 1200;
          let w = tempImg.width;
          let h = tempImg.height;
          if (w > maxDim || h > maxDim) {
            if (w > h) { h = (h / w) * maxDim; w = maxDim; }
            else { w = (w / h) * maxDim; h = maxDim; }
          }

          canvas.width = w;
          canvas.height = h;
          ctx?.drawImage(tempImg, 0, 0, w, h);
          img.src = canvas.toDataURL('image/jpeg', 0.6); // Lower quality for speed/memory
          
          img.style.filter = 'none';
          img.style.boxShadow = 'none';
          img.className = img.className.replace(/grayscale|hover:grayscale-0/g, '');
        } catch (e) {
          console.warn("Skipping image in PDF export:", e);
          // If image fails, we just leave it or remove it to prevent freeze
          img.style.display = 'none';
        }
      }

      const opt: any = {
        margin: [10, 10] as [number, number],
        filename: `${webBook.topic.replace(/\s+/g, '_')}.pdf`,
        image: { type: 'jpeg', quality: 0.8 },
        html2canvas: { 
          scale: 1, 
          useCORS: false, 
          logging: false,
          letterRendering: true,
          allowTaint: true,
          removeContainer: true,
          imageTimeout: 0
        },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait', compress: true },
        pagebreak: { mode: ['avoid-all', 'css', 'legacy'] }
      };

      if (typeof html2pdf === 'undefined') {
        throw new Error("html2pdf library not loaded from CDN");
      }

      await html2pdf().from(clone).set(opt).save();
      document.body.removeChild(clone);
    } catch (err) {
      console.error("PDF Export failed:", err);
      alert("High-Res PDF export failed due to resource limits. This is common for large books in browser environments. Please use the 'Print / Save as PDF' option which is much more reliable.");
    } finally {
      setIsExporting(false);
    }
  };

  const exportToPrint = () => {
    if (!webBook) return;
    const element = document.querySelector('.web-book-container');
    if (!element) return;

    // Create a new window for printing to bypass iframe restrictions
    const printWindow = window.open('', '_blank');
    if (!printWindow) {
      alert("Please allow popups to use the print feature.");
      return;
    }

    const htmlContent = element.innerHTML;
    printWindow.document.write(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>${webBook.topic}</title>
          <script src="https://cdn.tailwindcss.com"></script>
          <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;700&family=Playfair+Display:ital,wght@0,400;0,700;1,400;1,700&display=swap" rel="stylesheet">
          <style>
            body { font-family: 'Inter', sans-serif; background: white; padding: 0; margin: 0; }
            .font-serif { font-family: 'Playfair Display', serif; }
            .print\\:hidden { display: none !important; }
            @media print {
              body { padding: 0; }
              .no-print { display: none; }
              @page { margin: 1.5cm; }
            }
          </style>
        </head>
        <body>
          <div class="max-w-[850px] mx-auto p-8">
            ${htmlContent}
          </div>
          <script>
            // Wait for tailwind and fonts
            window.onload = () => {
              setTimeout(() => {
                window.print();
                // We don't close immediately to allow the user to see the print dialog
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
                    title={`Chapter ${i+1}`}
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
                          className="w-full px-4 py-3 text-left text-[10px] uppercase font-bold hover:bg-[#F5F5F5] flex items-center gap-3 border-b border-[#141414]/10"
                        >
                          <FileText size={14} className="text-red-600" /> PDF Document (High Res)
                        </button>
                        <button 
                          onClick={() => { exportToPrint(); setShowExportOptions(false); }}
                          className="w-full px-4 py-3 text-left text-[10px] uppercase font-bold hover:bg-[#F5F5F5] flex items-center gap-3 border-b border-[#141414]/10"
                        >
                          <Printer size={14} className="text-green-600" /> Print / Save as PDF (Lightweight)
                        </button>
                        <button 
                          onClick={() => { exportToWord(); setShowExportOptions(false); }}
                          className="w-full px-4 py-3 text-left text-[10px] uppercase font-bold hover:bg-[#F5F5F5] flex items-center gap-3 border-b border-[#141414]/10"
                        >
                          <FileText size={14} className="text-blue-600" /> Word (.doc)
                        </button>
                        <button 
                          onClick={() => { exportToHTML(); setShowExportOptions(false); }}
                          className="w-full px-4 py-3 text-left text-[10px] uppercase font-bold hover:bg-[#F5F5F5] flex items-center gap-3 border-b border-[#141414]/10"
                        >
                          <FileCode size={14} className="text-orange-600" /> HTML Webpage
                        </button>
                        <button 
                          onClick={() => { exportToTXT(); setShowExportOptions(false); }}
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
                className="text-[10px] uppercase font-bold flex items-center gap-1 hover:underline"
              >
                <Plus size={12}/> New Search
              </button>
            </div>
            <form 
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
                    initial={{ opacity: 0, y: 10, scale: 0.95 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: 10, scale: 0.95 }}
                    className="absolute bottom-full left-0 mb-3 w-full z-[60] pointer-events-none"
                  >
                    <div className="bg-yellow-300 text-[#141414] p-4 border-2 border-[#141414] shadow-[6px_6px_0px_0px_rgba(20,20,20,1)] text-sm font-mono break-words">
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
                    <div className="absolute -bottom-2 left-8 w-4 h-4 bg-yellow-300 border-r-2 border-b-2 border-[#141414] rotate-45" />
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
            <h2 className="font-serif italic text-sm uppercase mb-6 opacity-50">Evolutionary Metrics</h2>
            
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
                className="flex flex-col items-center gap-8 pb-20"
              >
                {/* Document Container - Mimics A4/PDF */}
                <div id="top" className="web-book-container w-full max-w-[850px] bg-white border border-[#141414] shadow-[12px_12px_0px_0px_rgba(20,20,20,1)] overflow-hidden print:shadow-none print:border-none print:max-w-none">
                  {/* PDF Style Header / Cover */}
                  <div className="bg-[#141414] text-[#E4E3E0] p-16 relative overflow-hidden text-center min-h-[1000px] flex flex-col justify-center print:break-inside-avoid print:page-break-after-always">
                    <div className="relative z-10">
                      <div className="flex flex-col items-center gap-4 mb-8">
                        <div className="w-12 h-12 border-2 border-[#E4E3E0] flex items-center justify-center rotate-45">
                          <Layers size={24} className="-rotate-45" />
                        </div>
                        <span className="text-[10px] uppercase tracking-[0.5em] opacity-60">Evolutionary Web-Book Engine</span>
                      </div>
                      <h2 className="text-7xl font-serif italic font-bold tracking-tighter leading-tight mb-8">{webBook.topic}</h2>
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
                  </div>

                  {/* Table of Contents - Page 2 Style */}
                  <div className="p-20 border-b border-[#141414] bg-[#FAFAFA] min-h-[1000px] flex flex-col print:break-inside-avoid print:page-break-after-always relative">
                    <h3 className="text-[14px] uppercase font-bold mb-16 tracking-[0.3em] border-b-2 border-[#141414] pb-6 inline-block self-start">Table of Contents</h3>
                    <div className="space-y-8 flex-1">
                      {chapterRenderPlan.map(({ chapter, titlePageNumber }, i) => (
                        <a key={i} href={`#chapter-${i}`} className="flex items-end gap-6 group">
                          <span className="font-mono text-base opacity-40">0{i+1}</span>
                          <span className="text-xl font-medium group-hover:underline underline-offset-8 decoration-1">{chapter.title}</span>
                          <div className="flex-1 border-b border-dotted border-[#141414] opacity-20 mb-2" />
                          <span className="font-mono text-base opacity-40">P.{titlePageNumber}</span>
                        </a>
                      ))}
                    </div>
                    <div className="mt-auto pt-12 flex justify-center text-[10px] font-mono opacity-40">
                      PAGE 2
                    </div>
                  </div>

                  {/* Chapters - Paginated Experience */}
                  <div className="bg-[#F0F0F0] p-8 space-y-12">
                    {chapterRenderPlan.map(({ chapter, titlePageNumber, analysisPageNumber, renderableDefinitions, renderableSubTopics }, i) => (
                      <div key={i} className="space-y-12">
                        {/* Chapter Page 1: Title & Image */}
                        <section id={`chapter-${i}`} className="p-16 bg-white border border-[#141414] shadow-sm min-h-[1000px] flex flex-col print:break-inside-avoid print:page-break-after-always">
                          <div className="flex items-center justify-between mb-12 border-b border-[#141414]/10 pb-6">
                            <div className="flex items-center gap-4">
                              <span className="w-10 h-10 bg-[#141414] text-white flex items-center justify-center font-mono text-sm">0{i+1}</span>
                              <h3 className="text-4xl font-serif italic font-bold tracking-tight">{chapter.title}</h3>
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
                            <div className="absolute -bottom-4 right-8 bg-white border border-[#141414] px-4 py-2 text-[10px] uppercase font-bold tracking-widest flex items-center gap-3 shadow-md">
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
                            <span>{webBook.topic}</span>
                            <span>PAGE {titlePageNumber}</span>
                          </div>
                        </section>

                        {/* Chapter Page 2: Analysis & Glossary */}
                        {analysisPageNumber !== null && (
                          <section className="p-16 bg-white border border-[#141414] shadow-sm min-h-[1000px] flex flex-col print:break-inside-avoid print:page-break-after-always">
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
                      </div>
                    ))}
                  </div>

                  {/* Document Footer - Inside export container for inclusion in PDF/Word */}
                  <div className="p-16 bg-[#F5F5F5] border-t border-[#141414] flex flex-col md:flex-row justify-between items-center gap-8 w-full">
                    <div className="flex items-center gap-4">
                      <div className="w-10 h-10 rounded-full bg-green-100 flex items-center justify-center">
                        <CheckCircle2 className="text-green-600" size={20} />
                      </div>
                      <div className="flex flex-col">
                        <span className="text-[10px] uppercase font-bold tracking-widest">Synthesis Verified</span>
                        <span className="text-[9px] opacity-50 font-mono text-left">Engine v2.5 • Evolutionary Pass Complete</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-4">
                      <a 
                        href="#top"
                        onClick={(e) => { e.preventDefault(); window.scrollTo({ top: 0, behavior: 'smooth' }); }}
                        className="text-[10px] uppercase font-bold hover:underline flex items-center gap-2"
                      >
                        Back to Top
                      </a>
                    </div>
                  </div>
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
                <button onClick={() => setShowHistory(false)} className="p-2 hover:bg-[#F5F5F5] rounded-full transition-colors">
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
