import type { OAuthCredentials } from "@earendil-works/pi-ai";
import { createHash, randomBytes, randomUUID } from "crypto";
import { createServer, type Server } from "http";
import { GROK_PROVIDER } from "./constants.js";

const XAI_OAUTH_ISSUER = "https://auth.x.ai";
const XAI_OAUTH_DISCOVERY_URL = `${XAI_OAUTH_ISSUER}/.well-known/openid-configuration`;
const XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const XAI_OAUTH_SCOPE =
  "openid profile email offline_access grok-cli:access api:access";
const XAI_OAUTH_REDIRECT_HOST = "127.0.0.1";
const XAI_OAUTH_REDIRECT_PORT = 56121;
const XAI_OAUTH_REDIRECT_PATH = "/callback";
const XAI_OAUTH_REFRESH_SKEW_MS = 2 * 60 * 1000;

type XaiDiscovery = {
  authorization_endpoint: string;
  token_endpoint: string;
};

type XaiTokenPayload = {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  token_type?: string;
};

export type CallbackResult = {
  code?: string;
  state?: string;
  error?: string;
  error_description?: string;
  trustedManualCode?: boolean;
};

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function validateXaiEndpoint(url: string): string {
  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase();
  if (
    parsed.protocol !== "https:" ||
    (host !== "x.ai" && !host.endsWith(".x.ai"))
  ) {
    throw new Error(
      `Grok OAuth discovery returned an unexpected endpoint: ${url}`,
    );
  }
  return url;
}

async function xaiDiscovery(): Promise<XaiDiscovery> {
  const response = await fetch(XAI_OAUTH_DISCOVERY_URL, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(
      `Grok OAuth discovery failed: ${response.status} ${await response.text()}`,
    );
  }

  const data = (await response.json()) as Partial<XaiDiscovery>;
  if (!data.authorization_endpoint || !data.token_endpoint) {
    throw new Error(
      "Grok OAuth discovery response did not include authorization/token endpoints",
    );
  }

  return {
    authorization_endpoint: validateXaiEndpoint(data.authorization_endpoint),
    token_endpoint: validateXaiEndpoint(data.token_endpoint),
  };
}

function callbackCorsOrigin(origin: string | undefined): string | undefined {
  return origin === "https://accounts.x.ai" || origin === "https://auth.x.ai"
    ? origin
    : undefined;
}

async function exchangeXaiToken(
  tokenEndpoint: string,
  body: Record<string, string>,
): Promise<XaiTokenPayload> {
  const response = await fetch(tokenEndpoint, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(body).toString(),
  });
  if (!response.ok) {
    throw new Error(
      `Grok token request failed: ${response.status} ${await response.text()}`,
    );
  }
  return (await response.json()) as XaiTokenPayload;
}

function credentialsFromTokenPayload(
  data: XaiTokenPayload,
  tokenEndpoint: string,
  fallbackRefresh = "",
): OAuthCredentials {
  if (!data.access_token) {
    throw new Error("Grok token response did not include an access token");
  }

  const refresh = data.refresh_token || fallbackRefresh;
  if (!refresh) {
    throw new Error("Grok token response did not include a refresh token");
  }

  return {
    refresh,
    access: data.access_token,
    expires:
      Date.now() + (data.expires_in || 3600) * 1000 - XAI_OAUTH_REFRESH_SKEW_MS,
    tokenEndpoint,
    idToken: data.id_token || "",
    tokenType: data.token_type || "Bearer",
  };
}

export async function refreshGrokCredentials(
  credentials: OAuthCredentials,
): Promise<OAuthCredentials> {
  if (!credentials.refresh) {
    throw new Error(
      "Grok credentials are expired and do not include a refresh token",
    );
  }

  const tokenEndpoint =
    typeof credentials.tokenEndpoint === "string" && credentials.tokenEndpoint
      ? validateXaiEndpoint(credentials.tokenEndpoint)
      : (await xaiDiscovery()).token_endpoint;
  const data = await exchangeXaiToken(tokenEndpoint, {
    grant_type: "refresh_token",
    refresh_token: credentials.refresh,
    client_id: XAI_OAUTH_CLIENT_ID,
  });

  return credentialsFromTokenPayload(data, tokenEndpoint, credentials.refresh);
}

