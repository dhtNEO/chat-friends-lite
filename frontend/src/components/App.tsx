import {
  createSignal,
  createEffect,
  onMount,
  onCleanup,
  For,
  Show,
  type Component,
} from "solid-js";
import {
  Room,
  RoomEvent,
  ParticipantEvent,
  Track,
  VideoQuality,
  RemoteParticipant,
  type RemoteTrackPublication,
} from "livekit-client";
import {
  getMe,
  logout,
  getMessages,
  sendMessage,
  toggleMessageReaction,
  getMediaToken,
  connectWebSocket,
  type User,
  type ChatMessage,
} from "../api";
import { audioEngine } from "../audio/AudioEngine";
import { MicrophoneProcessor } from "../audio/MicrophoneGain";
import {
  playJoinSound,
  playLeaveSound,
  playMute,
  playUnmute,
  playDeafen,
  playUndeafen,
  playStreamStart,
  playStreamStop,
} from "../audio/SoundEffects";
import { AuthModal } from "./AuthModal";
import { AudioSettings } from "./AudioSettings";

interface ParticipantState {
  identity: string;
  displayName: string;
  avatarColor: string;
  isSpeaking: boolean;
  isMuted: boolean;
  isScreenSharing: boolean;
  screenPublication?: RemoteTrackPublication;
}

interface WatchedStream {
  identity: string; // "__local__" para a própria transmissão, ou identity do participante
  displayName: string;
  avatarColor: string;
  isLocal: boolean;
  publication?: RemoteTrackPublication;
  mediaStream?: MediaStream;
}

const LOCAL_STREAM_ID = "__local__";

