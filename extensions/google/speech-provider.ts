import { readFileSync } from "node:fs";
import {
  asFiniteNumber,
  asObject,
  readResponseTextLimited,
  requireInRange,
  trimToUndefined,
  truncateErrorDetail,
} from "openclaw/plugin-sdk/speech";
import type {
  SpeechProviderConfig,
  SpeechProviderPlugin,
  SpeechSynthesisRequest,
} from "openclaw/plugin-sdk/speech";

const DEFAULT_GOOGLE_VOICE_ID = "en-US-Chirp3-HD-Charon";
const DEFAULT_GOOGLE_LOCATION = "global";
const GOOGLE_SPEED_MIN = 0.25;
const GOOGLE_SPEED_MAX = 4.0;
const TOKEN_REFRESH_BUFFER_MS = 60000;

type GoogleServiceAccountCredentials = {
  client_email: string;
  private_key: string;
  project_id: string;
};

type GoogleSpeechProviderConfig = {
  credentialsFile?: string;
  voiceId: string;
  languageCode?: string;
  location: string;
  outputFormat?: string;
  speed?: number;
};

type CachedToken = {
  token: string;
  expiresAt: number;
  credentialsFile: string;
};

let cachedToken: CachedToken | null = null;
let pendingTokenPromise: Promise<string> | null = null;

function normalizeGoogleOutputFormat(
  format: string | undefined,
  target: "audio-file" | "voice-note",
): { audioEncoding: string; fileExtension: string; voiceCompatible: boolean } {
  const normalized = trimToUndefined(format);
  if (normalized === "pcm") {
    return { audioEncoding: "LINEAR16", fileExtension: ".pcm", voiceCompatible: false };
  }
  if (normalized === "mulaw") {
    return { audioEncoding: "MULAW", fileExtension: ".mulaw", voiceCompatible: false };
  }
  if (normalized === "alaw") {
    return { audioEncoding: "ALAW", fileExtension: ".alaw", voiceCompatible: false };
  }
  if (normalized === "ogg_opus" || target === "voice-note") {
    return { audioEncoding: "OGG_OPUS", fileExtension: ".ogg", voiceCompatible: true };
  }
  return { audioEncoding: "MP3", fileExtension: ".mp3", voiceCompatible: false };
}

function deriveLanguageCodeFromVoiceId(voiceId: string): string | undefined {
  const match = voiceId.match(/^([a-z]{2}-[A-Z]{2})/);
  return match ? match[1] : undefined;
}

function normalizeGoogleSpeechProviderConfig(
  rawConfig: Record<string, unknown>,
): GoogleSpeechProviderConfig {
  const providers = asObject(rawConfig.providers);
  const raw = asObject(providers?.google) ?? asObject(rawConfig.google);
  const voiceId = trimToUndefined(raw?.voiceId) ?? DEFAULT_GOOGLE_VOICE_ID;
  const derivedLanguageCode = deriveLanguageCodeFromVoiceId(voiceId);
  return {
    credentialsFile: trimToUndefined(raw?.credentialsFile),
    voiceId,
    languageCode: trimToUndefined(raw?.languageCode) ?? derivedLanguageCode ?? "en-US",
    location: trimToUndefined(raw?.location) ?? DEFAULT_GOOGLE_LOCATION,
    outputFormat: trimToUndefined(raw?.outputFormat),
    speed: asFiniteNumber(raw?.speed),
  };
}

function readGoogleSpeechProviderConfig(config: SpeechProviderConfig): GoogleSpeechProviderConfig {
  const defaults = normalizeGoogleSpeechProviderConfig({});
  return {
    credentialsFile: trimToUndefined(config.credentialsFile) ?? defaults.credentialsFile,
    voiceId: trimToUndefined(config.voiceId) ?? defaults.voiceId,
    languageCode: trimToUndefined(config.languageCode) ?? defaults.languageCode,
    location: trimToUndefined(config.location) ?? defaults.location,
    outputFormat: trimToUndefined(config.outputFormat) ?? defaults.outputFormat,
    speed: asFiniteNumber(config.speed) ?? defaults.speed,
  };
}

function loadCredentials(credentialsFile: string): GoogleServiceAccountCredentials {
  try {
    const content = readFileSync(credentialsFile, "utf-8");
    const parsed = JSON.parse(content) as GoogleServiceAccountCredentials;
    if (!parsed.client_email || !parsed.private_key) {
      throw new Error(
        `Invalid Google credentials file: missing client_email or private_key in ${credentialsFile}`,
      );
    }
    return parsed;
  } catch (err) {
    if (err instanceof Error && err.message.includes("ENOENT")) {
      throw new Error(`Google credentials file not found: ${credentialsFile}`, { cause: err });
    }
    if (err instanceof SyntaxError) {
      throw new Error(`Invalid JSON in Google credentials file: ${credentialsFile}`, {
        cause: err,
      });
    }
    throw err;
  }
}

