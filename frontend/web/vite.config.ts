import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite rejects requests whose Host header it does not know. These let the dev
// server be opened through a tunnel (needed for camera and microphone on a phone).
// Add more with DEV_ALLOWED_HOSTS=host1,host2.
const extraHosts = (process.env.DEV_ALLOWED_HOSTS ?? '')
  .split(',')
  .map((host) => host.trim())
  .filter(Boolean);
const allowedHosts = ['.trycloudflare.com', '.ngrok-free.app', '.ngrok.app', '.ngrok.io', ...extraHosts];

export default defineConfig({
  plugins: [react()],
  server: { port: 5180, strictPort: true, allowedHosts },
  preview: { allowedHosts },
});
