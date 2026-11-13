import { Controller, Get, Inject, Optional, Res } from "@nestjs/common";
import { Public } from "../tenancy/scopes.decorator.js";

export const READINESS_PROBES = Symbol("READINESS_PROBES");
export const READY_TIMEOUT_MS = Symbol("READY_TIMEOUT_MS");

/** Prazo padrão de cada sonda do `/api/ready`. */
export const DEFAULT_READY_TIMEOUT_MS = 2000;

/** Cada sonda resolve se o serviço responde; qualquer rejeição (ou o prazo) conta como falha. */
export interface ReadinessProbes {
  postgres(): Promise<void>;
  redis(): Promise<void>;
}

type ProbeStatus = "ok" | "fail";
export interface ReadyStatus {
  postgres: ProbeStatus;
  redis: ProbeStatus;
}

/** Só o `status` da resposta do Express é usado. */
interface StatusSetter {
  status(code: number): unknown;
}

/**
 * Liveness (`/api/health`) e readiness (`/api/ready`). Públicas: sem chave, então também fora do
 * RateLimitGuard (que deixa passar rotas @Public) e sem TenantContext. O `/api/ready` roda as
 * duas sondas em paralelo, cada uma com prazo, e responde 503 com o serviço que falhou; o corpo
 * só tem "ok"/"fail" (nunca a mensagem do erro, que pode trazer host, usuário ou URL).
 */
@Public()
@Controller()
export class HealthController {
  constructor(
    @Inject(READINESS_PROBES) private readonly probes: ReadinessProbes,
    @Optional()
    @Inject(READY_TIMEOUT_MS)
    private readonly timeoutMs: number = DEFAULT_READY_TIMEOUT_MS,
  ) {}

  @Get("health")
  health(): { status: "ok" } {
    return { status: "ok" };
  }

  @Get("ready")
  async ready(@Res({ passthrough: true }) res: StatusSetter): Promise<ReadyStatus> {
    const [postgres, redis] = await Promise.all([
      this.check(() => this.probes.postgres()),
      this.check(() => this.probes.redis()),
    ]);
    const body: ReadyStatus = { postgres, redis };
    if (postgres !== "ok" || redis !== "ok") res.status(503);
    return body;
  }

  private async check(probe: () => Promise<void>): Promise<ProbeStatus> {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<ProbeStatus>((resolve) => {
      timer = setTimeout(() => resolve("fail"), this.timeoutMs);
      timer.unref();
    });
    const run = (async (): Promise<ProbeStatus> => {
      try {
        await probe();
        return "ok";
      } catch {
        return "fail";
      }
    })();
    try {
      return await Promise.race([run, deadline]);
    } finally {
      clearTimeout(timer);
    }
  }
}
