import { describe, expect, it } from "vitest";
import { buildGoogleSpeechProvider } from "./speech-provider.js";

describe("google speech provider", () => {
  const provider = buildGoogleSpeechProvider();

  it("has correct id and label", () => {
    expect(provider.id).toBe("google");
    expect(provider.label).toBe("Google Cloud TTS");
  });

  it("has autoSelectOrder", () => {
    expect(provider.autoSelectOrder).toBe(15);
  });

  it("isConfigured returns false without credentials", () => {
    const result = provider.isConfigured({
      providerConfig: {},
      timeoutMs: 30000,
    });
    expect(result).toBe(false);
  });

  it("isConfigured returns true with credentialsFile", () => {
    const result = provider.isConfigured({
      providerConfig: { credentialsFile: "/path/to/key.json" },
      timeoutMs: 30000,
    });
    expect(result).toBe(true);
  });

  it("resolveConfig returns defaults", () => {
    const config = provider.resolveConfig!({
      rawConfig: {},
      cfg: {} as any,
      timeoutMs: 30000,
    });
    expect(config.voiceId).toBe("en-US-Chirp3-HD-Charon");
    expect(config.location).toBe("global");
    expect(config.languageCode).toBe("en-US");
  });

  it("resolveConfig derives languageCode from voiceId", () => {
    const config = provider.resolveConfig!({
      rawConfig: { google: { voiceId: "de-DE-Chirp3-HD-Charon" } },
      cfg: {} as any,
      timeoutMs: 30000,
    });
    expect(config.voiceId).toBe("de-DE-Chirp3-HD-Charon");
    expect(config.languageCode).toBe("de-DE");
  });

  it("resolveConfig derives languageCode from Turkish voiceId", () => {
    const config = provider.resolveConfig!({
      rawConfig: { google: { voiceId: "tr-TR-Chirp3-HD-Iapetus" } },
      cfg: {} as any,
      timeoutMs: 30000,
    });
    expect(config.voiceId).toBe("tr-TR-Chirp3-HD-Iapetus");
    expect(config.languageCode).toBe("tr-TR");
  });

  it("resolveTalkConfig merges base and talk config", () => {
    const config = provider.resolveTalkConfig!({
      baseTtsConfig: { google: { voiceId: "en-US-Chirp3-HD-Charon" } },
      talkProviderConfig: { voiceId: "de-DE-Chirp3-HD-Charon", speed: 1.2 },
      cfg: {} as any,
      timeoutMs: 30000,
    });
    expect(config.voiceId).toBe("de-DE-Chirp3-HD-Charon");
    expect(config.speed).toBe(1.2);
  });

  it("resolveTalkOverrides returns overrides", () => {
    const overrides = provider.resolveTalkOverrides!({
      talkProviderConfig: {},
      params: { voiceId: "en-US-Chirp3-HD-Aoede", speed: 0.9 },
    });
    expect(overrides?.voiceId).toBe("en-US-Chirp3-HD-Aoede");
    expect(overrides?.speed).toBe(0.9);
  });

  it("resolveConfig accepts valid speed in range", () => {
    const config = provider.resolveConfig!({
      rawConfig: { google: { speed: 1.5 } },
      cfg: {} as any,
      timeoutMs: 30000,
    });
    expect(config.speed).toBe(1.5);
  });

  it("resolveConfig accepts speed at minimum (0.25)", () => {
    const config = provider.resolveConfig!({
      rawConfig: { google: { speed: 0.25 } },
      cfg: {} as any,
      timeoutMs: 30000,
    });
    expect(config.speed).toBe(0.25);
  });

  it("resolveConfig accepts speed at maximum (4.0)", () => {
    const config = provider.resolveConfig!({
      rawConfig: { google: { speed: 4.0 } },
      cfg: {} as any,
      timeoutMs: 30000,
    });
    expect(config.speed).toBe(4.0);
  });

  it("resolveConfig ignores invalid speed values", () => {
    const config = provider.resolveConfig!({
      rawConfig: { google: { speed: "invalid" } },
      cfg: {} as any,
      timeoutMs: 30000,
    });
    expect(config.speed).toBe(undefined);
  });

  it("resolveConfig accepts regional location", () => {
    const config = provider.resolveConfig!({
      rawConfig: { google: { location: "us-central1" } },
      cfg: {} as any,
      timeoutMs: 30000,
    });
    expect(config.location).toBe("us-central1");
  });

  it("resolveConfig accepts outputFormat pcm", () => {
    const config = provider.resolveConfig!({
      rawConfig: { google: { outputFormat: "pcm" } },
      cfg: {} as any,
      timeoutMs: 30000,
    });
    expect(config.outputFormat).toBe("pcm");
  });

  it("resolveConfig accepts outputFormat ogg_opus", () => {
    const config = provider.resolveConfig!({
      rawConfig: { google: { outputFormat: "ogg_opus" } },
      cfg: {} as any,
      timeoutMs: 30000,
    });
    expect(config.outputFormat).toBe("ogg_opus");
  });

  it("synthesize throws error for missing credentialsFile", async () => {
    await expect(
      provider.synthesize({
        text: "Hello",
        cfg: {} as any,
        providerConfig: {},
        providerOverrides: {},
        target: "audio-file",
        timeoutMs: 30000,
      }),
    ).rejects.toThrow("Google TTS requires credentialsFile");
  });

  it("synthesize throws error for non-existent credentialsFile", async () => {
    await expect(
      provider.synthesize({
        text: "Hello",
        cfg: {} as any,
        providerConfig: { credentialsFile: "/nonexistent/path/key.json" },
        providerOverrides: {},
        target: "audio-file",
        timeoutMs: 30000,
      }),
    ).rejects.toThrow("Google credentials file not found");
  });

  it("synthesize throws error for speed below minimum", async () => {
    await expect(
      provider.synthesize({
        text: "Hello",
        cfg: {} as any,
        providerConfig: { credentialsFile: "/tmp/test.json" },
        providerOverrides: { speed: 0.1 },
        target: "audio-file",
        timeoutMs: 30000,
      }),
    ).rejects.toThrow("speed");
  });

  it("synthesize throws error for speed above maximum", async () => {
    await expect(
      provider.synthesize({
        text: "Hello",
        cfg: {} as any,
        providerConfig: { credentialsFile: "/tmp/test.json" },
        providerOverrides: { speed: 5.0 },
        target: "audio-file",
        timeoutMs: 30000,
      }),
    ).rejects.toThrow("speed");
  });

  it("resolveConfig uses providers.google path", () => {
    const config = provider.resolveConfig!({
      rawConfig: { providers: { google: { voiceId: "fr-FR-Chirp3-HD-Charon" } } },
      cfg: {} as any,
      timeoutMs: 30000,
    });
    expect(config.voiceId).toBe("fr-FR-Chirp3-HD-Charon");
  });

  it("resolveConfig prefers providers.google over google", () => {
    const config = provider.resolveConfig!({
      rawConfig: {
        google: { voiceId: "en-US-Chirp3-HD-Charon" },
        providers: { google: { voiceId: "es-ES-Chirp3-HD-Charon" } },
      },
      cfg: {} as any,
      timeoutMs: 30000,
    });
    expect(config.voiceId).toBe("es-ES-Chirp3-HD-Charon");
  });
});
