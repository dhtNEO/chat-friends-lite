export interface User {
  id: number;
  username: string;
  display_name: string;
  avatar_color: string;
  mic_gain: number;
}

export interface AudioPreference {
  target_username: string;
  stream_type: "voice" | "screen";
  volume: number;
}

export interface MeResponse {
  user: User;
  audio_preferences: AudioPreference[];
}

export interface ReactionGroup {
  emoji: string;
  count: number;
  users: string[];
}

export interface ChatMessage {
  id: number;
  user_id: number;
  username: string;
  display_name: string;
  avatar_color: string;
  content: string;
  image_url?: string;
  reactions?: ReactionGroup[];
  created_at: number;
}

export interface MediaTokenResponse {
  token: string;
  url: string;
}

export interface ApiError {
  error: string;
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers || {});
  if (options.body && typeof options.body === "string" && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(path, {
    ...options,
    headers,
    credentials: "same-origin",
  });

  if (!response.ok) {
    let errorMsg = `Erro ${response.status}: ${response.statusText}`;
    try {
      const data = await response.json();
      if (data && data.error) {
        errorMsg = data.error;
      }
    } catch {
      // not JSON
    }
    throw new Error(errorMsg);
  }

  if (response.status === 204) {
    return null as unknown as T;
  }

  return response.json();
}

export async function getMe(): Promise<MeResponse> {
  return request<MeResponse>("/api/auth/me");
}

export async function login(username: string, password: string): Promise<User> {
  return request<User>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
}

export async function register(
  username: string,
  display_name: string,
  password: string,
  invite_code: string,
): Promise<User> {
  return request<User>("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({
      username,
      display_name,
      password,
      invite_code,
    }),
  });
}

export async function logout(): Promise<void> {
  await request<{ status: string }>("/api/auth/logout", {
    method: "POST",
  });
}

export async function getMessages(
  beforeId?: number,
  limit = 50,
): Promise<ChatMessage[]> {
  const params = new URLSearchParams();
  if (beforeId !== undefined) {
    params.set("before_id", beforeId.toString());
  }
  params.set("limit", limit.toString());
  return request<ChatMessage[]>(`/api/messages?${params.toString()}`);
}

export async function sendMessage(
  content: string,
  image_url?: string,
): Promise<ChatMessage> {
  return request<ChatMessage>("/api/messages", {
    method: "POST",
    body: JSON.stringify({ content, image_url }),
  });
}

export async function toggleMessageReaction(
  messageId: number,
  emoji: string,
): Promise<{ message_id: number; reactions: ReactionGroup[] }> {
  return request<{ message_id: number; reactions: ReactionGroup[] }>(
    `/api/messages/${messageId}/reactions`,
    {
      method: "POST",
      body: JSON.stringify({ emoji }),
    },
  );
}

export async function getMediaToken(): Promise<MediaTokenResponse> {
  return request<MediaTokenResponse>("/api/media/token", {
    method: "POST",
  });
}

export async function updateAudioPreference(
  target_username: string,
  stream_type: "voice" | "screen",
  volume: number,
): Promise<{ status: string }> {
  return request<{ status: string }>("/api/media/preferences", {
    method: "PUT",
    body: JSON.stringify({
      target_username,
      stream_type,
      volume,
    }),
  });
}

export async function updateMicGain(
  mic_gain: number,
): Promise<{ status: string; mic_gain: number }> {
  return request<{ status: string; mic_gain: number }>("/api/media/mic-gain", {
    method: "PUT",
    body: JSON.stringify({ mic_gain }),
  });
}

export type WsMessageCallback = (data: {
  type: string;
  message?: ChatMessage;
  message_id?: number;
  reactions?: ReactionGroup[];
  user?: { id: number; username: string; display_name: string };
  users?: string[];
}) => void;

export function connectWebSocket(
  onMessage: WsMessageCallback,
  onOpen?: () => void,
  onClose?: () => void,
): { sendPing: () => void; close: () => void } {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${protocol}//${window.location.host}/ws`;
  let ws: WebSocket | null = null;
  let isClosed = false;
  let pingInterval: number | null = null;

  function connect() {
    if (isClosed) return;
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      onOpen?.();
      pingInterval = window.setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send("ping");
        }
      }, 15000);
    };

    ws.onmessage = (event) => {
      try {
        if (event.data === "pong") return;
        const parsed = JSON.parse(event.data);
        onMessage(parsed);
      } catch {
        // Ignora mensagens mal formatadas
      }
    };

    ws.onclose = () => {
      if (pingInterval) clearInterval(pingInterval);
      onClose?.();
      if (!isClosed) {
        setTimeout(connect, 3000); // Reconnect automático
      }
    };

    ws.onerror = () => {
      ws?.close();
    };
  }

  connect();

  return {
    sendPing: () => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send("ping");
      }
    },
    close: () => {
      isClosed = true;
      if (pingInterval) clearInterval(pingInterval);
      ws?.close();
    },
  };
}
