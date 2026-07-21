import { afterEach, describe, expect, it, vi } from "vitest";
import { MockProvider, OpenAIProvider } from "../src/index";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenAIProvider", () => {
  it("sends messages, tools, and model name", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "",
                tool_calls: [
                  {
                    id: "call-1",
                    function: {
                      name: "search_notes",
                      arguments: "{\"query\":\"memory\"}",
                    },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200 },
      );
    });

    const provider = new OpenAIProvider({ apiKey: "test-key", fetchImpl: fetchMock as typeof fetch });
    const response = await provider.complete({
      model: "gpt-test",
      messages: [{ role: "user", content: "Find memory notes" }],
      tools: [{ name: "search_notes", description: "Search notes", parameters: { type: "object" } }],
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.openai.com/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer test-key",
        }),
      }),
    );
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).toEqual(
      expect.objectContaining({
        model: "gpt-test",
        messages: [{ role: "user", content: "Find memory notes" }],
      }),
    );
    expect(body.tools[0].function.parameters).toEqual({ type: "object" });
    expect(response.toolCalls).toEqual([
      { id: "call-1", name: "search_notes", argumentsJson: "{\"query\":\"memory\"}" },
    ]);
  });

  it("serializes assistant tool calls and tool results for follow-up requests", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ choices: [{ message: { content: "done" } }] }), { status: 200 });
    });

    const provider = new OpenAIProvider({ apiKey: "test-key", fetchImpl: fetchMock as typeof fetch });
    await provider.complete({
      model: "gpt-test",
      messages: [
        { role: "user", content: "Find memory notes" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call-1", name: "search_notes", argumentsJson: "{\"query\":\"memory\"}" }],
        },
        { role: "tool", content: "[{\"title\":\"Graph Memory\"}]", toolCallId: "call-1" },
      ],
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.messages).toEqual([
      { role: "user", content: "Find memory notes" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "search_notes", arguments: "{\"query\":\"memory\"}" },
          },
        ],
      },
      { role: "tool", content: "[{\"title\":\"Graph Memory\"}]", tool_call_id: "call-1" },
    ]);
  });

  it("surfaces sanitized request failures", async () => {
    const provider = new OpenAIProvider({
      apiKey: "secret-key",
      fetchImpl: vi.fn(async () => new Response("nope", { status: 429 })) as typeof fetch,
    });

    await expect(
      provider.complete({ model: "gpt-test", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow("Model request failed: 429 nope");
  });
});

describe("MockProvider", () => {
  it("returns scripted tool calls and final answers", async () => {
    const provider = new MockProvider([
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call-1", name: "search_notes", argumentsJson: "{\"query\":\"memory\"}" }],
      },
      {
        role: "assistant",
        content: "Here is the answer.",
      },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call-2", name: "propose_create_note", argumentsJson: "{}" }],
      },
    ]);

    await expect(provider.complete({ model: "mock", messages: [] })).resolves.toEqual(
      expect.objectContaining({ toolCalls: [expect.objectContaining({ name: "search_notes" })] }),
    );
    await expect(provider.complete({ model: "mock", messages: [] })).resolves.toEqual(
      expect.objectContaining({ content: "Here is the answer." }),
    );
    await expect(provider.complete({ model: "mock", messages: [] })).resolves.toEqual(
      expect.objectContaining({ toolCalls: [expect.objectContaining({ name: "propose_create_note" })] }),
    );
  });
});
