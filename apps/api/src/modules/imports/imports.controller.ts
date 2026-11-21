import {
  ImportUploadFieldsSchema,
  type ImportJobList,
  type ImportJobView,
  type ImportUploadFields,
} from "@carina/shared";
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type {} from "multer";
import { ZodValidationPipe } from "nestjs-zod";
import { z } from "zod";
import { RequireScopes } from "../tenancy/scopes.decorator.js";
import { DEFAULT_LIST_LIMIT, ImportsService, MAX_LIST_LIMIT } from "./imports.service.js";
import { UploadErrorsInterceptor } from "./upload-errors.interceptor.js";

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** `?limit=` (1 a 100, padrão 20) e `?after=` (o `nextCursor` da página anterior). */
export const ImportsQuerySchema = z.object({
  limit: z
    .string()
    .regex(/^\d{1,3}$/, "precisa ser um inteiro")
    .transform(Number)
    .pipe(z.number().int().min(1).max(MAX_LIST_LIMIT))
    .default(DEFAULT_LIST_LIMIT),
  after: z.string().min(1).max(256).optional(),
});
type ImportsQuery = z.output<typeof ImportsQuerySchema>;

interface StatusRes {
  status(code: number): unknown;
}

/**
 * Importação de arquivos do cliente final (`:clientId` é o `externalId` do tenant). O POST cria o
 * cliente se não existir; 202 para job novo ou reenfileirado, 200 para o mesmo arquivo já
 * enfileirado, em andamento ou concluído. Cliente de outro tenant é indistinguível de inexistente.
 */
@Controller("clients/:clientId/imports")
export class ImportsController {
  constructor(@Inject(ImportsService) private readonly imports: ImportsService) {}

  @Post()
  @HttpCode(202)
  @RequireScopes("data:write")
  @UseInterceptors(
    UploadErrorsInterceptor,
    FileInterceptor("file", {
      // O nome do arquivo vem em UTF-8 (o padrão do multer é latin1 e estragaria acentos).
      defParamCharset: "utf8",
      limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 10, fieldSize: 16 * 1024 },
    }),
  )
  async upload(
    @Param("clientId") clientId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body(new ZodValidationPipe(ImportUploadFieldsSchema)) fields: ImportUploadFields,
    @Res({ passthrough: true }) res: StatusRes,
  ): Promise<ImportJobView> {
    const { job, created } = await this.imports.create(
      clientId,
      { bytes: file?.buffer ?? Buffer.alloc(0), originalName: file?.originalname },
      fields,
    );
    if (!created) res.status(200);
    return job;
  }

  @Get()
  @RequireScopes("chat")
  list(
    @Param("clientId") clientId: string,
    @Query(new ZodValidationPipe(ImportsQuerySchema)) query: ImportsQuery,
  ): Promise<ImportJobList> {
    return this.imports.list(clientId, query);
  }

  @Get(":id")
  @RequireScopes("chat")
  get(@Param("clientId") clientId: string, @Param("id") id: string): Promise<ImportJobView> {
    return this.imports.get(clientId, id);
  }
}
