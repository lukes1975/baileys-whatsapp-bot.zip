// server.js
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import qrcode from 'qrcode-terminal';

import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from '@whiskeysocket/baileys';

import { createClient as createSupabase } from '@supabase/supabase-js';
import { Redis } from '@upstash/redis';

dotenv.config();

const app = express();
const server = http.createServer(app);

const allowed = [
  'http://localhost:5173',
  'https://vendora-whats.lovable.app/',
  'https://preview--vendora-whats.lovable.app/'
];

app.use(cors({
  origin: (origin, cb) => {
    // allow non-browser requests (Postman/server)
    if (!origin) return cb(null, true);
    if (allowed.includes(origin)) return cb(null, true);
    return cb(new Error('CORS not allowed'), false);
  },
  methods: ['GET', 'POST']
}));

const io = new Server(server, {
  cors: {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (allowed.includes(origin)) return cb(null, true);
      return cb(new Error('CORS not allowed'), false);
    },
    methods: ['GET', 'POST']
  }
});

app.use(express.json());

/**
 * Required env vars:
 * - API_KEY                (for /send endpoint)
 * - SUPABASE_URL
 * - SUPABASE_SERVICE_ROLE_KEY
 * - UPSTASH_REST_URL
 * - UPSTASH_REDIS_TOKEN
 * - AUTH_DIR               (optional)
 * - TENANT_ID              (optional single-tenant store id)
 * - WHATSAPP_SESSION_ID    (optional; used for Redis keys)
 * - PORT
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const UPSTASH_REST_URL = process.env.UPSTASH_REST_URL;
const UPSTASH_REDIS_TOKEN = process.env.UPSTASH_REDIS_TOKEN;
const AUTH_DIR = process.env.AUTH_DIR || 'auth_info_baileys';
const TENANT_ID = process.env.TENANT_ID || process.env.WHATSAPP_SESSION_ID || 'dev_tenant';
const SESSION_ID = process.env.WHATSAPP_SESSION_ID || TENANT_ID;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing Supabase config. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(1);
}
if (!UPSTASH_REST_URL || !UPSTASH_REDIS_TOKEN) {
  console.error('Missing Upstash config. Set UPSTASH_REST_URL and UPSTASH_REDIS_TOKEN.');
  process.exit(1);
}

const supabase = createSupabase(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const redis = new Redis({ url: UPSTASH_REST_URL, token: UPSTASH_REDIS_TOKEN });

let sock = null;
let latestQr = null; // latest QR string
let savedState = null; // will hold `state` from useMultiFileAuthState when available

/**
 * Start Baileys socket and wire events:
 * - emit QR over socket.io and persist QR to Redis (TTL 5m)
 * - save session credentials to Supabase (wa_sessions) on creds.update
 * - push inbound messages to Redis stream `wa.inbound`
 */
async function startBot() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    savedState = state;

    const { version } = await fetchLatestBaileysVersion();
    sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
    });

    // Persist credentials on update
    sock.ev.on('creds.update', async () => {
      try {
        // save local files (the helper does this)
        await saveCreds();

        // persist session JSON to Supabase (service role only)
        // Note: upsert on store_id assumes a unique constraint or acceptable conflict behavior.
        await supabase
          .from('wa_sessions')
          .upsert(
            {
              store_id: STORE_ID,
              session_json: state,
              status: 'connected',
              updated_at: new Date().toISOString(),
            },
            { onConflict: ['store_id'] }
          );
      } catch (e) {
        console.error('Error saving creds to Supabase:', e);
      }
    });

    // Connection updates: QR, open, close
    sock.ev.on('connection.update', async (update) => {
      try {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          latestQr = qr;
          // Emit via socket.io for frontend
          io.emit('qr', qr);
          // Print to terminal
          qrcode.generate(qr, { small: true });
          // Store QR in Redis for frontend polling (TTL 300s)
          await redis.set(`wa:qr:${SESSION_ID}`, qr, { ex: 300 });
        }

        if (connection === 'open') {
          console.log('✅ WhatsApp connected');
          io.emit('connected');
          // mark session in DB
          await supabase
            .from('wa_sessions')
            .upsert(
              {
                store_id: TENANT_ID,
                status: 'connected',
                updated_at: new Date().toISOString(),
              },
              { onConflict: ['store_id'] }
            );
          // re-emit latest QR to any new clients
          if (latestQr) io.emit('qr', latestQr);
        }

        if (connection === 'close') {
          const shouldReconnect =
            lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
          console.log('❌ Connection closed.', shouldReconnect ? 'Reconnecting...' : 'Logged out.');
          // Update DB status
          await supabase
            .from('wa_sessions')
            .upsert(
              {
                store_id: TENANT_ID,
                status: shouldReconnect ? 'reconnecting' : 'logged_out',
                updated_at: new Date().toISOString(),
              },
              { onConflict: ['store_id'] }
            );

          if (shouldReconnect) {
            setTimeout(() => startBot().catch((e) => console.error('Reconnect failed', e)), 5000);
          } else {
            // session logged out: clear QR key and inform frontend
            await redis.del(`wa:qr:${SESSION_ID}`);
            io.emit('session_logged_out');
          }
        }
      } catch (e) {
        console.error('Error in connection.update handler', e);
      }
    });

    // Handle messages - send to Redis stream for orchestrator consumption and notify frontend
    sock.ev.on('messages.upsert', async (m) => {
      try {
        const message = m.messages && m.messages[0];
        if (!message) return;

        // Only handle simple conversation text here (extend to other types as needed)
        const text =
          message.message?.conversation ||
          message.message?.extendedTextMessage?.text ||
          message.message?.imageMessage?.caption ||
          null;

        // Ignore messages sent by this session
        if (message.key?.fromMe) return;

        // Derive tenant_id dynamically (Baileys bot should send it along with message)
        const tenantId = 
          message?.message?.extendedTextMessage?.contextInfo?.quotedMessage?.tenant_id ||
          message?.key?.tenant_id || // custom injection if available
          SESSION_ID; // fallback
        if (!tenantId) {
          console.warn('No tenant_id found in inbound message, skipping.');
          return;
        }

        const payload = {
          tenant_id: tenantId,
          chat_id: message.key.remoteJid,
          from: message.key.participant || message.key.remoteJid,
          text,
          message_id: message.key.id,
          ts: message.messageTimestamp,
        };

        // Insert inbound event into Redis stream (XADD)
        // Upstash supports xadd via this client
        await redis.xadd('wa.inbound', '*', 'payload', JSON.stringify(payload));

        // Optional: store message envelope in Supabase for audit (lightweight)
        await supabase.from('wa_messages').insert([
          {
            store_id: TENANT_ID,
            store_id: tenantId,
            chat_id: payload.chat_id,
            direction: 'inbound',
            payload,
          },
        ]);

        // Emit to frontend via socket.io for realtime preview
        io.emit('msg-received', { from: payload.chat_id, message: payload.text });
      } catch (e) {
        console.error('Error handling messages.upsert', e);
      }
    });

    // done starting bot
  } catch (err) {
    console.error('startBot error:', err);
    throw err;
  }
}

