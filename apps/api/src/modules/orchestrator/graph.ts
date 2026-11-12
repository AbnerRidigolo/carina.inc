/**
 * Grafo do orquestrador (spec §4 e §6.2):
 *
 * ```
 * START → classify → retrieve
 * retrieve → (sem especialistas) → respond ────────────────────┐
 * retrieve → Send("specialist", {agent}) × N → synthesize ─────┤
 *                                       (plan.wantsExecution) ─┴→ executor → (irreversível) → approval → END
 *                                                               └→ END
 * ```
 *
 * - `classify`: classificador (papel `reasoning`, saída `Plan`) revalidado por `normalizePlan`;
 *   qualquer erro ou saída inválida → `heuristicPlan`.
 * - `retrieve`: `KnowledgeService.search`; falha → conhecimento vazio e `errors.retrieve`.
 * - `specialist`: um especialista; erro → `results[agent] = agentFailure()` e `errors[agent]`
 *   (o Navigator, na síntese, avisa que a análise falhou e não inventa o conteúdo).
 * - `respond` / `synthesize`: Navigator (modos answer/synthesize; o nó não pode se chamar
 *   `answer`, que é um canal do estado); falha → resposta fixa de contingência e `errors.navigator`.
 * - `executor`: o agente PROPÕE (`ExecutorAgent.run`), `classifyRisk` decide:
 *     read → `ExecutorRegistry` direto; reversible → executa e publica `notification`;
 *     irreversible → `InboxService.request` (upsert idempotente) e grava `pending`.
 * - `approval`: `interrupt({ approvalId })`. É um nó SEPARADO de propósito: na retomada o LangGraph
 *   reexecuta o nó interrompido desde o começo; se a proposta (LLM, não determinístico) estivesse
 *   no mesmo nó, rodaria de novo e poderia gerar outra proposta/aprovação. Aqui nada vem antes do
 *   `interrupt()`; a proposta já está no checkpoint. Depois da retomada, o valor do resume é só
 *   um sinal: a decisão é LIDA DO BANCO (`InboxService.get`). `approved` →
 *   `InboxService.executeOnce` (cerca `executed_action`: no máximo uma vez, mesmo com o nó
 *   reexecutado, retomada duplicada ou concorrente); se a cerca já existia (`skipped`), reporta o
 *   status real de `executed_action`. `rejected`/`expired` → `rejected`, nunca executa.
 *   `pending` → erro repetível (o thread continua retomável).
 *
 * Cada nó roda com o TenantContext do thread (`runInThread`). Logs: só ids e o erro, nunca a
 * pergunta, o conhecimento ou a saída do modelo.
 */
import { randomUUID } from "node:crypto";
import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import {
  type BaseCheckpointSaver,
  END,
  type LangGraphRunnableConfig,
  Overwrite,
  START,
  Send,
  StateGraph,
  interrupt,
} from "@langchain/langgraph";
import {
  type ActionProposal,
  type ChatEvent,
  type Plan,
  PlanSchema,
  SpecialistNameSchema,
} from "@carina/shared";
import { z } from "zod";
import { TenantContext } from "../../core/context/tenant-context.js";
import {
  AllProvidersFailedError,
  ApprovalConflictError,
  ValidationError,
} from "../../core/errors/domain-errors.js";
import { type AgentInput, QUESTION_MESSAGE_ID, agentFailure } from "../agents/agent.js";
import type { AgentRegistry } from "../agents/agent-registry.js";
import type { InboxService } from "../inbox/inbox.service.js";
import type { ExecutorRegistry } from "../inbox/executors.js";
import { classifyRisk } from "../inbox/risk.js";
import {
  MAX_QUERY_CHARS,
  type KnowledgeService,
  type SearchResult,
} from "../knowledge/knowledge.service.js";
import type { ModelFactory } from "../llm/model-factory.js";
import type { StreamsService } from "../../core/redis/streams.service.js";
import { CLASSIFIER_PROMPT, heuristicPlan, normalizePlan } from "./heuristic.js";
import {
  type Execution,
  GraphState,
  type GraphStateUpdate,
  type GraphStateValue,
  MAX_HISTORY_MESSAGES,
  type SpecialistInput,
} from "./state.js";
import { runInThread } from "./thread-id.js";

