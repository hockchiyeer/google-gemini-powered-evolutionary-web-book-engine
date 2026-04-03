import { useEffect, useState } from 'react';
import type { EvolutionState, WebBook } from '../types';
import { assembleWebBook, evolve, searchAndExtract } from '../services/evolutionService';
import {
  clearPersistedSearches,
  completePersistedSearch,
  createPersistedSearch,
  deletePersistedSearch,
  failPersistedSearch,
  loadLocalHistoryBooks,
  loadPersistedWebBooks,
  mergeHistoryBooks,
  saveLocalHistoryBooks,
} from '../services/historyService';

const INITIAL_STATE: EvolutionState = {
  generation: 0,
  population: [],
  bestFitness: 0,
  status: 'idle',
  artifacts: {},
};

export function useWebBookEngine() {
  const [query, setQuery] = useState('');
  const [state, setState] = useState<EvolutionState>(INITIAL_STATE);
  const [webBook, setWebBook] = useState<WebBook | null>(null);
  const [history, setHistory] = useState<WebBook[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setHistory(loadLocalHistoryBooks());
  }, []);

  useEffect(() => {
    let isMounted = true;

    const syncPersistedHistory = async () => {
      try {
        const persistedHistory = await loadPersistedWebBooks();
        if (!isMounted || persistedHistory.length === 0) return;
        setHistory((previousHistory) => mergeHistoryBooks(previousHistory, persistedHistory));
      } catch (persistenceError) {
        console.error('Failed to load Firebase history', persistenceError);
      }
    };

    void syncPersistedHistory();

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    saveLocalHistoryBooks(history);
  }, [history]);

  const startNewSearch = () => {
    setQuery('');
    setWebBook(null);
    setError(null);
    setNotice(null);
    setState(INITIAL_STATE);
  };

  const runSearch = async () => {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) return;

    setState({ ...INITIAL_STATE, status: 'searching' });
    setWebBook(null);
    setError(null);
    setNotice(null);

    let persistedSearchId: string | null = null;

    try {
      try {
        persistedSearchId = await createPersistedSearch(trimmedQuery);
      } catch (persistenceError) {
        console.error('Failed to create persisted search record', persistenceError);
      }

      const searchResult = await searchAndExtract(trimmedQuery);
      const initialPopulation = searchResult.results;
      const initialBest = initialPopulation.length > 0
        ? initialPopulation.reduce((previous, current) => (
          previous.informativeScore + previous.authorityScore > current.informativeScore + current.authorityScore
            ? previous
            : current
        ))
        : null;

      setNotice(searchResult.generationNote || null);
      setState((previousState) => ({
        ...previousState,
        status: 'evolving',
        population: initialPopulation,
        bestInformativeScore: initialBest?.informativeScore || 0,
        bestAuthorityScore: initialBest?.authorityScore || 0,
        bestRedundancyPenalty: 0,
        artifacts: {
          ...previousState.artifacts,
          rawSearchResults: searchResult.artifacts.groundingChunks,
          searchSummary: searchResult.artifacts.searchSummary,
        },
      }));

      const evolvedPopulation = await evolve(initialPopulation);
      const bestEvolved = evolvedPopulation.length > 0
        ? evolvedPopulation.reduce((previous, current) => previous.fitness > current.fitness ? previous : current)
        : null;

      setState((previousState) => ({
        ...previousState,
        status: 'assembling',
        population: evolvedPopulation,
        bestFitness: bestEvolved?.fitness || 0,
        bestInformativeScore: bestEvolved?.informativeScore || 0,
        bestAuthorityScore: bestEvolved?.authorityScore || 0,
        bestRedundancyPenalty: 0,
        artifacts: {
          ...previousState.artifacts,
          evolvedPopulation,
        },
      }));

      const assembledBook = await assembleWebBook(evolvedPopulation, trimmedQuery, searchResult);
      const book = persistedSearchId ? { ...assembledBook, id: persistedSearchId } : assembledBook;

      setWebBook(book);
      setNotice(book.generationNote || searchResult.generationNote || null);
      setHistory((previousHistory) => mergeHistoryBooks([book], previousHistory));

      void completePersistedSearch(persistedSearchId, trimmedQuery, book).catch((persistenceError) => {
        console.error('Failed to persist completed WebBook', persistenceError);
      });

      setState((previousState) => ({
        ...previousState,
        status: 'complete',
        generation: 3,
        population: evolvedPopulation,
        bestFitness: bestEvolved?.fitness || 0,
        bestInformativeScore: bestEvolved?.informativeScore || 0,
        bestAuthorityScore: bestEvolved?.authorityScore || 0,
        bestRedundancyPenalty: 0,
        artifacts: {
          ...previousState.artifacts,
          assemblyInput: evolvedPopulation.slice(0, 4),
          assemblyOutput: book,
        },
      }));
    } catch (runtimeError: any) {
      console.error('Evolution error:', runtimeError);
      let message = runtimeError?.message || 'An unexpected error occurred during evolution.';
      if (message.includes('429') || message.includes('quota') || message.includes('RESOURCE_EXHAUSTED')) {
        message = 'The AI engine is currently busy or has reached its rate limit. Please wait a minute and try again.';
      }

      void failPersistedSearch(persistedSearchId, trimmedQuery, message).catch((persistenceError) => {
        console.error('Failed to persist failed search', persistenceError);
      });

      setError(message);
      setNotice(null);
      setState(INITIAL_STATE);
    }
  };

  const viewHistoryItem = (item: WebBook) => {
    setWebBook(item);
    setQuery(item.topic);
    setError(null);
    setNotice(item.generationNote || null);
    setState({
      generation: 3,
      population: [],
      bestFitness: 0,
      status: 'complete',
      artifacts: {},
    });
  };

  const deleteHistoryItem = (id: string) => {
    setHistory((previousHistory) => previousHistory.filter((item) => item.id !== id));
    if (webBook?.id === id) {
      startNewSearch();
    }

    void deletePersistedSearch(id).catch((persistenceError) => {
      console.error('Failed to delete persisted history item', persistenceError);
    });
  };

  const clearAllHistory = () => {
    if (!window.confirm('Are you sure you want to delete all search history?')) {
      return;
    }

    setHistory([]);
    if (webBook) {
      startNewSearch();
    }

    void clearPersistedSearches().catch((persistenceError) => {
      console.error('Failed to clear persisted history', persistenceError);
    });
  };

  return {
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
  };
}
