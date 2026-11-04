const BACKEND_URL = (window.VENDLY_CONFIG?.backendUrl || "http://127.0.0.1:3000").replace(/\/$/, "");
export const API_URL = `${BACKEND_URL}/api`;
export const SOCKET_URL = BACKEND_URL;
