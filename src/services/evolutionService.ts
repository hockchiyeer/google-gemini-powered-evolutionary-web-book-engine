import { GoogleGenAI, Type } from "@google/genai";
import { WebPageGenotype } from "../types";
import { getRenderableDefinitions, getRenderableSubTopics, isMeaningfulText } from "../utils/webBookRender";

// The API key is injected via Vite's 'define' in vite.config.ts
const getAI = () => new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

async function withRetry<T>(fn: () => Promise<T>, retries = 3, delay = 2000): Promise<T> {
  try {
    return await fn();
  } catch (error: any) {
    if (retries > 0 && (error.message?.includes("429") || error.message?.includes("quota") || error.message?.includes("RESOURCE_EXHAUSTED"))) {
      await new Promise(resolve => setTimeout(resolve, delay));
      return withRetry(fn, retries - 1, delay * 2);
    }
    throw error;
  }
}

function repairTruncatedJSON(jsonString: string): string {
  const attemptRepair = (str: string) => {
    let stack: string[] = [];
    let inString = false;
    let escaped = false;
    
    for (let i = 0; i < str.length; i++) {
      const char = str[i];
      if (escaped) { escaped = false; continue; }
      if (char === '\\') { escaped = true; continue; }
      if (char === '"') { inString = !inString; continue; }
      if (inString) continue;
      
      if (char === '{' || char === '[') {
        stack.push(char);
      } else if (char === '}' || char === ']') {
        if (stack.length > 0) {
          const last = stack[stack.length - 1];
          if ((char === '}' && last === '{') || (char === ']' && last === '[')) {
            stack.pop();
          }
        }
      }
    }
    
    let repaired = str;
    if (inString) repaired += '"';
    while (stack.length > 0) {
      const last = stack.pop();
      if (last === '{') repaired += '}';
      else if (last === '[') repaired += ']';
    }
    return repaired;
  };

  // First attempt: just close open structures
  let firstTry = attemptRepair(jsonString);
  try {
    JSON.parse(firstTry);
    return firstTry;
  } catch (e) {
    // Second attempt: backtrack to last comma and try again
    // This handles cases where we are in the middle of a key or value
    let lastComma = jsonString.lastIndexOf(',');
    while (lastComma > 0) {
      // Truncate before the comma to avoid trailing comma issues
      let truncated = jsonString.substring(0, lastComma);
      let secondTry = attemptRepair(truncated);
      try {
        JSON.parse(secondTry);
        return secondTry;
      } catch (inner) {
        lastComma = jsonString.lastIndexOf(',', lastComma - 1);
      }
    }
  }
  
  return firstTry; // Fallback to first try if all else fails
}

export async function searchAndExtract(query: string): Promise<{ results: WebPageGenotype[], artifacts: any }> {
  const ai = getAI();
  const model = "gemini-3-flash-preview";
  
  const response = await withRetry(() => ai.models.generateContent({
    model,
    contents: `Search for comprehensive information about "${query}". 
    Identify at least 5 distinct high-quality web pages or sources. 
    For each source, extract:
    1. A list of key definitions found on the page.
    2. A list of salient sub-topics discussed.
    3. A summary of the content.
    4. An assessment of its "Informative Value" (0-1) based on depth of definitions.
    5. An assessment of its "Authority" (0-1) based on source credibility.`,
    config: {
      systemInstruction: "You are a precise data extractor. Extract only real, meaningful definitions and sub-topics from the search results. Do not generate placeholder text, random numbers, or gibberish. If no meaningful definitions are found for a source, return an empty array for that source's definitions.",
      tools: [{ googleSearch: {} }],
      responseMimeType: "application/json",
      maxOutputTokens: 8192,
      responseSchema: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            url: { type: Type.STRING },
            title: { type: Type.STRING },
            content: { type: Type.STRING },
            definitions: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  term: { type: Type.STRING },
                  description: { type: Type.STRING }
                },
                required: ["term", "description"]
              }
            },
            subTopics: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  title: { type: Type.STRING },
                  summary: { type: Type.STRING }
                },
                required: ["title", "summary"]
              }
            },
            informativeScore: { type: Type.NUMBER },
            authorityScore: { type: Type.NUMBER }
          },
          required: ["url", "title", "content", "definitions", "subTopics", "informativeScore", "authorityScore"]
        }
      }
    }
  }));

  let results;
  const rawText = (response.text || "").trim();
  const artifacts = response.candidates?.[0]?.groundingMetadata;

  if (!rawText) return { results: [], artifacts };
  try {
    results = JSON.parse(rawText);
  } catch (e) {
    try {
      results = JSON.parse(repairTruncatedJSON(rawText));
    } catch (inner) {
      console.error("Search JSON Parse Error:", rawText);
      throw new Error("The search engine returned an invalid response. Please try a different query.");
    }
  }
  
  if (!Array.isArray(results)) {
    console.error("Search results is not an array:", results);
    return { results: [], artifacts };
  }
  
  const processedResults = results.map((r: any, index: number) => ({
    ...r,
    id: `gen-${index}-${Date.now()}`,
    content: r.content ? r.content.substring(0, 2000) : "", 
    definitions: (r.definitions || []).map((d: any) => ({ ...d, sourceUrl: r.url })),
    subTopics: (r.subTopics || []).map((s: any) => ({ ...s, sourceUrl: r.url })),
    fitness: 0 
  }));

  return { results: processedResults, artifacts };
}

