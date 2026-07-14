import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { GROK_API_BASE_URL, GROK_PROVIDER } from "./constants.js";
import { GROK_MODELS } from "./models.js";
import {
  grokOAuthRefreshError,
  loginGrok,
  refreshGrokCredentials,
} from "./oauth.js";
import { streamSimpleGrokResponses } from "./responses.js";
import { registerGrokTools } from "./tools.js";

export default function (pi: ExtensionAPI) {
  pi.registerProvider(GROK_PROVIDER, {
    name: "Grok",
    baseUrl: GROK_API_BASE_URL,
    api: "xai-responses",
    models: GROK_MODELS as any,
    authHeader: true,
    streamSimple: streamSimpleGrokResponses as any,

    oauth: {
      usesCallbackServer: true,
      name: "Grok",

      async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
        return loginGrok(callbacks);
      },

      async refreshToken(
        credentials: OAuthCredentials,
      ): Promise<OAuthCredentials> {
        if (
          !credentials.refresh &&
          credentials.expires &&
          credentials.expires <= Date.now()
        ) {
          throw new Error(grokOAuthRefreshError());
        }
        if (!credentials.refresh) return credentials;
        return refreshGrokCredentials(credentials);
      },

      getApiKey(credentials: OAuthCredentials): string {
        return credentials.access;
      },
    } as any,
  });

  registerGrokTools(pi);
}