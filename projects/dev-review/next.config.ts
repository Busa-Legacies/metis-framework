import type { NextConfig } from 'next'
import path from 'node:path'

const nextConfig: NextConfig = {
  turbopack: { root: path.resolve(__dirname) },
  // Allow Electron AND remote tailnet browsers to load the dev server
  // (Next dev blocks cross-origin dev resources by default — hydration JS
  // silently never runs and every button is dead; Ant hit this 2026-06-06).
  allowedDevOrigins: ['127.0.0.1', 'localhost', '0.0.0.0', '<<MACHINE_1_TAILSCALE_IP>>', '<<MACHINE_2_TAILSCALE_IP>>'],
}

export default nextConfig
