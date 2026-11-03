export type NoiseSuppressionMode = "studio" | "light" | "browser" | "off";

export interface AudioLevelTelemetry {
  percent: number;
  db: number;
  isClipping: boolean;
  gateOpen: boolean;
  reductionDb: number;
}

const NS_STORAGE_KEY = "cf_noise_suppression_mode";

export function getSavedNoiseSuppressionMode(): NoiseSuppressionMode {
  try {
    const saved = localStorage.getItem(NS_STORAGE_KEY);
    if (
      saved === "studio" ||
      saved === "light" ||
      saved === "browser" ||
      saved === "off"
    ) {
      return saved;
    }
  } catch {
    // ignore storage errors
  }
  return "studio";
}

export function saveNoiseSuppressionMode(mode: NoiseSuppressionMode): void {
  try {
    localStorage.setItem(NS_STORAGE_KEY, mode);
  } catch {
    // ignore storage errors
  }
}

/**
 * Código do AudioWorkletProcessor executado na thread de áudio dedicada.
 * Implementa:
 * 1. Filtro passa-banda interno (180 Hz - 3800 Hz) para detecção de formantes vocais
 * 2. Estimador adaptativo de piso de ruído (Minimum Statistics) que congela durante a fala
 * 3. Buffer circular de Lookahead (4 ms) para nunca cortar o início das palavras/consoantes
 * 4. Hold Timer (240 ms) + Wiener Soft Expander para nunca picotar finais de frases ou vogais longas
 * 5. Telemetria completa (RMS, dB, Peak, Clipping e Redução de Ruído) calculada na própria thread de áudio (~20 Hz),
 *    eliminando a necessidade de AnalyserNode e polling em requestAnimationFrame na thread principal!
 */
