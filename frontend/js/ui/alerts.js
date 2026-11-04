export function showToast(icon, title, timer = 1500) {
  Swal.fire({
    toast: true,
    position: "top-end",
    icon,
    title,
    timer,
    showConfirmButton: false,
    timerProgressBar: true,
  });
}

export function showError(title, text) {
  Swal.fire({
    icon: "error",
    title,
    text,
  });
}

export function showSuccess(title, text, timer = 1500) {
  Swal.fire({
    icon: "success",
    title,
    text,
    timer,
    showConfirmButton: false,
  });
}
