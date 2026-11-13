import { Controller, Get, Inject, Optional, Res } from "@nestjs/common";
import { Public } from "../tenancy/scopes.decorator.js";

export const READINESS_PROBES = Symbol("READINESS_PROBES");
export const READY_OPTIONS = Symbol("READY_OPTIONS");

/** Prazo padrão de cada sonda do `/api/ready`. */
export const DEFAULT_READY_TIMEOUT_MS = 2000;
/** Por quanto tempo um resultado (ok OU fail) é reaproveitado. */
export const DEFAULT_READY_CACHE_TTL_MS = 1500;

/** Cada sonda resolve se o serviço responde; qualquer rejeição (ou o prazo) conta como falha. */
export interface ReadinessProbes {
  postgres(): Promise<void>;
  redis(): Promise<void>;
}

export interface ReadyOptions {
  timeoutMs?: number;
  cacheTtlMs?: number;
  /** Relógio em ms (os testes controlam o tempo). */
  clock?: () => number;
}

type ProbeStatus = "ok" | "fail";
type Service = keyof ReadinessProbes;
export interface ReadyStatus {
  postgres: ProbeStatus;
  redis: ProbeStatus;
}

/** Só o `status` da resposta do Express é usado. */
interface StatusSetter {
  status(code: number): unknown;
}

/** Estado da sonda de um serviço. */
interface ProbeState {
  /** Último resultado e até quando vale. */
  status?: ProbeStatus;
  expiresAt: number;
  /** Rodada em andamento (com prazo): quem chega agora espera esta mesma promessa. */
  current?: Promise<ProbeStatus>;
  /** A sonda em si; pode seguir viva depois do prazo, segurando uma conexão. */
  raw?: Promise<unknown>;
}

/**
 * Liveness (`/api/health`) e readiness (`/api/ready`). Públicas: sem chave, então também fora do
 * RateLimitGuard (que deixa passar rotas @Public) e sem TenantContext. O `/api/ready` responde 503
 * com o serviço que falhou; o corpo só tem "ok"/"fail" (nunca a mensagem do erro, que pode trazer
 * host, usuário ou URL).
 *
 * Como a rota é pública e cada sonda abre uma conexão própria, ela não pode virar amplificador de
 * conexões: por serviço há no máximo UMA sonda viva por vez (single-flight: requisições
 * concorrentes esperam a mesma promessa), o resultado — ok ou fail — é reaproveitado por
 * `cacheTtlMs`, e uma sonda que estourou o prazo mas ainda não terminou impede outra de abrir
 * (vale o último resultado até ela terminar). Conexões abertas pelo `/api/ready` ficam, assim,
 * limitadas a uma por serviço, qualquer que seja a carga.
 */
@Public()
@Controller()
export class HealthController {
  private readonly timeoutMs: number;
  private readonly cacheTtlMs: number;
  private readonly clock: () => number;
  private readonly state: Record<Service, ProbeState> = {
    postgres: { expiresAt: 0 },
    redis: { expiresAt: 0 },
  };

  constructor(
    @Inject(READINESS_PROBES) private readonly probes: ReadinessProbes,
    @Optional() @Inject(READY_OPTIONS) options: ReadyOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_READY_CACHE_TTL_MS;
    this.clock = options.clock ?? Date.now;
  }

  @Get("health")
  health(): { status: "ok" } {
    return { status: "ok" };
  }

  @Get("ready")
  async ready(@Res({ passthrough: true }) res: StatusSetter): Promise<ReadyStatus> {
    const [postgres, redis] = await Promise.all([this.check("postgres"), this.check("redis")]);
    const body: ReadyStatus = { postgres, redis };
    if (postgres !== "ok" || redis !== "ok") res.status(503);
    return body;
  }

  private check(service: Service): Promise<ProbeStatus> | ProbeStatus {
    const s = this.state[service];
    if (s.current) return s.current;
    if (s.status !== undefined && this.clock() < s.expiresAt) return s.status;
    // A sonda anterior estourou o prazo e ainda segura a conexão: não abre outra.
    if (s.raw) return s.status ?? "fail";

    const raw = (async () => this.probes[service]())();
    s.raw = raw;
    raw.then(
      () => this.settleRaw(s, raw),
      () => this.settleRaw(s, raw),
    );
    const round = this.withDeadline(raw).then((status) => {
      s.status = status;
      s.expiresAt = this.clock() + this.cacheTtlMs;
      s.current = undefined;
      return status;
    });
    s.current = round;
    return round;
  }

  private settleRaw(s: ProbeState, raw: Promise<unknown>): void {
    if (s.raw === raw) s.raw = undefined;
  }

  /** "ok" se a sonda resolve dentro do prazo; "fail" se rejeita ou estoura. Nunca rejeita. */
  private async withDeadline(raw: Promise<unknown>): Promise<ProbeStatus> {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<ProbeStatus>((resolve) => {
      timer = setTimeout(() => resolve("fail"), this.timeoutMs);
      timer.unref();
    });
    const outcome = raw.then(
      (): ProbeStatus => "ok",
      (): ProbeStatus => "fail",
    );
    try {
      return await Promise.race([outcome, deadline]);
    } finally {
      clearTimeout(timer);
    }
  }
}