const NOISE_SUPPRESSOR_WORKLET_CODE = `
class StudioNoiseSuppressorProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.mode = "studio"; // "studio" | "light" | "browser" | "off"
    this.userGain = 1.0;
    this.noiseFloor = 0.0018; // ~ -55 dBFS inicial
    this.smoothedEnv = 0.0;
    this.voiceBandEnv = 0.0;
    this.currentGain = 1.0;
    this.holdSamples = 0;

    // Acumuladores de telemetria
    this.telemetryCounter = 0;
    this.accumPeak = 0;
    this.accumSumSq = 0;
    this.accumSamples = 0;

    // Estados do filtro IIR de detecção de voz (180 Hz - 3.8 kHz)
    this.hpStateX = 0;
    this.hpStateY = 0;
    this.lpStateY = 0;

    // Lookahead circular buffer de ~4ms (192 amostras @ 48kHz)
    this.lookaheadSize = 192;
    this.ringBufferL = new Float32Array(this.lookaheadSize);
    this.ringBufferR = new Float32Array(this.lookaheadSize);
    this.writeIndex = 0;

    this.port.onmessage = (event) => {
      if (!event.data) return;
      if (event.data.type === "SET_MODE") {
        this.mode = event.data.mode || "studio";
      } else if (event.data.type === "SET_GAIN") {
        this.userGain = typeof event.data.gain === "number" ? event.data.gain : 1.0;
      }
    };
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0 || !output || output.length === 0) {
      return true;
    }

    const inCh0 = input[0];
    const outCh0 = output[0];
    const inCh1 = input.length > 1 ? input[1] : null;
    const outCh1 = output.length > 1 ? output[1] : null;
    const frameCount = inCh0.length;

    // Se estiver em modo off ou browser, passa o sinal direto sem latência e mede nível
    if (this.mode === "off" || this.mode === "browser") {
      for (let i = 0; i < frameCount; i++) {
        const s = inCh0[i];
        outCh0[i] = s;
        if (outCh1 && inCh1) outCh1[i] = inCh1[i];
        const post = Math.abs(s * this.userGain);
        this.accumSumSq += post * post;
        if (post > this.accumPeak) this.accumPeak = post;
      }
      this.accumSamples += frameCount;
      this.currentGain = 1.0;
      this.reportTelemetry(true, 0);
      return true;
    }

    const sr = sampleRate || 48000;
    const isStudio = this.mode === "studio";

    // Parâmetros calibrados para não cortar a voz
    const snrThreshold = isStudio ? 2.4 : 1.8;
    const minGainFloor = isStudio ? 0.045 : 0.18; // -27 dB (studio) ou -15 dB (light) de redução no silêncio
    const holdDurationSamples = Math.round((isStudio ? 0.24 : 0.28) * sr); // 240ms a 280ms de hold
    const attackCoeff = 1.0 - Math.exp(-1.0 / (0.0015 * sr)); // 1.5 ms (abre quase instantaneamente)
    const releaseCoeff = 1.0 - Math.exp(-1.0 / (0.16 * sr)); // 160 ms (fecha suavemente)

    // Coeficientes dos filtros IIR do detector de voz
    const hpAlpha = 0.975; // ~190 Hz high-pass
    const lpAlpha = 0.36;  // ~3.8 kHz low-pass

    let sumSq = 0;
    let voiceSumSq = 0;

    for (let i = 0; i < frameCount; i++) {
      const s = inCh0[i];
      sumSq += s * s;

      // Filtro passa-banda focado na voz humana
      const hpOut = hpAlpha * (this.hpStateY + s - this.hpStateX);
      this.hpStateX = s;
      this.hpStateY = hpOut;
      this.lpStateY += lpAlpha * (hpOut - this.lpStateY);
      const vSample = this.lpStateY;
      voiceSumSq += vSample * vSample;
    }

    const blockRms = Math.sqrt(sumSq / frameCount);
    const voiceRms = Math.sqrt(voiceSumSq / frameCount);

    // Suavização rápida de envelope
    this.smoothedEnv = 0.65 * this.smoothedEnv + 0.35 * blockRms;
    this.voiceBandEnv = 0.65 * this.voiceBandEnv + 0.35 * voiceRms;

    // Atualização adaptativa do piso de ruído (Minimum Statistics):
    // Só adapta para cima se o sinal estiver baixo e estável (sem voz ativa)
    if (this.voiceBandEnv < this.noiseFloor * 1.65) {
      if (this.voiceBandEnv < this.noiseFloor) {
        this.noiseFloor = 0.985 * this.noiseFloor + 0.015 * this.voiceBandEnv;
      } else {
        this.noiseFloor = 0.9992 * this.noiseFloor + 0.0008 * this.voiceBandEnv;
      }
      // Limita o piso de ruído estimado entre -68 dB e -33 dB
      if (this.noiseFloor < 0.0004) this.noiseFloor = 0.0004;
      if (this.noiseFloor > 0.022) this.noiseFloor = 0.022;
    }

    // Razão Sinal-Ruído na banda de voz
    const effectiveSignal = Math.max(this.voiceBandEnv, this.smoothedEnv * 0.85);
    const snr = effectiveSignal / (this.noiseFloor + 1e-6);
    const isVoiceDetected = snr >= snrThreshold || effectiveSignal > 0.018;

    let targetGain = minGainFloor;
    if (isVoiceDetected) {
      this.holdSamples = holdDurationSamples;
      targetGain = 1.0;
    } else if (this.holdSamples > 0) {
      this.holdSamples = Math.max(0, this.holdSamples - frameCount);
      targetGain = 1.0;
    } else {
      // Curva de atenuação Wiener suave entre o limiar e o piso de ruído
      const normalized = Math.max(0, Math.min(1, (snr - 1.0) / (snrThreshold - 1.0)));
      const wiener = normalized * normalized;
      targetGain = minGainFloor + (1.0 - minGainFloor) * wiener;
    }

    // Aplica ganho com Lookahead de 4ms amostra por amostra para evitar qualquer clique
    for (let i = 0; i < frameCount; i++) {
      if (targetGain > this.currentGain) {
        this.currentGain += attackCoeff * (targetGain - this.currentGain);
      } else {
        this.currentGain += releaseCoeff * (targetGain - this.currentGain);
      }

      const delayedL = this.ringBufferL[this.writeIndex];
      this.ringBufferL[this.writeIndex] = inCh0[i];
      const outSample = delayedL * this.currentGain;
      outCh0[i] = outSample;

      const post = Math.abs(outSample * this.userGain);
      this.accumSumSq += post * post;
      if (post > this.accumPeak) this.accumPeak = post;

      if (outCh1 && inCh1) {
        const delayedR = this.ringBufferR[this.writeIndex];
        this.ringBufferR[this.writeIndex] = inCh1[i];
        outCh1[i] = delayedR * this.currentGain;
      }

      this.writeIndex = (this.writeIndex + 1) % this.lookaheadSize;
    }

    this.accumSamples += frameCount;

    const reductionDb =
      this.currentGain < 0.99
        ? Math.min(30, Math.round(-20 * Math.log10(Math.max(0.03, this.currentGain))))
        : 0;
    this.reportTelemetry(isVoiceDetected || this.holdSamples > 0, reductionDb);

    return true;
  }

  reportTelemetry(gateOpen, reductionDb) {
    this.telemetryCounter++;
    // Envia a cada 18 blocos (~48ms = ~20.8 Hz), taxa ideal para VU Meter sem sobrecarregar a UI thread
    if (this.telemetryCounter >= 18) {
      const rms = this.accumSamples > 0 ? Math.sqrt(this.accumSumSq / this.accumSamples) : 0;
      const rawDb = rms > 0.0001 ? 20 * Math.log10(rms) : -60;
      const db = Math.max(-60, Math.min(0, Math.round(rawDb)));
      const percent = Math.max(0, Math.min(100, Math.round(((db + 60) / 60) * 100)));
      const isClipping = this.accumPeak >= 0.88 || db >= -3;

      this.telemetryCounter = 0;
      this.accumPeak = 0;
      this.accumSumSq = 0;
      this.accumSamples = 0;

      this.port.postMessage({
        type: "TELEMETRY",
        gateOpen: gateOpen && db > -50,
        reductionDb,
        db,
        percent,
        isClipping,
      });
    }
  }
}

registerProcessor("studio-noise-suppressor", StudioNoiseSuppressorProcessor);
`;