async function startCallbackServer(expectedState: string): Promise<{
  redirectUri: string;
  waitForCallback: (signal?: AbortSignal) => Promise<CallbackResult>;
  resolveCallback: (result: CallbackResult) => void;
  close: () => void;
}> {
  let resolveCallback!: (result: CallbackResult) => void;
  const callbackPromise = new Promise<CallbackResult>((resolve) => {
    resolveCallback = resolve;
  });

  const makeServer = () =>
    createServer((req, res) => {
      const origin = callbackCorsOrigin(req.headers.origin);
      const writeCors = () => {
        if (!origin) return;
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");
        res.setHeader("Access-Control-Allow-Private-Network", "true");
        res.setHeader("Vary", "Origin");
      };

      if (req.method === "OPTIONS") {
        writeCors();
        res.writeHead(204);
        res.end();
        return;
      }

      const url = new URL(req.url || "/", `http://${XAI_OAUTH_REDIRECT_HOST}`);
      if (url.pathname !== XAI_OAUTH_REDIRECT_PATH) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not found");
        return;
      }

      const result: CallbackResult = {
        code: url.searchParams.get("code") || undefined,
        state: url.searchParams.get("state") || undefined,
        error: url.searchParams.get("error") || undefined,
        error_description:
          url.searchParams.get("error_description") || undefined,
      };
      if (result.state !== expectedState) {
        writeCors();
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          "<html><body><h1>Grok authorization state mismatch.</h1>Please return to pi and try again.</body></html>",
        );
        return;
      }
      resolveCallback(result);

      writeCors();
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        result.error
          ? "<html><body><h1>Grok authorization failed.</h1>You can close this tab.</body></html>"
          : "<html><body><h1>Grok authorization received.</h1>You can close this tab.</body></html>",
      );
    });

  const listen = (port: number): Promise<Server> =>
    new Promise((resolve, reject) => {
      const server = makeServer();
      server.once("error", reject);
      server.listen(port, XAI_OAUTH_REDIRECT_HOST, () => {
        server.removeListener("error", reject);
        resolve(server);
      });
    });

  let server: Server;
  try {
    server = await listen(XAI_OAUTH_REDIRECT_PORT);
  } catch {
    server = await listen(0);
  }

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not determine Grok OAuth callback port");
  }

  const redirectUri = `http://${XAI_OAUTH_REDIRECT_HOST}:${address.port}${XAI_OAUTH_REDIRECT_PATH}`;

  const close = () => {
    try {
      server.close();
    } catch {
      // ignore
    }
  };

  return {
    redirectUri,
    close,
    resolveCallback,
    waitForCallback: async (signal?: AbortSignal) => {
      let timer: NodeJS.Timeout | undefined;
      let abortHandler: (() => void) | undefined;
      const timeout = new Promise<CallbackResult>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Timed out waiting for Grok OAuth callback")),
          180_000,
        );
        abortHandler = () => {
          if (timer) clearTimeout(timer);
          reject(new Error("Grok OAuth login was cancelled"));
        };
        signal?.addEventListener("abort", abortHandler, { once: true });
      });

      try {
        return await Promise.race([callbackPromise, timeout]);
      } finally {
        if (timer) clearTimeout(timer);
        if (abortHandler) signal?.removeEventListener("abort", abortHandler);
        close();
      }
    },
  };
}

function buildAuthorizeUrl(
  discovery: XaiDiscovery,
  redirectUri: string,
  challenge: string,
  state: string,
  nonce: string,
): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: XAI_OAUTH_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: XAI_OAUTH_SCOPE,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    nonce,
  });
  return `${discovery.authorization_endpoint}?${params.toString()}`;
}

