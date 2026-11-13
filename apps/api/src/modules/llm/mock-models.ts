/**
 * Modo mock (`LLM_MODE=mock`): modelos determinísticos e offline, para o app e a suíte de testes
 * rodarem sem chave nenhuma. Nenhum cliente de provedor é construído neste modo.
 *
 * Cada chamada resolve um `MockResponder` pelo `mockKey` (padrão: o papel) no
 * `MockResponderRegistry`. Este módulo NÃO registra responders de agentes nem do classificador
 * (Tasks 17/18 fazem isso); sem registro, vale `defaultMockResponder`, um placeholder fixo.
 */
import { Injectable } from "@nestjs/common";
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, AIMessageChunk, type BaseMessage } from "@langchain/core/messages";
import { ChatGenerationChunk, type ChatResult } from "@langchain/core/outputs";
import { type Runnable, RunnableLambda } from "@langchain/core/runnables";
import type { ZodType } from "zod";
import { ValidationError } from "../../core/errors/domain-errors.js";

export type MockResponder = (input: {
  mockKey: string;
  messages: BaseMessage[];
}) => string | object;

/** Resposta de mock que simula chamadas de ferramenta (para agentes com `tools`). */
export interface MockToolCallReply {
  content?: string;
  tool_calls: { id?: string; name: string; args: Record<string, unknown> }[];
}

export const MOCK_CHUNK_SIZE = 12;

export const defaultMockResponder: MockResponder = ({ mockKey }) =>
  `Resposta simulada do CARINA (${mockKey}).`;

@Injectable()
export class MockResponderRegistry {
  private readonly responders = new Map<string, MockResponder>();

  /** Registra o responder de um `mockKey`; registrar a mesma chave duas vezes é erro (colisão). */
  register(mockKey: string, responder: MockResponder): void {
    if (this.responders.has(mockKey)) {
      throw new Error(`MockResponder já registrado para "${mockKey}"`);
    }
    this.responders.set(mockKey, responder);
  }

  has(mockKey: string): boolean {
    return this.responders.has(mockKey);
  }

  resolve(mockKey: string): MockResponder {
    return this.responders.get(mockKey) ?? defaultMockResponder;
  }
}

function isToolCallReply(out: object): out is MockToolCallReply {
  return Array.isArray((out as { tool_calls?: unknown }).tool_calls);
}

function toolCalls(reply: MockToolCallReply) {
  return reply.tool_calls.map((c, i) => ({
    id: c.id ?? `mock-call-${i}`,
    name: c.name,
    args: c.args,
    type: "tool_call" as const,
  }));
}

/** Texto da resposta: string como está; objeto sem tool_calls vira JSON. */
function textOf(out: string | object): string {
  if (typeof out === "string") return out;
  if (isToolCallReply(out)) return out.content ?? "";
  return JSON.stringify(out);
}

export interface MockChatModelFields {
  responder: MockResponder;
  mockKey: string;
}

export class MockChatModel extends BaseChatModel {
  readonly responder: MockResponder;
  readonly mockKey: string;

  constructor(fields: MockChatModelFields) {
    super({});
    this.responder = fields.responder;
    this.mockKey = fields.mockKey;
  }

  _llmType(): string {
    return "carina-mock";
  }

  /** Resposta bruta do responder (string ou objeto). */
  respond(messages: BaseMessage[]): string | object {
    return this.responder({ mockKey: this.mockKey, messages });
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const out = this.respond(messages);
    const text = textOf(out);
    const message =
      typeof out === "object" && isToolCallReply(out)
        ? new AIMessage({ content: text, tool_calls: toolCalls(out) })
        : new AIMessage(text);
    return { generations: [{ text, message }] };
  }

  async *_streamResponseChunks(
    messages: BaseMessage[],
    _options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    const out = this.respond(messages);
    const text = textOf(out);
    const pieces: string[] = [];
    for (let i = 0; i < text.length; i += MOCK_CHUNK_SIZE) {
      pieces.push(text.slice(i, i + MOCK_CHUNK_SIZE));
    }
    if (pieces.length === 0) pieces.push("");
    for (const piece of pieces) {
      yield new ChatGenerationChunk({ text: piece, message: new AIMessageChunk(piece) });
      await runManager?.handleLLMNewToken(piece);
    }
    if (typeof out === "object" && isToolCallReply(out)) {
      yield new ChatGenerationChunk({
        text: "",
        message: new AIMessageChunk({
          content: "",
          tool_call_chunks: toolCalls(out).map((c, index) => ({
            id: c.id,
            name: c.name,
            args: JSON.stringify(c.args),
            index,
            type: "tool_call_chunk" as const,
          })),
        }),
      });
    }
  }

  /** As ferramentas não mudam o mock: quem decide tool_calls é o responder. */
  override bindTools(): this {
    return this;
  }
}

/**
 * Saída estruturada do mock: o objeto do responder (ou o JSON da string) é validado com o próprio
 * schema; inválido → `ValidationError`.
 *
 * Divergência conhecida e intencional com o modo live: lá, uma saída fora do schema vira
 * `AllProvidersFailedError` (503, pelo ChainFailureMapper, como qualquer falha da cadeia); aqui um
 * responder mock quebrado é bug de código/teste e aparece como `ValidationError`. As checagens de
 * limites dos agentes depois do schema (`refine*`, `checkMoney` em agents/output-limits.ts) lançam
 * `AllProvidersFailedError` nos dois modos.
 */
export function mockStructured<T>(
  model: MockChatModel,
  schema: ZodType<T>,
): Runnable<BaseMessage[], T> {
  return RunnableLambda.from(async (messages: BaseMessage[]): Promise<T> => {
    let out: unknown = model.respond(messages);
    if (typeof out === "string") {
      try {
        out = JSON.parse(out);
      } catch {
        throw new ValidationError(`Resposta simulada (${model.mockKey}) não é JSON`);
      }
    }
    const parsed = schema.safeParse(out);
    if (!parsed.success) {
      const paths = parsed.error.issues.map((i) => i.path.join(".") || "(raiz)").join(", ");
      throw new ValidationError(
        `Resposta simulada (${model.mockKey}) não confere com o schema: ${paths}`,
      );
    }
    return parsed.data;
  });
}