export class MicrophoneProcessor {
  private ctx: AudioContext;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private highpassNode: BiquadFilterNode;
  private presenceNode: BiquadFilterNode;
  private lowpassNode: BiquadFilterNode;
  private workletNode: AudioWorkletNode | null = null;
  private workletReadyPromise: Promise<void>;
  private gainNode: GainNode;
  private limiterNode: DynamicsCompressorNode;
  private destinationNode: MediaStreamAudioDestinationNode;
  private keepAliveGainNode: GainNode;
  private monitorDelayNode: DelayNode;
  private monitorGainNode: GainNode;
  private currentStream: MediaStream | null = null;
  private noiseSuppressionMode: NoiseSuppressionMode;
  private isMonitoring = false;
  private monitorVolumePercent = 100;
  private currentGainScalar = 1.0;
  private currentDeviceId: string =
    localStorage.getItem("cf_audio_input_device") || "default";
  private latestTelemetry: AudioLevelTelemetry = {
    percent: 0,
    db: -60,
    isClipping: false,
    gateOpen: false,
    reductionDb: 0,
  };
  private telemetryListener: ((level: AudioLevelTelemetry) => void) | null =
    null;

  constructor() {
    const AudioContextClass =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    this.ctx = new AudioContextClass({
      latencyHint: "interactive",
    });

    this.noiseSuppressionMode = getSavedNoiseSuppressionMode();

    // 1. Filtros Biquad de pré-processamento vocal
    // Passa-alta em 85 Hz para remover ruído elétrico (50/60Hz), vento, cooler grave e batidas na mesa
    this.highpassNode = this.ctx.createBiquadFilter();
    this.highpassNode.type = "highpass";
    this.highpassNode.frequency.setValueAtTime(85, this.ctx.currentTime);
    this.highpassNode.Q.setValueAtTime(0.707, this.ctx.currentTime);

    // Realce sutil de presença vocal em 2.8 kHz para nitidez da fala
    this.presenceNode = this.ctx.createBiquadFilter();
    this.presenceNode.type = "peaking";
    this.presenceNode.frequency.setValueAtTime(2800, this.ctx.currentTime);
    this.presenceNode.Q.setValueAtTime(1.0, this.ctx.currentTime);
    this.presenceNode.gain.setValueAtTime(1.5, this.ctx.currentTime);

    // Passa-baixa em 14.5 kHz para eliminar chiado agudo (hiss) de placas de som/USB
    this.lowpassNode = this.ctx.createBiquadFilter();
    this.lowpassNode.type = "lowpass";
    this.lowpassNode.frequency.setValueAtTime(14500, this.ctx.currentTime);
    this.lowpassNode.Q.setValueAtTime(0.707, this.ctx.currentTime);

    // 2. Gain Node (0% a 200% com curva perceptual quadrática)
    this.gainNode = this.ctx.createGain();
    this.gainNode.gain.setValueAtTime(1.0, this.ctx.currentTime);

    // 3. DynamicsCompressorNode configurado como Brickwall Limiter suave (-3dB)
    this.limiterNode = this.ctx.createDynamicsCompressor();
    this.limiterNode.threshold.setValueAtTime(-3, this.ctx.currentTime);
    this.limiterNode.knee.setValueAtTime(6, this.ctx.currentTime);
    this.limiterNode.ratio.setValueAtTime(20, this.ctx.currentTime);
    this.limiterNode.attack.setValueAtTime(0.003, this.ctx.currentTime);
    this.limiterNode.release.setValueAtTime(0.15, this.ctx.currentTime);

    // 4. DestinationNode que fornece a track processada para transmissão
    this.destinationNode = this.ctx.createMediaStreamDestination();

    // 5. Nó silencioso conectado ao destination principal para manter o clock
    // do Web Audio ativo no Safari/WebKit e Firefox
    this.keepAliveGainNode = this.ctx.createGain();
    this.keepAliveGainNode.gain.setValueAtTime(0, this.ctx.currentTime);

    // 6. Monitoramento Direto (Self-Test) dentro do Web Audio API:
    // Usa um micro-delay de 35ms para evitar cancelamento de fase com a condução óssea
    // e não passar por elementos <audio> externos que ativam o corte do AEC do navegador.
    this.monitorDelayNode = this.ctx.createDelay(0.2);
    this.monitorDelayNode.delayTime.setValueAtTime(0.035, this.ctx.currentTime);
    this.monitorGainNode = this.ctx.createGain();
    this.monitorGainNode.gain.setValueAtTime(0, this.ctx.currentTime);

    // Conexão inicial (antes do Worklet terminar de carregar, conecta direto)
    this.highpassNode.connect(this.presenceNode);
    this.presenceNode.connect(this.lowpassNode);
    this.lowpassNode.connect(this.gainNode);
    this.gainNode.connect(this.limiterNode);
    this.limiterNode.connect(this.destinationNode);
    this.limiterNode.connect(this.keepAliveGainNode);
    this.keepAliveGainNode.connect(this.ctx.destination);

    // Caminho de retorno de teste (Self-Monitor)
    this.limiterNode.connect(this.monitorDelayNode);
    this.monitorDelayNode.connect(this.monitorGainNode);
    this.monitorGainNode.connect(this.ctx.destination);

    this.applyFilterTuning(this.noiseSuppressionMode);
    this.workletReadyPromise = this.initNoiseSuppressorWorklet();

    // No Safari, o getUserMedia pode colocar o AudioContext em estado "interrupted" ou "suspended"
    this.ctx.onstatechange = () => {
      const state = this.ctx.state as string;
      if (state === "suspended" || state === "interrupted") {
        void this.ctx.resume().catch(() => {});
      }
    };
  }