export const App: Component = () => {
  const [currentUser, setCurrentUser] = createSignal<User | null>(null);
  const [authLoading, setAuthLoading] = createSignal(true);
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const [chatOpen, setChatOpen] = createSignal(true);

  // Estados de Chamada e Mídia
  const [inCall, setInCall] = createSignal(false);
  const [connecting, setConnecting] = createSignal(false);
  const [isMicMuted, setIsMicMuted] = createSignal(false);
  const [isLocalSpeaking, setIsLocalSpeaking] = createSignal(false);
  const [isDeafened, setIsDeafened] = createSignal(false);
  const [isScreenSharing, setIsScreenSharing] = createSignal(false);
  const [screenQualityModal, setScreenQualityModal] = createSignal(false);

  // Participantes e Telas (Suporte a Múltiplas Transmissões Simultâneas + Própria Tela)
  const [participants, setParticipants] = createSignal<ParticipantState[]>([]);
  const [expandedVolumeUser, setExpandedVolumeUser] = createSignal<string | null>(
    null,
  );
  const [participantVolumes, setParticipantVolumes] = createSignal<
    Record<string, number>
  >({});
  const [watchedStreams, setWatchedStreams] = createSignal<WatchedStream[]>([]);
  const [focusedStreamId, setFocusedStreamId] = createSignal<string | null>(
    null,
  );
  const [pipStreamId, setPipStreamId] = createSignal<string | null>(null);
  const [isPageHidden, setIsPageHidden] = createSignal(false);

  // Chat
  const [messages, setMessages] = createSignal<ChatMessage[]>([]);
  const [chatInput, setChatInput] = createSignal("");
  const [pendingImage, setPendingImage] = createSignal<string | null>(null);
  const [lightboxImage, setLightboxImage] = createSignal<string | null>(null);
  const [onlineUsernames, setOnlineUsernames] = createSignal<string[]>([]);
  let chatEndRef: HTMLDivElement | undefined;
  let fileInputRef: HTMLInputElement | undefined;
  const videoRefsMap = new Map<string, HTMLVideoElement>();
  const canvasCleanupMap = new Map<string, () => void>();
  const mockStreamsMap = new Map<
    string,
    { stream: MediaStream; cleanup: () => void }
  >();

  const QUICK_EMOJIS = ["👍", "❤️", "😂", "🔥", "😮", "🎉", "👀", "🚀"];

  // Processador de Microfone Local
  let micProcessor: MicrophoneProcessor | null = null;
  let room: Room | null = null;
  let wsCloser: { close: () => void } | null = null;
  let localScreenStream: MediaStream | null = null;
  let localPreviewStream: MediaStream | null = null;
  let speakingInterval: number | null = null;
  let micMutedBeforeDeafen = false;

  onMount(async () => {
    const handleVisibilityChange = () => {
      const hidden = document.hidden;
      setIsPageHidden(hidden);
      // Quando o usuário volta para a aba (ou fecha o seletor de janelas do sistema),
      // garante que todos os elementos de vídeo ativos voltem a reproduzir sem tela preta
      if (!hidden) {
        videoRefsMap.forEach((videoEl) => {
          if (videoEl.paused) {
            void videoEl.play().catch(() => {});
          }
        });
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    onCleanup(() => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    });

    try {
      const data = await getMe();
      setCurrentUser(data.user);
      audioEngine.initPreferences(data.audio_preferences);
      void loadMessages();
      setupWebSocket();
    } catch {
      // Usuário não autenticado
    } finally {
      setAuthLoading(false);
    }
  });

  // Gerenciamento dinâmico de resolução/qualidade (Simulcast) das lives assistidas
  // para minimizar uso de GPU e banda no modo Mosaico, Destaque ou Aba em Segundo Plano
  createEffect(() => {
    const streams = watchedStreams();
    const focused = focusedStreamId();
    const activePip = pipStreamId();
    const hidden = isPageHidden();
    const totalCount = streams.length;

    for (const s of streams) {
      if (!s.publication) continue;
      // Se esta live estiver em Picture-in-Picture (PiP), mantém qualidade ALTA mesmo com aba oculta
      if (activePip === s.identity) {
        s.publication.setVideoQuality(VideoQuality.HIGH);
      } else if (hidden) {
        s.publication.setVideoQuality(VideoQuality.LOW);
      } else if (totalCount === 1 || focused === s.identity) {
        s.publication.setVideoQuality(VideoQuality.HIGH);
      } else if (focused !== null) {
        // Miniatura secundária no modo Destaque
        s.publication.setVideoQuality(VideoQuality.LOW);
      } else if (totalCount === 2) {
        s.publication.setVideoQuality(VideoQuality.MEDIUM);
      } else {
        // Grade com 3 ou mais transmissões simultâneas
        s.publication.setVideoQuality(VideoQuality.LOW);
      }
    }
  });

  onCleanup(() => {
    disconnectCall();
    wsCloser?.close();
    micProcessor?.cleanup();
    audioEngine.cleanup();
  });

  const loadMessages = async () => {
    try {
      const msgs = await getMessages(undefined, 50);
      setMessages(msgs);
      scrollToBottom();
    } catch {
      // Falha ao obter histórico
    }
  };

  const setupWebSocket = () => {
    wsCloser?.close();
    wsCloser = connectWebSocket((data) => {
      if (data.type === "chat_message" && data.message) {
        setMessages((prev) => [...prev, data.message!]);
        scrollToBottom();
      } else if (
        data.type === "message_reactions" &&
        data.message_id !== undefined &&
        data.reactions
      ) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === data.message_id ? { ...m, reactions: data.reactions } : m,
          ),
        );
      } else if (data.type === "presence" && data.users) {
        setOnlineUsernames(data.users);
      }
    });
  };

  const scrollToBottom = () => {
    setTimeout(() => {
      chatEndRef?.scrollIntoView({ behavior: "smooth" });
    }, 50);
  };

  // Conectar à sala LiveKit
  const joinCall = async () => {
    if (inCall() || connecting()) return;
    setConnecting(true);

    // Importante para Safari/WebKit: instanciar e resumir os AudioContexts
    // de forma síncrona dentro do evento de clique antes do primeiro await
    audioEngine.resumeContext();
    micProcessor?.cleanup();
    micProcessor = new MicrophoneProcessor();
    micProcessor.resume();
    micProcessor.setGainPercent(currentUser()?.mic_gain ?? 100);

    try {
      const { token, url } = await getMediaToken();

      // Solicita acesso ao microfone usando o pipeline DSP de supressão de ruído configurado
      const savedInputId =
        localStorage.getItem("cf_audio_input_device") || "default";
      const processedAudioTrack =
        await micProcessor.acquireAndSetStream(savedInputId);
      audioEngine.resumeContext();

      // Modo de preview local (mock server do Vite)
      if (url.includes("demo.invalid")) {
        setInCall(true);
        playJoinSound();
        setParticipants([
          {
            identity: "galecalol",
            displayName: "Galeca",
            avatarColor: "#57F287",
            isSpeaking: false,
            isMuted: false,
            isScreenSharing: true,
          },
          {
            identity: "penumbra",
            displayName: "Penumbra",
            avatarColor: "#EB459E",
            isSpeaking: false,
            isMuted: true,
            isScreenSharing: false,
          },
          {
            identity: "vgeralt",
            displayName: "Geralt",
            avatarColor: "#FEE75C",
            isSpeaking: false,
            isMuted: false,
            isScreenSharing: true,
          },
        ]);
        if (speakingInterval) clearInterval(speakingInterval);
        speakingInterval = window.setInterval(() => {
          if (micProcessor && !isMicMuted()) {
            const { db } = micProcessor.getAudioLevel();
            setIsLocalSpeaking(db > -42);
          } else {
            setIsLocalSpeaking(false);
          }
        }, 100);
        return;
      }

      // Instancia a sala LiveKit com controle manual de inscrição, Opus DTX/RED e Simulcast
      // (adaptiveStream desativado pois gerenciamos VideoQuality manualmente com suporte a PiP e Mosaico)
      room = new Room({
        adaptiveStream: false,
        dynacast: true,
        publishDefaults: {
          dtx: true,
          red: true,
          simulcast: true,
        },
      });

      // Eventos de Tracks Remotos
      room.on(RoomEvent.TrackPublished, (publication, participant) => {
        // Áudio de microfone: inscrição automática
        if (publication.source === Track.Source.Microphone) {
          void publication.setSubscribed(true);
        }
        // Vídeo e áudio de tela: NUNCA subscrever automaticamente (Opt-in)
        if (
          publication.source === Track.Source.ScreenShare ||
          publication.source === Track.Source.ScreenShareAudio
        ) {
          void publication.setSubscribed(false);
          updateParticipantScreenStatus(participant.identity, true, publication);
        }
        syncParticipantState(participant);
      });

      room.on(RoomEvent.TrackUnpublished, (publication, participant) => {
        if (publication.source === Track.Source.ScreenShare) {
          updateParticipantScreenStatus(participant.identity, false, undefined);
          if (isStreamWatched(participant.identity)) {
            stopWatchingStream(participant.identity);
          }
        }
        syncParticipantState(participant);
      });

      room.on(RoomEvent.TrackMuted, (_publication, participant) => {
        if (participant instanceof RemoteParticipant) {
          syncParticipantState(participant);
        }
      });

      room.on(RoomEvent.TrackUnmuted, (_publication, participant) => {
        if (participant instanceof RemoteParticipant) {
          syncParticipantState(participant);
        }
      });

      room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
        if (track.kind === "audio") {
          const isScreen =
            publication.source === Track.Source.ScreenShareAudio;
          audioEngine.attachRemoteTrack(
            track.mediaStreamTrack,
            participant.identity,
            isScreen ? "screen" : "voice",
          );
        } else if (track.kind === "video") {
          const newMediaStream = new MediaStream([track.mediaStreamTrack]);
          // Atualiza o mediaStream sem recriar a referência do objeto em watchedStreams,
          // preservando o elemento <video> já montado no DOM (e eventual janela PiP ativa)
          const existingEntry = watchedStreams().find(
            (s) => s.identity === participant.identity,
          );
          if (existingEntry) {
            existingEntry.mediaStream = newMediaStream;
          }
          const targetVideo = videoRefsMap.get(participant.identity);
          if (targetVideo) {
            targetVideo.muted = true;
            track.attach(targetVideo);
            void targetVideo.play().catch(() => {});
          }
        }
        syncParticipantState(participant);
      });

      room.on(RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
        if (track.kind === "audio") {
          const isScreen =
            publication.source === Track.Source.ScreenShareAudio;
          audioEngine.detachRemoteTrack(
            track.mediaStreamTrack,
            participant.identity,
            isScreen ? "screen" : "voice",
          );
        } else if (track.kind === "video") {
          const targetVideo = videoRefsMap.get(participant.identity);
          if (targetVideo) {
            track.detach(targetVideo);
          }
        }
        syncParticipantState(participant);
      });

      room.on(RoomEvent.ParticipantConnected, (participant) => {
        playJoinSound();
        syncParticipantState(participant);
      });

      room.on(RoomEvent.ParticipantDisconnected, (participant) => {
        playLeaveSound();
        removeParticipantFromList(participant.identity);
        if (isStreamWatched(participant.identity)) {
          stopWatchingStream(participant.identity);
        }
      });

      room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
        const speakingSet = new Set(speakers.map((s) => s.identity));
        const localIdentity = room?.localParticipant.identity;
        if (localIdentity) {
          setIsLocalSpeaking(!isMicMuted() && speakingSet.has(localIdentity));
        }
        setParticipants((prev) =>
          prev.map((p) => ({
            ...p,
            isSpeaking: !p.isMuted && speakingSet.has(p.identity),
          })),
        );
      });

      // Conexão LiveKit com autoSubscribe: false
      await room.connect(url, token, { autoSubscribe: false });

      room.localParticipant.on(
        ParticipantEvent.IsSpeakingChanged,
        (speaking: boolean) => {
          setIsLocalSpeaking(!isMicMuted() && speaking);
        },
      );

      // Publica track de microfone calibrado
      const localMicPub = await room.localParticipant.publishTrack(
        processedAudioTrack,
        {
          source: Track.Source.Microphone,
        },
      );
      if (isMicMuted()) {
        processedAudioTrack.enabled = false;
        await localMicPub.mute();
      }

      // Popula participantes já presentes
      room.remoteParticipants.forEach((p) => {
        syncParticipantState(p);
        p.trackPublications.forEach((pub) => {
          if (pub.source === Track.Source.Microphone) {
            void pub.setSubscribed(true);
          } else if (pub.source === Track.Source.ScreenShare) {
            updateParticipantScreenStatus(p.identity, true, pub);
          }
        });
      });

      setInCall(true);
    } catch (err) {
      console.error("Erro ao conectar ao LiveKit:", err);
      micProcessor?.cleanup();
      micProcessor = null;
      room?.disconnect();
      room = null;
    } finally {
      setConnecting(false);
    }
  };

  const disconnectCall = () => {
    if (!inCall()) return;
    if (speakingInterval) {
      clearInterval(speakingInterval);
      speakingInterval = null;
    }
    playLeaveSound();
    stopWatchingAllStreams();
    localPreviewStream?.getTracks().forEach((t) => t.stop());
    localPreviewStream = null;
    localScreenStream?.getTracks().forEach((t) => t.stop());
    localScreenStream = null;
    room?.disconnect();
    micProcessor?.cleanup();
    micProcessor = null;
    room = null;
    setInCall(false);
    setIsLocalSpeaking(false);
    setIsScreenSharing(false);
    setParticipants([]);
  };

  const syncParticipantState = (p: RemoteParticipant) => {
    const pubs = Array.from(p.trackPublications.values());
    const micPub = pubs.find((pub) => pub.source === Track.Source.Microphone);
    const screenPub = pubs.find(
      (pub) => pub.source === Track.Source.ScreenShare,
    );
    const isMuted = micPub ? micPub.isMuted : false;

    setParticipants((prev) => {
      const existing = prev.find((item) => item.identity === p.identity);
      const nextState: ParticipantState = {
        identity: p.identity,
        displayName: p.name || p.identity,
        avatarColor: existing?.avatarColor || "#5865F2",
        isSpeaking: !isMuted && p.isSpeaking,
        isMuted,
        isScreenSharing: Boolean(screenPub),
        screenPublication: screenPub,
      };
      if (existing) {
        return prev.map((item) =>
          item.identity === p.identity ? nextState : item,
        );
      }
      return [...prev, nextState];
    });
  };

  const getParticipantVol = (
    identity: string,
    streamType: "voice" | "screen" = "voice",
  ): number => {
    const key = `${identity.toLowerCase()}:${streamType}`;
    const reactiveVal = participantVolumes()[key];
    if (reactiveVal !== undefined) return reactiveVal;
    return audioEngine.getVolume(identity, streamType);
  };

  const setParticipantVol = (
    identity: string,
    streamType: "voice" | "screen",
    val: number,
  ) => {
    const clamped =
      streamType === "screen"
        ? Math.max(0, Math.min(100, Math.round(val)))
        : Math.max(0, Math.min(200, Math.round(val)));
    const key = `${identity.toLowerCase()}:${streamType}`;
    setParticipantVolumes((prev) => ({ ...prev, [key]: clamped }));
    audioEngine.setVolume(identity, streamType, clamped);
  };

  const toggleParticipantQuickMute = (
    identity: string,
    streamType: "voice" | "screen" = "voice",
  ) => {
    const current = getParticipantVol(identity, streamType);
    if (current > 0) {
      setParticipantVol(identity, streamType, 0);
    } else {
      setParticipantVol(identity, streamType, 100);
    }
  };

  const removeParticipantFromList = (identity: string) => {
    setParticipants((prev) => prev.filter((p) => p.identity !== identity));
  };

  const updateParticipantScreenStatus = (
    identity: string,
    isSharing: boolean,
    pub?: RemoteTrackPublication,
  ) => {
    setParticipants((prev) =>
      prev.map((p) =>
        p.identity === identity
          ? { ...p, isScreenSharing: isSharing, screenPublication: pub }
          : p,
      ),
    );
  };

  const applyMicMute = async (muted: boolean) => {
    setIsMicMuted(muted);
    if (muted) {
      setIsLocalSpeaking(false);
    }

    const processedTrack = micProcessor?.getProcessedTrack();
    if (processedTrack) {
      processedTrack.enabled = !muted;
    }

    if (room) {
      const micPub = room.localParticipant.getTrackPublication(
        Track.Source.Microphone,
      );
      if (micPub) {
        if (muted) {
          await micPub.mute();
        } else {
          await micPub.unmute();
        }
      }
    }
  };

  // Mute / Unmute
  const toggleMute = async () => {
    const next = !isMicMuted();
    if (!next && isDeafened()) {
      // Se estava com áudio desativado e clicou para ativar o microfone, reativa o áudio também
      setIsDeafened(false);
      audioEngine.setDeafened(false);
    }
    await applyMicMute(next);
    if (next) {
      playMute();
    } else {
      playUnmute();
    }
  };

  // Deafen / Undeafen (sempre muta o microfone junto ao silenciar o áudio)
  const toggleDeafen = async () => {
    const next = !isDeafened();
    setIsDeafened(next);
    audioEngine.setDeafened(next);
    if (next) {
      micMutedBeforeDeafen = isMicMuted();
      await applyMicMute(true);
      playDeafen();
    } else {
      if (!micMutedBeforeDeafen) {
        await applyMicMute(false);
      }
      playUndeafen();
    }
  };

  // Compartilhamento de Tela com Presets
  const startScreenShare = async (preset: "720p" | "1080p") => {
    setScreenQualityModal(false);

    const videoConstraints =
      preset === "720p"
        ? { width: 1280, height: 720, frameRate: 30 }
        : { width: 1920, height: 1080, frameRate: 60 };

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: videoConstraints,
        audio: true,
      });
    } catch (err: any) {
      // Caso o sistema/navegador não suporte captura de áudio de tela mas o usuário não tenha cancelado, tenta apenas vídeo
      if (err?.name === "NotAllowedError" || err?.name === "AbortError") {
        return;
      }
      try {
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: videoConstraints,
          audio: false,
        });
      } catch {
        return;
      }
    }

    const videoTrack = stream.getVideoTracks()[0];
    const audioTrack = stream.getAudioTracks()[0];
    if (!videoTrack) return;

    videoTrack.enabled = true;
    videoTrack.contentHint = preset === "720p" ? "detail" : "motion";
    localScreenStream = stream;

    // Cria um MediaStream contendo apenas a track de vídeo original (sem track de áudio no elemento <video>)
    // para garantir autoplay imediato sem bloqueio de política de mídia e sem bug de clone() no WebKit/macOS
    localPreviewStream = new MediaStream([videoTrack]);

    setIsScreenSharing(true);
    playStreamStart();

    // Abre imediatamente o preview da própria transmissão
    watchOwnStream();

    videoTrack.addEventListener("ended", () => {
      void stopScreenShare();
    });

    if (room) {
      try {
        const videoPub = await room.localParticipant.publishTrack(videoTrack, {
          source: Track.Source.ScreenShare,
          simulcast: true,
          screenShareEncoding:
            preset === "720p"
              ? { maxBitrate: 1_500_000, maxFramerate: 30 }
              : { maxBitrate: 3_500_000, maxFramerate: 60 },
        });

        const localVideoEl = videoRefsMap.get(LOCAL_STREAM_ID);
        if (localVideoEl && videoPub?.videoTrack) {
          localVideoEl.muted = true;
          videoPub.videoTrack.attach(localVideoEl);
        }

        if (audioTrack) {
          await room.localParticipant.publishTrack(audioTrack, {
            source: Track.Source.ScreenShareAudio,
            dtx: true,
          });
        }
      } catch (pubErr) {
        console.error("Erro ao publicar transmissão no LiveKit:", pubErr);
      }
    }

    // Garante que o elemento <video> do preview local esteja reproduzindo após a conclusão da negociação
    const localVideoEl = videoRefsMap.get(LOCAL_STREAM_ID);
    if (localVideoEl && localPreviewStream) {
      if (!localVideoEl.srcObject) {
        localVideoEl.srcObject = localPreviewStream;
      }
      localVideoEl.muted = true;
      void localVideoEl.play().catch(() => {});
    }
  };

  const stopScreenShare = async () => {
    if (!isScreenSharing()) return;

    stopWatchingStream(LOCAL_STREAM_ID);

    localPreviewStream = null;
    if (localScreenStream) {
      localScreenStream.getTracks().forEach((t) => t.stop());
      localScreenStream = null;
    }

    if (room) {
      const pubs = Array.from(
        room.localParticipant.trackPublications.values(),
      ).filter(
        (p) =>
          p.source === Track.Source.ScreenShare ||
          p.source === Track.Source.ScreenShareAudio,
      );

      for (const pub of pubs) {
        if (pub.track) {
          pub.track.stop();
          await room.localParticipant.unpublishTrack(pub.track);
        }
      }
    }

    setIsScreenSharing(false);
    playStreamStop();
  };

  const createMockLiveStream = (displayName: string, accentColor = "#57F287") => {
    const canvas = document.createElement("canvas");
    canvas.width = 1280;
    canvas.height = 720;
    const ctx = canvas.getContext("2d");
    const startTime = performance.now();
    let rafId = 0;

    const renderFrame = (now: number) => {
      if (!ctx) return;
      const elapsed = (now - startTime) / 1000;

      // Fundo gradiente estilo gameplay / cyber arena
      const grad = ctx.createLinearGradient(0, 0, 1280, 720);
      grad.addColorStop(0, "#0f1021");
      grad.addColorStop(0.5, "#1b1e3c");
      grad.addColorStop(1, "#111320");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, 1280, 720);

      // Grade em perspectiva animada
      ctx.strokeStyle = "rgba(88, 101, 242, 0.25)";
      ctx.lineWidth = 2;
      const offset = (elapsed * 80) % 60;
      for (let y = 360; y < 720; y += 30) {
        const py = y + (offset * (y - 360)) / 360;
        if (py < 720) {
          ctx.beginPath();
          ctx.moveTo(0, py);
          ctx.lineTo(1280, py);
          ctx.stroke();
        }
      }
      for (let x = -640; x <= 1920; x += 80) {
        ctx.beginPath();
        ctx.moveTo(640 + (x - 640) * 0.2, 360);
        ctx.lineTo(x, 720);
        ctx.stroke();
      }

      // Orbes / partículas dinâmicas
      for (let i = 0; i < 6; i++) {
        const angle = elapsed * (0.8 + i * 0.15) + i * 1.1;
        const cx = 640 + Math.cos(angle) * (260 + i * 35);
        const cy = 320 + Math.sin(angle * 1.4) * (110 + i * 18);
        const r = 24 + Math.sin(elapsed * 3 + i) * 6;

        const orbGrad = ctx.createRadialGradient(cx, cy, 2, cx, cy, r * 2);
        orbGrad.addColorStop(0, i % 2 === 0 ? accentColor : "#5865F2");
        orbGrad.addColorStop(1, "rgba(88, 101, 242, 0)");
        ctx.fillStyle = orbGrad;
        ctx.beginPath();
        ctx.arc(cx, cy, r * 2, 0, Math.PI * 2);
        ctx.fill();
      }

      // HUD Central da Transmissão Mock
      ctx.fillStyle = "rgba(17, 18, 20, 0.78)";
      ctx.beginPath();
      ctx.roundRect(380, 220, 520, 220, 16);
      ctx.fill();
      ctx.strokeStyle = accentColor;
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.fillStyle = "#f23f43";
      ctx.beginPath();
      ctx.roundRect(410, 245, 92, 28, 6);
      ctx.fill();

      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 14px sans-serif";
      ctx.fillText("● AO VIVO", 422, 264);

      ctx.fillStyle = "#949ba4";
      ctx.font = "600 14px sans-serif";
      ctx.fillText("1080p • 60 FPS • Opt-In WebRTC Stream", 516, 264);

      ctx.fillStyle = "#f2f3f5";
      ctx.font = "bold 32px sans-serif";
      ctx.fillText(`Transmissão de ${displayName}`, 410, 320);

      // Equalizador visual animado no HUD
      for (let b = 0; b < 24; b++) {
        const barH =
          12 +
          Math.abs(Math.sin(elapsed * 5 + b * 0.45)) * 42 +
          Math.abs(Math.cos(elapsed * 3 - b * 0.3)) * 18;
        ctx.fillStyle = b % 3 === 0 ? accentColor : "#5865F2";
        ctx.fillRect(410 + b * 19, 410 - barH, 12, barH);
      }

      // Timecode no canto inferior direito
      const mins = String(Math.floor(elapsed / 60)).padStart(2, "0");
      const secs = String(Math.floor(elapsed % 60)).padStart(2, "0");
      ctx.fillStyle = "rgba(0, 0, 0, 0.65)";
      ctx.beginPath();
      ctx.roundRect(1110, 660, 140, 38, 8);
      ctx.fill();
      ctx.fillStyle = "#dbdee1";
      ctx.font = "bold 16px monospace";
      ctx.fillText(`LIVE ${mins}:${secs}`, 1128, 684);

      rafId = requestAnimationFrame(renderFrame);
    };

    rafId = requestAnimationFrame(renderFrame);
    const stream = canvas.captureStream(30);

    return {
      stream,
      cleanup: () => {
        cancelAnimationFrame(rafId);
        stream.getTracks().forEach((t) => t.stop());
      },
    };
  };

  const isStreamWatched = (identity: string): boolean => {
    return watchedStreams().some((s) => s.identity === identity);
  };

  // Assistir a própria transmissão local
  const watchOwnStream = () => {
    const preview = localPreviewStream || localScreenStream;
    if (!preview) return;
    if (isStreamWatched(LOCAL_STREAM_ID)) return;

    const myName = currentUser()?.display_name || "Você";
    const myColor = currentUser()?.avatar_color || "#5865F2";
    const ownEntry: WatchedStream = {
      identity: LOCAL_STREAM_ID,
      displayName: `${myName} (Sua Tela)`,
      avatarColor: myColor,
      isLocal: true,
      mediaStream: preview,
    };

    setWatchedStreams((prev) => [...prev, ownEntry]);
  };

  const toggleWatchOwnStream = () => {
    if (isStreamWatched(LOCAL_STREAM_ID)) {
      stopWatchingStream(LOCAL_STREAM_ID);
    } else {
      watchOwnStream();
    }
  };

  // Assistir Transmissão de Amigo (Opt-in sob demanda, suportando múltiplas lives)
  const watchStream = async (p: ParticipantState) => {
    if (isStreamWatched(p.identity)) return;

    if (p.screenPublication) {
      // Subscreve na track de vídeo sob demanda
      await p.screenPublication.setSubscribed(true);

      // Se houver track de áudio da tela, subscreve também
      const remoteP = room?.remoteParticipants.get(p.identity);
      const audioPub = Array.from(
        remoteP?.trackPublications.values() || [],
      ).find((pub) => pub.source === Track.Source.ScreenShareAudio);

      if (audioPub) {
        await audioPub.setSubscribed(true);
      }

      const existingTrack = p.screenPublication.track;
      const existingMediaStream = existingTrack
        ? new MediaStream([existingTrack.mediaStreamTrack])
        : undefined;

      setWatchedStreams((prev) => [
        ...prev,
        {
          identity: p.identity,
          displayName: p.displayName,
          avatarColor: p.avatarColor,
          isLocal: false,
          publication: p.screenPublication,
          mediaStream: existingMediaStream,
        },
      ]);
      return;
    }

    // Modo Mock Local: cria ou reutiliza stream de vídeo animada em tempo real para este participante
    let mock = mockStreamsMap.get(p.identity);
    if (!mock) {
      mock = createMockLiveStream(p.displayName, p.avatarColor);
      mockStreamsMap.set(p.identity, mock);
    }

    setWatchedStreams((prev) => [
      ...prev,
      {
        identity: p.identity,
        displayName: p.displayName,
        avatarColor: p.avatarColor,
        isLocal: false,
        mediaStream: mock.stream,
      },
    ]);
  };

  const toggleWatchStream = (p: ParticipantState) => {
    if (isStreamWatched(p.identity)) {
      stopWatchingStream(p.identity);
    } else {
      void watchStream(p);
    }
  };

  // Sair de uma transmissão específica (mantendo as demais abertas)
  const stopWatchingStream = (identity: string) => {
    const target = watchedStreams().find((s) => s.identity === identity);

    const mock = mockStreamsMap.get(identity);
    if (mock) {
      mock.cleanup();
      mockStreamsMap.delete(identity);
    }

    if (target?.publication) {
      void target.publication.setSubscribed(false);
      const remoteP = room?.remoteParticipants.get(identity);
      const audioPub = Array.from(
        remoteP?.trackPublications.values() || [],
      ).find((pub) => pub.source === Track.Source.ScreenShareAudio);
      if (audioPub) {
        void audioPub.setSubscribed(false);
      }
    }

    const stopCanvas = canvasCleanupMap.get(identity);
    if (stopCanvas) {
      stopCanvas();
      canvasCleanupMap.delete(identity);
    }

    const videoEl = videoRefsMap.get(identity);
    if (videoEl) {
      if (document.pictureInPictureElement === videoEl) {
        void document.exitPictureInPicture().catch(() => {});
      }
      if (target?.publication?.track) {
        target.publication.track.detach(videoEl);
      }
      videoEl.srcObject = null;
      videoRefsMap.delete(identity);
    }

    setWatchedStreams((prev) => prev.filter((s) => s.identity !== identity));
    if (focusedStreamId() === identity) {
      setFocusedStreamId(null);
    }
    if (pipStreamId() === identity) {
      setPipStreamId(null);
    }
  };

  // Sair de todas as transmissões simultaneamente
  const stopWatchingAllStreams = () => {
    const currentIds = watchedStreams().map((s) => s.identity);
    for (const id of currentIds) {
      stopWatchingStream(id);
    }
    setFocusedStreamId(null);
    setPipStreamId(null);
  };

  // Assistir todas as transmissões disponíveis na sala de uma vez
  const watchAllStreams = async () => {
    if (isScreenSharing() && !isStreamWatched(LOCAL_STREAM_ID)) {
      watchOwnStream();
    }
    const liveFriends = participants().filter((p) => p.isScreenSharing);
    for (const friend of liveFriends) {
      if (!isStreamWatched(friend.identity)) {
        await watchStream(friend);
      }
    }
  };

  const bindStreamVideoElement = (
    streamItem: WatchedStream,
    el: HTMLVideoElement | undefined,
  ) => {
    if (!el) return;
    videoRefsMap.set(streamItem.identity, el);
    el.muted = true; // O áudio remoto passa pelo AudioEngine com ganho individual, e o local é mudo para evitar eco
    el.defaultMuted = true;
    el.playsInline = true;

    const onEnterPiP = () => {
      setPipStreamId(streamItem.identity);
      if (el.paused) {
        void el.play().catch(() => {});
      }
    };
    const onLeavePiP = () => {
      if (pipStreamId() === streamItem.identity) {
        setPipStreamId(null);
      }
      // Ao fechar o PiP, os navegadores pausam o vídeo por padrão; retomamos imediatamente
      setTimeout(() => {
        el.muted = true;
        void el.play().catch(() => {});
      }, 50);
    };

    const onFullscreenChange = () => {
      if (el.paused) {
        el.muted = true;
        void el.play().catch(() => {});
      }
    };

    const onWebkitPresentationModeChanged = () => {
      const mode = (
        el as HTMLVideoElement & { webkitpresentationmode?: string }
      ).webkitpresentationmode;
      if (mode === "picture-in-picture") {
        setPipStreamId(streamItem.identity);
        if (el.paused) {
          el.muted = true;
          void el.play().catch(() => {});
        }
      } else {
        if (pipStreamId() === streamItem.identity) {
          setPipStreamId(null);
        }
        setTimeout(() => {
          el.muted = true;
          void el.play().catch(() => {});
        }, 50);
      }
    };

    el.addEventListener("enterpictureinpicture", onEnterPiP);
    el.addEventListener("leavepictureinpicture", onLeavePiP);
    el.addEventListener("fullscreenchange", onFullscreenChange);
    el.addEventListener("webkitfullscreenchange", onFullscreenChange);
    el.addEventListener(
      "webkitpresentationmodechanged",
      onWebkitPresentationModeChanged,
    );

    const attachAndPlay = () => {
      // No SolidJS, o callback ref executa antes de o elemento ser inserido no DOM.
      // Aguardamos o próximo frame se el.isConnected ainda for false para evitar aborto de play() e tela preta.
      if (!el.isConnected) {
        requestAnimationFrame(attachAndPlay);
        return;
      }
      el.muted = true;
      el.defaultMuted = true;
      el.playsInline = true;

      const targetStream = streamItem.isLocal
        ? localPreviewStream || streamItem.mediaStream
        : streamItem.mediaStream;

      const localPub = streamItem.isLocal
        ? room?.localParticipant.getTrackPublication(Track.Source.ScreenShare)
        : undefined;

      if (streamItem.publication?.track) {
        streamItem.publication.track.attach(el);
      } else if (localPub?.videoTrack) {
        localPub.videoTrack.attach(el);
      } else if (targetStream && el.srcObject !== targetStream) {
        el.srcObject = targetStream;
      }

      setTimeout(() => {
        if (!el.isConnected) return;
        el.muted = true;
        void el.play().catch(() => {});
      }, 0);
    };

    attachAndPlay();
  };

  // Espelha os quadros decodificados do <video> em um <canvas> inline dentro de .video-wrapper.
  // Isso elimina definitivamente o bug de tela preta da camada de hardware inline do Safari/macOS
  // (e mantém o preview visível na tela inicial mesmo durante ou após PiP / Tela Cheia).
  const bindStreamCanvasElement = (
    streamItem: WatchedStream,
    canvasEl: HTMLCanvasElement | undefined,
  ) => {
    if (!canvasEl) return;

    const prevStop = canvasCleanupMap.get(streamItem.identity);
    if (prevStop) prevStop();

    const ctx = canvasEl.getContext("2d", { alpha: false });
    let rafId = 0;
    let active = true;
    let lastDrawMs = 0;

    const renderLoop = (now: number) => {
      if (!active) return;

      const videoEl = videoRefsMap.get(streamItem.identity) as
        | (HTMLVideoElement & {
            webkitpresentationmode?: string;
            webkitDisplayingFullscreen?: boolean;
          })
        | undefined;

      if (videoEl && !document.hidden) {
        const isInPiP =
          pipStreamId() === streamItem.identity ||
          document.pictureInPictureElement === videoEl ||
          videoEl.webkitpresentationmode === "picture-in-picture";

        const isAnyFullscreen =
          Boolean(document.fullscreenElement) ||
          Boolean(
            (document as Document & { webkitFullscreenElement?: Element })
              .webkitFullscreenElement,
          ) ||
          Boolean(videoEl.webkitDisplayingFullscreen);

        // Economia de GPU/CPU: pausa o espelhamento no <canvas> da tela inicial
        // enquanto o vídeo estiver em PiP ou em Tela Cheia, evitando dupla renderização.
        if (isInPiP || isAnyFullscreen) {
          if (canvasEl.style.opacity !== "0") {
            canvasEl.style.opacity = "0";
          }
          rafId = requestAnimationFrame(renderLoop);
          return;
        }

        if (videoEl.paused && videoEl.srcObject) {
          videoEl.muted = true;
          void videoEl.play().catch(() => {});
        }

        if (
          ctx &&
          videoEl.readyState >= 2 &&
          videoEl.videoWidth > 0 &&
          videoEl.videoHeight > 0 &&
          now - lastDrawMs >= 30
        ) {
          lastDrawMs = now;
          if (
            canvasEl.width !== videoEl.videoWidth ||
            canvasEl.height !== videoEl.videoHeight
          ) {
            canvasEl.width = videoEl.videoWidth;
            canvasEl.height = videoEl.videoHeight;
          }
          try {
            ctx.drawImage(videoEl, 0, 0, canvasEl.width, canvasEl.height);
            if (canvasEl.style.opacity !== "1") {
              canvasEl.style.opacity = "1";
            }
          } catch {
            // Ignora falha transitória de frame
          }
        }
      }

      rafId = requestAnimationFrame(renderLoop);
    };

    rafId = requestAnimationFrame(renderLoop);
    canvasCleanupMap.set(streamItem.identity, () => {
      active = false;
      cancelAnimationFrame(rafId);
    });
  };

  const handleFullscreen = (identity: string) => {
    const el = videoRefsMap.get(identity) as
      | (HTMLVideoElement & {
          webkitRequestFullscreen?: () => Promise<void> | void;
          webkitEnterFullscreen?: () => void;
        })
      | undefined;
    if (!el) return;
    if (el.requestFullscreen) {
      void el.requestFullscreen();
    } else if (el.webkitRequestFullscreen) {
      void el.webkitRequestFullscreen();
    } else if (el.webkitEnterFullscreen) {
      el.webkitEnterFullscreen();
    }
  };

  const handlePictureInPicture = async (identity: string) => {
    const el = videoRefsMap.get(identity) as
      | (HTMLVideoElement & {
          webkitSupportsPresentationMode?: (mode: string) => boolean;
          webkitpresentationmode?: string;
          webkitSetPresentationMode?: (mode: string) => void;
        })
      | undefined;
    if (!el) return;

    try {
      // Garante que o vídeo esteja reproduzindo antes de solicitar PiP
      el.muted = true;
      if (el.paused) {
        await el.play().catch(() => {});
      }

      // Se os metadados do vídeo ainda não tiverem carregado (readyState === 0), aguarda até 1.5s
      if (el.readyState < 1) {
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(resolve, 1500);
          el.addEventListener(
            "loadedmetadata",
            () => {
              clearTimeout(timeout);
              resolve();
            },
            { once: true },
          );
        });
      }

      if (document.pictureInPictureEnabled && el.requestPictureInPicture) {
        if (document.pictureInPictureElement === el) {
          await document.exitPictureInPicture();
          setPipStreamId(null);
        } else {
          await el.requestPictureInPicture();
          setPipStreamId(identity);
        }
      } else if (
        typeof el.webkitSupportsPresentationMode === "function" &&
        el.webkitSupportsPresentationMode("picture-in-picture") &&
        typeof el.webkitSetPresentationMode === "function"
      ) {
        const nextMode =
          el.webkitpresentationmode === "picture-in-picture"
            ? "inline"
            : "picture-in-picture";
        el.webkitSetPresentationMode(nextMode);
        setPipStreamId(nextMode === "picture-in-picture" ? identity : null);
      }
    } catch (err) {
      console.warn("Não foi possível ativar Picture-in-Picture:", err);
    }
  };

  const compressImageFile = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          const maxDim = 1280;
          let { width, height } = img;
          if (width > maxDim || height > maxDim) {
            if (width > height) {
              height = Math.round((height * maxDim) / width);
              width = maxDim;
            } else {
              width = Math.round((width * maxDim) / height);
              height = maxDim;
            }
          }
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext("2d");
          if (!ctx) {
            resolve(reader.result as string);
            return;
          }
          ctx.drawImage(img, 0, 0, width, height);
          const dataUrl = canvas.toDataURL("image/webp", 0.82);
          resolve(dataUrl);
        };
        img.onerror = reject;
        img.src = reader.result as string;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  };

  const handleFileSelect = async (e: Event) => {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file || !file.type.startsWith("image/")) return;
    try {
      const compressed = await compressImageFile(file);
      setPendingImage(compressed);
    } catch (err) {
      console.error("Erro ao processar imagem:", err);
    } finally {
      input.value = "";
    }
  };

  const handleChatPaste = async (e: ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of Array.from(items)) {
      if (item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) {
          e.preventDefault();
          const compressed = await compressImageFile(file);
          setPendingImage(compressed);
          break;
        }
      }
    }
  };

  // Enviar Mensagem no Chat
  const handleSendMessage = async (e: Event) => {
    e.preventDefault();
    const content = chatInput().trim();
    const img = pendingImage() || undefined;
    if (!content && !img) return;

    setChatInput("");
    setPendingImage(null);
    try {
      await sendMessage(content, img);
    } catch (err) {
      console.error("Falha ao enviar mensagem:", err);
    }
  };

  const handleReaction = async (messageId: number, emoji: string) => {
    try {
      const res = await toggleMessageReaction(messageId, emoji);
      setMessages((prev) =>
        prev.map((m) =>
          m.id === messageId ? { ...m, reactions: res.reactions } : m,
        ),
      );
    } catch (err) {
      console.error("Falha ao reagir:", err);
    }
  };

  const renderMessageContent = (text: string) => {
    const urlRegex = /(https?:\/\/[^\s<]+)/g;
    const parts = text.split(urlRegex);
    return (
      <For each={parts}>
        {(part) =>
          /^https?:\/\/[^\s<]+$/.test(part) ? (
            <a
              href={part}
              target="_blank"
              rel="noopener noreferrer"
              class="chat-link"
            >
              {part}
            </a>
          ) : (
            <>{part}</>
          )
        }
      </For>
    );
  };

  const handleLogout = async () => {
    disconnectCall();
    await logout();
    setCurrentUser(null);
  };

  return (
    <div class="discord-app">
      {/* Modal de Autenticação */}
      <Show when={!currentUser() && !authLoading()}>
        <AuthModal
          onSuccess={(u) => {
            setCurrentUser(u);
            void loadMessages();
            setupWebSocket();
          }}
        />
      </Show>

      {/* Modal de Calibração de Áudio */}
      <Show when={settingsOpen()}>
        <AudioSettings
          micGain={currentUser()?.mic_gain ?? 100}
          onMicGainChange={(g) => {
            if (currentUser()) {
              setCurrentUser({ ...currentUser()!, mic_gain: g });
            }
          }}
          micProcessor={micProcessor}
          onClose={() => setSettingsOpen(false)}
        />
      </Show>

      {/* Modal Seletor de Resolução de Tela */}
      <Show when={screenQualityModal()}>
        <div
          class="modal-backdrop"
          onClick={() => setScreenQualityModal(false)}
        >
          <div
            class="modal-card quality-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <div class="modal-header">
              <h3>Compartilhar Tela</h3>
              <button
                class="modal-close-btn"
                onClick={() => setScreenQualityModal(false)}
                title="Fechar"
              >
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            <p class="quality-subtitle">
              Escolha a qualidade da transmissão antes de iniciar:
            </p>
            <div class="quality-options">
              <button
                class="quality-option-card"
                onClick={() => startScreenShare("720p")}
              >
                <div class="quality-badge eco">Econômico</div>
                <h4>720p @ 30 FPS</h4>
                <p>Ideal para jogos leves, menor uso de CPU e internet estável.</p>
              </button>
              <button
                class="quality-option-card"
                onClick={() => startScreenShare("1080p")}
              >
                <div class="quality-badge pro">Fluido</div>
                <h4>1080p @ 60 FPS</h4>
                <p>Qualidade máxima para jogos rápidos e alta taxa de quadros.</p>
              </button>
            </div>
          </div>
        </div>
      </Show>

      {/* BARRA SUPERIOR (HEADER) */}
      <header class="top-nav">
        <div class="top-nav-left">
          <div class="guild-tag">VGH</div>
          <h1 class="room-title">Chat Friends</h1>
          <span class="room-channel-badge"># geral</span>
        </div>
        <div class="top-nav-right">
          <button
            class={`chat-toggle-btn ${chatOpen() ? "active" : ""}`}
            onClick={() => setChatOpen(!chatOpen())}
            title={chatOpen() ? "Recolher Chat" : "Abrir Chat"}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            <span>Chat</span>
          </button>
          <Show when={currentUser()}>
            <button
              class="chat-toggle-btn logout-top-btn"
              onClick={handleLogout}
              title="Sair da Conta"
            >
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <polyline points="16 17 21 12 16 7" />
                <line x1="21" y1="12" x2="9" y2="12" />
              </svg>
              <span>Sair</span>
            </button>
          </Show>
        </div>
      </header>

      {/* ÁREA PRINCIPAL */}
      <div class="app-body">
        {/* SIDEBAR ESQUERDA (CANAIS & VOZ) */}
        <aside class="sidebar-voice">
          <div class="channel-section-header">
            <span>CANAIS DE VOZ</span>
          </div>

          <div class="voice-channel-item">
            <div class="voice-channel-title">
              <svg
                viewBox="0 0 24 24"
                width="18"
                height="18"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
              </svg>
              <span>Voz Principal</span>
            </div>

            <Show
              when={inCall()}
              fallback={
                <button
                  class="connect-voice-btn"
                  onClick={joinCall}
                  disabled={connecting()}
                >
                  {connecting() ? "Conectando..." : "Entrar na Voz"}
                </button>
              }
            >
              <div class="voice-participants-list">
                {/* Usuário Local */}
                <div
                  class={`participant-row local ${
                    isLocalSpeaking() && !isMicMuted() ? "speaking-active" : ""
                  }`}
                >
                  <div
                    class="avatar-circle"
                    style={{
                      "background-color":
                        currentUser()?.avatar_color || "#5865F2",
                    }}
                  >
                    {currentUser()?.display_name.charAt(0).toUpperCase()}
                  </div>
                  <span class="participant-name">
                    {currentUser()?.display_name} (Você)
                  </span>
                  <div class="participant-status-icons">
                    <Show when={isScreenSharing()}>
                      <span
                        class={`live-pill clickable ${
                          isStreamWatched(LOCAL_STREAM_ID) ? "watching" : ""
                        }`}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleWatchOwnStream();
                        }}
                        title={
                          isStreamWatched(LOCAL_STREAM_ID)
                            ? "Assistindo sua própria transmissão (Clique para ocultar preview)"
                            : "Clique para assistir sua própria transmissão"
                        }
                      >
                        {isStreamWatched(LOCAL_STREAM_ID)
                          ? "ASSISTINDO"
                          : "AO VIVO"}
                      </span>
                    </Show>
                    <Show when={isMicMuted()}>
                      <span class="status-icon muted" title="Microfone Silenciado">
                        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                          <line x1="2" y1="2" x2="22" y2="22" />
                          <path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2" />
                          <path d="M5 10v2a7 7 0 0 0 12 5" />
                          <path d="M15 9.34V5a3 3 0 0 0-5.68-1.33" />
                          <path d="M9 9v3a3 3 0 0 0 5.12 2.12" />
                          <line x1="12" y1="19" x2="12" y2="22" />
                        </svg>
                      </span>
                    </Show>
                    <Show when={isDeafened()}>
                      <span class="status-icon deaf" title="Áudio Silenciado">
                        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                          <line x1="2" y1="2" x2="22" y2="22" />
                          <path d="M3 14v-3a9 9 0 0 1 2.45-6.19" />
                          <path d="M10.42 3.14A9 9 0 0 1 21 11v3" />
                          <path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3z" />
                          <path d="M3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z" />
                        </svg>
                      </span>
                    </Show>
                  </div>
                </div>

                {/* Participantes Remotos */}
                <For each={participants()}>
                  {(p) => {
                    const isExpanded = () => expandedVolumeUser() === p.identity;
                    const voiceVol = () => getParticipantVol(p.identity, "voice");
                    const screenVol = () => getParticipantVol(p.identity, "screen");
                    return (
                      <div class="participant-item-wrapper">
                        <div
                          class={`participant-row clickable-row ${
                            p.isSpeaking ? "speaking-active" : ""
                          } ${isExpanded() ? "expanded" : ""}`}
                          onClick={() =>
                            setExpandedVolumeUser(
                              isExpanded() ? null : p.identity,
                            )
                          }
                          title="Clique para ajustar o volume deste participante"
                        >
                          <div
                            class="avatar-circle"
                            style={{ "background-color": p.avatarColor }}
                          >
                            {p.displayName.charAt(0).toUpperCase()}
                          </div>
                          <span class="participant-name">{p.displayName}</span>
                          <div class="participant-status-icons">
                            <Show when={p.isScreenSharing}>
                              <span
                                class={`live-pill clickable ${
                                  isStreamWatched(p.identity) ? "watching" : ""
                                }`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  toggleWatchStream(p);
                                }}
                                title={
                                  isStreamWatched(p.identity)
                                    ? "Assistindo (Clique para sair desta transmissão)"
                                    : "Clique para assistir"
                                }
                              >
                                {isStreamWatched(p.identity)
                                  ? "ASSISTINDO"
                                  : "AO VIVO"}
                              </span>
                            </Show>
                            <Show when={p.isMuted}>
                              <span class="status-icon muted" title="Silenciado">
                                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                                  <line x1="2" y1="2" x2="22" y2="22" />
                                  <path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2" />
                                  <path d="M5 10v2a7 7 0 0 0 12 5" />
                                  <path d="M15 9.34V5a3 3 0 0 0-5.68-1.33" />
                                  <path d="M9 9v3a3 3 0 0 0 5.12 2.12" />
                                  <line x1="12" y1="19" x2="12" y2="22" />
                                </svg>
                              </span>
                            </Show>
                            <button
                              type="button"
                              class={`participant-vol-trigger ${
                                voiceVol() === 0
                                  ? "muted"
                                  : voiceVol() !== 100
                                    ? "custom"
                                    : ""
                              } ${isExpanded() ? "active" : ""}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                setExpandedVolumeUser(
                                  isExpanded() ? null : p.identity,
                                );
                              }}
                              title={`Volume de ${p.displayName}: ${voiceVol()}%`}
                            >
                              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                                <Show
                                  when={voiceVol() > 0}
                                  fallback={
                                    <>
                                      <line x1="23" y1="9" x2="17" y2="15" />
                                      <line x1="17" y1="9" x2="23" y2="15" />
                                    </>
                                  }
                                >
                                  <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                                </Show>
                              </svg>
                              <span>{voiceVol()}%</span>
                            </button>
                          </div>
                        </div>

                        {/* Gaveta Expansível de Volume Individual na Sidebar */}
                        <Show when={isExpanded()}>
                          <div
                            class="participant-volume-drawer"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <div class="vol-drawer-row">
                              <div class="vol-drawer-header">
                                <span class="vol-drawer-label">Volume da Voz</span>
                                <div class="vol-drawer-actions">
                                  <Show when={voiceVol() !== 100}>
                                    <button
                                      type="button"
                                      class="vol-reset-chip"
                                      onClick={() =>
                                        setParticipantVol(p.identity, "voice", 100)
                                      }
                                      title="Restaurar para 100%"
                                    >
                                      100%
                                    </button>
                                  </Show>
                                  <span class="vol-drawer-val">{voiceVol()}%</span>
                                </div>
                              </div>
                              <div class="vol-drawer-slider-wrap">
                                <button
                                  type="button"
                                  class={`vol-mute-icon-btn ${
                                    voiceVol() === 0 ? "muted" : ""
                                  }`}
                                  onClick={() =>
                                    toggleParticipantQuickMute(p.identity, "voice")
                                  }
                                  title={
                                    voiceVol() === 0
                                      ? "Reativar voz deste amigo"
                                      : "Silenciar este amigo (0%)"
                                  }
                                >
                                  <Show
                                    when={voiceVol() > 0}
                                    fallback={
                                      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                                        <line x1="23" y1="9" x2="17" y2="15" />
                                        <line x1="17" y1="9" x2="23" y2="15" />
                                      </svg>
                                    }
                                  >
                                    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                                      <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                                    </svg>
                                  </Show>
                                </button>
                                <input
                                  type="range"
                                  min="0"
                                  max="200"
                                  value={voiceVol()}
                                  onInput={(e) =>
                                    setParticipantVol(
                                      p.identity,
                                      "voice",
                                      Number(e.currentTarget.value),
                                    )
                                  }
                                  class="participant-vol-slider"
                                />
                              </div>
                            </div>

                            <Show when={p.isScreenSharing}>
                              <div class="vol-drawer-row">
                                <div class="vol-drawer-header">
                                  <span class="vol-drawer-label">
                                    Volume da Transmissão
                                  </span>
                                  <span class="vol-drawer-val">{screenVol()}%</span>
                                </div>
                                <div class="vol-drawer-slider-wrap">
                                  <button
                                    type="button"
                                    class={`vol-mute-icon-btn ${
                                      screenVol() === 0 ? "muted" : ""
                                    }`}
                                    onClick={() =>
                                      toggleParticipantQuickMute(
                                        p.identity,
                                        "screen",
                                      )
                                    }
                                    title="Silenciar/Reativar áudio da live"
                                  >
                                    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                      <rect x="2" y="3" width="20" height="14" rx="2" />
                                      <line x1="8" y1="21" x2="16" y2="21" />
                                      <line x1="12" y1="17" x2="12" y2="21" />
                                    </svg>
                                  </button>
                                  <input
                                    type="range"
                                    min="0"
                                    max="100"
                                    value={screenVol()}
                                    onInput={(e) =>
                                      setParticipantVol(
                                        p.identity,
                                        "screen",
                                        Number(e.currentTarget.value),
                                      )
                                    }
                                    class="participant-vol-slider"
                                  />
                                </div>
                              </div>
                            </Show>
                          </div>
                        </Show>
                      </div>
                    );
                  }}
                </For>
              </div>
            </Show>
          </div>

          {/* DOCK DO USUÁRIO NA BASE DA SIDEBAR */}
          <div class="user-dock">
            <div class="user-dock-profile">
              <div
                class="avatar-circle small"
                style={{
                  "background-color":
                    currentUser()?.avatar_color || "#5865F2",
                }}
              >
                {currentUser()?.display_name.charAt(0).toUpperCase()}
              </div>
              <div class="user-dock-names">
                <span class="user-dock-display">
                  {currentUser()?.display_name}
                </span>
                <span class="user-dock-username">
                  @{currentUser()?.username}
                </span>
              </div>
            </div>

            <div class="user-dock-actions">
              <button
                class={`dock-action-btn ${isMicMuted() ? "muted" : ""}`}
                onClick={toggleMute}
                title={isMicMuted() ? "Ativar Microfone" : "Silenciar Microfone"}
              >
                <Show
                  when={isMicMuted()}
                  fallback={
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                      <line x1="12" y1="19" x2="12" y2="22" />
                    </svg>
                  }
                >
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <line x1="2" y1="2" x2="22" y2="22" />
                    <path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2" />
                    <path d="M5 10v2a7 7 0 0 0 12 5" />
                    <path d="M15 9.34V5a3 3 0 0 0-5.68-1.33" />
                    <path d="M9 9v3a3 3 0 0 0 5.12 2.12" />
                    <line x1="12" y1="19" x2="12" y2="22" />
                  </svg>
                </Show>
              </button>
              <button
                class={`dock-action-btn ${isDeafened() ? "muted" : ""}`}
                onClick={toggleDeafen}
                title={isDeafened() ? "Reativar Áudio" : "Silenciar Áudio e Microfone"}
              >
                <Show
                  when={isDeafened()}
                  fallback={
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3" />
                    </svg>
                  }
                >
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <line x1="2" y1="2" x2="22" y2="22" />
                    <path d="M3 14v-3a9 9 0 0 1 2.45-6.19" />
                    <path d="M10.42 3.14A9 9 0 0 1 21 11v3" />
                    <path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3z" />
                    <path d="M3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z" />
                  </svg>
                </Show>
              </button>
              <Show when={inCall()}>
                <button
                  class={`dock-action-btn ${isScreenSharing() ? "active" : ""}`}
                  onClick={() => {
                    if (isScreenSharing()) void stopScreenShare();
                    else setScreenQualityModal(true);
                  }}
                  title={
                    isScreenSharing()
                      ? "Parar Compartilhamento"
                      : "Compartilhar Tela"
                  }
                >
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <rect x="2" y="3" width="20" height="14" rx="2" />
                    <line x1="8" y1="21" x2="16" y2="21" />
                    <line x1="12" y1="17" x2="12" y2="21" />
                  </svg>
                </button>
              </Show>
              <button
                class="dock-action-btn"
                onClick={() => setSettingsOpen(true)}
                title="Configurações de Áudio"
              >
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
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
              </button>
              <Show when={inCall()}>
                <button
                  class="dock-action-btn danger"
                  onClick={disconnectCall}
                  title="Desconectar da Chamada"
                >
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-3.33-2.67m-2.67-3.34a19.79 19.79 0 0 1-3.07-8.63A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91" />
                    <line x1="22" y1="2" x2="2" y2="22" />
                  </svg>
                </button>
              </Show>
            </div>
          </div>
        </aside>

        {/* PALCO CENTRAL (STAGE DE TRANSMISSÕES MÚLTIPLAS OU AVATARES) */}
        <main class="center-stage">
          {/* BARRA CENTRAL DE GERENCIAMENTO DE TRANSMISSÕES (Sempre visível quando há lives ativas na sala) */}
          <Show
            when={
              inCall() &&
              (isScreenSharing() ||
                participants().some((p) => p.isScreenSharing))
            }
          >
            <div class="live-streams-hub">
              <div class="live-hub-left">
                <span class="live-hub-label">
                  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <rect x="2" y="3" width="20" height="14" rx="2" />
                    <line x1="8" y1="21" x2="16" y2="21" />
                    <line x1="12" y1="17" x2="12" y2="21" />
                  </svg>
                  Lives na Sala
                </span>

                <div class="live-hub-chips">
                  {/* Chip da própria transmissão quando estiver transmitindo */}
                  <Show when={isScreenSharing()}>
                    <button
                      type="button"
                      class={`live-hub-chip self ${
                        isStreamWatched(LOCAL_STREAM_ID) ? "watching" : ""
                      }`}
                      onClick={toggleWatchOwnStream}
                      title={
                        isStreamWatched(LOCAL_STREAM_ID)
                          ? "Clique para ocultar o preview da sua transmissão"
                          : "Clique para assistir sua própria transmissão"
                      }
                    >
                      <span class="chip-live-dot" />
                      <span class="chip-name">Sua Tela (Você)</span>
                      <span class="chip-status">
                        {isStreamWatched(LOCAL_STREAM_ID)
                          ? "Assistindo ✓"
                          : "+ Assistir"}
                      </span>
                    </button>
                  </Show>

                  {/* Chips das transmissões dos participantes */}
                  <For each={participants().filter((p) => p.isScreenSharing)}>
                    {(liveFriend) => {
                      const watching = () => isStreamWatched(liveFriend.identity);
                      return (
                        <button
                          type="button"
                          class={`live-hub-chip ${watching() ? "watching" : ""}`}
                          onClick={() => toggleWatchStream(liveFriend)}
                          title={
                            watching()
                              ? `Clique para sair da transmissão de ${liveFriend.displayName}`
                              : `Clique para assistir ${liveFriend.displayName}`
                          }
                        >
                          <span class="chip-live-dot" />
                          <span class="chip-name">{liveFriend.displayName}</span>
                          <span class="chip-status">
                            {watching() ? "Assistindo ✓" : "+ Assistir"}
                          </span>
                        </button>
                      );
                    }}
                  </For>
                </div>
              </div>

              <div class="live-hub-actions">
                <Show when={watchedStreams().length >= 2}>
                  <button
                    type="button"
                    class={`hub-action-btn layout-btn ${
                      focusedStreamId() === null ? "active" : ""
                    }`}
                    onClick={() => setFocusedStreamId(null)}
                    title="Exibir todas as transmissões em grade dividida (Mosaico)"
                  >
                    Grade ({watchedStreams().length})
                  </button>
                </Show>

                <Show
                  when={
                    (isScreenSharing() && !isStreamWatched(LOCAL_STREAM_ID)) ||
                    participants().some(
                      (p) => p.isScreenSharing && !isStreamWatched(p.identity),
                    )
                  }
                >
                  <button
                    type="button"
                    class="hub-action-btn watch-all"
                    onClick={() => void watchAllStreams()}
                    title="Assistir todas as transmissões ativas simultaneamente"
                  >
                    Assistir Todas
                  </button>
                </Show>

                <Show when={watchedStreams().length > 0}>
                  <button
                    type="button"
                    class="hub-action-btn leave-all"
                    onClick={stopWatchingAllStreams}
                    title="Sair de todas as transmissões abertas e voltar aos avatares"
                  >
                    {watchedStreams().length > 1
                      ? `Sair de Todas (${watchedStreams().length})`
                      : "Fechar Transmissão"}
                  </button>
                </Show>
              </div>
            </div>
          </Show>

          {/* Se estiver assistindo a 1 ou mais transmissões */}
          <Show
            when={watchedStreams().length > 0}
            fallback={
              <div class="avatars-stage-grid">
                {/* Card da própria transmissão caso o usuário tenha ocultado o preview */}
                <Show
                  when={
                    isScreenSharing() && !isStreamWatched(LOCAL_STREAM_ID)
                  }
                >
                  <div class="stream-invite-card self-stream">
                    <div class="stream-invite-icon self">
                      <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <rect x="2" y="3" width="20" height="14" rx="2" />
                        <line x1="8" y1="21" x2="16" y2="21" />
                        <line x1="12" y1="17" x2="12" y2="21" />
                      </svg>
                    </div>
                    <div class="stream-invite-content">
                      <h3>Você está transmitindo sua tela!</h3>
                      <p>
                        Sua transmissão está ativa para a sala. Abra o preview se quiser conferir como está a imagem.
                      </p>
                    </div>
                    <div class="stream-invite-buttons">
                      <button
                        class="watch-stream-btn self"
                        onClick={watchOwnStream}
                      >
                        Assistir Minha Transmissão
                      </button>
                      <button
                        class="stop-own-stream-btn"
                        onClick={() => void stopScreenShare()}
                      >
                        Encerrar Live
                      </button>
                    </div>
                  </div>
                </Show>

                {/* Avisos de amigos transmitindo tela com botão de Opt-in */}
                <For
                  each={participants().filter(
                    (p) => p.isScreenSharing && !isStreamWatched(p.identity),
                  )}
                >
                  {(liveFriend) => (
                    <div class="stream-invite-card">
                      <div class="stream-invite-icon">
                        <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                          <rect x="2" y="3" width="20" height="14" rx="2" />
                          <line x1="8" y1="21" x2="16" y2="21" />
                          <line x1="12" y1="17" x2="12" y2="21" />
                        </svg>
                      </div>
                      <div class="stream-invite-content">
                        <h3>{liveFriend.displayName} está ao vivo!</h3>
                        <p>Transmitindo tela no canal de voz.</p>
                      </div>
                      <button
                        class="watch-stream-btn"
                        onClick={() => void watchStream(liveFriend)}
                      >
                        Assistir Transmissão
                      </button>
                    </div>
                  )}
                </For>

                {/* Grade dos Participantes Conectados */}
                <div class="stage-participants-wrapper">
                  <Show
                    when={inCall()}
                    fallback={
                      <div class="empty-stage-state">
                        <div class="empty-stage-icon">
                          <svg viewBox="0 0 24 24" width="52" height="52" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3" />
                          </svg>
                        </div>
                        <h2>Você ainda não está conectado à voz</h2>
                        <p>
                          Clique em <strong>"Entrar na Voz"</strong> na barra lateral
                          para conversar e compartilhar a tela com seus amigos.
                        </p>
                        <button class="stage-cta-btn" onClick={joinCall}>
                          Entrar na Chamada
                        </button>
                      </div>
                    }
                  >
                    <div class="participants-grid">
                      {/* Card do Usuário Local */}
                      <div
                        class={`stage-user-card ${
                          isLocalSpeaking() && !isMicMuted() ? "speaking" : ""
                        }`}
                      >
                        <Show when={isScreenSharing()}>
                          <button
                            class="stage-watch-pill self"
                            onClick={watchOwnStream}
                            title="Ver preview da sua própria transmissão"
                          >
                            ● Ver Minha Live
                          </button>
                        </Show>
                        <div
                          class="stage-avatar"
                          style={{
                            "background-color":
                              currentUser()?.avatar_color || "#5865F2",
                          }}
                        >
                          {currentUser()?.display_name.charAt(0).toUpperCase()}
                        </div>
                        <span class="stage-user-name">
                          {currentUser()?.display_name} (Você)
                        </span>
                      </div>

                      {/* Cards dos Amigos */}
                      <For each={participants()}>
                        {(p) => {
                          const voiceVol = () => getParticipantVol(p.identity, "voice");
                          return (
                            <div
                              class={`stage-user-card ${
                                p.isSpeaking ? "speaking" : ""
                              }`}
                            >
                              <Show when={p.isScreenSharing}>
                                <button
                                  class="stage-watch-pill"
                                  onClick={() => void watchStream(p)}
                                >
                                  ● Assistir Live
                                </button>
                              </Show>
                              <div
                                class="stage-avatar"
                                style={{ "background-color": p.avatarColor }}
                              >
                                {p.displayName.charAt(0).toUpperCase()}
                              </div>
                              <span class="stage-user-name">{p.displayName}</span>

                              {/* Controle de Volume Integrado no Card do Palco */}
                              <div class="stage-card-volume">
                                <button
                                  type="button"
                                  class={`stage-vol-mute-btn ${
                                    voiceVol() === 0 ? "muted" : ""
                                  }`}
                                  onClick={() =>
                                    toggleParticipantQuickMute(p.identity, "voice")
                                  }
                                  title={
                                    voiceVol() === 0
                                      ? "Reativar áudio"
                                      : "Silenciar amigo"
                                  }
                                >
                                  <Show
                                    when={voiceVol() > 0}
                                    fallback={
                                      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                                        <line x1="23" y1="9" x2="17" y2="15" />
                                        <line x1="17" y1="9" x2="23" y2="15" />
                                      </svg>
                                    }
                                  >
                                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                                      <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                                    </svg>
                                  </Show>
                                </button>
                                <input
                                  type="range"
                                  min="0"
                                  max="200"
                                  value={voiceVol()}
                                  onInput={(e) =>
                                    setParticipantVol(
                                      p.identity,
                                      "voice",
                                      Number(e.currentTarget.value),
                                    )
                                  }
                                  class="stage-vol-slider"
                                  title={`Volume de ${p.displayName}: ${voiceVol()}%`}
                                />
                                <button
                                  type="button"
                                  class="stage-vol-pct"
                                  onClick={() =>
                                    setParticipantVol(p.identity, "voice", 100)
                                  }
                                  title="Clique para restaurar 100%"
                                >
                                  {voiceVol()}%
                                </button>
                              </div>
                            </div>
                          );
                        }}
                      </For>
                    </div>
                  </Show>
                </div>
              </div>
            }
          >
            {/* PALCO MULTI-STREAM (Suporta 1, 2, 3+ Transmissões em Mosaico ou Destaque) */}
            <div
              class={`multi-stream-stage ${
                focusedStreamId() && watchedStreams().length > 1
                  ? "layout-spotlight"
                  : watchedStreams().length === 1
                    ? "layout-single"
                    : watchedStreams().length === 2
                      ? "layout-split"
                      : "layout-quad"
              }`}
            >
              <For each={watchedStreams()}>
                {(streamItem) => {
                  const isFocused = () =>
                    focusedStreamId() === streamItem.identity;
                  const screenVol = () =>
                    getParticipantVol(streamItem.identity, "screen");

                  return (
                    <div
                      class={`stream-tile ${
                        isFocused() ? "focused-tile" : ""
                      } ${
                        focusedStreamId() && !isFocused()
                          ? "secondary-tile"
                          : ""
                      }`}
                    >
                      <div class="stream-top-bar">
                        <div class="stream-info">
                          <span
                            class={`live-tag ${
                              streamItem.isLocal ? "self" : ""
                            }`}
                          >
                            {streamItem.isLocal ? "SUA TELA" : "AO VIVO"}
                          </span>
                          <span class="streamer-title">
                            {streamItem.displayName}
                          </span>
                        </div>

                        <div class="stream-controls">
                          {/* Controle de Volume da Transmissão Remota ou Aviso Local */}
                          <Show
                            when={!streamItem.isLocal}
                            fallback={
                              <button
                                type="button"
                                class="stream-btn danger-outline"
                                onClick={() => void stopScreenShare()}
                                title="Parar de transmitir sua tela para a sala"
                              >
                                Encerrar Minha Live
                              </button>
                            }
                          >
                            <div class="stream-vol-control">
                              <button
                                type="button"
                                class={`stream-vol-mute-btn ${
                                  screenVol() === 0 ? "muted" : ""
                                }`}
                                onClick={() =>
                                  toggleParticipantQuickMute(
                                    streamItem.identity,
                                    "screen",
                                  )
                                }
                                title={
                                  screenVol() === 0
                                    ? "Reativar áudio desta transmissão"
                                    : "Silenciar áudio desta transmissão"
                                }
                              >
                                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                                  <Show
                                    when={screenVol() > 0}
                                    fallback={
                                      <>
                                        <line x1="23" y1="9" x2="17" y2="15" />
                                        <line x1="17" y1="9" x2="23" y2="15" />
                                      </>
                                    }
                                  >
                                    <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                                  </Show>
                                </svg>
                              </button>
                              <input
                                type="range"
                                min="0"
                                max="100"
                                value={screenVol()}
                                onInput={(e) =>
                                  setParticipantVol(
                                    streamItem.identity,
                                    "screen",
                                    Number(e.currentTarget.value),
                                  )
                                }
                                class="mini-slider"
                                title={`Volume da live de ${streamItem.displayName}: ${screenVol()}%`}
                              />
                              <span class="stream-vol-pct">{screenVol()}%</span>
                            </div>
                          </Show>

                          <Show when={watchedStreams().length > 1}>
                            <button
                              type="button"
                              class={`stream-btn ${isFocused() ? "active" : ""}`}
                              onClick={() =>
                                setFocusedStreamId(
                                  isFocused() ? null : streamItem.identity,
                                )
                              }
                              title={
                                isFocused()
                                  ? "Voltar para visualização em Grade (Mosaico)"
                                  : "Destacar esta transmissão em tamanho maior"
                              }
                            >
                              {isFocused() ? "Grade" : "Destacar"}
                            </button>
                          </Show>

                          <button
                            type="button"
                            class={`stream-btn pip ${
                              pipStreamId() === streamItem.identity
                                ? "active"
                                : ""
                            }`}
                            onClick={() =>
                              void handlePictureInPicture(streamItem.identity)
                            }
                            title="Janela Flutuante (Picture-in-Picture)"
                          >
                            {pipStreamId() === streamItem.identity
                              ? "Sair do PiP"
                              : "PiP"}
                          </button>
                          <button
                            type="button"
                            class="stream-btn fullscreen"
                            onClick={() => handleFullscreen(streamItem.identity)}
                            title="Tela Cheia"
                          >
                            Tela Cheia
                          </button>
                          <button
                            type="button"
                            class="stream-btn stop-watch"
                            onClick={() =>
                              stopWatchingStream(streamItem.identity)
                            }
                            title={
                              streamItem.isLocal
                                ? "Ocultar preview da sua tela (sua transmissão continuará ativa para a sala)"
                                : `Sair apenas da transmissão de ${streamItem.displayName}`
                            }
                          >
                            {streamItem.isLocal
                              ? "Ocultar Preview"
                              : "Sair da Live"}
                          </button>
                        </div>
                      </div>

                      <div
                        class="video-wrapper"
                        onDblClick={() => handleFullscreen(streamItem.identity)}
                      >
                        <video
                          ref={(el) => bindStreamVideoElement(streamItem, el)}
                          playsinline
                          muted
                          onLoadedMetadata={(e) => {
                            e.currentTarget.muted = true;
                            void e.currentTarget.play().catch(() => {});
                          }}
                          onLoadedData={(e) => {
                            e.currentTarget.muted = true;
                            if (e.currentTarget.paused) {
                              void e.currentTarget.play().catch(() => {});
                            }
                          }}
                          onCanPlay={(e) => {
                            if (e.currentTarget.paused) {
                              void e.currentTarget.play().catch(() => {});
                            }
                          }}
                          class="stream-video-element"
                        />
                        <canvas
                          ref={(canvasEl) =>
                            bindStreamCanvasElement(streamItem, canvasEl)
                          }
                          class="stream-video-canvas"
                        />
                        <Show when={pipStreamId() === streamItem.identity}>
                          <div class="pip-active-placeholder">
                            <span class="pip-placeholder-title">
                              Reproduzindo em Picture-in-Picture
                            </span>
                            <span class="pip-placeholder-sub">
                              Preview na tela inicial pausado para economizar GPU
                            </span>
                            <button
                              type="button"
                              class="stream-btn"
                              onClick={() =>
                                void handlePictureInPicture(streamItem.identity)
                              }
                            >
                              Voltar para a Tela Inicial
                            </button>
                          </div>
                        </Show>
                      </div>
                    </div>
                  );
                }}
              </For>
            </div>
          </Show>
        </main>

        {/* GAVETA LATERAL DIREITA (CHAT) */}
        <Show when={chatOpen()}>
          <aside class="chat-drawer">
            <div class="chat-header">
              <div class="chat-header-title-group">
                <h3>Mensagens da Sala</h3>
                <span
                  class="chat-retention-badge"
                  title="Mensagens, fotos e reações são excluídas automaticamente após 7 dias para economizar armazenamento."
                >
                  ⏳ 7 dias
                </span>
              </div>
              <span class="chat-counter">
                {messages().length} mensagem(ns)
              </span>
            </div>

            <div class="chat-messages-container">
              <For each={messages()}>
                {(msg) => (
                  <div class="chat-message-row">
                    <div
                      class="chat-avatar"
                      style={{ "background-color": msg.avatar_color }}
                    >
                      {msg.display_name.charAt(0).toUpperCase()}
                    </div>
                    <div class="chat-body">
                      <div class="chat-meta">
                        <span class="chat-author">{msg.display_name}</span>
                        <span class="chat-time">
                          {new Date(msg.created_at * 1000).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </span>
                      </div>

                      <Show when={msg.content}>
                        <div class="chat-text">
                          {renderMessageContent(msg.content)}
                        </div>
                      </Show>

                      <Show when={msg.image_url}>
                        <div class="chat-image-wrapper">
                          <img
                            src={msg.image_url}
                            alt="Foto enviada no chat"
                            class="chat-image-attachment"
                            loading="lazy"
                            decoding="async"
                            onClick={() => setLightboxImage(msg.image_url!)}
                          />
                        </div>
                      </Show>

                      {/* Reações Existentes */}
                      <Show when={(msg.reactions?.length || 0) > 0}>
                        <div class="chat-reactions-list">
                          <For each={msg.reactions}>
                            {(r) => {
                              const myUsername = currentUser()?.username || "";
                              const reacted = r.users.includes(myUsername);
                              return (
                                <button
                                  type="button"
                                  class={`reaction-pill ${reacted ? "active" : ""}`}
                                  onClick={() => void handleReaction(msg.id, r.emoji)}
                                  title={`Reagido por: ${r.users.join(", ")}`}
                                >
                                  <span class="reaction-emoji">{r.emoji}</span>
                                  <span class="reaction-count">{r.count}</span>
                                </button>
                              );
                            }}
                          </For>
                        </div>
                      </Show>

                      {/* Barra Rápida de Emojis em Hover */}
                      <div class="chat-Quick-reactions">
                        <For each={QUICK_EMOJIS}>
                          {(emoji) => (
                            <button
                              type="button"
                              class="quick-emoji-btn"
                              onClick={() => void handleReaction(msg.id, emoji)}
                              title={`Reagir com ${emoji}`}
                            >
                              {emoji}
                            </button>
                          )}
                        </For>
                      </div>
                    </div>
                  </div>
                )}
              </For>
              <div ref={chatEndRef} />
            </div>

            {/* Preview de Imagem Anexada antes de enviar */}
            <Show when={pendingImage()}>
              <div class="chat-attachment-preview">
                <img
                  src={pendingImage()!}
                  alt="Preview do anexo"
                  class="chat-preview-thumb"
                />
                <span class="chat-preview-label">Imagem pronta para enviar</span>
                <button
                  type="button"
                  class="chat-preview-remove"
                  onClick={() => setPendingImage(null)}
                  title="Remover imagem"
                >
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>
            </Show>

            <form onSubmit={handleSendMessage} class="chat-input-bar">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                style={{ display: "none" }}
                onChange={handleFileSelect}
              />
              <button
                type="button"
                class="chat-attach-btn"
                onClick={() => fileInputRef?.click()}
                title="Enviar foto (ou cole com Ctrl+V)"
              >
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                  <circle cx="8.5" cy="8.5" r="1.5" />
                  <polyline points="21 15 16 10 5 21" />
                </svg>
              </button>
              <input
                type="text"
                maxlength="2000"
                placeholder="Conversar em #geral (ou cole uma foto)..."
                value={chatInput()}
                onInput={(e) => setChatInput(e.currentTarget.value)}
                onPaste={handleChatPaste}
                class="chat-input"
              />
              <button
                type="submit"
                disabled={!chatInput().trim() && !pendingImage()}
                class="chat-send-btn"
                title="Enviar mensagem"
              >
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <line x1="22" y1="2" x2="11" y2="13" />
                  <polygon points="22 2 15 22 11 13 2 9 22 2" />
                </svg>
              </button>
            </form>
          </aside>
        </Show>

        {/* Modal Lightbox para visualizar foto ampliada */}
        <Show when={lightboxImage()}>
          <div
            class="modal-backdrop lightbox-backdrop"
            onClick={() => setLightboxImage(null)}
          >
            <img
              src={lightboxImage()!}
              alt="Visualização ampliada"
              class="lightbox-image"
              onClick={(e) => e.stopPropagation()}
            />
            <button
              type="button"
              class="lightbox-close-btn"
              onClick={() => setLightboxImage(null)}
              title="Fechar"
            >
              <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </Show>
      </div>
    </div>
  );
};
