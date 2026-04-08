require('dotenv').config();

const { defineConfig } = require('cypress');
const { downloadFile } = require('cypress-downloadfile/lib/addPlugin');
const createBundler = require("@bahmutov/cypress-esbuild-preprocessor");
const { NodeModulesPolyfillPlugin } = require('@esbuild-plugins/node-modules-polyfill');
const { NodeGlobalsPolyfillPlugin } = require('@esbuild-plugins/node-globals-polyfill');

try {
  const nodeCrypto = require('crypto');
  if (typeof global.crypto === 'undefined') {
    global.crypto = nodeCrypto.webcrypto || nodeCrypto;
  }
  if (!global.crypto.randomUUID) {
    global.crypto.randomUUID = function fallbackRandomUUID() {
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
      });
    };
  }
} catch (e) {
  console.warn('[crypto-polyfill] Failed to initialize global crypto:', e.message);
}

const addCucumberPreprocessorPlugin = require('@badeball/cypress-cucumber-preprocessor').addCucumberPreprocessorPlugin;
const createEsbuildPlugin = require('@badeball/cypress-cucumber-preprocessor/esbuild').createEsbuildPlugin;
const { getCypressEnvironmentConfig } = require('./cypress.env.config');

const env = process.env.ENVIRONMENT || 'DEV';

module.exports = defineConfig({
  screenshotsFolder: './test-results/chromeReport',
  screenshotOnRunFailure: true,
  video: false,
  chromeWebSecurity: false,
  failOnStatusCode: false,
  reporter: 'cypress-multi-reporters',
  reporterOptions: {
    'reporterEnabled': 'mochawesome, mocha-junit-reporter',
    'mochawesomeReporterOptions': {
      'reportDir': 'test-results/chromeReport/mochawesome-json',
      'quiet': false,
      'overwrite': false,
      'html': true,
      'json': true
    },
    mochaJunitReporterReporterOptions: {
      'mochaFile': 'test-results/chromeReport/test-[hash].xml'
    },
  },
  e2e: {
    async setupNodeEvents(on, config) {
      await addCucumberPreprocessorPlugin(on, config);
      on('task', { downloadFile });
      on('file:preprocessor', createBundler({
        plugins: [
          NodeGlobalsPolyfillPlugin({ process: true, buffer: true }),
          NodeModulesPolyfillPlugin(),
          createEsbuildPlugin(config)
        ],
        define: { global: 'globalThis' }
      }));
      return config;
    },
    specPattern: [
      "cypress/e2e/features/**/*.feature",
      "**/*.spec.js"
    ],
    env: {
      ...getCypressEnvironmentConfig(env),
      omitFiltered: true,
      filterSpecs: true
    },
    includeShadowDom: true,
  },
});