export const FALLBACK_ANSWER =
  "Não consegui gerar a resposta agora. Tente de novo em instantes; nenhuma ação foi executada.";

export const APPROVAL_ID_RE = /^[0-9a-f]{64}$/;
export const InterruptValueSchema = z.object({ approvalId: z.string().regex(APPROVAL_ID_RE) });
export const ResumeValueSchema = z.object({ approved: z.boolean() });

/** Forma de OBJETO no 1º argumento (nestjs-pino): `err` no topo; só ids. */
export interface OrchestratorLogger {
  warn(fields: { msg: string; err?: unknown; [k: string]: unknown }): void;
  error(fields: { msg: string; err?: unknown; [k: string]: unknown }): void;
}

export interface GraphDeps {
  models: Pick<ModelFactory, "chat">;
  agents: Pick<AgentRegistry, "get" | "navigator" | "executor">;
  knowledge: Pick<KnowledgeService, "search">;
  inbox: Pick<InboxService, "request" | "executeOnce" | "get" | "executionOf">;
  executors: Pick<ExecutorRegistry, "get">;
  streams: Pick<StreamsService, "publish">;
  logger: OrchestratorLogger;
}

const EMPTY_KNOWLEDGE: SearchResult = { chunks: [], entities: [], neighbors: [] };

/** Código curto e fixo para `errors[...]` (nunca a mensagem do erro, que pode ecoar dados). */
const errorCode = (err: unknown): string =>
  err instanceof AllProvidersFailedError ? "all_providers_failed" : "failed";

const threadOf = (config: LangGraphRunnableConfig): unknown => config.configurable?.["thread_id"];

/** Emite um ChatEvent no stream `custom` (só existe quando o chamador pediu esse modo). */
function emit(config: LangGraphRunnableConfig, event: ChatEvent): void {
  config.writer?.(event);
}

const history = (state: Pick<GraphStateValue, "messages">) =>
  state.messages.slice(-MAX_HISTORY_MESSAGES);

