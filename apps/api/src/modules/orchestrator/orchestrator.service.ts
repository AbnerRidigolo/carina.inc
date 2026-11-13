/**
 * Orquestrador: roda o grafo (graph.ts) por thread e traduz o stream do LangGraph em `ChatEvent`.
 *
 * Segurança dos threads (as tabelas de checkpoint não têm RLS): `stream`, `resume` e `finalState`
 * chamam `assertThreadInContext` ANTES de qualquer acesso ao checkpointer; um thread de outro
 * tenant ou cliente é NotFoundError. Quem chama já fixou o TenantContext (ChatService, worker de
 * retomada), e cada nó roda de novo sob o contexto do thread.
 *
 * Limites: `recursionLimit` baixo (o grafo tem no máximo 6 superpassos por turno) e
 * `durability: "sync"` (o checkpoint de cada passo é gravado antes do próximo; o `pending` do nó
 * executor está persistido antes de o `interrupt` devolver o controle).
 */
import { AIMessageChunk, type BaseMessage } from "@langchain/core/messages";
import { type BaseCheckpointSaver, Command } from "@langchain/langgraph";
import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { type ChatEvent, ChatEventSchema, type Plan } from "@carina/shared";
import {
  ApprovalConflictError,
  NotFoundError,
  ValidationError,
} from "../../core/errors/domain-errors.js";
import { StreamsService } from "../../core/redis/streams.service.js";
import { MAX_QUESTION_CHARS, contentText } from "../agents/agent.js";
import { AgentRegistry } from "../agents/agent-registry.js";
import { ExecutorRegistry } from "../inbox/executors.js";
import { InboxService } from "../inbox/inbox.service.js";
import { KnowledgeService } from "../knowledge/knowledge.service.js";
import { ModelFactory } from "../llm/model-factory.js";
import {
  InterruptValueSchema,
  type OrchestratorGraph,
  type OrchestratorLogger,
  buildGraph,
} from "./graph.js";
import type { Execution, GraphStateValue } from "./state.js";
import { assertThreadInContext } from "./thread-id.js";

export const ORCHESTRATOR_CHECKPOINTER = Symbol("ORCHESTRATOR_CHECKPOINTER");
export const ORCHESTRATOR_LOGGER = Symbol("ORCHESTRATOR_LOGGER");

/** Superpassos por execução do grafo (um turno usa no máximo 6). */
export const RECURSION_LIMIT = 12;

const NAVIGATOR_NODES = new Set(["respond", "synthesize"]);

function validQuestion(question: unknown): string {
  if (typeof question !== "string") throw new ValidationError("A pergunta precisa ser texto");
  const q = question.trim();
  if (q.length === 0) throw new ValidationError("A pergunta não pode ser vazia");
  if (q.length > MAX_QUESTION_CHARS) {
    throw new ValidationError(`A pergunta excede ${MAX_QUESTION_CHARS} caracteres`);
  }
  return q;
}

/**
 * O nó `approval` ainda tem trabalho: interrompido (`next`) ou retomado e falhou (o LangGraph deixa
 * `next` vazio, mas mantém a tarefa com o erro; reinvocar a roda de novo com a decisão gravada).
 */
const awaitingApproval = (snapshot: { next: string[]; tasks: { name: string }[] }): boolean =>
  snapshot.next.includes("approval") || snapshot.tasks.some((t) => t.name === "approval");

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

@Injectable()
export class OrchestratorService {
  private readonly graph: OrchestratorGraph;

  constructor(
    @Inject(ModelFactory) models: Pick<ModelFactory, "chat">,
    @Inject(AgentRegistry) agents: Pick<AgentRegistry, "get" | "navigator" | "executor">,
    @Inject(KnowledgeService) knowledge: Pick<KnowledgeService, "search">,
    @Inject(InboxService)
    private readonly inbox: Pick<
      InboxService,
      "request" | "executeOnce" | "get" | "executionOf" | "expireIfDue" | "closeOrphan"
    >,
    @Inject(ExecutorRegistry) executors: Pick<ExecutorRegistry, "get">,
    @Inject(StreamsService) streams: Pick<StreamsService, "publish">,
    @Inject(ORCHESTRATOR_CHECKPOINTER) checkpointer: BaseCheckpointSaver,
    @Optional()
    @Inject(ORCHESTRATOR_LOGGER)
    private readonly logger: OrchestratorLogger = new Logger(OrchestratorService.name),
  ) {
    this.graph = buildGraph(
      { models, agents, knowledge, inbox, executors, streams, logger: this.logger },
      checkpointer,
    );
  }

  private config(threadId: string) {
    return {
      configurable: { thread_id: threadId },
      recursionLimit: RECURSION_LIMIT,
      durability: "sync" as const,
    };
  }

