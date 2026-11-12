/**
 * Estado do grafo do orquestrador (persistido por thread no checkpointer).
 *
 * Campos por TURNO (`plan`, `knowledge`, `results`, `errors`, `answer`, `pending`, `execution`) são
 * zerados pelo nó `classify` no começo de cada turno (`Overwrite` passa por cima do reducer de
 * merge); só `messages` atravessa os turnos, limitado a `MAX_STORED_MESSAGES` (o corte em
 * `MAX_HISTORY_MESSAGES` é aplicado ao montar as chamadas dos agentes).
 */
import type { BaseMessage } from "@langchain/core/messages";
import { Annotation } from "@langchain/langgraph";
import type { Plan, SpecialistName } from "@carina/shared";
import type { SearchResult } from "../knowledge/knowledge.service.js";

/** Histórico enviado a cada agente (spec §4: as últimas 20 mensagens). */
export const MAX_HISTORY_MESSAGES = 20;
/** Histórico guardado no checkpoint (o estado não cresce sem limite). */
export const MAX_STORED_MESSAGES = 40;

export type ExecutionStatus = "succeeded" | "failed" | "skipped" | "needs_review" | "rejected";

export interface Execution {
  approvalId: string;
  status: ExecutionStatus;
  result?: unknown;
}

const merge = <T>(a: Record<string, T>, b: Record<string, T>): Record<string, T> => ({
  ...a,
  ...b,
});

const last = <T>(fallback: T) =>
  Annotation<T>({ reducer: (_a: T, b: T) => b, default: () => fallback });

export const GraphState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (a, b) => [...a, ...b].slice(-MAX_STORED_MESSAGES),
    default: () => [],
  }),
  question: last<string>(""),
  plan: last<Plan | null>(null),
  knowledge: last<SearchResult | null>(null),
  results: Annotation<Record<string, unknown>>({ reducer: merge, default: () => ({}) }),
  errors: Annotation<Record<string, string>>({ reducer: merge, default: () => ({}) }),
  answer: last<string | null>(null),
  pending: last<{ approvalId: string } | null>(null),
  execution: last<Execution | null>(null),
});

export type GraphStateValue = typeof GraphState.State;
export type GraphStateUpdate = typeof GraphState.Update;

/** Entrada do nó `specialist` (via `Send`). */
export interface SpecialistInput {
  agent: SpecialistName;
  question: string;
  knowledge: SearchResult;
  messages: BaseMessage[];
}