  private async initNoiseSuppressorWorklet(): Promise<void> {
    if (!this.ctx.audioWorklet) return;
    try {
      const blob = new Blob([NOISE_SUPPRESSOR_WORKLET_CODE], {
        type: "application/javascript",
      });
      const url = URL.createObjectURL(blob);
      try {
        await this.ctx.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }

      if ((this.ctx.state as string) === "closed") return;

      this.workletNode = new AudioWorkletNode(
        this.ctx,
        "studio-noise-suppressor",
      );
      this.workletNode.port.postMessage({
        type: "SET_MODE",
        mode: this.noiseSuppressionMode,
      });
      this.workletNode.port.postMessage({
        type: "SET_GAIN",
        gain: this.currentGainScalar,
      });
      this.workletNode.port.onmessage = (e) => {
        if (e.data && e.data.type === "TELEMETRY") {
          this.latestTelemetry = {
            percent: Number(e.data.percent) || 0,
            db: typeof e.data.db === "number" ? e.data.db : -60,
            isClipping: Boolean(e.data.isClipping),
            gateOpen: Boolean(e.data.gateOpen),
            reductionDb: Number(e.data.reductionDb) || 0,
          };
          this.telemetryListener?.(this.latestTelemetry);
        }
      };

      // Insere o AudioWorkletNode entre lowpassNode e gainNode
      this.lowpassNode.disconnect();
      this.lowpassNode.connect(this.workletNode);
      this.workletNode.connect(this.gainNode);
    } catch {
      // Fallback seguro: mantém a cadeia de filtros Biquad ativa mesmo se AudioWorklet falhar
    }
  }

