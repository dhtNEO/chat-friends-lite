import { audioEngine } from "./AudioEngine";

const bufferCache = new Map<string, AudioBuffer>();

async function playCachedSound(url: string, fallbackFreqs: number[]): Promise<void> {
  try {
    const ctx = audioEngine.getContext();
    let buffer = bufferCache.get(url);

    if (!buffer) {
      const resp = await fetch(url);
      if (resp.ok) {
        const arrayBuf = await resp.arrayBuffer();
        buffer = await ctx.decodeAudioData(arrayBuf);
        bufferCache.set(url, buffer);
      }
    }

    if (buffer) {
      const source = ctx.createBufferSource();
      const gain = ctx.createGain();
      source.buffer = buffer;
      gain.gain.setValueAtTime(0.55, ctx.currentTime);
      source.connect(gain);
      gain.connect(audioEngine.getMasterGain());
      source.start(0);
      return;
    }
  } catch {
    // Fallback para síntese leve se o arquivo não existir ou falhar
  }
  playToneSequence(fallbackFreqs, 0.18, "sine", 0.14);
}

export function playJoinSound(): void {
  void playCachedSound("/sounds/entrar.mp3", [440, 587.33]);
}

export function playLeaveSound(): void {
  void playCachedSound("/sounds/sair.mp3", [523.25, 349.23]);
}

function playToneSequence(
  frequencies: number[],
  duration: number,
  type: OscillatorType = "sine",
  volume = 0.15,
): void {
  try {
    const ctx = audioEngine.getContext();
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = type;
    gain.gain.setValueAtTime(volume, now);

    const stepTime = duration / frequencies.length;
    frequencies.forEach((freq, idx) => {
      osc.frequency.setValueAtTime(freq, now + idx * stepTime);
    });

    gain.gain.setValueAtTime(volume, now + duration * 0.7);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    osc.connect(gain);
    // Conecta diretamente no ctx.destination para que os bipes de mute/deafen ainda sejam ouvidos pelo próprio usuário ao desativar o áudio
    gain.connect(ctx.destination);

    osc.start(now);
    osc.stop(now + duration);
  } catch {
    // Falha silenciosa
  }
}

export function playMute(): void {
  // Tom duplo descendente suave (estilo Discord)
  playToneSequence([480, 360], 0.14, "sine", 0.16);
}

export function playUnmute(): void {
  // Tom duplo ascendente suave
  playToneSequence([360, 540], 0.14, "sine", 0.16);
}

export function playDeafen(): void {
  // Tom grave descendente
  playToneSequence([380, 240], 0.18, "triangle", 0.18);
}

export function playUndeafen(): void {
  // Tom agudo ascendente
  playToneSequence([260, 480], 0.18, "triangle", 0.18);
}

export function playStreamStart(): void {
  // Acorde triadico ascendente
  playToneSequence([440, 554, 659], 0.22, "sine", 0.15);
}

export function playStreamStop(): void {
  // Tom curto descendente
  playToneSequence([554, 440], 0.15, "sine", 0.15);
}
