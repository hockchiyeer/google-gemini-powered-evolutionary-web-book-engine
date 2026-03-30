import { GoogleGenAI, Type } from "@google/genai";
import { WebPageGenotype } from "../types";

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
  let stack: string[] = [];
  let inString = false;
  let escaped = false;
  
  for (let i = 0; i < jsonString.length; i++) {
    const char = jsonString[i];
    
    if (escaped) {
      escaped = false;
      continue;
    }
    
    if (char === '\\') {
      escaped = true;
      continue;
    }
    
    if (char === '"') {
      inString = !inString;
      continue;
    }
    
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
  
  let repaired = jsonString;
  
  // If we are inside a string, close it
  if (inString) {
    repaired += '"';
  }
  
  // Close open brackets/braces in reverse order
  while (stack.length > 0) {
    const last = stack.pop();
    if (last === '{') repaired += '}';
    else if (last === '[') repaired += ']';
  }
  
  return repaired;
}

export async function searchAndExtract(query: string): Promise<WebPageGenotype[]> {
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
      maxOutputTokens: 4000,
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
  if (!rawText) return [];
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
    return [];
  }
  
  return results.map((r: any, index: number) => ({
    ...r,
    id: `gen-${index}-${Date.now()}`,
    content: r.content ? r.content.substring(0, 2000) : "", 
    definitions: (r.definitions || []).map((d: any) => ({ ...d, sourceUrl: r.url })),
    subTopics: (r.subTopics || []).map((s: any) => ({ ...s, sourceUrl: r.url })),
    fitness: 0 
  }));
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
  
  // 1. Generate a detailed 10-chapter outline
  const truncatedData = optimalPopulation.slice(0, 4).map(p => ({
    title: p.title,
    url: p.url,
    content: p.content.substring(0, 1000),
    definitions: p.definitions.slice(0, 4),
    subTopics: p.subTopics.slice(0, 3)
  }));

  const outlineResponse = await withRetry(() => ai.models.generateContent({
    model,
    contents: `Topic: ${topic}. Data: ${JSON.stringify(truncatedData)}. 
    Create a detailed 10-chapter outline for a comprehensive, full-length Web-book. 
    For each chapter, provide:
    1. A compelling title.
    2. A brief 2-sentence focus description.
    3. 3 key terms to define.
    4. 2 sub-topics to explore.
    5. A visual seed keyword for an image.`,
    config: {
      systemInstruction: "You are a master book architect. Output valid JSON only. Create a 10-chapter outline that flows logically from introduction to advanced concepts and future outlook. Ensure all terms and sub-topics are meaningful and relevant to the topic. Strictly avoid placeholders, random strings, or meaningless identifiers.",
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
                visualSeed: { type: Type.STRING }
              },
              required: ["title", "focus", "terms", "subTopicTitles", "visualSeed"]
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

  // 2. Generate content for each chapter (parallelized for speed)
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

    const isMeaningful = (text: string) => {
      if (!text) return false;
      const clean = text.replace(/\s/g, '');
      // Filter out strings that are mostly digits
      if (/^\d+$/.test(clean)) return false;
      // Filter out long sequences of the same character (repetitive noise)
      if (/(.)\1{8,}/.test(clean)) return false;
      // Filter out strings with too many digits (more than 10 consecutive digits)
      if (/\d{10,}/.test(clean)) return false;
      // Filter out very long strings without spaces (likely code or IDs)
      if (text.length > 40 && !text.includes(' ')) return false;
      // Filter out strings that look like random hex/alphanumeric (no vowels and long)
      if (clean.length > 12 && !/[aeiou]/i.test(clean)) return false;
      return true;
    };

    return {
      title: chapterOutline.title,
      content: chapterData?.content || "Content generation failed.",
      definitions: (chapterData?.definitions || [])
        .filter((d: any) => isMeaningful(d.term))
        .map((d: any) => ({ ...d, sourceUrl: truncatedData[0]?.url || "Synthesized" })),
      subTopics: (chapterData?.subTopics || [])
        .filter((s: any) => isMeaningful(s.title))
        .map((s: any) => ({ ...s, sourceUrl: truncatedData[0]?.url || "Synthesized" })),
      sourceUrls: truncatedData.map(d => ({ title: d.title, url: d.url })),
      visualSeed: chapterOutline.visualSeed || "evolution"
    };
  });

  const chapters = await Promise.all(chapterPromises);

  return {
    topic: outlineData.topic,
    chapters,
    id: `book-${Date.now()}`,
    timestamp: Date.now()
  };
}
