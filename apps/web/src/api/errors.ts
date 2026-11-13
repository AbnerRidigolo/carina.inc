import { ApiNetworkError, ApiProblemError, ApiValidationError } from "./client";

/** Mensagem em português para um código de erro de domínio (REST `Problem` ou evento `error` do WS). */
export function messageForCode(code: string, retryAfterSeconds?: number): string {
  const wait = retryAfterSeconds !== undefined ? ` Tente de novo em ${retryAfterSeconds} s.` : "";
  switch (code) {
    case "thread_busy":
    case "turn_in_progress":
      return "Já existe uma resposta em andamento nesta conversa. Aguarde terminar e tente de novo.";
    case "connection_lost":
      return "A conexão caiu durante a resposta. O servidor pode ter concluído (e cobrado) o pedido: confira a caixa de entrada antes de reenviar uma ação. Você já pode enviar outra mensagem.";
    case "approval_conflict":
      return "Esta conversa aguarda uma aprovação. Decida a pendência no painel de aprovações antes de continuar.";
    case "rate_limited":
      return `Muitas requisições em pouco tempo.${wait}`;
    case "quota_exceeded":
      return `A cota mensal de uso desta chave acabou.${wait}`;
    case "all_providers_failed":
      return `O serviço de IA está indisponível no momento.${wait}`;
    case "unauthenticated":
    case "connection_expired":
      return "Chave inválida ou expirada.";
    case "forbidden_scope":
      return "Esta chave não tem permissão para esta operação.";
    case "not_found":
      return "Não encontrado.";
    case "validation_error":
    case "client_mismatch":
      return "A mensagem não pôde ser processada. Revise o texto e tente de novo.";
    default:
      return "Algo deu errado. Tente de novo em instantes.";
  }
}

/** Mensagem para qualquer erro de chamada à API (nunca expõe corpo de resposta nem chave). */
export function describeApiError(err: unknown): string {
  if (err instanceof ApiProblemError) {
    const base = messageForCode(err.code, err.retryAfterSeconds);
    return err.traceId ? `${base} (rastreio: ${err.traceId})` : base;
  }
  if (err instanceof ApiValidationError)
    return "Resposta inesperada do servidor. Os dados não foram exibidos.";
  if (err instanceof ApiNetworkError)
    return "Não foi possível falar com o servidor. Verifique a conexão.";
  return "Algo deu errado. Tente de novo em instantes.";
}
