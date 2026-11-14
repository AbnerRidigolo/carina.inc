/**
 * Sonda de prontidão do Postgres para `/api/ready`: abre uma conexão NOVA como carina_app
 * (DATABASE_URL), roda `SELECT 1` e fecha. Não usa o pool da aplicação, então não ocupa nem
 * prende conexões dele, e prova que dá para abrir uma conexão agora. Todos os prazos são curtos
 * (conexão, statement e consulta); o `end()` não é aguardado (um socket meio-aberto não segura a
 * resposta). O erro é repassado como está: quem chama nunca o devolve ao cliente.
 */
import pg from "pg";

export async function pingPostgres(connectionString: string, timeoutMs: number): Promise<void> {
  const client = new pg.Client({
    connectionString,
    connectionTimeoutMillis: timeoutMs,
    query_timeout: timeoutMs,
    statement_timeout: timeoutMs,
  });
  // Erro assíncrono depois do fim (ex.: servidor derruba a conexão) não pode virar exceção solta.
  client.on("error", () => undefined);
  try {
    await client.connect();
    await client.query("SELECT 1");
  } finally {
    client.end().catch(() => undefined);
  }
}
