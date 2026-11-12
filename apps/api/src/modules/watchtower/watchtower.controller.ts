import type { AuditEventView } from "@carina/shared";
import { Controller, Get, Inject, Query } from "@nestjs/common";
import { ValidationError } from "../../core/errors/domain-errors.js";
import { RequireScopes } from "../tenancy/scopes.decorator.js";
import { DEFAULT_TRAIL_LIMIT, WatchtowerService } from "./watchtower.service.js";

@Controller("audit")
export class WatchtowerController {
  constructor(@Inject(WatchtowerService) private readonly watchtower: WatchtowerService) {}

  /** Trilha de auditoria do tenant da chave (`?limit=`: default 100, máximo 500). */
  @Get()
  @RequireScopes("chat")
  trail(@Query("limit") limit?: string | string[]): Promise<AuditEventView[]> {
    if (limit === undefined) return this.watchtower.trail(DEFAULT_TRAIL_LIMIT);
    // Só dígitos: rejeita "abc", "1.5", "-3", "", "2x" e parâmetro repetido (array).
    if (typeof limit !== "string" || !/^\d{1,9}$/.test(limit)) {
      throw new ValidationError("limit precisa ser um inteiro maior ou igual a 1");
    }
    // Valores acima de 500 são limitados a 500 pelo serviço; 0 → 422.
    return this.watchtower.trail(Number(limit));
  }
}
