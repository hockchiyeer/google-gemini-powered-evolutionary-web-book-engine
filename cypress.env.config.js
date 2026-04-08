/**
 * Cypress Environment Configuration for Web-Book Engine
 */

const ENVIRONMENT_URLS = {
  'DEV': {
    "baseUrl": "http://localhost:3000"
  },
  'QA': {
    "baseUrl": "https://qa.webbook-engine.example.com"
  },
  'PROD': {
    "baseUrl": "https://webbook-engine.example.com"
  }
};

const GLOBAL_ENV_VAR_KEYS = [
  'USER_NAME',
  'USER_PASSWORD',
  'GEMINI_API_KEY'
];

function loadGlobalEnvironmentVariables() {
  const envVars = {};
  GLOBAL_ENV_VAR_KEYS.forEach(key => {
    envVars[key] = process.env[key];
  });
  return envVars;
}

function getCypressEnvironmentConfig(environment) {
  const envUrls = ENVIRONMENT_URLS[environment] || ENVIRONMENT_URLS['DEV'];
  const globalVars = loadGlobalEnvironmentVariables();
  
  return {
    ...envUrls,
    ...globalVars,
    ENVIRONMENT: environment
  };
}

module.exports = {
  getCypressEnvironmentConfig,
  GLOBAL_ENV_VAR_KEYS,
  ENVIRONMENT_URLS
};
