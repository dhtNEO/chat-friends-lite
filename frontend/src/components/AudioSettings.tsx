import {
  createSignal,
  onMount,
  onCleanup,
  For,
  type Component,
} from "solid-js";
import { updateMicGain } from "../api";
import type { MicrophoneProcessor } from "../audio/MicrophoneGain";

interface AudioSettingsProps {
  micGain: number;
  onMicGainChange: (newGain: number) => void;
  micProcessor: MicrophoneProcessor | null;
  onClose: () => void;
}

export const AudioSettings: Component<AudioSettingsProps> = (props) => {
  const [gain, setGain] = createSignal(props.micGain);
  const [audioDevices, setAudioDevices] = createSignal<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = createSignal("");
  const [isTesting, setIsTesting] = createSignal(false);
  const [vuPercent, setVuPercent] = createSignal(0);
  const [vuDb, setVuDb] = createSignal(-60);
  const [isClipping, setIsClipping] = createSignal(false);

  let testAudioEl: HTMLAudioElement | undefined;
  let rafId: number | null = null;

  onMount(async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const audioInputs = devices.filter((d) => d.kind === "audioinput");
      setAudioDevices(audioInputs);
      if (audioInputs.length > 0) {
        setSelectedDeviceId(audioInputs[0].deviceId);
      }
    } catch {
      // Dispositivos não permitidos ainda
    }

    // Loop de monitoramento do VU Meter
    const updateMeter = () => {
      if (props.micProcessor) {
        const level = props.micProcessor.getAudioLevel();
        setVuPercent(level.percent);
        setVuDb(level.db);
        setIsClipping(level.isClipping);
      }
      rafId = requestAnimationFrame(updateMeter);
    };
    rafId = requestAnimationFrame(updateMeter);
  });

  onCleanup(() => {
    if (rafId) cancelAnimationFrame(rafId);
    if (testAudioEl) {
      testAudioEl.srcObject = null;
    }
  });

  const handleGainChange = (newVal: number) => {
    setGain(newVal);
    props.onMicGainChange(newVal);
    props.micProcessor?.setGainPercent(newVal);
    void updateMicGain(newVal).catch(() => {});
  };

  const toggleTest = () => {
    if (!props.micProcessor) return;
    const next = !isTesting();
    setIsTesting(next);

    if (next) {
      const track = props.micProcessor.getProcessedTrack();
      if (track && testAudioEl) {
        testAudioEl.srcObject = new MediaStream([track]);
        void testAudioEl.play().catch(() => {});
      }
    } else if (testAudioEl) {
      testAudioEl.srcObject = null;
    }
  };

  return (
    <div class="modal-backdrop" onClick={props.onClose}>
      <div class="modal-card" onClick={(e) => e.stopPropagation()}>
        <div class="modal-header">
          <h3>Configurações de Áudio e Voz</h3>
          <button class="modal-close-btn" onClick={props.onClose}>
            ✕
          </button>
        </div>

        <div class="modal-body">
          {/* Seletor de Microfone */}
          <div class="settings-group">
            <label class="settings-label">DISPOSITIVO DE ENTRADA</label>
            <select
              class="settings-select"
              value={selectedDeviceId()}
              onChange={(e) => setSelectedDeviceId(e.currentTarget.value)}
            >
              <For each={audioDevices()}>
                {(device, idx) => (
                  <option value={device.deviceId}>
                    {device.label || `Microfone ${idx() + 1}`}
                  </option>
                )}
              </For>
            </select>
          </div>

          {/* Slider de Ganho com Limiter */}
          <div class="settings-group">
            <div class="settings-label-row">
              <span class="settings-label">GANHO DO MICROFONE (0% A 200%)</span>
              <span class="settings-value-badge">{gain()}%</span>
            </div>
            <p class="settings-hint">
              Curva perceptual quadrática com Brickwall Limiter suave em -3 dB para
              evitar distorções.
            </p>
            <input
              type="range"
              min="0"
              max="200"
              value={gain()}
              onInput={(e) => handleGainChange(Number(e.currentTarget.value))}
              class="settings-slider"
            />
          </div>

          {/* VU Meter em Tempo Real */}
          <div class="settings-group">
            <div class="settings-label-row">
              <span class="settings-label">TESTE DE MICROFONE & VU METER</span>
              <span class={`vu-db-text ${isClipping() ? "clip" : ""}`}>
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
              <span>-12 dB (Normal)</span>
              <span class="clip-label">0 dB (Pico)</span>
            </div>

            <button
              class={`test-mic-btn ${isTesting() ? "active" : ""}`}
              onClick={toggleTest}
            >
              {isTesting()
                ? "Parar Teste de Retorno"
                : "Testar Microfone (Ouvir Retorno)"}
            </button>
            <audio ref={testAudioEl} style={{ display: "none" }} />
          </div>
        </div>

        <div class="modal-footer">
          <button class="settings-done-btn" onClick={props.onClose}>
            Pronto
          </button>
        </div>
      </div>
    </div>
  );
};
