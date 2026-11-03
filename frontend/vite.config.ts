import { defineConfig, type Plugin } from "vite";
import solid from "vite-plugin-solid";
import { WebSocketServer, WebSocket } from "ws";

interface User {
  id: number;
  username: string;
  display_name: string;
  avatar_color: string;
  mic_gain: number;
}

interface ReactionGroup {
  emoji: string;
  count: number;
  users: string[];
}

interface ChatMessage {
  id: number;
  user_id: number;
  username: string;
  display_name: string;
  avatar_color: string;
  content: string;
  image_url?: string;
  reactions: ReactionGroup[];
  created_at: number;
}

function devBackendPlugin(): Plugin {
  let currentUser: User | null = null;
  const sessions = new Set<string>();

  const messages: ChatMessage[] = [
    {
      id: 1,
      user_id: 2,
      username: "galecalol",
      display_name: "Galeca",
      avatar_color: "#57F287",
      content: "Salve galera! Bora pro canal de voz?",
      reactions: [{ emoji: "🔥", count: 2, users: ["penumbra", "vgeralt"] }],
      created_at: Math.floor(Date.now() / 1000) - 300,
    },
    {
      id: 2,
      user_id: 3,
      username: "penumbra",
      display_name: "Penumbra",
      avatar_color: "#EB459E",
      content: "Opa, to entrando agora! Confiram o link: https://github.com",
      reactions: [{ emoji: "👍", count: 1, users: ["galecalol"] }],
      created_at: Math.floor(Date.now() / 1000) - 180,
    },
    {
      id: 3,
      user_id: 4,
      username: "vgeralt",
      display_name: "Geralt",
      avatar_color: "#FEE75C",
      content: "Vou abrir uma live da gameplay pra vocês assistirem.",
      reactions: [],
      created_at: Math.floor(Date.now() / 1000) - 60,
    },
  ];

  let nextMsgId = 4;
  const rawImages = new Map<number, string>();
  const audioPrefs = new Map<string, number>();
  const wsClients = new Set<WebSocket>();

  return {
    name: "dev-backend-mock",
    configureServer(server) {
      // 1. Servidor WebSocket no caminho /ws
      if (server.httpServer) {
        const wss = new WebSocketServer({ noServer: true });

        server.httpServer.on("upgrade", (req, socket, head) => {
          if (req.url === "/ws") {
            wss.handleUpgrade(req, socket, head, (ws) => {
              wss.emit("connection", ws, req);
            });
          }
        });

        wss.on("connection", (ws) => {
          wsClients.add(ws);

          // Envia presença dos amigos e do usuário
          const presenceUsers = ["galecalol", "penumbra", "vgeralt"];
          if (currentUser) presenceUsers.unshift(currentUser.username);
          ws.send(JSON.stringify({ type: "presence", users: presenceUsers }));

          ws.on("message", (data) => {
            const str = data.toString();
            if (str === "ping") {
              ws.send("pong");
            }
          });

          ws.on("close", () => {
            wsClients.delete(ws);
          });
        });
      }

      // 2. Middleware HTTP para rotas /api/*
      server.middlewares.use(async (req, res, next) => {
        if (!req.url || !req.url.startsWith("/api")) {
          return next();
        }

        const url = new URL(
          req.url,
          `http://${req.headers.host || "localhost"}`
        );
        const path = url.pathname;
        const method = req.method || "GET";

        const parseBody = async (): Promise<Record<string, any>> => {
          return new Promise((resolve) => {
            let data = "";
            req.on("data", (chunk) => (data += chunk));
            req.on("end", () => {
              try {
                resolve(data ? JSON.parse(data) : {});
              } catch {
                resolve({});
              }
            });
          });
        };

        const json = (
          data: any,
          status = 200,
          headers: Record<string, string> = {}
        ) => {
          res.writeHead(status, {
            "Content-Type": "application/json",
            ...headers,
          });
          res.end(JSON.stringify(data));
        };

        const cookieHeader = req.headers.cookie || "";
        const hasSession =
          cookieHeader.includes("cf_session=") || sessions.size > 0;

        // GET /api/auth/me
        if (method === "GET" && path === "/api/auth/me") {
          if (!hasSession && !currentUser) {
            return json({ error: "Sessão não encontrada" }, 401);
          }
          if (!currentUser) {
            currentUser = {
              id: 1,
              username: "voce",
              display_name: "Você",
              avatar_color: "#5865F2",
              mic_gain: 100,
            };
          }
          const prefsArray: Array<{
            target_username: string;
            stream_type: string;
            volume: number;
          }> = [];
          audioPrefs.forEach((volume, key) => {
            const [target_username, stream_type] = key.split(":");
            prefsArray.push({ target_username, stream_type, volume });
          });
          return json({
            user: currentUser,
            audio_preferences: prefsArray,
          });
        }

        // POST /api/auth/login
        if (method === "POST" && path === "/api/auth/login") {
          const body = await parseBody();
          const uname = (body.username || "voce").trim().toLowerCase();
          currentUser = {
            id: 1,
            username: uname,
            display_name: body.username ? body.username.trim() : "Você",
            avatar_color: "#5865F2",
            mic_gain: 100,
          };
          const token = "mock-dev-token";
          sessions.add(token);
          return json(currentUser, 200, {
            "Set-Cookie": `cf_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`,
          });
        }

        // POST /api/auth/register
        if (method === "POST" && path === "/api/auth/register") {
          const body = await parseBody();
          const uname = (body.username || "novo_usuario").trim().toLowerCase();
          currentUser = {
            id: 1,
            username: uname,
            display_name: body.display_name ? body.display_name.trim() : uname,
            avatar_color: "#5865F2",
            mic_gain: 100,
          };
          const token = "mock-dev-token";
          sessions.add(token);
          return json(currentUser, 200, {
            "Set-Cookie": `cf_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`,
          });
        }

        // POST /api/auth/logout
        if (method === "POST" && path === "/api/auth/logout") {
          currentUser = null;
          sessions.clear();
          return json({ status: "logged_out" }, 200, {
            "Set-Cookie": `cf_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
          });
        }

        // GET /api/messages
        if (method === "GET" && path === "/api/messages") {
          return json(messages);
        }

        // POST /api/messages
        if (method === "POST" && path === "/api/messages") {
          const body = await parseBody();
          const content = (body.content || "").trim();
          const image_url =
            typeof body.image_url === "string" && body.image_url.trim()
              ? body.image_url.trim()
              : undefined;
          if (!content && !image_url) {
            return json({ error: "Mensagem vazia" }, 400);
          }
          const user = currentUser || {
            id: 1,
            username: "voce",
            display_name: "Você",
            avatar_color: "#5865F2",
            mic_gain: 100,
          };
          const msgId = nextMsgId++;
          let publicImageUrl: string | undefined;
          if (image_url) {
            if (image_url.startsWith("data:")) {
              rawImages.set(msgId, image_url);
              publicImageUrl = `/api/messages/${msgId}/image`;
            } else {
              publicImageUrl = image_url;
            }
          }

          const newMsg: ChatMessage = {
            id: msgId,
            user_id: user.id,
            username: user.username,
            display_name: user.display_name,
            avatar_color: user.avatar_color,
            content,
            image_url: publicImageUrl,
            reactions: [],
            created_at: Math.floor(Date.now() / 1000),
          };
          messages.push(newMsg);

          // Notifica clientes WebSocket
          const eventStr = JSON.stringify({
            type: "chat_message",
            message: newMsg,
          });
          for (const ws of wsClients) {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(eventStr);
            }
          }

          return json(newMsg, 201);
        }

        // GET /api/messages/:id/image
        const imageMatch = path.match(/^\/api\/messages\/(\d+)\/image$/);
        if (method === "GET" && imageMatch) {
          const msgId = Number(imageMatch[1]);
          const dataUri = rawImages.get(msgId);
          if (!dataUri || !dataUri.startsWith("data:")) {
            return json({ error: "Imagem não encontrada" }, 404);
          }
          const [metaPart, b64Data] = dataUri.slice(5).split(";base64,");
          const buf = Buffer.from(b64Data || "", "base64");
          res.writeHead(200, {
            "Content-Type": metaPart || "image/webp",
            "Cache-Control": "public, max-age=31536000, immutable",
          });
          res.end(buf);
          return;
        }

        // POST /api/messages/:id/reactions
        const reactionMatch = path.match(/^\/api\/messages\/(\d+)\/reactions$/);
        if (method === "POST" && reactionMatch) {
          const msgId = Number(reactionMatch[1]);
          const body = await parseBody();
          const emoji = (body.emoji || "").trim();
          const msg = messages.find((m) => m.id === msgId);
          if (!msg || !emoji) {
            return json({ error: "Mensagem ou emoji inválido" }, 400);
          }

          const uname = currentUser?.username || "voce";
          let group = msg.reactions.find((r) => r.emoji === emoji);
          if (group) {
            if (group.users.includes(uname)) {
              group.users = group.users.filter((u) => u !== uname);
              group.count = group.users.length;
              if (group.count === 0) {
                msg.reactions = msg.reactions.filter((r) => r.emoji !== emoji);
              }
            } else {
              group.users.push(uname);
              group.count = group.users.length;
            }
          } else {
            msg.reactions.push({ emoji, count: 1, users: [uname] });
          }

          const eventStr = JSON.stringify({
            type: "message_reactions",
            message_id: msgId,
            reactions: msg.reactions,
          });
          for (const ws of wsClients) {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(eventStr);
            }
          }

          return json({ message_id: msgId, reactions: msg.reactions });
        }

        // POST /api/media/token
        if (method === "POST" && path === "/api/media/token") {
          return json({
            token: "dev-livekit-mock-token",
            url: "wss://demo.invalid/rtc",
          });
        }

        // PUT /api/media/preferences
        if (method === "PUT" && path === "/api/media/preferences") {
          const body = await parseBody();
          if (body.target_username && body.stream_type) {
            audioPrefs.set(
              `${body.target_username}:${body.stream_type}`,
              body.volume ?? 100
            );
          }
          return json({ status: "updated" });
        }

        // PUT /api/media/mic-gain
        if (method === "PUT" && path === "/api/media/mic-gain") {
          const body = await parseBody();
          if (currentUser) {
            currentUser.mic_gain = body.mic_gain ?? 100;
          }
          return json({ status: "updated", mic_gain: body.mic_gain ?? 100 });
        }

        // GET /api/health
        if (method === "GET" && path === "/api/health") {
          return json({ status: "ok" });
        }

        next();
      });
    },
  };
}

const useBackendProxy = process.env.USE_BACKEND_PROXY === "true";

export default defineConfig({
  plugins: [solid(), ...(!useBackendProxy ? [devBackendPlugin()] : [])],
  server: {
    host: "0.0.0.0",
    port: 3000,
    proxy: useBackendProxy
      ? {
          "/api": {
            target: "http://localhost:8080",
            changeOrigin: true,
          },
          "/ws": {
            target: "ws://localhost:8080",
            ws: true,
          },
        }
      : undefined,
  },
  build: {
    target: "esnext",
    chunkSizeWarningLimit: 700,
  },
});
