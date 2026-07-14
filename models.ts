import type { Api, Model } from "@earendil-works/pi-ai";
import {
  DEFAULT_GROK_MODEL,
  GROK_API_BASE_URL,
  GROK_PROVIDER,
} from "./constants.js";

export const GROK_MODELS = [
  {
    id: "grok-4.5",
    name: "Grok 4.5",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 },
    contextWindow: 500_000,
    maxTokens: 131_072,
  },
  {
    id: "grok-4.3",
    name: "Grok 4.3",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 131_072,
  },
  {
    id: "grok-4.20-multi-agent-0309",
    name: "Grok 4.20 Multi-Agent",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 0 },
    contextWindow: 2_000_000,
    maxTokens: 131_072,
  },
  {
    id: "grok-build",
    name: "Grok Build",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 1.0, output: 2.0, cacheRead: 0.2, cacheWrite: 0 },
    contextWindow: 256_000,
    maxTokens: 131_072,
  },
] as const;

export function grokModelForRequest(modelId?: string): Model<Api> {
  const id = modelId || DEFAULT_GROK_MODEL;
  const model =
    GROK_MODELS.find((candidate) => candidate.id === id) || GROK_MODELS[0];
  return {
    ...model,
    id,
    provider: GROK_PROVIDER,
    api: "xai-responses",
    baseUrl: GROK_API_BASE_URL,
  } as Model<Api>;
}

export function grokSupportsReasoningEffort(modelId: string): boolean {
  const normalized = (modelId || "").toLowerCase().split("/").pop() || "";
  return (
    normalized.startsWith("grok-3-mini") ||
    normalized.startsWith("grok-4.20-multi-agent") ||
    normalized.startsWith("grok-4.3")
  );
}