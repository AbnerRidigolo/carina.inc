/**
 * Chave de API da sessão. Fica só no `sessionStorage` (some ao fechar a aba) e numa variável em
 * memória; nunca em localStorage, cookie, URL ou log. Todo acesso ao storage é protegido: com o
 * storage bloqueado (modo privado, política do navegador) a chave vale só para esta página.
 */
const STORAGE_KEY = "carina.apiKey";

let memoryKey: string | null = null;
const listeners = new Set<() => void>();

function readStorage(): string | null {
  try {
    return globalThis.sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function notify(): void {
  for (const listener of [...listeners]) listener();
}

export function getApiKey(): string | null {
  return readStorage() ?? memoryKey;
}

export function setApiKey(key: string): void {
  memoryKey = key;
  try {
    globalThis.sessionStorage.setItem(STORAGE_KEY, key);
  } catch {
    /* storage indisponível: a chave segue só em memória */
  }
  notify();
}

export function clearApiKey(): void {
  memoryKey = null;
  try {
    globalThis.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* nada a limpar */
  }
  notify();
}

/** Para `useSyncExternalStore`. */
export function subscribeApiKey(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Versão exibível: prefixo e só os 4 últimos caracteres (a chave inteira nunca vai para a tela). */
export function maskKey(key: string): string {
  const prefix = key.startsWith("sk-live-") ? "sk-live-" : "";
  return `${prefix}…${key.slice(-4)}`;
}

/** Só para os testes: zera a memória e os assinantes. */
export function resetSessionForTests(): void {
  memoryKey = null;
  listeners.clear();
  try {
    globalThis.sessionStorage.clear();
  } catch {
    /* ignora */
  }
}
