import {defineConfig} from '@playwright/test';
export default defineConfig({testDir:'test/browser',testMatch:'**/*.spec.ts',fullyParallel:true,workers:2,outputDir:'.tmp/playwright-results',reporter:'list',use:{baseURL:'http://127.0.0.1:4187',browserName:'chromium',trace:'retain-on-failure'},webServer:{command:'node test/browser/server.mjs',url:'http://127.0.0.1:4187',reuseExistingServer:false}});
