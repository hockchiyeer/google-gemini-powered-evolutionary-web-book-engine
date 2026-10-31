import type { IncomingMessage, ServerResponse } from "node:http";
import type { Server as HttpServer } from "node:http";
import type { Plugin } from "vite";
import { GoogleGenAI, Modality } from "@google/genai";
import type { LiveServerMessage } from "@google/genai";
import { WebSocketServer, WebSocket } from "ws";
import dotenv from "dotenv";

dotenv.config();

export const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: {
    headers: {
      "User-Agent": "aistudio-build",
    },
  },
});

export interface GeminiGenerateRequestBody {
  model?: string;
  contents: any;
  config?: any;
}

async function readJsonBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

export async function handleGeminiGenerate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: { message: "Method not allowed" } });
    return;
  }

  try {
    const body: GeminiGenerateRequestBody = await readJsonBody(req);
    const model = body.model || "gemini-3.6-flash";

    if (!process.env.GEMINI_API_KEY) {
      sendJson(res, 401, {
        error: {
          message: "Missing Gemini API key on server. Set GEMINI_API_KEY in environment secrets.",
          status: "UNAUTHENTICATED",
          code: 401,
        },
      });
      return;
    }

    const response = await ai.models.generateContent({
      model,
      contents: body.contents,
      config: body.config,
    });

    sendJson(res, 200, {
      text: response.text,
      candidates: response.candidates,
      usageMetadata: response.usageMetadata,
    });
  } catch (err: any) {
    const rawStatus = Number(err?.status || err?.code);
    const status = Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus < 600 ? rawStatus : 500;
    sendJson(res, status, {
      error: {
        message: err?.message || "Gemini API request failed",
        status: err?.status || (status === 429 ? "RESOURCE_EXHAUSTED" : "INTERNAL"),
        code: status,
        details: err?.details,
      },
    });
  }
}

export async function handleGeminiStream(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: { message: "Method not allowed" } });
    return;
  }

  try {
    const body: GeminiGenerateRequestBody = await readJsonBody(req);
    const model = body.model || "gemini-3.6-flash";

    if (!process.env.GEMINI_API_KEY) {
      sendJson(res, 401, {
        error: {
          message: "Missing Gemini API key on server. Set GEMINI_API_KEY in environment secrets.",
          status: "UNAUTHENTICATED",
          code: 401,
        },
      });
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });

    const responseStream = await ai.models.generateContentStream({
      model,
      contents: body.contents,
      config: body.config,
    });

    for await (const chunk of responseStream) {
      const payload = JSON.stringify({
        text: chunk.text,
        candidates: chunk.candidates,
      });
      res.write(`data: ${payload}\n\n`);
    }

    res.write("data: [DONE]\n\n");
    res.end();
  } catch (err: any) {
    const payload = JSON.stringify({
      error: {
        message: err?.message || "Stream failed",
        status: err?.status,
        code: err?.code,
      },
    });
    if (!res.headersSent) {
      const rawStatus = Number(err?.status || err?.code);
      const status = Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus < 600 ? rawStatus : 500;
      sendJson(res, status, JSON.parse(payload));
    } else {
      res.write(`data: ${payload}\n\n`);
      res.end();
    }
  }
}

export function createGeminiMiddleware() {
  return async (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => {
    if (!req.url) {
      next();
      return;
    }

    const parsedUrl = new URL(req.url, "http://localhost");
    const pathname = parsedUrl.pathname;

    if (pathname === "/api/gemini/generate" || pathname === "/api/gemini/generateContent") {
      await handleGeminiGenerate(req, res);
      return;
    }

    if (pathname === "/api/gemini/stream" || pathname === "/api/gemini/generateContentStream") {
      await handleGeminiStream(req, res);
      return;
    }

    if (pathname === "/api/gemini/models" && req.method === "GET") {
      sendJson(res, 200, {
        models: [
          "gemini-3.8-flash",
          "gemini-flash-latest",
          "gemini-3.1-flash-lite",
          "gemini-4-argon",
        ],
      });
      return;
    }

    next();
  };
}

export function setupGeminiLiveWebSocket(server: HttpServer): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const pathname = new URL(request.url || "/", "http://localhost").pathname;
    if (pathname === "/live" || pathname === "/api/gemini/live") {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    }
  });

  wss.on("connection", async (clientWs: WebSocket) => {
    let session: any = null;

    try {
      if (!process.env.GEMINI_API_KEY) {
        clientWs.send(
          JSON.stringify({
            error: "Missing Gemini API key on server. Set GEMINI_API_KEY in environment secrets.",
          })
        );
        clientWs.close();
        return;
      }

      session = await ai.live.connect({
        model: "gemini-3.8-live",
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: "Zephyr" } },
          },
          systemInstruction: "You are a helpful assistant.",
        },
        callbacks: {
          onmessage: (message: LiveServerMessage) => {
            const audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (audio && clientWs.readyState === WebSocket.OPEN) {
              clientWs.send(JSON.stringify({ audio }));
            }
            if (message.serverContent?.interrupted && clientWs.readyState === WebSocket.OPEN) {
              clientWs.send(JSON.stringify({ interrupted: true }));
            }
          },
          onclose: () => {
            try {
              if (clientWs.readyState === WebSocket.OPEN) clientWs.close();
            } catch {}
          },
          onerror: (err: any) => {
            try {
              if (clientWs.readyState === WebSocket.OPEN) {
                clientWs.send(JSON.stringify({ error: err?.message || "Live API error" }));
              }
            } catch {}
          },
        },
      });

      clientWs.on("message", (data) => {
        try {
          const parsed = JSON.parse(data.toString());
          if (parsed.audio) {
            session.sendRealtimeInput({
              audio: { data: parsed.audio, mimeType: "audio/pcm;rate=16000" },
            });
          } else if (parsed.text) {
            session.sendRealtimeInput({
              text: parsed.text,
            });
          }
        } catch (e) {
          console.error("Live API WS message parse error:", e);
        }
      });

      clientWs.on("close", () => {
        try {
          session?.close?.();
        } catch {}
      });
    } catch (err: any) {
      console.error("Failed to connect to Gemini Live API:", err);
      try {
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(JSON.stringify({ error: err?.message || "Failed to connect to Live API" }));
          clientWs.close();
        }
      } catch {}
    }
  });

  return wss;
}

export function geminiPlugin(): Plugin {
  const middleware = createGeminiMiddleware();

  return {
    name: "gemini-server-plugin",
    configureServer(server) {
      server.middlewares.use(middleware);
      if (server.httpServer) {
        setupGeminiLiveWebSocket(server.httpServer);
      }
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
      if (server.httpServer) {
        setupGeminiLiveWebSocket(server.httpServer);
      }
    },
  };
}