function base64urlEncode(buffer: Buffer): string {
  return buffer.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function createJwtAssertion(
  credentials: GoogleServiceAccountCredentials,
  scope: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const expiry = now + 3600;

  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: credentials.client_email,
    sub: credentials.client_email,
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: expiry,
    scope,
  };

  const encodedHeader = base64urlEncode(Buffer.from(JSON.stringify(header)));
  const encodedPayload = base64urlEncode(Buffer.from(JSON.stringify(payload)));
  const signatureInput = `${encodedHeader}.${encodedPayload}`;

  const privateKeyPEM = credentials.private_key
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s/g, "");

  const privateKeyBuffer = Buffer.from(privateKeyPEM, "base64");

  const key = await crypto.subtle.importKey(
    "pkcs8",
    privateKeyBuffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, Buffer.from(signatureInput));

  const encodedSignature = base64urlEncode(Buffer.from(signature));
  return `${signatureInput}.${encodedSignature}`;
}

async function fetchNewToken(credentialsFile: string): Promise<string> {
  const credentials = loadCredentials(credentialsFile);
  const jwt = await createJwtAssertion(
    credentials,
    "https://www.googleapis.com/auth/cloud-platform",
  );

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Failed to get Google access token: ${response.status} ${errorBody}`);
  }

  const tokenData = (await response.json()) as { access_token: string; expires_in: number };
  if (!tokenData.access_token) {
    throw new Error("Google token response missing access_token");
  }

  cachedToken = {
    token: tokenData.access_token,
    expiresAt: Date.now() + (tokenData.expires_in ?? 3600) * 1000,
    credentialsFile,
  };

  return tokenData.access_token;
}

async function getGoogleAccessToken(credentialsFile: string): Promise<string> {
  if (
    cachedToken &&
    cachedToken.credentialsFile === credentialsFile &&
    cachedToken.expiresAt > Date.now() + TOKEN_REFRESH_BUFFER_MS
  ) {
    return cachedToken.token;
  }

  if (pendingTokenPromise && cachedToken?.credentialsFile === credentialsFile) {
    return pendingTokenPromise;
  }

  pendingTokenPromise = fetchNewToken(credentialsFile);
  try {
    const token = await pendingTokenPromise;
    return token;
  } finally {
    pendingTokenPromise = null;
  }
}

function buildGoogleTtsEndpoint(location: string): string {
  if (location === "global") {
    return "https://texttospeech.googleapis.com/v1/text:synthesize";
  }
  return `https://${location}-texttospeech.googleapis.com/v1/text:synthesize`;
}

async function extractGoogleErrorDetail(response: Response): Promise<string | undefined> {
  const rawBody = trimToUndefined(await readResponseTextLimited(response));
  if (!rawBody) {
    return undefined;
  }
  try {
    const json = JSON.parse(rawBody) as { error?: { message?: string; code?: number } };
    const message = trimToUndefined(json.error?.message);
    const code = json.error?.code;
    if (message && code) {
      return `${truncateErrorDetail(message)} [code=${code}]`;
    }
    if (message) {
      return truncateErrorDetail(message);
    }
    if (code) {
      return `[code=${code}]`;
    }
    return truncateErrorDetail(rawBody);
  } catch {
    return truncateErrorDetail(rawBody);
  }
}

function validateSpeed(speed: number | undefined): number | undefined {
  if (speed === undefined) {
    return undefined;
  }
  requireInRange(speed, GOOGLE_SPEED_MIN, GOOGLE_SPEED_MAX, "speed");
  return speed;
}

async function googleTTS(params: {
  text: string;
  credentialsFile: string;
  voiceId: string;
  languageCode?: string;
  location: string;
  audioEncoding: string;
  speed?: number;
  timeoutMs: number;
}): Promise<Buffer> {
  const {
    text,
    credentialsFile,
    voiceId,
    languageCode,
    location,
    audioEncoding,
    speed,
    timeoutMs,
  } = params;

  const validatedSpeed = validateSpeed(speed);
  const token = await getGoogleAccessToken(credentialsFile);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const endpoint = buildGoogleTtsEndpoint(location);
    const resolvedLanguageCode = languageCode ?? deriveLanguageCodeFromVoiceId(voiceId) ?? "en-US";

    const audioConfig: { audioEncoding: string; speakingRate?: number } = { audioEncoding };
    if (validatedSpeed !== undefined) {
      audioConfig.speakingRate = validatedSpeed;
    }

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input: { text },
        voice: { name: voiceId, languageCode: resolvedLanguageCode },
        audioConfig,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = await extractGoogleErrorDetail(response);
      throw new Error(`Google Cloud TTS error (${response.status})${detail ? `: ${detail}` : ""}`);
    }

    const json = (await response.json()) as { audioContent?: string };
    if (!json.audioContent) {
      throw new Error("Google Cloud TTS response missing audioContent");
    }

    return Buffer.from(json.audioContent, "base64");
  } finally {
    clearTimeout(timeout);
  }
}

