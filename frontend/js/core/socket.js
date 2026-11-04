import { SOCKET_URL } from "./config.js";

export let socket = null;

export function initSocket() {
  socket = io(SOCKET_URL, {
    withCredentials: true,
    transports: ["websocket"], // Força o canal estável direto do WebSocket cross-origin
    upgrade: false,
  });

  socket.on("sessaoEncerrada", () => {
    window.dispatchEvent(
      new CustomEvent("sessaoEncerrada", {
        detail: "Sua sessão foi encerrada porque houve um novo login.",
      }),
    );
  });

  return socket;
}

export function disconnectSocket() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}
