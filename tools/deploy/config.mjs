// Local deploy configuration for the Node ops scripts (infra/leaderboard/verify.mjs).
// The file is ~/.config/gokyuzu/deploy.env, or $GOKYUZU_DEPLOY_ENV; keys and rules: tools/deploy/deploy.env.example
// (same parser as config.sh and deploy_config.py). Values are read from the file only and never printed.
//
//   need('AWS_REGION')              required: throws an Error naming the key if missing, empty or REPLACE_ME
//   optional('CF_HOST_PRODUCTION')  the value or ''
//   profile('AWS_PROFILE_ADMIN')    environment, else the file, else the built-in default
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PLACEHOLDER = 'REPLACE_ME';
const PROFILE_DEFAULTS = { AWS_PROFILE_DEPLOY: 'gokyuzu-deploy', AWS_PROFILE_ADMIN: 'gokyuzu-admin', AWS_PROFILE_ANALYTICS: 'gokyuzu-analytics' };
const LINE = /^(?:export[ \t]+)?([^=]*?)[ \t]*=[ \t]*(.*?)[ \t\r]*$/;

export const configPath = () => process.env.GOKYUZU_DEPLOY_ENV || path.join(os.homedir(), '.config', 'gokyuzu', 'deploy.env');
const shown = () => process.env.GOKYUZU_DEPLOY_ENV || '~/.config/gokyuzu/deploy.env';

/** KEY=VALUE lines → object (last one wins); comment lines, blank lines and lines without '=' are ignored. */
export function parse(text) {
  const out = {};
  for (const raw of text.split('\n')) {
    const line = raw.replace(/^[ \t]+/, '');
    if (!line || line.startsWith('#')) continue;
    const m = LINE.exec(line);
    if (!m) continue;
    let val = m[2];
    if (val.length >= 2 && val[0] === val[val.length - 1] && (val[0] === '"' || val[0] === "'")) val = val.slice(1, -1);
    out[m[1]] = val;
  }
  return out;
}

let cache = null;
export function load() {
  if (!cache) cache = fs.existsSync(configPath()) ? parse(fs.readFileSync(configPath(), 'utf8')) : {};
  return cache;
}

export function need(key) {
  if (!fs.existsSync(configPath())) {
    throw new Error(`Deploy config not found: ${shown()}\n  Copy tools/deploy/deploy.env.example there (chmod 600) and fill it in, or set GOKYUZU_DEPLOY_ENV.`);
  }
  const val = load()[key] || '';
  if (!val || val === PLACEHOLDER) throw new Error(`Deploy config: key ${key} is missing, empty or still ${PLACEHOLDER} in ${shown()} (see tools/deploy/deploy.env.example).`);
  return val;
}

export function optional(key) {
  const val = load()[key] || '';
  return val === PLACEHOLDER ? '' : val;
}

export function profile(key) {
  const val = process.env[key] || load()[key] || '';
  return val && val !== PLACEHOLDER ? val : PROFILE_DEFAULTS[key];
}
