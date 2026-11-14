/**
 * Broadcast da inbox para os WebSockets abertos neste processo.
 *
 * Um único `StreamsService.tail("inbox.events")` por processo, iniciado no `onModuleInit` (cedo no
 * bootstrap: o tail fixa o cursor na chamada; o que for publicado depois é entregue uma vez e em
 * ordem; o histórico não é reenviado). Cada evento `approval.created` / `approval.executed` vai só
 * para os assinantes do MESMO tenant E cliente do evento:
 *  1. filtro síncrono pela chave `tenantId:clientId` do evento (sem assinante → nada a fazer, nem
 *     consulta ao banco);
 *  2. a `ApprovalView` é lida sob o contexto do tenant/cliente do evento (`InboxService.get`, RLS):
 *     um evento forjado que aponte a aprovação de outro tenant resolve como NotFound e é descartado;
 *  3. o `clientId` (externalId) da aprovação lida precisa ser o do assinante.
 * Depois vira o `ChatEvent` correspondente (`approval_required` / `approval_executed`, este com o
 * resultado gravado em `executed_action` quando `succeeded`).
 *
 * Ordem: as leituras de uma mesma chave são encadeadas (um `approval.executed` nunca chega antes
 * do `approval.created` da mesma aprovação); chaves diferentes não se bloqueiam.
 * Encerramento: `onModuleDestroy` aborta o tail (desconecta a conexão bloqueante), espera o loop e
 * as entregas em curso e esquece os assinantes. Logs só com ids.
 */
import { type ChatEvent, type StreamEvent } from "@carina/shared";
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
  Optional,
} from "@nestjs/common";
import { TenantContext } from "../../core/context/tenant-context.js";
import { NotFoundError, ValidationError } from "../../core/errors/domain-errors.js";
import { StreamsService } from "../../core/redis/streams.service.js";
import { InboxService } from "../inbox/inbox.service.js";
import { CHAT_LOGGER, type ChatLogger } from "./chat.service.js";

export interface InboxSubscriber {
  tenantId: string;
  /** uuid interno do cliente final */
  clientId: string;
  /** externalId do cliente final (o da `ApprovalView`) */
  clientExternalId: string;
  send(event: ChatEvent): void;
}

type InboxEvent = Extract<StreamEvent, { type: "approval.created" | "approval.executed" }>;

const keyOf = (tenantId: string, clientId: string) =>
  `${tenantId.toLowerCase()}:${clientId.toLowerCase()}`;

@Injectable()
export class InboxBroadcast implements OnModuleInit, OnModuleDestroy {
  private readonly subscribers = new Map<string, Set<InboxSubscriber>>();
  private readonly chains = new Map<string, Promise<void>>();
  private abort: AbortController | undefined;
  private loop: Promise<void> | undefined;

  constructor(
    @Inject(StreamsService) private readonly streams: Pick<StreamsService, "tail">,
    @Inject(InboxService) private readonly inbox: Pick<InboxService, "get" | "executionOf">,
    @Optional()
    @Inject(CHAT_LOGGER)
    private readonly logger: ChatLogger = new Logger(InboxBroadcast.name),
  ) {}

  onModuleInit(): void {
    const abort = new AbortController();
    this.abort = abort;
    // Chamado de forma síncrona: o cursor do tail é fixado já aqui (ver StreamsService.tail).
    this.loop = this.streams
      .tail("inbox.events", (e) => this.dispatch(e), abort.signal)
      .catch((err: unknown) => {
        this.logger.error({ msg: "Tail de inbox.events terminou com erro", err });
      });
  }

  async onModuleDestroy(): Promise<void> {
    this.abort?.abort();
    await this.loop;
    await Promise.allSettled([...this.chains.values()]);
    this.subscribers.clear();
  }

  /** Assina os eventos do tenant e cliente; devolve a função que cancela a assinatura. */
  subscribe(subscriber: InboxSubscriber): () => void {
    const key = keyOf(subscriber.tenantId, subscriber.clientId);
    let set = this.subscribers.get(key);
    if (!set) {
      set = new Set();
      this.subscribers.set(key, set);
    }
    set.add(subscriber);
    return () => {
      const current = this.subscribers.get(key);
      if (!current) return;
      current.delete(subscriber);
      if (current.size === 0) this.subscribers.delete(key);
    };
  }

  /** Quantidade de assinantes (para testes e métricas). */
  size(): number {
    let n = 0;
    for (const set of this.subscribers.values()) n += set.size;
    return n;
  }

  private dispatch(e: StreamEvent): void {
    if (e.type !== "approval.created" && e.type !== "approval.executed") return;
    const key = keyOf(e.tenantId, e.clientId);
    if (!this.subscribers.get(key)?.size) return;
    const previous = this.chains.get(key) ?? Promise.resolve();
    const next = previous.then(() => this.deliver(key, e));
    this.chains.set(key, next);
    void next.finally(() => {
      if (this.chains.get(key) === next) this.chains.delete(key);
    });
  }

  /** Nunca rejeita (a cadeia da chave segue). */
  private async deliver(key: string, e: InboxEvent): Promise<void> {
    const built = await this.toChatEvent(e);
    if (!built) return;
    for (const s of [...(this.subscribers.get(key) ?? [])]) {
      if (s.clientExternalId !== built.clientExternalId) continue;
      try {
        s.send(built.event);
      } catch (err) {
        this.logger.warn({
          msg: "Falha ao entregar evento da inbox a um socket",
          err,
          approvalId: e.approvalId,
        });
      }
    }
  }

  private async toChatEvent(
    e: InboxEvent,
  ): Promise<{ event: ChatEvent; clientExternalId: string } | undefined> {
    try {
      return await TenantContext.run({ tenantId: e.tenantId, clientId: e.clientId }, async () => {
        const view = await this.inbox.get(e.approvalId);
        if (e.type === "approval.created") {
          return {
            event: { type: "approval_required", approval: view },
            clientExternalId: view.clientId,
          };
        }
        const execution = e.status === "succeeded" ? await this.inbox.executionOf(view.id) : null;
        return {
          event: {
            type: "approval_executed",
            approvalId: view.id,
            status: e.status,
            ...(execution?.result !== undefined ? { result: execution.result } : {}),
          },
          clientExternalId: view.clientId,
        };
      });
    } catch (err) {
      const ids = { eventId: e.eventId, tenantId: e.tenantId, approvalId: e.approvalId };
      if (err instanceof NotFoundError || err instanceof ValidationError) {
        // Aprovação inexistente no tenant/cliente do evento (forjado, apagado ou ids inválidos).
        this.logger.warn({
          msg: "Evento da inbox sem aprovação correspondente; descartado",
          ...ids,
        });
      } else {
        this.logger.error({ msg: "Falha ao montar o evento da inbox", err, ...ids });
      }
      return undefined;
    }
  }
}
