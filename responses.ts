import type { Api, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { streamSimpleOpenAIResponses } from "@earendil-works/pi-ai";
import { existsSync, readFileSync } from "fs";
import { extname, isAbsolute, resolve } from "path";
import { fileURLToPath } from "url";
import { XAI_RESPONSES_URL } from "./constants.js";
import { grokModelForRequest, grokSupportsReasoningEffort } from "./models.js";

function stripShellQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function unescapeShellPath(value: string): string {
  return stripShellQuotes(value).replace(/\\([\\\s'"()&;@])/g, "$1");
}

function imageMimeTypeForPath(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    default:
      throw new Error(
        "Grok image understanding supports local .jpg, .jpeg, and .png files only",
      );
  }
}

function resolveLocalImagePath(value: string): string | undefined {
  const cleaned = unescapeShellPath(value);
  if (!cleaned) return undefined;

  if (cleaned.startsWith("file://")) {
    try {
      return fileURLToPath(cleaned);
    } catch {
      return undefined;
    }
  }

  const candidates = [cleaned];
  if (!isAbsolute(cleaned)) candidates.push(resolve(process.cwd(), cleaned));

  return candidates.find((candidate) => existsSync(candidate));
}

function normalizeXaiImageInput(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const cleaned = stripShellQuotes(value);

  if (/^https?:\/\//i.test(cleaned) || /^data:image\//i.test(cleaned)) {
    return cleaned;
  }

  const localPath = resolveLocalImagePath(cleaned);
  if (!localPath) {
    throw new Error(
      `Image file does not exist or is not a valid URL: ${cleaned}`,
    );
  }

  const mimeType = imageMimeTypeForPath(localPath);
  const data = readFileSync(localPath).toString("base64");
  return `data:${mimeType};base64,${data}`;
}

export function extractResponsesText(data: any): string {
  if (typeof data?.output_text === "string" && data.output_text)
    return data.output_text;
  const chunks: string[] = [];
  for (const item of data?.output || []) {
    for (const part of item?.content || []) {
      if (
        typeof part?.text === "string" &&
        (part.type === "output_text" || part.text)
      )
        chunks.push(part.text);
    }
  }
  return chunks.join("") || JSON.stringify(data);
}

function textFromResponsesContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      const item = part as { type?: unknown; text?: unknown };
      const type = typeof item.type === "string" ? item.type : "";
      return ["text", "input_text", "output_text"].includes(type) &&
        typeof item.text === "string"
        ? item.text
        : "";
    })
    .filter(Boolean)
    .join("\n");
}

function normalizeResponsesImageParts(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeResponsesImageParts);
  if (!value || typeof value !== "object") return value;

  const obj: Record<string, any> = { ...(value as Record<string, any>) };
  if (
    obj.type === "image" &&
    typeof obj.data === "string" &&
    typeof obj.mimeType === "string"
  ) {
    return {
      type: "input_image",
      image_url: `data:${obj.mimeType};base64,${obj.data}`,
      detail:
        typeof obj.detail === "string" && obj.detail ? obj.detail : "auto",
    };
  }
  if (obj.type === "image_url") {
    const imageUrl =
      typeof obj.image_url === "object" && obj.image_url
        ? obj.image_url.url
        : obj.image_url;
    const detail =
      typeof obj.image_url === "object" && obj.image_url
        ? obj.image_url.detail
        : obj.detail;
    obj.type = "input_image";
    obj.image_url = imageUrl;
    if (typeof detail === "string" && detail) obj.detail = detail;
  }
  if (obj.type === "input_image") {
    const imageUrl =
      typeof obj.image_url === "object" && obj.image_url
        ? obj.image_url.url
        : obj.image_url;
    const detail =
      typeof obj.image_url === "object" && obj.image_url
        ? obj.image_url.detail
        : obj.detail;
    const normalized = normalizeXaiImageInput(imageUrl);
    if (normalized) obj.image_url = normalized;
    if (typeof detail === "string" && detail) obj.detail = detail;
    if (typeof obj.detail !== "string" || !obj.detail) obj.detail = "auto";
  }
  if (Array.isArray(obj.content))
    obj.content = normalizeResponsesImageParts(obj.content);
  if (Array.isArray(obj.output))
    obj.output = normalizeResponsesImageParts(obj.output);
  return obj;
}

function isResponsesInputImagePart(
  value: unknown,
): value is Record<string, any> {
  return (
    !!value &&
    typeof value === "object" &&
    (value as Record<string, any>).type === "input_image"
  );
}

function textForFunctionCallOutput(output: unknown): string {
  if (typeof output === "string") return output;
  if (!Array.isArray(output))
    return output === undefined || output === null
      ? ""
      : JSON.stringify(output);

  const chunks: string[] = [];
  let imageCount = 0;
  for (const part of output) {
    if (isResponsesInputImagePart(part)) {
      imageCount++;
      continue;
    }
    const text = textFromResponsesContent([part]).trim();
    if (text) chunks.push(text);
  }
  if (imageCount > 0)
    chunks.push(
      `[${imageCount} image${imageCount === 1 ? "" : "s"} attached in the following user message]`,
    );
  return (
    chunks.join("\n") ||
    (imageCount > 0
      ? `[${imageCount} image${imageCount === 1 ? "" : "s"} attached]`
      : "")
  );
}

