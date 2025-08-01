import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysocket/baileys';
import qrcode from 'qrcode-terminal';

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(cors());
app.use(express.json());

let sock;

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
  const { version } = await fetchLatestBaileysVersion();
  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, qr } = update;
    if (qr) {
      io.emit('qr', qr);
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'open') {
      console.log('✅ WhatsApp connected');
      io.emit('connected');
    }
    if (connection === 'close') {
      console.log('❌ Connection closed. Reconnecting...');
      startBot();
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async (msg) => {
    const message = msg.messages[0];
    if (!message.key.fromMe && message.message?.conversation) {
      io.emit('msg-received', {
        from: message.key.remoteJid,
        message: message.message.conversation
      });
    }
  });
}

startBot();

app.post('/send', async (req, res) => {
  const { to, message } = req.body;
  if (!sock) return res.status(500).json({ error: 'WhatsApp not connected' });
  await sock.sendMessage(`${to}@s.whatsapp.net`, { text: message });
  res.json({ status: 'sent' });
});

server.listen(4000, () => console.log('🚀 Server running on http://localhost:4000'));