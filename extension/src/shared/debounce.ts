export interface DebounceOptions {
  maxWait?: number; // optional maximum wait time before force flush
}

export function debounce<T extends (...args: any[]) => any>(
  fn: T,
  delay: number,
  options: DebounceOptions = {}
): (...args: Parameters<T>) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastInvokeTime = 0;
  let lastArgs: Parameters<T> | null = null;

  const { maxWait } = options;

  function invoke() {
    timer && clearTimeout(timer);
    timer = null;
    lastInvokeTime = Date.now();
    if (lastArgs) {
      try {
        fn(...lastArgs);
      } catch (e) {
        console.error("[AEGIS debounce] function threw:", e);
      }
      lastArgs = null;
    }
  }

  return (...args: Parameters<T>) => {
    lastArgs = args;
    const now = Date.now();

    // Cancel existing timer
    if (timer) clearTimeout(timer);

    // Schedule new normal delay
    timer = setTimeout(invoke, delay);

    // Force flush if maxWait exceeded
    if (maxWait && now - lastInvokeTime >= maxWait) {
      invoke();
    }
  };
}