export function calculateFitness(
  page: WebPageGenotype, 
  optimalSet: WebPageGenotype[], 
  weights: { alpha: number; beta: number; gamma: number }
): number {
  const { alpha, beta, gamma } = weights;
  
  // Redundancy Penalty R(w, S)
  let redundancy = 0;
  if (optimalSet.length > 0) {
    const currentTerms = new Set(optimalSet.flatMap(p => (p.definitions || []).map(d => (d.term || "").toLowerCase())));
    const pageTerms = (page.definitions || []).map(d => (d.term || "").toLowerCase());
    const overlap = pageTerms.filter(t => t && currentTerms.has(t)).length;
    redundancy = overlap / Math.max(pageTerms.length, 1);
  }

  // F(w) = αI(w) + βA(w) − γR(w,S)
  return (alpha * page.informativeScore) + (beta * page.authorityScore) - (gamma * redundancy);
}

export async function evolve(
  population: WebPageGenotype[], 
  generations: number = 3
): Promise<WebPageGenotype[]> {
  let currentPopulation = [...population];
  const weights = { alpha: 0.5, beta: 0.3, gamma: 0.2 };

  for (let g = 0; g < generations; g++) {
    // 1. Selection & Fitness Calculation
    // In our case, we select the best ones to "breed"
    currentPopulation.forEach(p => {
      p.fitness = calculateFitness(p, [], weights); // Initial fitness
    });
    
    currentPopulation.sort((a, b) => b.fitness - a.fitness);
    
    // Keep top 50%
    const survivors = currentPopulation.slice(0, Math.ceil(currentPopulation.length / 2));
    
    // 2. Recombination (Crossover)
    const offspring: WebPageGenotype[] = [];
    for (let i = 0; i < survivors.length - 1; i += 2) {
      const parentA = survivors[i];
      const parentB = survivors[i+1];
      
      // Merge definitions and subtopics
      const child: WebPageGenotype = {
        id: `offspring-${g}-${i}`,
        url: "hybrid-source",
        title: `Synthesized: ${parentA.title} & ${parentB.title}`,
        content: `${parentA.content.substring(0, 500)}... ${parentB.content.substring(0, 500)}...`,
        definitions: [...(parentA.definitions || []).slice(0, Math.ceil((parentA.definitions?.length || 0)/2)), ...(parentB.definitions || []).slice(Math.ceil((parentB.definitions?.length || 0)/2))],
        subTopics: [...(parentA.subTopics || []).slice(0, Math.ceil((parentA.subTopics?.length || 0)/2)), ...(parentB.subTopics || []).slice(Math.ceil((parentB.subTopics?.length || 0)/2))],
        informativeScore: (parentA.informativeScore + parentB.informativeScore) / 2,
        authorityScore: (parentA.authorityScore + parentB.authorityScore) / 2,
        fitness: 0
      };
      offspring.push(child);
    }

    // 3. Mutation
    // Occasionally add a "random" insight (simulated by AI)
    // For this demo, we'll just keep it simple
    
    currentPopulation = [...survivors, ...offspring];
  }

  return currentPopulation;
}

