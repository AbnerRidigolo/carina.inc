/**
 * Processo de workers (sem HTTP): SyncWorker, ResumeWorker e ReconciliationJob. Mesmo código e
 * mesma imagem da API; WORKERS_ENABLED é forçado a "true" (ver createWorkerContext). O processo
 * fica vivo pelos loops de consumo e encerra limpo no SIGTERM (shutdown hooks).
 */
import { Logger } from "@nestjs/common";
import { createWorkerContext } from "./bootstrap.js";
import { formatBootError } from "./core/errors/boot-error.js";

try {
  await createWorkerContext();
  new Logger("Bootstrap").log({ msg: "Workers no ar" });
} catch (err) {
  console.error(`Falha ao iniciar os workers: ${formatBootError(err)}`);
  process.exit(1);
}
