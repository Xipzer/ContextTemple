import { afterEach, describe, expect, test } from "bun:test";

import { embedText } from "./provider.ts";

const servers: Array<{ stop: (close?: boolean) => void }> = [];

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop(true);
  }
});

describe("embedding providers", () => {
  test("uses the hashed provider by default", async () => {
    const result = await embedText({ text: "OAuth device flow", tags: ["auth"] });
    if (result instanceof Error) throw result;

    expect(result.provider).toBe("hashed");
    expect(result.embedding.length).toBeGreaterThan(0);
    expect(result.semanticTerms).toContain("oauth");
  });

  test("supports openai-compatible embedding providers", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: async () =>
        Response.json({
          data: [{ embedding: [0.1, 0.2, 0.3, 0.4] }],
        }),
    });
    servers.push(server);

    const result = await embedText({
      text: "OAuth device flow",
      config: {
        provider: "openai-compatible",
        url: `http://127.0.0.1:${server.port}`,
        model: "mini-embed",
      },
    });
    if (result instanceof Error) throw result;

    expect(result.provider).toBe("openai-compatible");
    expect(result.model).toBe("mini-embed");
    expect(result.embedding.length).toBe(4);
  });
});
