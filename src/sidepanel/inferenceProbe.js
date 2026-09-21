/** One 探测: media capability check + context-window resolution. */

export function bindInferenceProbe({ root = document, t, media, windowUi } = {}) {
  const btn = root.getElementById?.('inferenceProbeBtn');
  let mediaBusy = false;
  let windowBusy = false;
  const paint = () => {
    if (!btn) return;
    const busy = mediaBusy || windowBusy;
    btn.disabled = busy;
    btn.textContent = busy ? t('inferenceProbeChecking') : t('inferenceProbe');
  };
  media?.setBusyListener?.((busy) => {
    mediaBusy = !!busy;
    paint();
  });
  windowUi?.setBusyListener?.((busy) => {
    windowBusy = !!busy;
    paint();
  });
  btn?.addEventListener('click', () => {
    mediaBusy = true;
    windowBusy = true;
    paint();
    void media?.probe?.({ force: true });
    void windowUi?.probe?.({ force: true });
  });
  paint();
  return { paint };
}
