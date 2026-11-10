import basicSsl from '@vitejs/plugin-basic-ssl';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// basicSsl serves https:// with a self-signed cert so getUserMedia works on phones
// that open the dev/preview server over the local network (secure context required).
export default defineConfig({
  plugins: [react(), basicSsl()],
  server: { host: true, port: 5173 },
  preview: { host: true, port: 4173 },
});