export function buildGraph(deps: GraphDeps, checkpointer: BaseCheckpointSaver) {
  const { models, agents, knowledge, inbox, executors, streams, logger } = deps;

  const classify = (state: GraphStateValue, config: LangGraphRunnableConfig) =>
    runInThread(threadOf(config), async (): Promise<GraphStateUpdate> => {
      let plan: Plan | undefined;
      try {
        const raw = await models
          .chat("reasoning", { schema: PlanSchema, mockKey: "classifier" })
          .invoke([
            new SystemMessage(CLASSIFIER_PROMPT),
            new HumanMessage({ content: state.question, id: QUESTION_MESSAGE_ID }),
          ]);
        plan = normalizePlan(raw, state.question);
        if (!plan) {
          logger.warn({
            msg: "Plano do classificador inválido; usando a heurística",
            threadId: threadOf(config),
          });
        }
      } catch (err) {
        logger.warn({
          msg: "Classificador falhou; usando a heurística",
          err,
          threadId: threadOf(config),
        });
      }
      // Começo do turno: zera tudo o que é do turno (os reducers de merge recebem Overwrite).
      return {
        plan: plan ?? heuristicPlan(state.question),
        knowledge: null,
        results: new Overwrite({}) as never,
        errors: new Overwrite({}) as never,
        answer: null,
        pending: null,
        execution: null,
      };
    });

  const retrieve = (state: GraphStateValue, config: LangGraphRunnableConfig) =>
    runInThread(threadOf(config), async (): Promise<GraphStateUpdate> => {
      try {
        return { knowledge: await knowledge.search(state.question.slice(0, MAX_QUERY_CHARS)) };
      } catch (err) {
        logger.warn({ msg: "Busca de conhecimento falhou", err, threadId: threadOf(config) });
        return { knowledge: EMPTY_KNOWLEDGE, errors: { retrieve: errorCode(err) } };
      }
    });

  const route = (state: GraphStateValue) => {
    const specialists = state.plan?.agents ?? [];
    if (specialists.length === 0) return "respond";
    return specialists.map(
      (agent) =>
        new Send("specialist", {
          agent,
          question: state.question,
          knowledge: state.knowledge ?? EMPTY_KNOWLEDGE,
          messages: history(state),
        } satisfies SpecialistInput),
    );
  };

  const specialist = (input: SpecialistInput, config: LangGraphRunnableConfig) =>
    runInThread(threadOf(config), async (): Promise<GraphStateUpdate> => {
      const agent = SpecialistNameSchema.parse(input.agent);
      emit(config, { type: "agent_started", agent });
      try {
        const out = await agents.get(agent).run({
          question: input.question,
          history: input.messages.slice(-MAX_HISTORY_MESSAGES),
          knowledge: input.knowledge,
        });
        return { results: { [agent]: out } };
      } catch (err) {
        logger.warn({ msg: "Especialista falhou", err, agent, threadId: threadOf(config) });
        return { results: { [agent]: agentFailure() }, errors: { [agent]: errorCode(err) } };
      }
    });

  const navigatorNode =
    (mode: "answer" | "synthesize") => (state: GraphStateValue, config: LangGraphRunnableConfig) =>
      runInThread(threadOf(config), async (): Promise<GraphStateUpdate> => {
        emit(config, { type: "agent_started", agent: "navigator" });
        const input: AgentInput = {
          question: state.question,
          history: history(state),
          knowledge: state.knowledge ?? EMPTY_KNOWLEDGE,
        };
        let answer: string;
        let failed: string | undefined;
        try {
          answer =
            mode === "answer"
              ? await agents.navigator().answer(input)
              : await agents.navigator().synthesize({ ...input, results: state.results });
        } catch (err) {
          logger.warn({ msg: "Navigator falhou", err, mode, threadId: threadOf(config) });
          answer = FALLBACK_ANSWER;
          failed = errorCode(err);
        }
        return {
          answer,
          messages: [new HumanMessage(state.question), new AIMessage(answer)],
          ...(failed ? { errors: { navigator: failed } } : {}),
        };
      });

  const maybeExecute = (state: GraphStateValue) =>
    state.plan?.wantsExecution === true ? "executor" : END;

  const executor = (state: GraphStateValue, config: LangGraphRunnableConfig) =>
    runInThread(threadOf(config), async (): Promise<GraphStateUpdate> => {
      const threadId = threadOf(config) as string;
      emit(config, { type: "agent_started", agent: "executor" });
      let proposal: ActionProposal;
      try {
        proposal = (await agents.executor().run({
          question: state.question,
          history: history(state),
          knowledge: state.knowledge ?? EMPTY_KNOWLEDGE,
        })) as ActionProposal;
      } catch (err) {
        logger.warn({ msg: "Executor (proposta) falhou", err, threadId });
        return { results: { executor: agentFailure() }, errors: { executor: errorCode(err) } };
      }

      const risk = classifyRisk(proposal.action);
      const summary = {
        action: proposal.action,
        risk,
        payload: proposal.payload,
        valueBrl: proposal.valueBrl,
        rationale: proposal.rationale,
      };

      if (risk === "irreversible") {
        // Upsert idempotente (id = hash(thread, ação, payload)), sob o contexto do thread.
        // Upsert idempotente: se a 1ª chamada gravou a linha e só a resposta se perdeu (timeout),
        // repetir devolve o MESMO id e o grafo segue para o interrupt, sem deixar uma aprovação
        // órfã. ValidationError não muda numa nova tentativa e não repete.
        const request = () =>
          inbox.request({
            threadId,
            agent: "executor",
            action: proposal.action,
            payload: proposal.payload,
            valueBrl: proposal.valueBrl,
          });
        let approvalId: string;
        try {
          try {
            ({ approvalId } = await request());
          } catch (err) {
            if (err instanceof ValidationError) throw err;
            logger.warn({ msg: "Falha ao registrar a aprovação; nova tentativa", err, threadId });
            ({ approvalId } = await request());
          }
        } catch (err) {
          // Sem o id não há o que aprovar nem executar. Se a linha chegou a ser gravada, ela fica
          // `pending` sem thread esperando e a expiração (ReconciliationJob) a encerra; se alguém
          // decidir antes, o `resume` do worker (Task 19) recebe NotFound ("thread sem aprovação
          // pendente") e DEVE tratar NotFound como terminal (ack, sem retentar).
          logger.error({ msg: "Falha ao registrar a aprovação", err, threadId });
          return {
            results: { executor: { ...summary, status: "failed" } },
            errors: { executor: "approval_request_failed" },
          };
        }
        return {
          pending: { approvalId },
          results: { executor: { ...summary, status: "pending_approval", approvalId } },
        };
      }

      // read / reversible: executa já (sem aprovação humana, spec §6.2).
      const fn = executors.get(proposal.action);
      const { tenantId, clientId } = TenantContext.current();
      let result: unknown;
      try {
        if (!fn) throw new Error("Nenhum executor registrado para a ação");
        result = await fn(proposal.payload);
      } catch (err) {
        logger.error({
          msg: "Execução direta falhou",
          err,
          action: proposal.action,
          risk,
          threadId,
        });
        return {
          results: { executor: { ...summary, status: "failed" } },
          errors: { executor: "execution_failed" },
        };
      }
      if (risk === "reversible" && clientId !== undefined) {
        try {
          await streams.publish("notifications", {
            eventId: randomUUID(),
            type: "notification",
            tenantId,
            clientId,
            kind: "action.executed",
            text: `Ação ${proposal.action} executada`,
          });
        } catch (err) {
          logger.error({
            msg: "Falha ao publicar notification; a ação foi executada",
            err,
            threadId,
          });
        }
      }
      return { results: { executor: { ...summary, status: "succeeded", result } } };
    });

  const afterExecutor = (state: GraphStateValue) => (state.pending ? "approval" : END);

  const approval = (state: GraphStateValue, config: LangGraphRunnableConfig) => {
    const approvalId = state.pending?.approvalId;
    if (!approvalId) return Promise.resolve({});
    // NADA antes do interrupt: na retomada este nó roda de novo desde aqui.
    const raw: unknown = interrupt({ approvalId });
    return runInThread(threadOf(config), async (): Promise<GraphStateUpdate> => {
      const threadId = threadOf(config);
      // O valor da retomada é só um SINAL para acordar; a decisão é a gravada no banco (travada
      // pelo `decide`). Um evento atrasado, duplicado ou forjado não decide nada.
      const view = await inbox.get(approvalId);
      const signal = ResumeValueSchema.safeParse(raw);
      if (view.status === "pending") {
        // Acordou antes da decisão: erro repetível. A tarefa fica pendente no checkpoint e o
        // thread continua retomável (OrchestratorService.resume olha `tasks`).
        logger.warn({ msg: "Retomada com a aprovação ainda pendente", approvalId, threadId });
        throw new ApprovalConflictError("A aprovação ainda está pendente");
      }
      const approved = view.status === "approved";
      if (!signal.success || signal.data.approved !== approved) {
        logger.warn({
          msg: "Decisão da retomada diverge do banco; vale o banco",
          approvalId,
          dbStatus: view.status,
          threadId,
        });
      }
      if (!approved) return { execution: { approvalId, status: "rejected" } };

      let outcome: Omit<Execution, "approvalId">;
      try {
        outcome = await inbox.executeOnce(approvalId);
        if (outcome.status === "skipped") {
          // Aprovada mas a cerca já existia: outro worker executou (ou está executando).
          // Reporta o estado real de executed_action, não um `skipped` ambíguo.
          const real = await inbox.executionOf(approvalId);
          if (real) outcome = real;
        }
      } catch (err) {
        // Falha antes/durante a execução: o thread continua pendente neste nó e a próxima
        // retomada (reconciliação) tenta de novo; a cerca impede execução dupla.
        logger.error({ msg: "executeOnce falhou na retomada", err, approvalId, threadId });
        throw err;
      }
      return { execution: { approvalId, ...outcome } };
    });
  };

  return new StateGraph(GraphState)
    .addNode("classify", classify)
    .addNode("retrieve", retrieve)
    .addNode("specialist", specialist as never)
    .addNode("respond", navigatorNode("answer"))
    .addNode("synthesize", navigatorNode("synthesize"))
    .addNode("executor", executor)
    .addNode("approval", approval)
    .addEdge(START, "classify")
    .addEdge("classify", "retrieve")
    .addConditionalEdges("retrieve", route, ["respond", "specialist"])
    .addEdge("specialist", "synthesize")
    .addConditionalEdges("respond", maybeExecute, ["executor", END])
    .addConditionalEdges("synthesize", maybeExecute, ["executor", END])
    .addConditionalEdges("executor", afterExecutor, ["approval", END])
    .addEdge("approval", END)
    .compile({ checkpointer });
}

export type OrchestratorGraph = ReturnType<typeof buildGraph>;
