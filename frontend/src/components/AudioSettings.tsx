import {
  createSignal,
  onMount,
  onCleanup,
  For,
  Show,
  type Component,
} from "solid-js";
import { updateMicGain } from "../api";
import { audioEngine } from "../audio/AudioEngine";
import {
  MicrophoneProcessor,
  getSavedNoiseSuppressionMode,
  type NoiseSuppressionMode,
} from "../audio/MicrophoneGain";

interface AudioSettingsProps {
  micGain: number;
  onMicGainChange: (newGain: number) => void;
  micProcessor: MicrophoneProcessor | null;
  onClose: () => void;
}

export const AudioSettings: Component<AudioSettingsProps> = (props) => {
  const [gain, setGain] = createSignal(props.micGain);
  const [outputVol, setOutputVol] = createSignal(audioEngine.getOutputVolume());
  const [nsMode, setNsMode] = createSignal<NoiseSuppressionMode>(
    props.micProcessor?.getNoiseSuppressionMode() ||
      getSavedNoiseSuppressionMode(),
  );
  const [inputDevices, setInputDevices] = createSignal<MediaDeviceInfo[]>([]);
  const [outputDevices, setOutputDevices] = createSignal<MediaDeviceInfo[]>([]);
  const [selectedInputId, setSelectedInputId] = createSignal(
    localStorage.getItem("cf_audio_input_device") || "default",
  );
  const [selectedOutputId, setSelectedOutputId] = createSignal(
    audioEngine.getOutputDevice() || "default",
  );
  const [isTesting, setIsTesting] = createSignal(false);
  const [vuPercent, setVuPercent] = createSignal(0);
  const [vuDb, setVuDb] = createSignal(-60);
  const [isClipping, setIsClipping] = createSignal(false);
  const [gateOpen, setGateOpen] = createSignal(false);
  const [reductionDb, setReductionDb] = createSignal(0);

  let gainDebounceTimer: number | null = null;
  let pendingGainToSave: number | null = null;
  let standaloneProcessor: MicrophoneProcessor | null = null;

  const getActiveProcessor = () => props.micProcessor || standaloneProcessor;

  const loadDevices = async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const inputs = devices.filter(
        (d) => d.kind === "audioinput" && d.deviceId !== "",
      );
      const outputs = devices.filter(
        (d) => d.kind === "audiooutput" && d.deviceId !== "",
      );

      setInputDevices(inputs);
      setOutputDevices(outputs);

      if (
        inputs.length > 0 &&
        selectedInputId() !== "default" &&
        !inputs.some((d) => d.deviceId === selectedInputId())
      ) {
        setSelectedInputId(inputs[0].deviceId);
      }
      if (
        outputs.length > 0 &&
        selectedOutputId() !== "default" &&
        !outputs.some((d) => d.deviceId === selectedOutputId())
      ) {
        setSelectedOutputId(outputs[0].deviceId);
      }
    } catch {
      // Dispositivos não permitidos ainda
    }
  };

  onMount(async () => {
    await loadDevices();

    // Se o usuário abrir as configurações fora da chamada, cria um processador temporário
    // para que o VU Meter e o teste de microfone funcionem imediatamente
    if (!props.micProcessor) {
      try {
        standaloneProcessor = new MicrophoneProcessor();
        standaloneProcessor.resume();
        standaloneProcessor.setGainPercent(gain());
        await standaloneProcessor.acquireAndSetStream(selectedInputId());
        await loadDevices();
      } catch {
        // Permissão de microfone negada ou indisponível
      }
    }

    // Escuta eventos de telemetria (~20 Hz) calculados diretamente na thread do AudioWorklet,
    // evitando polling a 60 FPS na thread principal
    const proc = getActiveProcessor();
    if (proc) {
      const initial = proc.getAudioLevel();
      setVuPercent(initial.percent);
      setVuDb(initial.db);
      setIsClipping(initial.isClipping);
      setGateOpen(initial.gateOpen);
      setReductionDb(initial.reductionDb);

      proc.setTelemetryListener((level) => {
        setVuPercent(level.percent);
        setVuDb(level.db);
        setIsClipping(level.isClipping);
        setGateOpen(level.gateOpen);
        setReductionDb(level.reductionDb);
      });
    }
  });

  onCleanup(() => {
    if (gainDebounceTimer !== null) {
      clearTimeout(gainDebounceTimer);
      gainDebounceTimer = null;
      if (pendingGainToSave !== null) {
        void updateMicGain(pendingGainToSave).catch(() => {});
        pendingGainToSave = null;
      }
    }
    props.micProcessor?.setTelemetryListener(null);
    // Se estava em chamada e testando o microfone, desativa o retorno e restaura echoCancellation
    if (props.micProcessor && isTesting()) {
      void props.micProcessor.setMonitoring(false);
    }
    standaloneProcessor?.cleanup();
    standaloneProcessor = null;
  });

  const handleInputDeviceChange = async (deviceId: string) => {
    setSelectedInputId(deviceId);
    try {
      localStorage.setItem("cf_audio_input_device", deviceId);
    } catch {
      // ignore
    }
    const proc = getActiveProcessor();
    if (proc) {
      try {
        await proc.acquireAndSetStream(deviceId);
      } catch {
        // Falha ao trocar microfone em tempo real
      }
    }
  };

  const handleOutputDeviceChange = async (deviceId: string) => {
    setSelectedOutputId(deviceId);
    await audioEngine.setOutputDevice(deviceId);
    const proc = getActiveProcessor();
    if (proc) {
      await proc.setMonitorSinkId(deviceId);
    }
  };

  const handleGainChange = (newVal: number) => {
    const clamped = Math.max(0, Math.min(200, Math.round(newVal)));
    setGain(clamped);
    props.onMicGainChange(clamped);
    getActiveProcessor()?.setGainPercent(clamped);

    // Debounce de 500ms para evitar dezenas de escritas no SQLite ao arrastar o slider
    pendingGainToSave = clamped;
    if (gainDebounceTimer !== null) {
      clearTimeout(gainDebounceTimer);
    }
    gainDebounceTimer = window.setTimeout(() => {
      if (pendingGainToSave !== null) {
        void updateMicGain(pendingGainToSave).catch(() => {});
        pendingGainToSave = null;
      }
      gainDebounceTimer = null;
    }, 500);
  };

  const handleOutputVolChange = (newVal: number) => {
    const clamped = Math.max(0, Math.min(200, Math.round(newVal)));
    setOutputVol(clamped);
    audioEngine.setOutputVolume(clamped);
    getActiveProcessor()?.setMonitorVolume(clamped);
  };

  const handleNsModeChange = async (mode: NoiseSuppressionMode) => {
    setNsMode(mode);
    const proc = getActiveProcessor();
    if (proc) {
      await proc.setNoiseSuppressionMode(mode);
    }
  };

  const toggleTest = async () => {
    const proc = getActiveProcessor();
    if (!proc) return;
    const next = !isTesting();
    setIsTesting(next);
    await proc.setMonitoring(next, outputVol(), selectedOutputId());
  };

  return (
    <div class="modal-backdrop" onClick={props.onClose}>
      <div
        class="modal-card audio-settings-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div class="modal-header">
          <div class="modal-header-title">
            <div class="modal-header-icon">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="4" y1="21" x2="4" y2="14" />
                <line x1="4" y1="10" x2="4" y2="3" />
                <line x1="12" y1="21" x2="12" y2="12" />
                <line x1="12" y1="8" x2="12" y2="3" />
                <line x1="20" y1="21" x2="20" y2="16" />
                <line x1="20" y1="12" x2="20" y2="3" />
                <line x1="2" y1="14" x2="6" y2="14" />
                <line x1="10" y1="8" x2="14" y2="8" />
                <line x1="18" y1="16" x2="22" y2="16" />
              </svg>
            </div>
            <div>
              <h3>Configurações de Voz e Áudio</h3>
              <p class="modal-header-subtitle">
                Calibre dispositivos, ganho, supressão de ruído DSP e saída mestre
              </p>
            </div>
          </div>
          <button class="modal-close-btn" onClick={props.onClose} title="Fechar">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div class="modal-body audio-settings-body">
          {/* GRADE DE ENTRADA E SAÍDA */}
          <div class="audio-io-grid">
            {/* CARD DE ENTRADA (MICROFONE) */}
            <div class="audio-io-card">
              <div class="audio-io-card-header">
                <span class="audio-io-badge input">
                  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                    <line x1="12" y1="19" x2="12" y2="22" />
                  </svg>
                  Entrada de Voz
                </span>
              </div>

              <div class="settings-group">
                <label class="settings-label">DISPOSITIVO DE ENTRADA</label>
                <select
                  class="settings-select"
                  value={selectedInputId()}
                  onChange={(e) => void handleInputDeviceChange(e.currentTarget.value)}
                >
                  <Show when={!inputDevices().some((d) => d.deviceId === "default")}>
                    <option value="default">Padrão do Sistema (Microfone)</option>
                  </Show>
                  <For each={inputDevices()}>
                    {(device, idx) => (
                      <option value={device.deviceId}>
                        {device.label || `Microfone ${idx() + 1}`}
                      </option>
                    )}
                  </For>
                </select>
              </div>

              <div class="settings-group">
                <div class="settings-label-row">
                  <span class="settings-label">GANHO DO MICROFONE</span>
                  <div class="settings-badge-actions">
                    <Show when={gain() !== 100}>
                      <button
                        type="button"
                        class="reset-100-btn"
                        onClick={() => handleGainChange(100)}
                        title="Restaurar para 100%"
                      >
                        Resetar
                      </button>
                    </Show>
                    <span class="settings-value-badge">{gain()}%</span>
                  </div>
                </div>
                <input
                  type="range"
                  min="0"
                  max="200"
                  value={gain()}
                  onInput={(e) => handleGainChange(Number(e.currentTarget.value))}
                  class="settings-slider"
                />
                <div class="slider-marks">
                  <span>0%</span>
                  <span>100% (Padrão)</span>
                  <span>200%</span>
                </div>
              </div>
            </div>

            {/* CARD DE SAÍDA (ÁUDIO / FONES) */}
            <div class="audio-io-card">
              <div class="audio-io-card-header">
                <span class="audio-io-badge output">
                  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                    <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                    <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                  </svg>
                  Saída de Áudio
                </span>
                <button
                  type="button"
                  class="test-tone-btn"
                  onClick={() => audioEngine.playTestTone()}
                  title="Tocar som de teste na saída"
                >
                  Testar Som
                </button>
              </div>

              <div class="settings-group">
                <label class="settings-label">DISPOSITIVO DE SAÍDA</label>
                <select
                  class="settings-select"
                  value={selectedOutputId()}
                  onChange={(e) => void handleOutputDeviceChange(e.currentTarget.value)}
                >
                  <Show when={!outputDevices().some((d) => d.deviceId === "default")}>
                    <option value="default">Padrão do Sistema (Saída)</option>
                  </Show>
                  <For each={outputDevices()}>
                    {(device, idx) => (
                      <option value={device.deviceId}>
                        {device.label || `Saída de Áudio ${idx() + 1}`}
                      </option>
                    )}
                  </For>
                </select>
              </div>

              <div class="settings-group">
                <div class="settings-label-row">
                  <span class="settings-label">VOLUME DA SAÍDA</span>
                  <div class="settings-badge-actions">
                    <Show when={outputVol() !== 100}>
                      <button
                        type="button"
                        class="reset-100-btn"
                        onClick={() => handleOutputVolChange(100)}
                        title="Restaurar para 100%"
                      >
                        Resetar
                      </button>
                    </Show>
                    <span class="settings-value-badge">{outputVol()}%</span>
                  </div>
                </div>
                <input
                  type="range"
                  min="0"
                  max="200"
                  value={outputVol()}
                  onInput={(e) => handleOutputVolChange(Number(e.currentTarget.value))}
                  class="settings-slider"
                />
                <div class="slider-marks">
                  <span>0%</span>
                  <span>100% (Padrão)</span>
                  <span>200%</span>
                </div>
              </div>
            </div>
          </div>

          {/* CARD DE SUPRESSÃO DE RUÍDO DSP */}
          <div class="audio-ns-card">
            <div class="settings-label-row">
              <div class="vu-title-group">
                <span class="settings-label">SUPRESSÃO DE RUÍDO INTELIGENTE (DSP)</span>
                <span class="settings-hint">
                  Substitui o filtro nativo instável do navegador por um AudioWorklet de estúdio com Lookahead (4ms) e Hold (240ms) que não corta a sua voz.
                </span>
              </div>
              <Show when={nsMode() === "studio" || nsMode() === "light"}>
                <span class={`ns-status-pill ${gateOpen() ? "speaking" : "suppressed"}`}>
                  {gateOpen()
                    ? "Voz Aberta (0 dB)"
                    : `Filtrando Ruído (-${reductionDb()} dB)`}
                </span>
              </Show>
            </div>

            <div class="ns-mode-grid">
              <button
                type="button"
                class={`ns-mode-btn ${nsMode() === "studio" ? "active" : ""}`}
                onClick={() => void handleNsModeChange("studio")}
              >
                <div class="ns-mode-top">
                  <span class="ns-mode-name">Estúdio DSP</span>
                  <span class="ns-mode-tag rec">Recomendado</span>
                </div>
                <span class="ns-mode-desc">
                  Filtro 85Hz–14.5kHz + Wiener Expander (-27 dB) sem cortar frases
                </span>
              </button>

              <button
                type="button"
                class={`ns-mode-btn ${nsMode() === "light" ? "active" : ""}`}
                onClick={() => void handleNsModeChange("light")}
              >
                <div class="ns-mode-top">
                  <span class="ns-mode-name">Suave</span>
                  <span class="ns-mode-tag">Natural</span>
                </div>
                <span class="ns-mode-desc">
                  Atenuação leve (-15 dB) ideal para ambientes já silenciosos
                </span>
              </button>

              <button
                type="button"
                class={`ns-mode-btn ${nsMode() === "browser" ? "active" : ""}`}
                onClick={() => void handleNsModeChange("browser")}
              >
                <div class="ns-mode-top">
                  <span class="ns-mode-name">Nativo</span>
                  <span class="ns-mode-tag">Navegador</span>
                </div>
                <span class="ns-mode-desc">
                  Usa o filtro padrão do sistema/navegador (pode abafar finais)
                </span>
              </button>

              <button
                type="button"
                class={`ns-mode-btn ${nsMode() === "off" ? "active" : ""}`}
                onClick={() => void handleNsModeChange("off")}
              >
                <div class="ns-mode-top">
                  <span class="ns-mode-name">Desativado</span>
                  <span class="ns-mode-tag">Áudio Cru</span>
                </div>
                <span class="ns-mode-desc">
                  Nenhuma filtragem de ruído, apenas ganho e limiter (-3 dB)
                </span>
              </button>
            </div>
          </div>

          {/* CARD DO VU METER E MONITORAMENTO DE MICROFONE */}
          <div class="audio-vu-card">
            <div class="settings-label-row">
              <div class="vu-title-group">
                <span class="settings-label">TESTE DE MICROFONE & LIMITER (-3 dB)</span>
                <span class="settings-hint">
                  {isTesting()
                    ? "Modo de Retorno Ativo: o cancelamento de eco é pausado durante o teste para não cortar a sua própria voz."
                    : "Curva quadrática com compressor dinâmico contra distorções."}
                </span>
              </div>
              <span class={`vu-db-pill ${isClipping() ? "clip" : ""}`}>
                {vuDb()} dB
              </span>
            </div>

            <div class="vu-meter-container">
              <div
                class={`vu-meter-bar ${isClipping() ? "clipping" : ""}`}
                style={{ width: `${vuPercent()}%` }}
              />
              <div class="vu-meter-threshold-marker" title="Limite Limiter (-3 dB)" />
            </div>

            <div class="vu-legend">
              <span>-60 dB (Silêncio)</span>
              <span>-18 dB (Ideal)</span>
              <span class="clip-label">-3 dB (Limiter)</span>
            </div>

            <button
              type="button"
              class={`test-mic-btn ${isTesting() ? "active" : ""}`}
              onClick={() => void toggleTest()}
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3" />
              </svg>
              <span>
                {isTesting()
                  ? "Parar Retorno do Microfone"
                  : "Testar Microfone (Ouvir Minha Voz)"}
              </span>
            </button>
          </div>
        </div>

        <div class="modal-footer">
          <button class="settings-done-btn" onClick={props.onClose}>
            Concluído
          </button>
        </div>
      </div>
    </div>
  );
};
