import {
  PayloadTooLargeException,
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from "@nestjs/common";
import { catchError, throwError, type Observable } from "rxjs";
import { PayloadTooLargeError } from "../../core/errors/domain-errors.js";

/**
 * Vai ANTES do FileInterceptor: o Nest já traduz o `LIMIT_FILE_SIZE` do multer em
 * PayloadTooLargeException; aqui vira o erro de domínio (413 em problem+json, mensagem fixa).
 */
@Injectable()
export class UploadErrorsInterceptor implements NestInterceptor {
  intercept(_ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next
      .handle()
      .pipe(
        catchError((err: unknown) =>
          throwError(() =>
            err instanceof PayloadTooLargeException ||
            (err as { code?: unknown } | null)?.code === "LIMIT_FILE_SIZE"
              ? new PayloadTooLargeError("O arquivo excede o limite de 10 MB")
              : err,
          ),
        ),
      );
  }
}
