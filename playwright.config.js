import { defineConfig } from '@playwright/test';

// Регресс подсистемы лимитов/velocity (UI: логин через Keycloak SSO + админка + консоль).
// Один воркер: кейсы делят scope лимитов и API мерча — параллель даёт ложные fail.
export default defineConfig({
  testDir: './tests',
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  projects: [
    { name: 'limits', testMatch: /_lim.*\.spec\.js$/ },
  ],
});
