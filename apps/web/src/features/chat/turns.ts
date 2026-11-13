import type { AgentName, ChatEvent, ComplianceFlag, Plan, WorkType } from "@carina/shared";

export interface AgentView {
  agent: AgentName;
  status: "thinking" | "done";
  /** Texto em streaming (tokens). */
  text: string;
  hasResult: boolean;
  result?: unknown;
}

export interface TurnDone {
  status: "completed" | "awaiting_approval";
  answer: string;
  workType: WorkType;
  priceBrl: string;
  auditId: string;
  flags: ComplianceFlag[];
}

export interface Turn {
  id: number;
  question: string;
  plan?: Plan;
  agents: AgentView[];
  done?: TurnDone;
  error?: { code: string; traceId: string };
}

export type TurnAction =
  | { type: "ask"; question: string }
  | { type: "event"; event: ChatEvent }
  /** O socket caiu no meio do turno: os eventos que faltam não vão chegar. */
  | { type: "turn_interrupted" };

export const isActive = (t: Turn | undefined): t is Turn => t !== undefined && !t.done && !t.error;

function withAgent(turn: Turn, agent: AgentName, update: (a: AgentView) => AgentView): Turn {
  const exists = turn.agents.some((a) => a.agent === agent);
  const base: AgentView[] = exists
    ? turn.agents
    : [...turn.agents, { agent, status: "thinking", text: "", hasResult: false }];
  return { ...turn, agents: base.map((a) => (a.agent === agent ? update(a) : a)) };
}

/** Aplica um evento do socket ao turno em andamento (eventos fora de turno são ignorados). */
function applyEvent(turn: Turn, event: ChatEvent): Turn {
  switch (event.type) {
    case "plan":
      return { ...turn, plan: event.plan };
    case "agent_started":
      return withAgent(turn, event.agent, (a) => a);
    case "token":
      return withAgent(turn, event.agent, (a) => ({ ...a, text: a.text + event.text }));
    case "agent_result":
      return withAgent(turn, event.agent, (a) => ({
        ...a,
        status: "done",
        hasResult: true,
        result: event.result,
      }));
    case "done": {
      const hasNavigator = turn.agents.some((a) => a.agent === "navigator");
      const agents: AgentView[] =
        hasNavigator || event.answer === ""
          ? turn.agents
          : [
              ...turn.agents,
              {
                agent: "navigator",
                status: "done",
                text: "",
                hasResult: true,
                result: event.answer,
              },
            ];
      return {
        ...turn,
        agents: agents.map((a) => (a.status === "thinking" ? { ...a, status: "done" } : a)),
        done: {
          status: event.status,
          answer: event.answer,
          workType: event.usage.workType,
          priceBrl: event.usage.priceBrl,
          auditId: event.compliance.auditId,
          flags: event.compliance.flags,
        },
      };
    }
    case "error":
      return { ...turn, error: { code: event.code, traceId: event.traceId } };
    case "approval_required":
    case "approval_executed":
      return turn;
  }
}

export function turnsReducer(turns: Turn[], action: TurnAction): Turn[] {
  if (action.type === "ask") {
    return [...turns, { id: turns.length + 1, question: action.question, agents: [] }];
  }
  const last = turns.at(-1);
  if (!isActive(last)) return turns;
  if (action.type === "turn_interrupted") {
    return [...turns.slice(0, -1), { ...last, error: { code: "connection_lost", traceId: "" } }];
  }
  return [...turns.slice(0, -1), applyEvent(last, action.event)];
}
