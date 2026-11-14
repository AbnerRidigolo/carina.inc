/**
 * Sonda de prontidão do Redis para `/api/ready`: conexão própria e descartável, sem fila offline,
 * sem novas tentativas e sem reconexão, com prazo de conexão curto; `PING` e desconecta. Não usa a
 * conexão compartilhada do app (cuja fila offline seguraria o comando enquanto o Redis estiver
 * fora). O erro é repassado como está: quem chama nunca o devolve ao cliente.
 */
import { Redis } from "ioredis";

export async function pingRedis(url: string, timeoutMs: number): Promise<void> {
  const redis = new Redis(url, {
    lazyConnect: true,
    connectTimeout: timeoutMs,
    commandTimeout: timeoutMs,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
    reconnectOnError: () => false,
  });
  redis.on("error", () => undefined);
  try {
    await redis.connect();
    const pong = await redis.ping();
    if (pong !== "PONG") throw new Error("resposta inesperada ao PING");
  } finally {
    redis.disconnect();
  }
}
