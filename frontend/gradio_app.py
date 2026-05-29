"""UI Gradio do CARINA — chat conversacional consumindo o Orchestrator.

Pode rodar standalone (``python -m frontend.gradio_app``) ou ser montada no app
FastAPI em produção (HF Spaces).
"""

from __future__ import annotations

import gradio as gr

from carina.api.deps import get_orchestrator


async def _respond(message: str, history: list, client_id: str) -> str:
    """Encaminha a mensagem ao Orchestrator e formata a resposta para a UI."""
    if not client_id.strip():
        return "Informe um client_id para isolar seu grafo."
    orch = get_orchestrator(client_id.strip())
    outcome = await orch.handle(message)
    parts = [f"**Plano:** {outcome['plan'].get('complexity')}"]
    for agent, result in outcome["results"].items():
        parts.append(f"\n**{agent}:**\n{result}")
    return "\n".join(parts)


def build_demo() -> gr.Blocks:
    """Monta a interface Gradio."""
    with gr.Blocks(title="CARINA Wealth AI") as demo:
        gr.Markdown("# CARINA Wealth AI\nGestão patrimonial autônoma multi-agente.")
        client_id = gr.Textbox(label="client_id", value="demo", scale=1)
        gr.ChatInterface(
            fn=_respond,
            additional_inputs=[client_id],
            type="messages",
            title="Converse com a CARINA",
        )
    return demo


demo = build_demo()

if __name__ == "__main__":
    demo.launch(server_name="0.0.0.0", server_port=7860)
