import {
  PositionBatchSchema,
  TransactionBatchSchema,
  type NormalizedTransaction,
  type PositionBatch,
  type TransactionBatch,
} from "@carina/shared";
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from "@nestjs/common";
import { ZodValidationPipe } from "nestjs-zod";
import { z } from "zod";
import { RequireScopes } from "../tenancy/scopes.decorator.js";
import {
  DEFAULT_PAGE_LIMIT,
  IngestionService,
  MAX_PAGE_SIZE,
  type IngestResult,
  type PositionsPage,
} from "./ingestion.service.js";

/** `?limit=`: inteiro de 1 a 1000 (padrão 100). */
const LimitSchema = z
  .string()
  .regex(/^\d{1,4}$/, "precisa ser um inteiro")
  .transform(Number)
  .pipe(z.number().int().min(1).max(MAX_PAGE_SIZE))
  .default(DEFAULT_PAGE_LIMIT);

/** `?limit=` e `?after=` (o `nextCursor` da página anterior; a validade do cursor é do serviço). */
export const PositionsQuerySchema = z.object({
  limit: LimitSchema,
  after: z.string().min(1).max(1024).optional(),
});
type PositionsQuery = z.output<typeof PositionsQuerySchema>;

/** `?from=&to=` (YYYY-MM-DD, inclusivos) e `?limit=` (1..1000, padrão 100). */
export const TransactionsQuerySchema = z
  .object({
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    limit: LimitSchema,
  })
  .refine((q) => q.from === undefined || q.to === undefined || q.from <= q.to, {
    path: ["from"],
    message: "from não pode ser depois de to",
  });
type TransactionsQuery = z.output<typeof TransactionsQuerySchema>;

/**
 * Posições e transações do cliente final (`:clientId` é o `externalId` do tenant). O POST cria o
 * cliente se não existir; o GET não (404). Cliente de outro tenant é indistinguível de inexistente.
 */
@Controller("clients/:clientId")
export class IngestionController {
  constructor(@Inject(IngestionService) private readonly ingestion: IngestionService) {}

  @Post("positions")
  @HttpCode(201)
  @RequireScopes("data:write")
  ingestPositions(
    @Param("clientId") clientId: string,
    @Body(new ZodValidationPipe(PositionBatchSchema)) body: PositionBatch,
  ): Promise<IngestResult> {
    return this.ingestion.upsertPositions(clientId, "api", body.items);
  }

  @Post("transactions")
  @HttpCode(201)
  @RequireScopes("data:write")
  ingestTransactions(
    @Param("clientId") clientId: string,
    @Body(new ZodValidationPipe(TransactionBatchSchema)) body: TransactionBatch,
  ): Promise<IngestResult> {
    return this.ingestion.upsertTransactions(clientId, "api", body.items);
  }

  @Get("positions")
  @RequireScopes("chat")
  positions(
    @Param("clientId") clientId: string,
    @Query(new ZodValidationPipe(PositionsQuerySchema)) query: PositionsQuery,
  ): Promise<PositionsPage> {
    return this.ingestion.listPositions(clientId, query);
  }

  @Get("transactions")
  @RequireScopes("chat")
  transactions(
    @Param("clientId") clientId: string,
    @Query(new ZodValidationPipe(TransactionsQuerySchema)) query: TransactionsQuery,
  ): Promise<NormalizedTransaction[]> {
    return this.ingestion.listTransactions(clientId, query);
  }
}