  public setTelemetryListener(
    listener: ((level: AudioLevelTelemetry) => void) | null,
  ): void {
    this.telemetryListener = listener;
  }

  private applyFilterTuning(mode: NoiseSuppressionMode): void {
    const now = this.ctx.currentTime;
    if (mode === "studio") {
      this.highpassNode.frequency.setTargetAtTime(85, now, 0.015);
      this.presenceNode.gain.setTargetAtTime(1.6, now, 0.015);
      this.lowpassNode.frequency.setTargetAtTime(14500, now, 0.015);
    } else if (mode === "light") {
      this.highpassNode.frequency.setTargetAtTime(70, now, 0.015);
      this.presenceNode.gain.setTargetAtTime(0.8, now, 0.015);
      this.lowpassNode.frequency.setTargetAtTime(16000, now, 0.015);
    } else {
      // "browser" ou "off": filtros transparentes
      this.highpassNode.frequency.setTargetAtTime(20, now, 0.015);
      this.presenceNode.gain.setTargetAtTime(0, now, 0.015);
      this.lowpassNode.frequency.setTargetAtTime(20000, now, 0.015);
    }
  }

  public getMediaTrackConstraints(
    deviceId?: string,
    forMonitoring = this.isMonitoring,
  ): MediaTrackConstraints {
    const targetDevice = deviceId ?? this.currentDeviceId;
    const useNativeNs =
      !forMonitoring && this.noiseSuppressionMode === "browser";
    // Durante o autoteste de microfone (forMonitoring = true), desativamos o echoCancellation
    // nativo do navegador/OS para que o VoiceProcessingIO (Safari/macOS) e o WebRTC APM (Chrome)
    // NÃO confundam a sua própria voz saindo no fone com eco e cortem o som após a primeira sílaba!
    const useEchoCancellation = !forMonitoring;

    return {
      deviceId:
        targetDevice && targetDevice !== "default"
          ? { ideal: targetDevice }
          : undefined,
      echoCancellation: useEchoCancellation,
      noiseSuppression: useNativeNs,
      autoGainControl: false,
      channelCount: 1,
    };
  }

