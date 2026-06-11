import type { NextConfig } from 'next'
import path from 'node:path'

const nextConfig: NextConfig = {
  turbopack: { root: path.resolve(__dirname) },
  // Allow Electron to load the dev server from either host (avoids HMR origin block).
  // Tailscale IPs allow remote browser access (mobile dashboard → Metis Command);
  // without them dev-mode origin protection blocks hydration and the page renders dead.
  allowedDevOrigins: ['127.0.0.1', 'localhost', '0.0.0.0', '<<MACHINE_1_TAILSCALE_IP>>', 'antfox-macbook', 'antfox-macbook.local'],
  // The floating dev-tools badge (<nextjs-portal>) sits exactly over the mobile
  // bottom tab bar's first tab and INTERCEPTS taps (real phones too, not just
  // Playwright). Pure dev chrome — drop it.
  devIndicators: false,
}

export default nextConfig
