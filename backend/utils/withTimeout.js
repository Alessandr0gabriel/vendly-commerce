module.exports = async function withTimeout(operation, timeoutMs, label) {
  let timeoutId;

  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((resolve, reject) => {
        timeoutId = setTimeout(
          () =>
            reject(
              new Error(`[DEV] ${label} não respondeu em ${timeoutMs}ms.`),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
};