  public async acquireAndSetStream(deviceId?: string): Promise<MediaStreamTrack> {
    if (deviceId !== undefined) {
      this.currentDeviceId = deviceId;
    }
    const constraints = this.getMediaTrackConstraints(
      this.currentDeviceId,
      this.isMonitoring,
    );
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: constraints,
    });
    return this.setSourceStream(stream);
  }

  public resume(): void {
    const state = this.ctx.state as string;
    if (state !== "running" && state !== "closed") {
      void this.ctx.resume().catch(() => {});
    }
  }

  public async setSourceStream(stream: MediaStream): Promise<MediaStreamTrack> {
    if ((this.ctx.state as string) !== "running") {
      await this.ctx.resume().catch(() => {});
    }
    await this.workletReadyPromise;

    if (this.sourceNode) {
      this.sourceNode.disconnect();
    }
    if (this.currentStream && this.currentStream !== stream) {
      this.currentStream.getTracks().forEach((t) => t.stop());
    }

    this.currentStream = stream;
    this.sourceNode = this.ctx.createMediaStreamSource(stream);
    this.sourceNode.connect(this.highpassNode);

    const processedTrack = this.destinationNode.stream.getAudioTracks()[0];
    processedTrack.enabled = true;
    return processedTrack;
  }

  public getNoiseSuppressionMode(): NoiseSuppressionMode {
    return this.noiseSuppressionMode;
  }

  public async setNoiseSuppressionMode(
    mode: NoiseSuppressionMode,
  ): Promise<void> {
    const prevMode = this.noiseSuppressionMode;
    this.noiseSuppressionMode = mode;
    saveNoiseSuppressionMode(mode);
    this.applyFilterTuning(mode);

    if (this.workletNode) {
      this.workletNode.port.postMessage({
        type: "SET_MODE",
        mode,
      });
    }

    // Se alternou de/para o modo "browser", atualiza as constraints da track de hardware
    if (
      this.currentStream &&
      (prevMode === "browser" || mode === "browser")
    ) {
      try {
        await this.acquireAndSetStream(this.currentDeviceId);
      } catch {
        const rawTrack = this.currentStream.getAudioTracks()[0];
        if (rawTrack?.applyConstraints) {
          void rawTrack
            .applyConstraints(
              this.getMediaTrackConstraints(
                this.currentDeviceId,
                this.isMonitoring,
              ),
            )
            .catch(() => {});
        }
      }
    }
  }

  public async setMonitoring(
    enabled: boolean,
    outputVolumePercent = 100,
    sinkId?: string,
  ): Promise<void> {
    this.resume();
    const stateChanged = this.isMonitoring !== enabled;
    this.isMonitoring = enabled;
    this.monitorVolumePercent = outputVolumePercent;

    if (sinkId !== undefined) {
      await this.setMonitorSinkId(sinkId);
    }

    // Quando o usuário ativa ou desativa o teste de microfone, reconfiguramos o stream
    // sem echoCancellation durante o teste para evitar que o navegador corte a voz após o início
    if (stateChanged && this.currentStream) {
      try {
        await this.acquireAndSetStream(this.currentDeviceId);
      } catch {
        const rawTrack = this.currentStream.getAudioTracks()[0];
        if (rawTrack?.applyConstraints) {
          void rawTrack
            .applyConstraints(
              this.getMediaTrackConstraints(this.currentDeviceId, enabled),
            )
            .catch(() => {});
        }
      }
    }

    const gainValue = enabled
      ? Math.max(0, Math.min(2.0, outputVolumePercent / 100))
      : 0;
    this.monitorGainNode.gain.setTargetAtTime(
      gainValue,
      this.ctx.currentTime,
      0.015,
    );
  }

  public setMonitorVolume(outputVolumePercent: number): void {
    this.monitorVolumePercent = outputVolumePercent;
    if (this.isMonitoring) {
      const gainValue = Math.max(0, Math.min(2.0, outputVolumePercent / 100));
      this.monitorGainNode.gain.setTargetAtTime(
        gainValue,
        this.ctx.currentTime,
        0.015,
      );
    }
  }

  public async setMonitorSinkId(deviceId: string): Promise<void> {
    const ctxWithSink = this.ctx as AudioContext & {
      setSinkId?: (id: string) => Promise<void>;
    };
    if (typeof ctxWithSink.setSinkId === "function") {
      try {
        await ctxWithSink.setSinkId(deviceId === "default" ? "" : deviceId);
      } catch {
        // Ignora se o navegador não suportar setSinkId no AudioContext
      }
    }
  }

  public setGainPercent(percent: number): void {
    const clamped = Math.max(0, Math.min(200, percent));
    // Curva perceptual quadrática: 50% = 0.25x, 100% = 1.0x, 200% = 4.0x
    const gainValue = Math.pow(clamped / 100, 2);
    this.currentGainScalar = gainValue;
    this.gainNode.gain.setTargetAtTime(gainValue, this.ctx.currentTime, 0.015);
    this.workletNode?.port.postMessage({
      type: "SET_GAIN",
      gain: gainValue,
    });
  }

  public getAudioLevel(): AudioLevelTelemetry {
    return this.latestTelemetry;
  }

  public getProcessedTrack(): MediaStreamTrack | null {
    const tracks = this.destinationNode.stream.getAudioTracks();
    return tracks.length > 0 ? tracks[0] : null;
  }

  public cleanup(): void {
    this.isMonitoring = false;
    this.telemetryListener = null;
    this.ctx.onstatechange = null;
    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }
    if (this.workletNode) {
      this.workletNode.port.onmessage = null;
      this.workletNode.disconnect();
      this.workletNode = null;
    }
    if (this.currentStream) {
      this.currentStream.getTracks().forEach((track) => track.stop());
      this.currentStream = null;
    }
    if ((this.ctx.state as string) !== "closed") {
      void this.ctx.close().catch(() => {});
    }
  }
}