  /**
   * Um turno de chat. Eventos: `plan`, `agent_started`, `token` (só do Navigator), `agent_result`
   * e, se o executor pedir aprovação, `approval_required` (último evento). Não emite `done`.
   *
   * Thread aguardando aprovação (um turno novo abandonaria o interrupt): o guard lê a aprovação
   * no banco (cura preguiçosa de um `resume` perdido, ex. que foi para a DLQ):
   * - `rejected`/`expired` (ou `pending` já vencida pelo CLOCK, que é vencida aqui): fecha a
   *   espera pelo mesmo caminho do `resume` (o grafo grava `rejected`, nada executa) e segue o
   *   turno. Se outro chamador (outro turno ou o ResumeWorker) fechou a espera entre a leitura e
   *   a cura, a cura vira no-op e o turno segue (ver `closeResolvedWait`).
   * - `approved`: ApprovalConflictError; a execução é retomada pelo worker/reconciliação.
   * - `pending` válida: ApprovalConflictError.
   *
   * Concorrência: este serviço NÃO serializa turnos do mesmo thread. Dois `stream` inteiros ao
   * mesmo tempo no mesmo thread não são suportados; quem garante um turno por thread é o
   * ChatService (lock Redis `chat:thread:<id>`). Sozinho, o orquestrador garante: execução no
   * máximo uma vez (o banco decide no nó `approval`, `executeOnce` é idempotente) e cura do guard
   * tolerante a corrida com outra cura ou com o `resume` do worker.
   */
  async *stream(input: { threadId: string; question: string }): AsyncIterable<ChatEvent> {
    const { threadId } = input;
    assertThreadInContext(threadId);
    const question = validQuestion(input.question);
    const config = this.config(threadId);

    const snapshot = await this.graph.getState(config);
    if (awaitingApproval(snapshot)) {
      const approvalId = (snapshot.values as Partial<GraphStateValue>).pending?.approvalId;
      await this.closeResolvedWait(threadId, approvalId);
    }

    const chunks = (await this.graph.stream(
      { question },
      { ...config, streamMode: ["updates", "messages", "custom"] },
    )) as AsyncIterable<[string, unknown]>;
    for await (const [mode, chunk] of chunks) {
      for (const event of await this.toEvents(mode, chunk, threadId)) yield event;
    }
  }

  /**
   * Retoma o thread interrompido. `approved` é só o sinal do evento: quem decide é a aprovação
   * gravada no banco (lida aqui e de novo no nó `approval`).
   * - Aprovação ainda `pending` no banco: ApprovalConflictError, SEM tocar no grafo (o interrupt
   *   continua de pé e a retomada depois da decisão funciona).
   * - Thread já resolvido: devolve a execução gravada, com o status atualizado de
   *   `executed_action` quando houver (nunca chama o executor de novo).
   * - Thread sem aprovação: NotFoundError. O worker de retomada (Task 19) deve tratar NotFound
   *   como TERMINAL (ack, sem retentar): o thread não espera nada.
   */
  async resume(threadId: string, approved: boolean): Promise<{ execution: Execution }> {
    assertThreadInContext(threadId);
    if (typeof approved !== "boolean") throw new ValidationError("approved precisa ser boolean");
    const config = this.config(threadId);

    const snapshot = await this.graph.getState(config);
    const values = snapshot.values as Partial<GraphStateValue>;
    const approvalId = values.pending?.approvalId;
    if (!approvalId) throw new NotFoundError("Thread sem aprovação pendente");
    if (!awaitingApproval(snapshot)) {
      const stored = values.execution;
      if (!stored || stored.status !== "rejected") {
        const real = await this.inbox.executionOf(approvalId);
        if (real) return { execution: { approvalId, ...real } };
      }
      return { execution: stored ?? { approvalId, status: "skipped" } };
    }

    const view = await this.inbox.get(approvalId);
    if (view.status === "pending") {
      throw new ApprovalConflictError("A aprovação ainda não foi decidida");
    }

    const out = (await this.graph.invoke(
      new Command({ resume: { approved } }),
      config,
    )) as GraphStateValue;
    const execution = out.execution;
    if (!execution || execution.approvalId !== approvalId) {
      // Não deveria acontecer: o nó approval sempre grava a execução da aprovação pendente.
      this.logger.error({ msg: "Retomada terminou sem execução registrada", approvalId, threadId });
      return { execution: { approvalId, status: "skipped" } };
    }
    return { execution };
  }

