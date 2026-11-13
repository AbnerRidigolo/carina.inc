import type { ChatEvent } from "@carina/shared";

/** Barramento mínimo: o ChatView publica o que chega no socket; inbox e uso escutam. */
export interface EventBus<T> {
  publish(event: T): void;
  subscribe(listener: (event: T) => void): () => void;
}

export function createEventBus<T>(): EventBus<T> {
  const listeners = new Set<(event: T) => void>();
  return {
    publish(event) {
      for (const listener of [...listeners]) listener(event);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** Tudo que os painéis recebem: eventos do chat e o aviso de que o socket (re)abriu. */
export type PanelSignal = ChatEvent | { type: "socket_open" };
export type SignalBus = EventBus<PanelSignal>;