export async function assembleWebBook(optimalPopulation: WebPageGenotype[], topic: string): Promise<any> {
  const ai = getAI();
  const model = "gemini-3-flash-preview";
  
  // 1. Generate a detailed 18-chapter candidate pool (increased for evolutionary selection)
  const truncatedData = optimalPopulation.slice(0, 5).map(p => ({
    title: p.title,
    url: p.url,
    content: p.content.substring(0, 1200),
    definitions: p.definitions.slice(0, 5),
    subTopics: p.subTopics.slice(0, 4)
  }));

  const outlineResponse = await withRetry(() => ai.models.generateContent({
    model,
    contents: `Topic: ${topic}. Data: ${JSON.stringify(truncatedData)}. 
    Create a detailed 18-chapter candidate pool for a comprehensive Web-book. 
    For each chapter, provide:
    1. A compelling title.
    2. A brief 2-sentence focus description.
    3. 3 key terms to define.
    4. 2 sub-topics to explore.
    5. A visual seed keyword for an image.
    6. A 'priorityScore' (1-100) representing how essential this chapter is to the core topic.`,
    config: {
      systemInstruction: "You are a master book architect. Output valid JSON only. Create an 18-chapter candidate pool. This is an evolutionary selection process: some chapters will be pruned later based on quality. Ensure a logical flow from basics to advanced. Assign higher priorityScore to foundational and critical chapters. Strictly avoid placeholders or meaningless text.",
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          topic: { type: Type.STRING },
          outline: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                title: { type: Type.STRING },
                focus: { type: Type.STRING },
                terms: { type: Type.ARRAY, items: { type: Type.STRING } },
                subTopicTitles: { type: Type.ARRAY, items: { type: Type.STRING } },
                visualSeed: { type: Type.STRING },
                priorityScore: { type: Type.NUMBER }
              },
              required: ["title", "focus", "terms", "subTopicTitles", "visualSeed", "priorityScore"]
            }
          }
        },
        required: ["topic", "outline"]
      }
    }
  }));

  let outlineData;
  try {
    outlineData = JSON.parse(outlineResponse.text);
  } catch (e) {
    outlineData = JSON.parse(repairTruncatedJSON(outlineResponse.text));
  }

  if (!outlineData || !Array.isArray(outlineData.outline)) {
    console.error("Invalid outline data:", outlineData);
    return {
      topic: topic,
      chapters: [{
        title: "Outline Generation Failed",
        content: "The AI was unable to generate a valid outline for this topic. Please try a more specific query.",
        definitions: [],
        subTopics: [],
        sourceUrls: [],
        visualSeed: "error"
      }],
      id: `error-${Date.now()}`,
      timestamp: Date.now()
    };
  }

  // 2. Generate content for all 18 candidates (parallelized)
  const chapterPromises = outlineData.outline.map(async (chapterOutline: any, index: number) => {
    const chapterResponse = await withRetry(() => ai.models.generateContent({
      model,
      contents: `Topic: ${topic}. Chapter: ${chapterOutline.title}. Focus: ${chapterOutline.focus}. 
      Write a comprehensive, high-quality chapter (approx 350-400 words). 
      Also provide detailed definitions for: ${chapterOutline.terms.join(', ')}.
      And detailed analyses for the sub-topics: ${chapterOutline.subTopicTitles.join(', ')}.`,
      config: {
        systemInstruction: "You are an expert technical writer. Output valid JSON only. Be detailed, authoritative, and academic in tone. Ensure all definitions and sub-topic analyses are meaningful, human-readable, and relevant to the chapter. Strictly avoid generating random numbers, long strings of digits, or meaningless placeholder text.",
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            content: { type: Type.STRING },
            definitions: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  term: { type: Type.STRING },
                  description: { type: Type.STRING }
                }
              }
            },
            subTopics: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  title: { type: Type.STRING },
                  summary: { type: Type.STRING }
                }
              }
            }
          },
          required: ["content", "definitions", "subTopics"]
        }
      }
    }));

    let chapterData;
    try {
      chapterData = JSON.parse(chapterResponse.text);
    } catch (e) {
      chapterData = JSON.parse(repairTruncatedJSON(chapterResponse.text));
    }

    const content = chapterData?.content;
    // Quality Check: Purge chapters with nonsense or poisoning data
    if (!content || !isMeaningfulText(content)) return null;

    const filteredDefinitions = getRenderableDefinitions(chapterData?.definitions || [])
      .map((d: any) => ({ ...d, sourceUrl: truncatedData[0]?.url || "Synthesized" }));
    const filteredSubTopics = getRenderableSubTopics(chapterData?.subTopics || [])
      .map((s: any) => ({ ...s, sourceUrl: truncatedData[0]?.url || "Synthesized" }));

    return {
      title: chapterOutline.title,
      content,
      definitions: filteredDefinitions,
      subTopics: filteredSubTopics,
      sourceUrls: truncatedData.map(d => ({ title: d.title, url: d.url })),
      visualSeed: chapterOutline.visualSeed || "evolution",
      priorityScore: chapterOutline.priorityScore || 50,
      originalIndex: index
    };
  });

  // 3. Evolutionary Selection: Filter, Rank, and Pick Top 10
  const allGeneratedChapters = (await Promise.all(chapterPromises)).filter((c): c is any => c !== null);
  
  // Sort by priorityScore (descending) to get the most relevant ones
  const selectedChapters = allGeneratedChapters
    .sort((a, b) => b.priorityScore - a.priorityScore)
    .slice(0, 10)
    // Re-sort by originalIndex to maintain the logical flow of the book
    .sort((a, b) => a.originalIndex - b.originalIndex);

  return {
    topic: outlineData.topic,
    chapters: selectedChapters,
    id: `book-${Date.now()}`,
    timestamp: Date.now()
  };
}
