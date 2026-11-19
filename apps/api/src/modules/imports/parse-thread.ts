/**
 * Entrada da worker thread do parse (ver parse-file.ts). Recebe `{ format, bytes, options }` em
 * `workerData` (os bytes transferidos, não copiados), roda o parser e devolve uma única mensagem:
 * `{ ok: true, result }` ou `{ ok: false, error }` com SÓ o nome do erro (a mensagem poderia
 * carregar conteúdo do arquivo).
 */
import { parentPort, workerData } from "node:worker_threads";
import { runParser } from "./parse-dispatch.js";
import type { ParseRequest } from "./parse-file.js";

const req = workerData as ParseRequest;
let reply: unknown;
try {
  reply = { ok: true, result: runParser(req.format, req.bytes, req.options) };
} catch (err) {
  reply = { ok: false, error: err instanceof Error ? err.name : "Error" };
}
parentPort?.postMessage(reply);
