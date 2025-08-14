# WhatsApp Bot Server

A Node.js server for managing WhatsApp connections via Baileys, with Supabase for persistence and Upstash Redis for event streaming.

## Features
- Connects to WhatsApp Web using Baileys
- Stores session data in Supabase
- Uses Upstash Redis for QR codes and message streaming
- Real-time QR and message events via Socket.IO

## Requirements
- Node.js 18+
- Supabase account (Service Role key)
- Upstash Redis account
- Render or other Node hosting service

## Installation
```bash
npm install
