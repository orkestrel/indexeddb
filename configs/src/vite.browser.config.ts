import { defineConfig } from 'vite'
import { srcBrowser } from '../../vite.config'

// The published `@src/browser` library build — a thin wrapper around the shared
// `srcBrowser` config in the root vite.config.ts.
export default defineConfig(srcBrowser())