export function parseCallbackInput(input: string): CallbackResult | undefined {
  const value = input.trim();
  if (!value) return undefined;

  try {
    if (/^https?:\/\//i.test(value)) {
      const url = new URL(value.replace(/\s+/g, ""));
      return {
        code: url.searchParams.get("code") || undefined,
        state: url.searchParams.get("state") || undefined,
        error: url.searchParams.get("error") || undefined,
        error_description:
          url.searchParams.get("error_description") || undefined,
      };
    }

    if (value.startsWith("?") || /(?:^|[&?])(code|error)=/.test(value)) {
      const url = new URL(
        `http://${XAI_OAUTH_REDIRECT_HOST}${XAI_OAUTH_REDIRECT_PATH}?${value.replace(/^\?/, "")}`,
      );
      return {
        code: url.searchParams.get("code") || undefined,
        state: url.searchParams.get("state") || undefined,
        error: url.searchParams.get("error") || undefined,
        error_description:
          url.searchParams.get("error_description") || undefined,
      };
    }
  } catch {
    return undefined;
  }

  const code = value.replace(/\s+/g, "");
  return code ? { code, trustedManualCode: true } : undefined;
}

export function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

export async function loginGrok(
  callbacks: {
    onProgress?: (message: string) => void;
    onAuth?: (info: { url: string; instructions?: string }) => void;
    onManualCodeInput?: () => Promise<string>;
    onPrompt?: (prompt: { message: string }) => Promise<string>;
    signal?: AbortSignal;
  },
): Promise<OAuthCredentials> {
  callbacks.onProgress?.("Starting Grok OAuth login...");
  const discovery = await xaiDiscovery();
  const { verifier, challenge } = pkcePair();
  const state = randomUUID().replace(/-/g, "");
  const nonce = randomUUID().replace(/-/g, "");
  const callbackServer = await startCallbackServer(state);
  const authorizeUrl = buildAuthorizeUrl(
    discovery,
    callbackServer.redirectUri,
    challenge,
    state,
    nonce,
  );

  callbacks.onAuth?.({
    url: authorizeUrl,
    instructions:
      "If the automatic open uses the wrong browser/profile, copy the URL and paste it into the field below (or open it manually in your preferred browser).",
  });

  callbacks.onProgress?.(
    `Waiting for Grok OAuth callback on ${callbackServer.redirectUri}...`,
  );

  const manualCodePromise = callbacks.onManualCodeInput?.();
  if (manualCodePromise) {
    manualCodePromise
      .then((input: string) => {
        if (input) {
          const manual = parseCallbackInput(input);
          if (
            manual?.trustedManualCode ||
            manual?.state === state ||
            manual?.error
          ) {
            callbackServer.resolveCallback(manual);
          } else if (manual) {
            callbacks.onProgress?.(
              "Ignored pasted Grok callback because the OAuth state did not match. Try the login again if needed.",
            );
          } else {
            callbacks.onProgress?.(
              "Could not parse pasted Grok authorization input. Paste the full redirect URL or authorization code.",
            );
          }
        }
      })
      .catch(() => {
        // Cancellation is handled by callbacks.signal / the login dialog.
      });
  }

  let callback: CallbackResult;
  try {
    callback = await callbackServer.waitForCallback(callbacks.signal);
  } catch (error) {
    callbacks.onProgress?.(
      `${messageFromError(error)}. Falling back to manual paste...`,
    );
    const input = await callbacks.onPrompt?.({
      message: "Paste the Grok authorization code or full redirect URL:",
    });
    if (!input) {
      throw new Error("Grok authorization failed: login was cancelled");
    }
    const manual = parseCallbackInput(input);
    if (!manual) {
      throw new Error(
        "Grok authorization failed: could not parse pasted code or redirect URL",
      );
    }
    callback = manual;
  }

  if (callback.error) {
    throw new Error(
      `Grok authorization failed: ${callback.error_description || callback.error}`,
    );
  }
  if (!callback.trustedManualCode && callback.state !== state) {
    throw new Error("Grok authorization failed: state mismatch");
  }
  if (!callback.code) {
    throw new Error(
      "Grok authorization failed: no authorization code returned",
    );
  }

  callbacks.onProgress?.("Exchanging Grok authorization code...");
  const data = await exchangeXaiToken(discovery.token_endpoint, {
    grant_type: "authorization_code",
    code: callback.code,
    redirect_uri: callbackServer.redirectUri,
    client_id: XAI_OAUTH_CLIENT_ID,
    code_verifier: verifier,
  });

  return credentialsFromTokenPayload(data, discovery.token_endpoint);
}

export function grokOAuthRefreshError(): string {
  return `Grok OAuth token is expired and cannot be refreshed. Please run /login ${GROK_PROVIDER} again.`;
}