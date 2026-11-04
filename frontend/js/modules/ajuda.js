export function exibirFromAjuda() {
  const lista = document.getElementById("listarPedidos");

  if (!lista) return;

  lista.innerHTML = `
    <div class="ajuda-container">
      <h2>Precisa de ajuda?</h2>
      <p>Fale com nosso suporte 👇</p>

      <a
        href="#contato"
        target="_blank"
        class="btn-whatsapp"
      >
        💬 Falar no WhatsApp
      </a>
    </div>
  `;
}
