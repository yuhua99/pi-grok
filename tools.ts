import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_GROK_IMAGE_MODEL,
  DEFAULT_GROK_MODEL,
  GROK_PROVIDER,
  XAI_IMAGES_GENERATIONS_URL,
} from "./constants.js";
import {
  createGrokResponse,
  extractResponsesText,
  grokTextInput,
  postGrokJson,
  statusFromError,
} from "./responses.js";
import { messageFromError } from "./oauth.js";

const grokToolRegistrations = new WeakSet<object>();

function grokToolError(message: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text", text: message }], details };
}

async function resolveGrokAuthToken(ctx: any): Promise<string | null> {
  const registryModel = ctx?.modelRegistry?.find?.(
    GROK_PROVIDER,
    DEFAULT_GROK_MODEL,
  );
  if (
    registryModel &&
    typeof ctx?.modelRegistry?.getApiKeyAndHeaders === "function"
  ) {
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(registryModel);
    if (auth?.ok && auth.apiKey) return auth.apiKey;
    const authorization =
      auth?.ok && typeof auth.headers?.Authorization === "string"
        ? auth.headers.Authorization
        : "";
    if (authorization.toLowerCase().startsWith("bearer "))
      return authorization.slice("bearer ".length);
  }
  if (ctx?.apiKey) return ctx.apiKey;
  return null;
}

export function registerGrokTools(pi: ExtensionAPI) {
  if (grokToolRegistrations.has(pi as object)) return;
  grokToolRegistrations.add(pi as object);

  pi.registerTool({
    name: "x_search",
    label: "X Search",
    description:
      "Real-time X.com/Twitter search. Prefer for x.com URLs, posts, threads.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "X search query" },
        count: {
          type: "number",
          description: "Max number of posts to return (1-10)",
          default: 5,
        },
        since: {
          type: "string",
          description: "Only posts after this date (YYYY-MM-DD)",
        },
        until: {
          type: "string",
          description: "Only posts before this date (YYYY-MM-DD)",
        },
      },
      required: ["query"],
    },
    execute: async (
      _toolCallId: string,
      params: {
        query?: string;
        count?: number;
        since?: string;
        until?: string;
      },
      _signal: any,
      _onUpdate: any,
      ctx: any,
    ) => {
      const apiKey = await resolveGrokAuthToken(ctx);
      if (!apiKey) {
        return grokToolError(
          `Error: No Grok OAuth credentials found. Please run /login ${GROK_PROVIDER} first.`,
          { query: params?.query },
        );
      }

      let prompt = `Search X for: ${params.query}.`;
      if (params.count) prompt += ` Return up to ${params.count} posts.`;
      if (params.since) prompt += ` Only include posts since ${params.since}.`;
      if (params.until) prompt += ` Only include posts until ${params.until}.`;
      prompt +=
        " Summarize most relevant posts with timestamps, authors, and key points.";

      const xSearchTool: Record<string, any> = {
        type: "x_search",
        enable_image_understanding: true,
      };
      if (params.since) xSearchTool.from_date = params.since;
      if (params.until) xSearchTool.to_date = params.until;

      let data: any;
      try {
        data = await createGrokResponse(
          apiKey,
          {
            model: DEFAULT_GROK_MODEL,
            input: grokTextInput(prompt),
            reasoning: { effort: "medium" },
            tools: [xSearchTool],
          },
          _signal,
        );
      } catch (error) {
        const status = statusFromError(error);
        return grokToolError(
          `Grok API Error${status ? ` ${status}` : ""}: ${messageFromError(error)}`,
          { error: true, status, query: params.query },
        );
      }

      const text =
        extractResponsesText(data) || `No X results for: ${params.query}`;
      return {
        content: [{ type: "text", text }],
        details: { query: params.query },
      };
    },
  } as any);

  pi.registerTool({
    name: "grok_generate_image",
    label: "Grok Image Generation",
    description: "Generate images using Grok's image generation model.",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "Detailed description of image to generate",
        },
        model: {
          type: "string",
          description: "Image model to use",
          default: DEFAULT_GROK_IMAGE_MODEL,
        },
        aspect_ratio: {
          type: "string",
          description:
            "Image aspect ratio. Supported: 1:1, 3:4, 4:3, 9:16, 16:9, 2:3, 3:2, 9:19.5, 19.5:9, 9:20, 20:9, 1:2, 2:1, auto",
          default: "auto",
        },
        resolution: {
          type: "string",
          description: "Image resolution. Supported: 1k, 2k",
          default: "1k",
        },
        n: {
          type: "number",
          description: "Number of images to generate (1-4)",
          default: 1,
        },
      },
      required: ["prompt"],
    },
    execute: async (
      _toolCallId: string,
      params: {
        prompt?: string;
        model?: string;
        aspect_ratio?: string;
        resolution?: string;
        n?: number;
      },
      _signal: any,
      _onUpdate: any,
      ctx: any,
    ) => {
      const apiKey = await resolveGrokAuthToken(ctx);
      if (!apiKey) {
        return grokToolError(
          `Error: No Grok OAuth credentials found. Please run /login ${GROK_PROVIDER} first.`,
          { prompt: params?.prompt },
        );
      }

      const body: Record<string, any> = {
        model: params.model || DEFAULT_GROK_IMAGE_MODEL,
        prompt: params.prompt,
        n: params.n || 1,
      };
      if (params.aspect_ratio) body.aspect_ratio = params.aspect_ratio;
      if (params.resolution) body.resolution = params.resolution;

      let data: any;
      try {
        data = await postGrokJson(
          apiKey,
          XAI_IMAGES_GENERATIONS_URL,
          body,
          _signal,
        );
      } catch (error) {
        const status = statusFromError(error);
        return grokToolError(
          `Grok Image API Error${status ? ` ${status}` : ""}: ${messageFromError(error)}`,
          { error: true, status, prompt: params.prompt },
        );
      }

      const images = data.data || [];
      const urls = images.map((img: any) => img.url).filter(Boolean);
      const text =
        urls.length > 0
          ? `Generated ${urls.length} image(s):\n${urls.map((u: string) => `- ${u}`).join("\n")}`
          : "Image generation completed but no URLs returned.";
      return {
        content: [{ type: "text", text }],
        details: { prompt: params.prompt, urls, count: urls.length },
      };
    },
  } as any);
}