function normalizeXaiResponsesInput(
  input: unknown[],
  model: Model<Api>,
): unknown[] {
  const normalizedInput = input.map(normalizeResponsesImageParts) as Record<
    string,
    any
  >[];
  const rewritten: unknown[] = [];
  const modelInputs = Array.isArray((model as any).input)
    ? ((model as any).input as unknown[])
    : [];
  const supportsImages = modelInputs.includes("image");

  for (const item of normalizedInput) {
    if (
      !item ||
      typeof item !== "object" ||
      item.type !== "function_call_output" ||
      !Array.isArray(item.output)
    ) {
      rewritten.push(item);
      continue;
    }

    const outputParts = item.output;
    const imageParts = outputParts.filter(isResponsesInputImagePart);
    const outputText = textForFunctionCallOutput(outputParts);
    rewritten.push({
      ...item,
      output: outputText || "(tool returned no text output)",
    });

    if (supportsImages && imageParts.length > 0) {
      const label = `The previous tool result${item.call_id ? ` (${item.call_id})` : ""} included ${imageParts.length} image${imageParts.length === 1 ? "" : "s"}. Use the attached image${imageParts.length === 1 ? "" : "s"} as the visual output from that tool.`;
      rewritten.push({
        role: "user",
        content: [{ type: "input_text", text: label }, ...imageParts],
      });
    }
  }

  return rewritten;
}

export function rewriteXaiResponsesPayload(
  payload: unknown,
  model: Model<Api>,
  options?: SimpleStreamOptions,
): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const body: Record<string, any> = { ...(payload as Record<string, any>) };

  if (Array.isArray(body.input)) {
    const input = normalizeXaiResponsesInput([...body.input], model) as Record<
      string,
      any
    >[];
    const instructionParts: string[] = [];
    while (input.length > 0) {
      const first = input[0];
      if (
        !first ||
        typeof first !== "object" ||
        (first.role !== "developer" && first.role !== "system")
      )
        break;
      const text = textFromResponsesContent(first.content).trim();
      if (text) instructionParts.push(text);
      input.shift();
    }
    if (instructionParts.length > 0) {
      body.instructions = [body.instructions, ...instructionParts]
        .filter((part) => typeof part === "string" && part)
        .join("\n\n");
    }
    body.input = input;
  }

  if (body.response_format && !body.text) {
    body.text = { format: body.response_format };
    delete body.response_format;
  }

  if (body.reasoning && typeof body.reasoning === "object") {
    const effort = body.reasoning.effort;
    if (
      typeof effort === "string" &&
      effort !== "none" &&
      grokSupportsReasoningEffort(String(body.model || model.id))
    ) {
      body.reasoning = { effort: effort === "minimal" ? "low" : effort };
    } else {
      delete body.reasoning;
    }
  }

  delete body.prompt_cache_retention;
  if (options?.sessionId && !body.prompt_cache_key)
    body.prompt_cache_key = options.sessionId;

  return body;
}

export function grokTextInput(
  text: string,
): Array<{ role: "user"; content: string }> {
  return [{ role: "user", content: text }];
}

export async function postGrokJson(
  apiKey: string,
  url: string,
  body: Record<string, any>,
  signal?: AbortSignal,
): Promise<any> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "Unknown error");
    const error = new Error(errorText);
    (error as any).status = response.status;
    throw error;
  }

  return response.json();
}

export async function createGrokResponse(
  apiKey: string,
  body: Record<string, any>,
  signal?: AbortSignal,
): Promise<any> {
  const model = grokModelForRequest(
    typeof body.model === "string" ? body.model : undefined,
  );
  const payload = rewriteXaiResponsesPayload(body, model) as Record<
    string,
    any
  >;
  return postGrokJson(apiKey, XAI_RESPONSES_URL, payload, signal);
}

export function statusFromError(error: unknown): number | undefined {
  return typeof (error as any)?.status === "number"
    ? (error as any).status
    : undefined;
}

export function streamSimpleGrokResponses(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) {
  const headers = { ...options?.headers };
  if (options?.sessionId && !headers["x-grok-conv-id"])
    headers["x-grok-conv-id"] = options.sessionId;

  return streamSimpleOpenAIResponses(
    model as Model<"openai-responses">,
    context,
    {
      ...options,
      headers,
      async onPayload(payload, payloadModel) {
        const rewritten = rewriteXaiResponsesPayload(
          payload,
          payloadModel,
          options,
        );
        const userRewritten = await options?.onPayload?.(
          rewritten,
          payloadModel,
        );
        return userRewritten === undefined ? rewritten : userRewritten;
      },
    },
  );
}