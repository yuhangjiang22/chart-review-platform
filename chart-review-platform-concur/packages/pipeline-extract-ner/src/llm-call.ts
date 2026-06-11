/**
 * Provider-pluggable LLM transport for the NER extractor.
 *
 * v2's NER extractor was hard-shaped for Azure's **Responses API**
 * (`POST ${baseUrl}/responses`, `api-key` header, `input` messages,
 * `max_output_tokens`, text at `output[].content[].text`). concur runs
 * on **OpenRouter** — an OpenAI-compatible `/chat/completions` surface
 * (`Authorization: Bearer`, `messages`, `choices[0].message.content`).
 *
 * Both `direct-llm-extract.ts` (identification pass) and
 * `normalize-span.ts` (per-span normalize) call through `callLlm`. Only
 * the transport differs by `mode`; all prompt-building and the
 * downstream JSON/sentinel parsing stay identical.
 */

export type LlmMode = "openrouter" | "azure-responses";

export interface LlmEndpoint {
  baseUrl: string;
  apiKey: string;
  model: string;
  mode: LlmMode;
}

export interface LlmUsage {
  input_tokens?: number;
  output_tokens?: number;
  cached_input_tokens?: number;
}

export interface LlmResult {
  text: string;
  usage?: LlmUsage;
}

/**
 * Call the configured LLM with a system + user prompt, returning the
 * assistant text and (when reported) token usage. Throws on non-2xx so
 * callers surface endpoint errors loudly rather than silently emitting
 * an empty span list.
 */
export async function callLlm(
  ep: LlmEndpoint,
  system: string,
  user: string,
  maxTokens = 4096,
): Promise<LlmResult> {
  if (ep.mode === "azure-responses") {
    // v2's Azure Responses API shape, verbatim.
    const r = await fetch(`${ep.baseUrl}/responses`, {
      method: "POST",
      headers: {
        "api-key": ep.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: ep.model,
        input: [
          { role: "system", content: [{ type: "input_text", text: system }] },
          { role: "user", content: [{ type: "input_text", text: user }] },
        ],
        max_output_tokens: maxTokens,
      }),
    });
    const body = (await r.json()) as {
      output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
      usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number };
      error?: { message?: string };
    };
    if (!r.ok) {
      throw new Error(`LLM ${r.status}: ${JSON.stringify(body).slice(0, 200)}`);
    }
    if (body.error) {
      throw new Error(`LLM error: ${body.error.message ?? JSON.stringify(body.error)}`);
    }
    let text = "";
    for (const item of body.output ?? []) {
      if (item.type !== "message") continue;
      for (const c of item.content ?? []) {
        if (c.type === "output_text" && typeof c.text === "string") text += c.text;
      }
    }
    return { text, usage: body.usage };
  }

  // openrouter / OpenAI-compatible chat-completions:
  const r = await fetch(`${ep.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ep.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: ep.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_tokens: maxTokens,
    }),
  });
  const j = (await r.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  if (!r.ok) {
    throw new Error(`LLM ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
  }
  return {
    text: j.choices?.[0]?.message?.content ?? "",
    usage: j.usage
      ? { input_tokens: j.usage.prompt_tokens, output_tokens: j.usage.completion_tokens }
      : undefined,
  };
}