  /**
   * Guard do `stream` para um thread parado no nó `approval` (ver `stream`): fecha a espera de
   * uma aprovação rejeitada/vencida ou lança ApprovalConflictError. Só ids no log.
   */
  private async closeResolvedWait(threadId: string, approvalId: string | undefined): Promise<void> {
    if (!approvalId) {
      throw new ApprovalConflictError("O thread aguarda a decisão de uma aprovação");
    }
    let status = (await this.inbox.get(approvalId)).status;
    if (status === "pending") {
      // Vencida pelo CLOCK e o job ainda não passou: vence agora (condicional). Se outra chamada
      // venceu antes, a releitura mostra `expired`.
      status = (await this.inbox.expireIfDue(approvalId))
        ? "expired"
        : (await this.inbox.get(approvalId)).status;
    }
    if (status === "pending") {
      throw new ApprovalConflictError("A aprovação ainda não foi decidida");
    }
    if (status === "approved") {
      throw new ApprovalConflictError(
        "A aprovação foi aprovada e a execução está sendo retomada; tente de novo em instantes",
      );
    }
    // rejected / expired: o `resume` perdido nunca vai chegar (a reconciliação só republica
    // aprovadas). Fecha a espera pelo caminho do resume; `approved: false` é só o sinal.
    this.logger.warn({
      msg: "Espera de aprovação fechada no novo turno (resume não entregue)",
      approvalId,
      threadId,
    });
    try {
      await this.resume(threadId, false);
    } catch (err) {
      // Corrida: entre a leitura do guard e esta cura, outro chamador já fechou a espera e um
      // turno novo começou (o `classify` zera `pending`), então `resume` não acha a aprovação.
      // Se o thread não aguarda mais ESTA aprovação, a cura já está feita: segue o turno.
      if (!(err instanceof NotFoundError)) throw err;
      const now = await this.graph.getState(this.config(threadId));
      const stillWaiting =
        awaitingApproval(now) &&
        (now.values as Partial<GraphStateValue>).pending?.approvalId === approvalId;
      if (stillWaiting) throw err;
    }
  }

  /**
   * Para o worker de retomada: se o thread NÃO espera esta aprovação, fecha a aprovação como
   * órfã (`InboxService.closeOrphan`, com carência e conferência do thread). Devolve se fechou.
   */
  async closeOrphan(threadId: string, approvalId: string): Promise<boolean> {
    assertThreadInContext(threadId);
    const snapshot = await this.graph.getState(this.config(threadId));
    const pending = (snapshot.values as Partial<GraphStateValue>).pending?.approvalId;
    if (pending === approvalId) return false;
    return this.inbox.closeOrphan(approvalId, "thread_not_waiting", { threadId });
  }

  /** Estado atual do thread (do tenant e cliente do contexto). */
  async finalState(threadId: string): Promise<GraphStateValue> {
    assertThreadInContext(threadId);
    const snapshot = await this.graph.getState(this.config(threadId));
    return snapshot.values as GraphStateValue;
  }

  private async toEvents(mode: string, chunk: unknown, threadId: string): Promise<ChatEvent[]> {
    if (mode === "custom") {
      const parsed = ChatEventSchema.safeParse(chunk);
      return parsed.success ? [parsed.data] : [];
    }
    if (mode === "messages") {
      if (!Array.isArray(chunk)) return [];
      const [message, metadata] = chunk as [BaseMessage | undefined, unknown];
      const node = isRecord(metadata) ? metadata["langgraph_node"] : undefined;
      if (typeof node !== "string" || !NAVIGATOR_NODES.has(node)) return [];
      // Só pedaços gerados pelo modelo; as mensagens gravadas no estado (pergunta e resposta
      // completas) também passam por este modo e não são tokens.
      if (!(message instanceof AIMessageChunk)) return [];
      const text = contentText(message.content);
      return text ? [{ type: "token", agent: "navigator", text }] : [];
    }
    if (mode !== "updates" || !isRecord(chunk)) return [];

    const events: ChatEvent[] = [];
    for (const [node, update] of Object.entries(chunk)) {
      if (node === "__interrupt__") {
        for (const intr of Array.isArray(update) ? update : []) {
          const value = InterruptValueSchema.safeParse(isRecord(intr) ? intr["value"] : undefined);
          if (!value.success) {
            this.logger.error({ msg: "Interrupt com valor inválido", threadId });
            continue;
          }
          try {
            const approval = await this.inbox.get(value.data.approvalId);
            events.push({ type: "approval_required", approval });
          } catch (err) {
            this.logger.error({
              msg: "Falha ao ler a aprovação do interrupt",
              err,
              approvalId: value.data.approvalId,
              threadId,
            });
            throw err;
          }
        }
        continue;
      }
      if (!isRecord(update)) continue;
      const results = isRecord(update["results"]) ? update["results"] : {};
      switch (node) {
        case "classify":
          events.push({ type: "plan", plan: update["plan"] as Plan });
          break;
        case "specialist":
          for (const [agent, result] of Object.entries(results)) {
            if (agent === "insight" || agent === "predictor" || agent === "risk") {
              events.push({ type: "agent_result", agent, result });
            }
          }
          break;
        case "respond":
        case "synthesize":
          events.push({ type: "agent_result", agent: "navigator", result: update["answer"] });
          break;
        case "executor":
          if ("executor" in results) {
            events.push({ type: "agent_result", agent: "executor", result: results["executor"] });
          }
          break;
      }
    }
    return events;
  }
}