// socket.io client connect
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  if (latestQr) socket.emit('qr', latestQr);
  // you can add auth for socket connections if desired
});

// Start bot
startBot().catch((err) => console.error('Unexpected error on start:', err));

/**
 * Outbound send endpoint (protected by x-api-key)
 * Body: { to: '2348012345678', message: 'Hello' }
 */
app.post('/send', async (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey || apiKey !== process.env.API_KEY) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { to, message } = req.body;
    if (!to || !message || message.length > 1000) {
      return res
        .status(400)
        .json({ error: 'Missing to, message, or message exceeds 1000 characters' });
    }

    // normalize phone digits only
    const digits = String(to).replace(/\D/g, '');
    if (!/^\d{6,20}$/.test(digits)) {
      return res.status(400).json({ error: 'Invalid phone format' });
    }

    const jid = `${digits}@s.whatsapp.net`;
    if (!sock) return res.status(500).json({ error: 'WhatsApp not connected' });

    await sock.sendMessage(jid, { text: message });

    // Optional: write outbound to wa_messages for audit
    await supabase.from('wa_messages').insert([
      {
        store_id: TENANT_ID,
        chat_id: jid,
        direction: 'outbound',
        payload: { to: jid, text: message },
      },
    ]);

    return res.json({ status: 'sent' });
  } catch (err) {
    console.error('/send error', err);
    return res.status(500).json({ error: String(err?.message || err) });
  }
});

/**
 * Retrieve QR (for frontend polling) - reads Redis key
 */
app.get('/session/:id/qr', async (req, res) => {
  try {
    const id = req.params.id || SESSION_ID;
    const qr = await redis.get(`wa:qr:${id}`);
    if (!qr) return res.status(404).json({ error: 'QR not found or expired' });
    return res.json({ qr });
  } catch (e) {
    console.error('GET /session/:id/qr', e);
    return res.status(500).json({ error: 'Server error' });
  }
});

/**
 * Session status - reads Supabase wa_sessions row
 */
app.get('/session/:id/status', async (req, res) => {
  try {
    const id = req.params.id || TENANT_ID;
    const { data, error } = await supabase
      .from('wa_sessions')
      .select('status, updated_at, store_id, phone')
      .eq('store_id', id)
      .limit(1)
      .single();

    if (error && error.code !== 'PGRST116') {
      // PGRST116 = no rows? supabase-javascript may return differently
      console.error('Supabase select error', error);
    }

    if (!data) return res.json({ status: 'unknown' });
    return res.json({ status: data.status, updated_at: data.updated_at, phone: data.phone });
  } catch (e) {
    console.error('GET /session/:id/status', e);
    return res.status(500).json({ error: 'Server error' });
  }
});

/**
 * Simple health check
 */
app.get('/health', (_req, res) => {
  res.json({ ok: true, wa_connected: !!sock });
});

// Start HTTP server
const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
