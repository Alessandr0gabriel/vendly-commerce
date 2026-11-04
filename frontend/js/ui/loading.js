export function mostrarLoading() {
  const el = document.getElementById("loading");
  if (el) el.classList.add("active");
}

export function esconderLoading() {
  const el = document.getElementById("loading");
  if (el) el.classList.remove("active");
}
