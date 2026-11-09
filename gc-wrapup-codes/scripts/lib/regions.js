'use strict';

const REGION_HOSTS = Object.freeze({
  us_east_1: 'mypurecloud.com',
  eu_west_1: 'mypurecloud.ie',
  ap_southeast_2: 'mypurecloud.com.au',
  ap_northeast_1: 'mypurecloud.jp',
  eu_central_1: 'mypurecloud.de',
  us_west_2: 'usw2.pure.cloud',
  ca_central_1: 'cac1.pure.cloud',
  ap_northeast_2: 'apne2.pure.cloud',
  eu_west_2: 'euw2.pure.cloud',
  ap_south_1: 'aps1.pure.cloud',
  us_east_2: 'use2.us-gov-pure.cloud',
  sa_east_1: 'sae1.pure.cloud',
  me_central_1: 'mec1.pure.cloud',
  ap_northeast_3: 'apne3.pure.cloud',
  eu_central_2: 'euc2.pure.cloud',
  mx_central_1: 'mxc1.pure.cloud',
  ap_southeast_1: 'apse1.pure.cloud',
  eusc_de_east_1: 'edee1.eusc-pure.cloud',
  dev_use1_ai: 'inindca.com',
  test_use1_ai: 'inintca.com',
});

const ALIASES = Object.freeze({
  prod: 'us_east_1',
  use1: 'us_east_1',
  'us-east-1': 'us_east_1',
  'prod-use1': 'us_east_1',
  euw1: 'eu_west_1',
  'eu-west-1': 'eu_west_1',
  'prod-euw1': 'eu_west_1',
  apse2: 'ap_southeast_2',
  'ap-southeast-2': 'ap_southeast_2',
  'prod-apse2': 'ap_southeast_2',
  apne1: 'ap_northeast_1',
  'ap-northeast-1': 'ap_northeast_1',
  'prod-apne1': 'ap_northeast_1',
  euc1: 'eu_central_1',
  'eu-central-1': 'eu_central_1',
  'prod-euc1': 'eu_central_1',
  usw2: 'us_west_2',
  'us-west-2': 'us_west_2',
  'prod-usw2': 'us_west_2',
  cac1: 'ca_central_1',
  'ca-central-1': 'ca_central_1',
  'prod-cac1': 'ca_central_1',
  apne2: 'ap_northeast_2',
  'ap-northeast-2': 'ap_northeast_2',
  'prod-apne2': 'ap_northeast_2',
  euw2: 'eu_west_2',
  'eu-west-2': 'eu_west_2',
  'prod-euw2': 'eu_west_2',
  aps1: 'ap_south_1',
  'ap-south-1': 'ap_south_1',
  'prod-aps1': 'ap_south_1',
  use2: 'us_east_2',
  'us-east-2': 'us_east_2',
  'prod-use2': 'us_east_2',
  sae1: 'sa_east_1',
  'sa-east-1': 'sa_east_1',
  'prod-sae1': 'sa_east_1',
  mec1: 'me_central_1',
  'me-central-1': 'me_central_1',
  'prod-mec1': 'me_central_1',
  apne3: 'ap_northeast_3',
  'ap-northeast-3': 'ap_northeast_3',
  'prod-apne3': 'ap_northeast_3',
  euc2: 'eu_central_2',
  'eu-central-2': 'eu_central_2',
  'prod-euc2': 'eu_central_2',
  mxc1: 'mx_central_1',
  'mx-central-1': 'mx_central_1',
  'prod-mxc1': 'mx_central_1',
  apse1: 'ap_southeast_1',
  'ap-southeast-1': 'ap_southeast_1',
  'prod-apse1': 'ap_southeast_1',
  edee1: 'eusc_de_east_1',
  'eusc-de-east-1': 'eusc_de_east_1',
  'prod-edee1': 'eusc_de_east_1',
  dev: 'dev_use1_ai',
  'dev-use1-ai': 'dev_use1_ai',
  test: 'test_use1_ai',
  'test-use1-ai': 'test_use1_ai',
});

function normalizeRegion(value) {
  if (!value || !String(value).trim()) throw new Error('Genesys Cloud region/habitat is required.');
  let input = String(value).trim().toLowerCase().replace(/\/+$/, '');
  if (input.startsWith('https://')) {
    const parsed = new URL(input);
    if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      throw new Error('Region URL must contain only an approved HTTPS regional host.');
    }
    input = parsed.hostname;
  }
  input = input.replace(/^(api|login|apps)\./, '');
  const key = Object.keys(REGION_HOSTS).find((candidate) => candidate === input)
    || Object.keys(REGION_HOSTS).find((candidate) => REGION_HOSTS[candidate] === input)
    || ALIASES[input];
  if (!key || !REGION_HOSTS[key]) throw new Error(`Unsupported Genesys Cloud region or habitat: ${value}`);
  const host = REGION_HOSTS[key];
  return {
    key,
    host,
    apiBase: `https://api.${host}`,
    loginBase: `https://login.${host}`,
  };
}

function resolveTarget(credentials, explicitRegion) {
  const configured = normalizeRegion(credentials.habitat);
  if (explicitRegion) {
    const explicit = normalizeRegion(explicitRegion);
    if (explicit.key !== configured.key) {
      throw new Error(`Explicit region ${explicitRegion} does not match the MCP-configured habitat.`);
    }
  }
  return configured;
}

module.exports = {
  ALIASES,
  REGION_HOSTS,
  normalizeRegion,
  resolveTarget,
};