export function buildGoogleSpeechProvider(): SpeechProviderPlugin {
  return {
    id: "google",
    label: "Google Cloud TTS",
    autoSelectOrder: 15,
    resolveConfig: ({ rawConfig }) => normalizeGoogleSpeechProviderConfig(rawConfig),
    resolveTalkConfig: ({ baseTtsConfig, talkProviderConfig }) => {
      const base = normalizeGoogleSpeechProviderConfig(baseTtsConfig);
      return {
        ...base,
        ...(trimToUndefined(talkProviderConfig.credentialsFile) == null
          ? {}
          : { credentialsFile: trimToUndefined(talkProviderConfig.credentialsFile) }),
        ...(trimToUndefined(talkProviderConfig.voiceId) == null
          ? {}
          : { voiceId: trimToUndefined(talkProviderConfig.voiceId) }),
        ...(trimToUndefined(talkProviderConfig.languageCode) == null
          ? {}
          : { languageCode: trimToUndefined(talkProviderConfig.languageCode) }),
        ...(trimToUndefined(talkProviderConfig.location) == null
          ? {}
          : { location: trimToUndefined(talkProviderConfig.location) }),
        ...(trimToUndefined(talkProviderConfig.outputFormat) == null
          ? {}
          : { outputFormat: trimToUndefined(talkProviderConfig.outputFormat) }),
        ...(asFiniteNumber(talkProviderConfig.speed) == null
          ? {}
          : { speed: asFiniteNumber(talkProviderConfig.speed) }),
      };
    },
    resolveTalkOverrides: ({ params }) => {
      return {
        ...(trimToUndefined(params.voiceId) == null
          ? {}
          : { voiceId: trimToUndefined(params.voiceId) }),
        ...(trimToUndefined(params.languageCode) == null
          ? {}
          : { languageCode: trimToUndefined(params.languageCode) }),
        ...(trimToUndefined(params.location) == null
          ? {}
          : { location: trimToUndefined(params.location) }),
        ...(trimToUndefined(params.outputFormat) == null
          ? {}
          : { outputFormat: trimToUndefined(params.outputFormat) }),
        ...(asFiniteNumber(params.speed) == null ? {} : { speed: asFiniteNumber(params.speed) }),
      };
    },
    isConfigured: ({ providerConfig }) => {
      const config = readGoogleSpeechProviderConfig(providerConfig);
      return Boolean(config.credentialsFile || process.env.GOOGLE_APPLICATION_CREDENTIALS);
    },
    synthesize: async (req: SpeechSynthesisRequest) => {
      const config = readGoogleSpeechProviderConfig(req.providerConfig);
      const overrides = req.providerOverrides ?? {};
      const credentialsFile =
        trimToUndefined(overrides.credentialsFile) ??
        config.credentialsFile ??
        process.env.GOOGLE_APPLICATION_CREDENTIALS;
      if (!credentialsFile) {
        throw new Error(
          "Google TTS requires credentialsFile in config or GOOGLE_APPLICATION_CREDENTIALS environment variable",
        );
      }
      const voiceId = trimToUndefined(overrides.voiceId) ?? config.voiceId;
      const languageCode = trimToUndefined(overrides.languageCode) ?? config.languageCode;
      const location = trimToUndefined(overrides.location) ?? config.location;
      const outputFormat = trimToUndefined(overrides.outputFormat) ?? config.outputFormat;
      const speed = asFiniteNumber(overrides.speed) ?? config.speed;

      const { audioEncoding, fileExtension, voiceCompatible } = normalizeGoogleOutputFormat(
        outputFormat,
        req.target,
      );

      const audioBuffer = await googleTTS({
        text: req.text,
        credentialsFile,
        voiceId,
        languageCode,
        location,
        audioEncoding,
        speed,
        timeoutMs: req.timeoutMs,
      });

      return {
        audioBuffer,
        outputFormat: audioEncoding.toLowerCase(),
        fileExtension,
        voiceCompatible,
      };
    },
  };
}
